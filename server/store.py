"""NearDrop 近传 - 数据层（SQLite + 文件落盘）"""

import os
import re
import json
import time
import uuid
import shutil
import secrets
import sqlite3
import threading
import mimetypes


def default_base_dir() -> str:
    """数据根目录：优先 %LOCALAPPDATA%\\NearDrop，避免写入 exe 所在目录（可能无权限）。"""
    env = os.environ.get("NEARDROP_HOME")
    if env:
        return env
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(local, "NearDrop")


def _safe_name(name: str) -> str:
    name = (name or "file").replace("\\", "/").split("/")[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if not name:
        name = "file"
    # 限制长度，保留扩展名
    base, ext = os.path.splitext(name)
    if len(base) > 80:
        base = base[:80]
    return base + ext[:16]


class Store:
    def __init__(self, base_dir: str = None):
        self.base = base_dir or default_base_dir()
        self.files_dir = os.path.join(self.base, "files")
        self.thumb_dir = os.path.join(self.base, "thumbs")
        os.makedirs(self.files_dir, exist_ok=True)
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.db_path = os.path.join(self.base, "neardrop.db")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()

    # ---------------- schema ----------------
    def _init_schema(self):
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS devices (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    kind       TEXT DEFAULT 'web',
                    created_at INTEGER NOT NULL,
                    last_seen  INTEGER NOT NULL,
                    last_ip    TEXT,
                    hw_id      TEXT,
                    dtoken     TEXT,
                    trusted    INTEGER DEFAULT 0,
                    revoked    INTEGER DEFAULT 0,
                    paired_at  INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    conv      TEXT NOT NULL,
                    sender    TEXT NOT NULL,
                    type      TEXT NOT NULL,
                    text      TEXT,
                    file_id   TEXT,
                    file_name TEXT,
                    file_size INTEGER DEFAULT 0,
                    mime      TEXT,
                    duration  REAL DEFAULT 0,
                    created   INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv, id);
                CREATE TABLE IF NOT EXISTS files (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    size       INTEGER NOT NULL,
                    mime       TEXT,
                    path       TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    k TEXT PRIMARY KEY,
                    v TEXT
                );
                """
            )
            # 老版本的库没有这些列，就地补上（不重建表，历史消息不丢）
            for col, ddl in (
                ("hw_id", "hw_id TEXT"),
                ("dtoken", "dtoken TEXT"),
                ("trusted", "trusted INTEGER DEFAULT 0"),
                ("revoked", "revoked INTEGER DEFAULT 0"),
                ("paired_at", "paired_at INTEGER DEFAULT 0"),
            ):
                self._add_column("devices", col, ddl)
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_dev_hw ON devices(hw_id)")

    def _add_column(self, table: str, col: str, ddl: str):
        cols = [r["name"] for r in self._conn.execute("PRAGMA table_info(%s)" % table)]
        if col not in cols:
            self._conn.execute("ALTER TABLE %s ADD COLUMN %s" % (table, ddl))

    # ---------------- 服务器身份 ----------------
    def server_id(self) -> str:
        """这台电脑的稳定身份。换 IP / 换网络都不变，客户端靠它认「还是那台电脑」。"""
        sid = self.get_setting("server_id")
        if not sid:
            sid = "srv_" + uuid.uuid4().hex[:16]
            self.set_setting("server_id", sid)
        return sid

    # ---------------- settings ----------------
    def get_setting(self, key: str, default=None):
        row = self._conn.execute("SELECT v FROM settings WHERE k=?", (key,)).fetchone()
        return row["v"] if row else default

    def set_setting(self, key: str, value: str):
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                (key, value),
            )

    # ---------------- devices ----------------
    # 这些是程序自动起的占位名，用户没亲手改过；遇到它们时不要覆盖已有的自定义名
    DEFAULT_NAMES = {"安卓手机", "Windows 电脑", "Mac 电脑", "浏览器设备", "iPhone",
                     "未命名设备", "手机", "电脑", "设备"}

    def register_device(self, name: str, kind: str = "web", device_id: str = None,
                        ip: str = None, hw_id: str = None, custom: int = 0) -> dict:
        """登记/更新设备。

        身份优先级：device_id（客户端持久 UUID） > hw_id（安卓 ANDROID_ID，清缓存后还能认回来）。
        名字规则：用户亲手改过（custom=1）才覆盖；否则不拿默认名冲掉服务端记着的名字。
        """
        now = int(time.time())
        name = (name or "").strip()
        with self._lock, self._conn:
            row = None
            if device_id:
                row = self._conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
            if row is None and hw_id:
                row = self._conn.execute(
                    "SELECT * FROM devices WHERE hw_id=? ORDER BY last_seen DESC LIMIT 1", (hw_id,)
                ).fetchone()
            if row is not None:
                did = row["id"]
                old = (row["name"] or "").strip()
                new_name = old
                if custom and name:
                    new_name = name
                elif not old:
                    new_name = name or "未命名设备"
                elif name and name not in self.DEFAULT_NAMES and old in self.DEFAULT_NAMES:
                    # 客户端本地存着一个更具体的名字，采纳它
                    new_name = name
                self._conn.execute(
                    "UPDATE devices SET name=?, kind=?, last_seen=?, last_ip=?, hw_id=COALESCE(?, hw_id) WHERE id=?",
                    (new_name, kind or row["kind"], now, ip, hw_id, did),
                )
                return self._device_dict(did)
            did = device_id or ("d_" + uuid.uuid4().hex[:12])
            self._conn.execute(
                """INSERT OR REPLACE INTO devices(id,name,kind,created_at,last_seen,last_ip,hw_id,trusted,revoked,paired_at)
                   VALUES(?,?,?,?,?,?,?,0,0,0)""",
                (did, name or "未命名设备", kind, now, now, ip, hw_id),
            )
            return self._device_dict(did)

    def _device_dict(self, device_id: str) -> dict:
        row = self._conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return dict(row) if row else {}

    def touch_device(self, device_id: str, ip: str = None):
        if not device_id:
            return
        with self._lock, self._conn:
            if ip:
                self._conn.execute(
                    "UPDATE devices SET last_seen=?, last_ip=? WHERE id=?",
                    (int(time.time()), ip, device_id),
                )
            else:
                self._conn.execute("UPDATE devices SET last_seen=? WHERE id=?", (int(time.time()), device_id))

    def rename_device(self, device_id: str, name: str):
        with self._lock, self._conn:
            self._conn.execute("UPDATE devices SET name=? WHERE id=?", (name, device_id))

    # ---------------- 可信设备凭证 ----------------
    def pair_device(self, device_id: str) -> dict:
        """访问码验证通过后调用：发一张长期设备凭证，之后换网络/IP 都不用再输码。"""
        with self._lock, self._conn:
            row = self._conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
            if row is None:
                return {}
            tok = row["dtoken"]
            if not tok:
                tok = "dt_" + secrets.token_hex(20)
            self._conn.execute(
                "UPDATE devices SET dtoken=?, trusted=1, revoked=0, paired_at=? WHERE id=?",
                (tok, int(time.time()), device_id),
            )
            return self._device_dict(device_id)

    def check_devtok(self, device_id: str, dtoken: str) -> bool:
        """校验设备凭证。撤销(revoked)后立即失效。"""
        if not device_id or not dtoken:
            return False
        with self._lock:
            row = self._conn.execute(
                "SELECT dtoken, trusted, revoked FROM devices WHERE id=?", (device_id,)
            ).fetchone()
        if not row or not row["dtoken"] or row["revoked"] or not row["trusted"]:
            return False
        return secrets.compare_digest(str(row["dtoken"]), str(dtoken))

    def revoke_device(self, device_id: str) -> bool:
        """踢出：撕掉凭证，该设备下次必须重新输访问码。"""
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE devices SET dtoken=NULL, trusted=0, revoked=1 WHERE id=?", (device_id,)
            )
            return cur.rowcount > 0

    def list_devices(self) -> list:
        rows = self._conn.execute("SELECT * FROM devices ORDER BY last_seen DESC").fetchall()
        return [dict(r) for r in rows]

    def delete_device(self, device_id: str) -> bool:
        """彻底删掉这台设备的记录和凭证。
        历史消息不删（否则聊天记录会出现空洞），发送者显示为「已移除设备」。
        这台设备如果哪天又连回来，会以全新身份重新输访问码。"""
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM devices WHERE id=?", (device_id,))
            return cur.rowcount > 0

    def get_device(self, device_id: str) -> dict:
        row = self._conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return dict(row) if row else {}

    # ---------------- files ----------------
    def save_file(self, fileobj, filename: str, mime: str = None) -> dict:
        fid = uuid.uuid4().hex
        safe = _safe_name(filename)
        stored = f"{fid}_{safe}"
        path = os.path.join(self.files_dir, stored)
        size = 0
        with open(path, "wb") as out:
            while True:
                chunk = fileobj.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)
        mime = mime or mimetypes.guess_type(safe)[0] or "application/octet-stream"
        now = int(time.time())
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO files(id,name,size,mime,path,created_at) VALUES(?,?,?,?,?,?)",
                (fid, safe, size, mime, path, now),
            )
        return {"file_id": fid, "file_name": safe, "file_size": size, "mime": mime}

    def get_file(self, fid: str) -> dict:
        row = self._conn.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
        return dict(row) if row else {}

    def delete_file_row(self, fid: str):
        row = self.get_file(fid)
        if not row:
            return
        try:
            if os.path.exists(row["path"]):
                os.remove(row["path"])
        except OSError:
            pass
        t = os.path.join(self.thumb_dir, fid + ".jpg")
        if os.path.exists(t):
            try:
                os.remove(t)
            except OSError:
                pass
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM files WHERE id=?", (fid,))

    # ---------------- messages ----------------
    def add_message(self, conv: str, sender: str, mtype: str, text: str = None,
                    file_info: dict = None, duration: float = 0) -> dict:
        now = int(time.time() * 1000)
        fi = file_info or {}
        with self._lock, self._conn:
            cur = self._conn.execute(
                """INSERT INTO messages(conv,sender,type,text,file_id,file_name,file_size,mime,duration,created)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (conv, sender, mtype, text, fi.get("file_id"), fi.get("file_name"),
                 fi.get("file_size", 0), fi.get("mime"), duration or 0, now),
            )
            mid = cur.lastrowid
        return self.get_message(mid)

    def get_message(self, mid: int) -> dict:
        row = self._conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        return self._msg_dict(row) if row else {}

    def _msg_dict(self, row) -> dict:
        d = dict(row)
        dev = self.get_device(d["sender"])
        # 设备被删掉后历史消息还在，别把裸 id 甩给用户看
        d["sender_name"] = dev.get("name") or "已移除设备"
        d["sender_kind"] = dev.get("kind") or "web"
        d["sender_gone"] = not bool(dev)
        return d

    def list_messages(self, conv: str, before: int = None, after: int = None, limit: int = 60) -> list:
        limit = max(1, min(int(limit or 60), 200))
        if after is not None:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE conv=? AND id>? ORDER BY id ASC LIMIT ?",
                (conv, int(after), limit),
            ).fetchall()
            return [self._msg_dict(r) for r in rows]
        if before is not None:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE conv=? AND id<? ORDER BY id DESC LIMIT ?",
                (conv, int(before), limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE conv=? ORDER BY id DESC LIMIT ?", (conv, limit)
            ).fetchall()
        return [self._msg_dict(r) for r in reversed(rows)]

    def last_message(self, conv: str) -> dict:
        row = self._conn.execute(
            "SELECT * FROM messages WHERE conv=? ORDER BY id DESC LIMIT 1", (conv,)
        ).fetchone()
        return self._msg_dict(row) if row else {}

    def count_messages(self, conv: str) -> int:
        row = self._conn.execute("SELECT COUNT(*) c FROM messages WHERE conv=?", (conv,)).fetchone()
        return row["c"] if row else 0

    def delete_message(self, mid: int) -> bool:
        msg = self.get_message(mid)
        if not msg:
            return False
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM messages WHERE id=?", (mid,))
        if msg.get("file_id"):
            ref = self._conn.execute(
                "SELECT COUNT(*) c FROM messages WHERE file_id=?", (msg["file_id"],)
            ).fetchone()
            if ref and ref["c"] == 0:
                self.delete_file_row(msg["file_id"])
        return True

    def clear_conv(self, conv: str):
        rows = self._conn.execute("SELECT id, file_id FROM messages WHERE conv=?", (conv,)).fetchall()
        for r in rows:
            self.delete_message(r["id"])

    def stats(self) -> dict:
        m = self._conn.execute("SELECT COUNT(*) c, COALESCE(SUM(file_size),0) s FROM messages").fetchone()
        return {"messages": m["c"], "bytes": m["s"], "base_dir": self.base}

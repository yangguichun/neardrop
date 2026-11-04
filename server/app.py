"""NearDrop 近传 - 局域网中转站服务端

一个跑在电脑上的小型服务：手机、平板、其他电脑连到同一个 Wi-Fi 后，
用浏览器或 App 打开它，就能像微信一样互发文字、图片、语音、视频和任意文件。
所有消息与文件都落在本机，谁离线谁上线后自动补收。
"""

import io
import os
import sys
import json
import time
import uuid
import socket
import secrets
import asyncio
import logging
import threading
from typing import Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException, Request, Query
from fastapi.responses import FileResponse, JSONResponse, Response, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .store import Store

APP_NAME = "NearDrop 近传"
VERSION = "1.2.3"
DISCOVERY_PORT = 37021
DEFAULT_PORT = 8787

# 无需口令即可访问的接口（登录页要能加载、前端要能探测连通性）
PUBLIC_API = {"/api/health", "/api/auth"}

log = logging.getLogger("neardrop")

store: Store = None
app = FastAPI(title=APP_NAME, version=VERSION)

# App 内 WebView 从 file:// 加载页面，请求 http://<ip>:port 属于跨域，需要放行
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# ---------------------------------------------------------------- 访问口令
def ensure_secrets() -> dict:
    """首次启动生成 6 位访问码 + 长期 token，落在 settings 表里，重启不变。"""
    code = store.get_setting("access_code")
    if not code:
        code = "%06d" % secrets.randbelow(1000000)
        store.set_setting("access_code", code)
    token = store.get_setting("token")
    if not token:
        token = secrets.token_hex(24)
        store.set_setting("token", token)
    return {"code": code, "token": token}


def reset_code() -> str:
    """换一个访问码。已配对设备的 token 不变，不会掉线。"""
    code = "%06d" % secrets.randbelow(1000000)
    store.set_setting("access_code", code)
    return code


def _incoming_token(request: Request) -> str:
    return (request.headers.get("x-nd-token") or request.query_params.get("token") or "").strip()


def server_id() -> str:
    return store.server_id()


def _device_cred(request: Request):
    """取出请求里带的设备身份：(device_id, device_token)。"""
    did = (request.headers.get("x-nd-device") or request.query_params.get("device") or "").strip()
    dtok = (request.headers.get("x-nd-device-token") or request.query_params.get("dtok") or "").strip()
    return did, dtok


def _is_local(request: Request) -> bool:
    """本机（127.0.0.1 / ::1）视为可信，不用输访问码——这台电脑本身就有物理权限。"""
    host = (request.client.host if request.client else "") or ""
    return host in ("127.0.0.1", "::1", "localhost")


def _is_paired(request: Request) -> bool:
    """这台设备以前输过访问码、且没被踢出 → 免密。"""
    did, dtok = _device_cred(request)
    return store is not None and store.check_devtok(did, dtok)


def _is_host(request: Request) -> bool:
    """主机级权限（本机或持有主机 token），用于踢人等管理操作。"""
    return _is_local(request) or _incoming_token(request) == ensure_secrets()["token"]


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    path = request.url.path
    # 预检请求交给内层 CORS 处理
    if request.method == "OPTIONS" or path in PUBLIC_API or not path.startswith("/api/"):
        return await call_next(request)
    if store is None:
        return JSONResponse({"detail": "服务正在启动"}, status_code=503)
    if _is_local(request) or _incoming_token(request) == ensure_secrets()["token"] or _is_paired(request):
        return await call_next(request)
    return JSONResponse(
        {"detail": "需要访问口令", "need_auth": True},
        status_code=401,
        headers={"Access-Control-Allow-Origin": "*"},
    )


# ---------------------------------------------------------------- helpers
def resource_path(rel: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    p = os.path.join(base, *rel.split("/"))
    if os.path.exists(p):
        return p
    # 开发态回退：server/ 目录下
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), *rel.split("/"))


def dm_id(a: str, b: str) -> str:
    return "dm:" + "__".join(sorted([a, b]))


def conv_members(conv: str) -> Optional[set]:
    """room 返回 None（所有人）；私聊返回成员集合。"""
    if conv == "room":
        return None
    if conv.startswith("dm:"):
        parts = conv[3:].split("__")
        return set(parts)
    return set()


def get_lan_ips() -> List[str]:
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.append(ip)
    except OSError:
        pass
    try:
        host = socket.gethostbyname(socket.gethostname())
        if host not in ips and not host.startswith("127."):
            ips.append(host)
    except OSError:
        pass
    return ips or ["127.0.0.1"]


def make_thumb(src_path: str, fid: str, max_side: int = 480) -> Optional[str]:
    """为图片生成 jpg 缩略图，返回路径；非图片返回 None。"""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    out = os.path.join(store.thumb_dir, fid + ".jpg")
    if os.path.exists(out):
        return out
    try:
        with Image.open(src_path) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            im.save(out, "JPEG", quality=82, optimize=True)
        return out
    except Exception as e:  # 损坏图片/不支持格式
        log.warning("thumb failed: %s", e)
        return None


# ---------------------------------------------------------------- websocket hub
class Hub:
    def __init__(self):
        self.conns = {}          # device_id -> set(WebSocket)
        self.loop = None
        self.lock = threading.Lock()

    async def connect(self, device_id: str, ws: WebSocket):
        await ws.accept()
        with self.lock:
            self.conns.setdefault(device_id, set()).add(ws)
        await self.broadcast_presence()

    async def disconnect(self, device_id: str, ws: WebSocket):
        with self.lock:
            s = self.conns.get(device_id)
            if s:
                s.discard(ws)
                if not s:
                    self.conns.pop(device_id, None)
        await self.broadcast_presence()

    def online_ids(self) -> list:
        with self.lock:
            return list(self.conns.keys())

    async def broadcast_presence(self):
        payload = {"event": "presence", "online": self.online_ids()}
        await self._fanout(None, payload)

    async def _fanout(self, members: Optional[set], payload: dict):
        with self.lock:
            targets = []
            for dev, socks in self.conns.items():
                if members is None or dev in members:
                    targets.extend(list(socks))
        dead = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            with self.lock:
                for dev in list(self.conns):
                    self.conns[dev] -= set(dead)
                    if not self.conns[dev]:
                        self.conns.pop(dev, None)

    def publish(self, conv: str, payload: dict):
        """从同步上下文（HTTP 路由、线程）安全地投递。"""
        members = conv_members(conv)
        if self.loop and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self._fanout(members, payload), self.loop)

    async def broadcast_event(self, payload: dict):
        await self._fanout(None, payload)

    async def send_to(self, device_id: str, payload: dict):
        """只发给某一台设备（测速邀请用，别打扰别人）。"""
        await self._fanout({device_id}, payload)

    async def kick(self, device_id: str, reason: str = "revoked"):
        """把某台设备的连接全部断掉（踢出后立即生效，不用等它自己重连）。"""
        with self.lock:
            socks = list(self.conns.get(device_id) or [])
        for ws in socks:
            try:
                await ws.send_json({"event": "kicked", "reason": reason})
                await ws.close(code=4003)
            except Exception:
                pass


hub = Hub()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, device: str = Query(""), token: str = Query(""),
                      dtok: str = Query("")):
    ip = ws.client.host if ws.client else None
    local = ip in ("127.0.0.1", "::1")
    if store is None:
        await ws.accept()
        await ws.close(code=4003)
        return
    if not (local or token == ensure_secrets()["token"] or store.check_devtok(device, dtok)):
        await ws.accept()
        await ws.close(code=4003)
        return
    if not device:
        await ws.accept()
        await ws.close(code=4001)
        return
    hub.loop = asyncio.get_running_loop()
    await hub.connect(device, ws)
    store.touch_device(device, ip)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = data.get("t")
            if t == "ping":
                store.touch_device(device, ip)
                await ws.send_json({"event": "pong", "ts": int(time.time() * 1000)})
            elif t == "typing":
                conv = data.get("conv")
                members = conv_members(conv) if conv else None
                if members is not None and device not in members:
                    continue
                await hub._fanout(members, {
                    "event": "typing", "conv": conv, "device": device,
                    "name": store.get_device(device).get("name", device),
                })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug("ws error: %s", e)
    finally:
        await hub.disconnect(device, ws)


# ---------------------------------------------------------------- api: device
@app.post("/api/auth")
def api_auth(payload: dict, request: Request):
    """用 6 位访问码换长期凭证：主机 token + 这台设备的专属凭证。

    设备凭证（device_token）是「记住这台手机」的关键：输过一次码，之后换 Wi-Fi、
    换 IP、重装 App 只要还是这台机器，都能直接连，不用再问。
    """
    if store is None:
        raise HTTPException(503, "服务正在启动")
    code = str(payload.get("code") or "").strip()
    sec = ensure_secrets()
    if code != sec["code"]:
        raise HTTPException(401, "访问码不对")

    did = (payload.get("device_id") or "").strip()
    hw = (payload.get("hw_id") or "").strip()
    name = (payload.get("name") or "").strip()
    kind = payload.get("kind") or "web"
    custom = 1 if payload.get("custom") else 0
    ip = request.client.host if request.client else None

    dev = store.register_device(name or "未命名设备", kind, did or None, ip, hw or None, custom)
    dev = store.pair_device(dev["id"]) if dev else {}
    log.info("pair device %s (%s) from %s", dev.get("id"), dev.get("name"), ip)
    return {
        "ok": True,
        "token": sec["token"],                 # 主机 token，兼容老客户端
        "device_token": dev.get("dtoken", ""),  # 这台设备的长期凭证
        "device": dev,
        "server_id": server_id(),
        "app": APP_NAME,
        "version": VERSION,
    }


@app.post("/api/auth/reset-code")
def api_reset_code():
    """换一个访问码（已配对的设备不受影响）。"""
    return {"ok": True, "access_code": reset_code()}


@app.get("/api/info")
def api_info(request: Request):
    port = request.url.port or DEFAULT_PORT
    ips = get_lan_ips()
    sec = ensure_secrets()
    return {
        "app": APP_NAME,
        "version": VERSION,
        "server_id": server_id(),
        "port": port,
        "ips": ips,
        "primary_ip": ips[0] if ips else "127.0.0.1",
        "server_name": socket.gethostname(),
        "access_code": sec["code"],
        "online": hub.online_ids(),
        "devices": store.list_devices(),
        "stats": store.stats(),
        "server_time": int(time.time() * 1000),
    }


@app.get("/api/devices")
def api_devices(request: Request, device: str = Query("")):
    """当前在线/历史设备清单，含各自的局域网 IP。"""
    now = int(time.time())
    online = set(hub.online_ids())
    ips = get_lan_ips()
    me_ip = None
    items = []
    for d in store.list_devices():
        if now - (d.get("last_seen") or 0) > 30 * 86400:
            continue
        is_self = d["id"] == device
        if is_self:
            me_ip = d.get("last_ip")
        items.append({
            "id": d["id"],
            "name": d.get("name") or "设备",
            "kind": d.get("kind") or "web",
            "ip": d.get("last_ip") or "",
            "online": d["id"] in online,
            "is_self": is_self,
            "trusted": bool(d.get("trusted")),
            "revoked": bool(d.get("revoked")),
            "paired_at": d.get("paired_at") or 0,
            "last_seen": d.get("last_seen") or 0,
        })
    items.sort(key=lambda x: (not x["online"], not x["is_self"], -(x["last_seen"] or 0)))
    return {
        "server": {
            "name": socket.gethostname(),
            "id": server_id(),
            "ip": ips[0] if ips else "127.0.0.1",
            "ips": ips,
            "port": request.url.port or DEFAULT_PORT,
        },
        "devices": items,
        "me_ip": me_ip or (request.client.host if request.client else ""),
        "online": list(online),
        "can_manage": _is_host(request),
        "access_code": ensure_secrets()["code"],
    }


@app.post("/api/register")
async def api_register(payload: dict, request: Request):
    name = (payload.get("name") or "").strip() or "未命名设备"
    kind = payload.get("kind") or "web"
    device_id = payload.get("device_id")
    hw_id = (payload.get("hw_id") or "").strip() or None
    custom = 1 if payload.get("custom") else 0
    ip = request.client.host if request.client else None
    dev = store.register_device(name, kind, device_id, ip, hw_id, custom)
    await hub.broadcast_event({"event": "device_update", "device": dev})
    return dev


@app.post("/api/device/rename")
async def api_rename(payload: dict):
    device_id = payload.get("device_id")
    name = (payload.get("name") or "").strip()
    if not device_id or not name:
        raise HTTPException(400, "缺少参数")
    store.rename_device(device_id, name)
    await hub.broadcast_event({"event": "device_update", "device": store.get_device(device_id)})
    return {"ok": True}


@app.post("/api/device/revoke")
async def api_revoke(payload: dict, request: Request):
    """踢出一台设备：撕掉它的长期凭证，下次必须重新输访问码。"""
    if not _is_host(request):
        raise HTTPException(403, "只有这台电脑本身能踢人")
    device_id = (payload.get("device_id") or "").strip()
    if not device_id:
        raise HTTPException(400, "缺少 device_id")
    if device_id == (payload.get("self") or ""):
        raise HTTPException(400, "不能踢自己")
    ok = store.revoke_device(device_id)
    await hub.kick(device_id)
    await hub.broadcast_event({"event": "device_update", "device": store.get_device(device_id)})
    return {"ok": ok}


@app.post("/api/device/delete")
async def api_delete_device(payload: dict, request: Request):
    """彻底删除一台设备的记录（清理离线僵尸设备）。历史消息保留，发送者显示「已移除设备」。

    谁能删：任何已通过鉴权的设备都能删**离线**设备（只是清理列表）；
    在线设备只有这台电脑本身能删，避免手机上误删正在用的设备。"""
    device_id = (payload.get("device_id") or "").strip()
    if not device_id:
        raise HTTPException(400, "缺少 device_id")
    if device_id == (payload.get("self") or ""):
        raise HTTPException(400, "不能删自己")
    online = device_id in hub.online_ids()
    if online and not _is_host(request):
        raise HTTPException(403, "这台设备还在线，只能在电脑端删")
    dev = store.get_device(device_id)
    if not dev:
        raise HTTPException(404, "这台设备已经不在了")
    # 万一它还连着（比如刚好重连），先断开再说，免得删完它拿着失效凭证乱撞
    await hub.kick(device_id, "deleted")
    ok = store.delete_device(device_id)
    await hub.broadcast_event({
        "event": "device_deleted",
        "device_id": device_id,
        "name": dev.get("name") or "设备",
    })
    return {"ok": ok, "name": dev.get("name") or "设备"}


# ---------------------------------------------------------------- api: conversations
@app.get("/api/conversations")
def api_conversations(device: str = Query("")):
    now = int(time.time())
    # 30 天没冒过头的设备不进列表（清缓存/重装产生的僵尸设备）
    devices = [d for d in store.list_devices() if now - (d.get("last_seen") or 0) < 30 * 86400]
    convs = []

    room_last = store.last_message("room")
    convs.append({
        "id": "room",
        "title": "公共频道",
        "kind": "room",
        "subtitle": "所有设备都能看到",
        "last": room_last,
    })

    for d in devices:
        if d["id"] == device:
            continue
        cid = dm_id(device, d["id"])
        last = store.last_message(cid)
        online = d["id"] in hub.online_ids()
        recent = now - (d.get("last_seen") or 0) < 3 * 86400
        # 没聊过、又不在线、还很久没出现的设备不进列表
        if not last and not online and not recent:
            continue
        convs.append({
            "id": cid,
            "title": d["name"],
            "kind": "dm",
            "peer": d["id"],
            "peer_kind": d.get("kind"),
            "subtitle": "私聊",
            "last": last,
            "online": online,
        })

    convs[1:] = sorted(
        convs[1:],
        key=lambda c: ((c.get("last") or {}).get("id") or 0),
        reverse=True,
    )
    return {"device": device, "conversations": convs, "devices": devices, "online": hub.online_ids()}


@app.get("/api/messages")
def api_messages(conv: str, device: str = "", before: int = None, after: int = None, limit: int = 60):
    members = conv_members(conv)
    if members and device not in members:
        raise HTTPException(403, "无权访问该会话")
    msgs = store.list_messages(conv, before=before, after=after, limit=limit)
    return {"conv": conv, "messages": msgs, "has_more": len(msgs) >= limit}


@app.post("/api/send")
async def api_send(payload: dict):
    conv = payload.get("conv") or "room"
    sender = payload.get("device")
    text = payload.get("text") or ""
    if not sender:
        raise HTTPException(400, "缺少 device")
    members = conv_members(conv)
    if members and sender not in members:
        raise HTTPException(403, "无权发送")
    msg = store.add_message(conv, sender, "text", text=text)
    hub.publish(conv, {"event": "msg", "conv": conv, "message": msg})
    return msg


@app.post("/api/upload")
async def api_upload(
    file: UploadFile = File(...),
    conv: str = Form("room"),
    device: str = Form(...),
    duration: float = Form(0),
):
    members = conv_members(conv)
    if members and device not in members:
        raise HTTPException(403, "无权发送")
    mime = file.content_type or ""
    # save_file 是阻塞写盘，必须丢到线程池，否则大文件传完那一刻整个事件循环被占住，
    # 同时进来的下载/保存请求会明显卡一下（实测从 110MB/s 掉到 30MB/s）。
    info = await run_in_threadpool(store.save_file, file.file, file.filename or "file", mime)
    mime = info["mime"]
    if mime.startswith("image/"):
        await run_in_threadpool(make_thumb, store.get_file(info["file_id"])["path"], info["file_id"])
        mtype = "image"
    elif mime.startswith("video/"):
        mtype = "video"
    elif mime.startswith("audio/"):
        mtype = "audio"
    else:
        mtype = "file"
    msg = store.add_message(conv, device, mtype, file_info=info, duration=duration)
    hub.publish(conv, {"event": "msg", "conv": conv, "message": msg})
    return msg


@app.delete("/api/message/{mid}")
async def api_delete_message(mid: int):
    msg = store.get_message(mid)
    if not msg:
        raise HTTPException(404, "消息不存在")
    store.delete_message(mid)
    hub.publish(msg["conv"], {"event": "msg_deleted", "conv": msg["conv"], "id": mid})
    return {"ok": True}


@app.post("/api/clear")
async def api_clear(payload: dict):
    conv = payload.get("conv")
    device = payload.get("device")
    if not conv:
        raise HTTPException(400, "缺少 conv")
    members = conv_members(conv)
    if members and device not in members:
        raise HTTPException(403, "无权操作")
    store.clear_conv(conv)
    hub.publish(conv, {"event": "conv_cleared", "conv": conv})
    return {"ok": True}


# ---------------------------------------------------------------- api: files
@app.get("/api/file/{fid}")
def api_file(fid: str, download: int = 0):
    row = store.get_file(fid)
    if not row or not os.path.exists(row["path"]):
        raise HTTPException(404, "文件不存在")
    headers = {}
    if download:
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{_q(row['name'])}"
    return FileResponse(row["path"], media_type=row["mime"] or "application/octet-stream",
                        filename=row["name"], headers=headers)


@app.get("/api/thumb/{fid}")
def api_thumb(fid: str):
    row = store.get_file(fid)
    if not row:
        raise HTTPException(404, "文件不存在")
    p = os.path.join(store.thumb_dir, fid + ".jpg")
    if not os.path.exists(p):
        p = make_thumb(row["path"], fid)
    if not p or not os.path.exists(p):
        # 无缩略图时退回原图（浏览器会自动缩放）
        return FileResponse(row["path"], media_type=row["mime"] or "application/octet-stream")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/api/qr")
def api_qr(request: Request, text: str = ""):
    import qrcode  # 延迟导入，缩短启动时间
    ips = get_lan_ips()
    code = ensure_secrets()["code"]
    url = text or f"http://{ips[0]}:{request.url.port or DEFAULT_PORT}/?code={code}"
    img = qrcode.make(url, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
def api_health():
    return {"ok": True, "app": APP_NAME, "version": VERSION,
            "server_id": server_id() if store else ""}


# ---------------------------------------------------------------- 测速
# 三种口径：
#   1) 单端：ping / 下载 / 上传，测的是「这台设备 ↔ 这台电脑」
#   2) 中继互测：A 发、B 收，服务器只转发不落盘，测的是手机之间的真实端到端速度
#   3) 因为电脑是中转站，A→B 的链路一定是 A→电脑→B 两跳，两段会互相争用同一信道
SPEED_CAP = 512 * 1024 * 1024
_SPEED_BLOCK = os.urandom(1024 * 1024)


@app.get("/api/speed/ping")
async def api_speed_ping():
    return {"ts": int(time.time() * 1000)}


@app.get("/api/speed/down")
async def api_speed_down(n_bytes: int = Query(8 * 1024 * 1024, alias="bytes")):
    total = max(64 * 1024, min(int(n_bytes), SPEED_CAP))

    async def gen():
        left = total
        while left > 0:
            take = min(len(_SPEED_BLOCK), left)
            yield _SPEED_BLOCK[:take]
            left -= take

    return StreamingResponse(gen(), media_type="application/octet-stream", headers={
        "Cache-Control": "no-store",
        "Content-Length": str(total),
        "X-Accel-Buffering": "no",
    })


@app.post("/api/speed/up")
async def api_speed_up(request: Request):
    n = 0
    t0 = time.perf_counter()
    async for chunk in request.stream():
        n += len(chunk)
        if n >= SPEED_CAP:
            break
    return {"bytes": n, "ms": max(1, int((time.perf_counter() - t0) * 1000))}


class RelaySession:
    """两端互测的转发会话：A 发进来的字节直接转给 B，全程不落盘。"""

    def __init__(self, sid: str, a: str, b: str):
        self.sid = sid
        self.a = a
        self.b = b
        self.wa: Optional[WebSocket] = None
        self.wb: Optional[WebSocket] = None
        self.up = 0          # 服务器从 A 收到
        self.down = 0        # 服务器发给 B 成功
        self.created = time.time()
        self.finished = False


_RELAY: dict = {}
RELAY_TTL = 180


def _sweep_relay():
    now = time.time()
    for k in [k for k, v in _RELAY.items() if now - v.created > RELAY_TTL]:
        _RELAY.pop(k, None)


@app.post("/api/speed/relay/start")
async def api_speed_relay_start(payload: dict):
    me = (payload.get("device") or "").strip()
    target = (payload.get("target") or "").strip()
    if not me or not target or me == target:
        raise HTTPException(400, "参数不对")
    _sweep_relay()
    sid = secrets.token_urlsafe(9)
    _RELAY[sid] = RelaySession(sid, me, target)
    # 通知对端：那边会自动打开测速面板并开始接收
    try:
        name = (store.get_device(me) or {}).get("name") or me
    except Exception:
        name = me
    await hub.send_to(target, {"event": "speed_invite", "sid": sid, "from": me, "from_name": name})
    return {"sid": sid, "target": target}


@app.websocket("/ws/speed/{sid}")
async def ws_speed(ws: WebSocket, sid: str, device: str = Query(""), token: str = Query(""),
                   dtok: str = Query("")):
    ip = ws.client.host if ws.client else None
    local = ip in ("127.0.0.1", "::1")
    s = _RELAY.get(sid)
    if store is None or not s or s.finished:
        await ws.accept()
        await ws.close(code=4004)
        return
    if not (local or token == ensure_secrets()["token"] or store.check_devtok(device, dtok)):
        await ws.accept()
        await ws.close(code=4003)
        return
    if device not in (s.a, s.b):
        await ws.accept()
        await ws.close(code=4003)
        return

    await ws.accept()
    sender = (device == s.a)
    if sender:
        s.wa = ws
    else:
        s.wb = ws
    # 两端都连上才喊开始，避免一方已经发了半秒、另一方还没开始计时
    if s.wa is not None and s.wb is not None:
        for w in (s.wa, s.wb):
            try:
                await w.send_json({"t": "go", "ts": int(time.time() * 1000)})
            except Exception:
                pass
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data:
                s.up += len(data)
                if s.wb is not None:
                    try:
                        await s.wb.send_bytes(data)
                        s.down += len(data)
                    except Exception:
                        s.wb = None
                continue
            txt = msg.get("text")
            if not txt:
                continue
            try:
                d = json.loads(txt)
            except json.JSONDecodeError:
                continue
            t = d.get("t")
            if t == "stat":
                # 发送端可能想看一眼对端到底收了多少
                try:
                    await ws.send_json({"t": "stat", "up": s.up, "down": s.down})
                except Exception:
                    pass
            elif t == "done":
                s.finished = True
                for w in (s.wa, s.wb):
                    if w is None:
                        continue
                    try:
                        await w.send_json({"t": "done", "up": s.up, "down": s.down})
                    except Exception:
                        pass
                break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug("speed ws error: %s", e)
    finally:
        if sender:
            s.wa = None
        else:
            s.wb = None
        if s.wa is None and s.wb is None:
            _RELAY.pop(sid, None)


def _q(s: str) -> str:
    from urllib.parse import quote
    return quote(s or "file")


# ---------------------------------------------------------------- static
STATIC_DIR = resource_path("static")


@app.get("/")
def index():
    p = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(p):
        return HTMLResponse("<h1>NearDrop</h1><p>static/index.html 缺失</p>")
    return FileResponse(p, media_type="text/html; charset=utf-8")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------- udp discovery
class Discovery(threading.Thread):
    """UDP 广播应答，让 App 免手输 IP 自动找到电脑。"""

    def __init__(self, port: int, name: str, sid: str = ""):
        super().__init__(daemon=True)
        self.http_port = port
        self.name = name
        self.sid = sid
        self._stop = threading.Event()

    def run(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", DISCOVERY_PORT))
        except OSError as e:
            log.warning("发现端口被占用，跳过 UDP 发现: %s", e)
            return
        sock.settimeout(1.0)
        while not self._stop.is_set():
            try:
                data, addr = sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            if data.strip() != b"NEARDROP_DISCOVER":
                continue
            resp = json.dumps({
                "app": "neardrop", "name": self.name, "sid": self.sid,
                "port": self.http_port, "version": VERSION,
            }).encode()
            try:
                sock.sendto(resp, addr)
            except OSError:
                pass
        sock.close()

    def stop(self):
        self._stop.set()


# ---------------------------------------------------------------- bootstrap
def create_app(base_dir: str = None) -> FastAPI:
    global store
    store = Store(base_dir)
    return app

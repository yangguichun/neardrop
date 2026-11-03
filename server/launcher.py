"""NearDrop 近传 - 桌面启动器（托盘常驻）"""

import os
import sys
import time
import socket
import threading
import webbrowser
import subprocess
import logging
import urllib.request

from . import app as app_module
from .app import create_app, get_lan_ips, Discovery, DEFAULT_PORT, APP_NAME, VERSION

LOG_PATH = None


def setup_logging():
    global LOG_PATH
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    logdir = os.path.join(base, "NearDrop")
    os.makedirs(logdir, exist_ok=True)
    LOG_PATH = os.path.join(logdir, "neardrop.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8")],
    )


def port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.2) as r:
            return b"neardrop" in r.read().lower() or b"NearDrop" in r.read()
    except Exception:
        return False


def make_icon_image():
    from PIL import Image, ImageDraw
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([6, 6, size - 6, size - 6], radius=58, fill=(37, 99, 235, 255))
    # 右箭头
    d.polygon([(56, 88), (104, 62), (104, 114)], fill=(255, 255, 255, 255))
    d.rectangle([100, 80, 192, 96], fill=(255, 255, 255, 255))
    # 左箭头
    d.polygon([(200, 168), (152, 142), (152, 194)], fill=(255, 255, 255, 230))
    d.rectangle([64, 160, 156, 176], fill=(255, 255, 255, 230))
    return img


def fix_std_streams():
    """windows 下以 --noconsole 方式打包后 stdout/stderr 为 None，
    uvicorn 的日志格式化器会调 .isatty() 直接崩，这里兜底成空设备。"""
    for name in ("stdout", "stderr", "stdin"):
        if getattr(sys, name, "missing") is None:
            try:
                if name == "stdin":
                    setattr(sys, name, open(os.devnull, "r", encoding="utf-8", errors="ignore"))
                else:
                    setattr(sys, name, open(os.devnull, "w", encoding="utf-8",
                                            errors="ignore", buffering=1))
            except Exception:
                pass


def safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except Exception:
        pass


def run_server(port: int, base_dir: str):
    import uvicorn
    create_app(base_dir)
    # log_config=None：不让 uvicorn 用自己的 logging 配置（它会去碰 stdout），
    # 日志统一走 setup_logging() 里挂的文件 handler。
    config = uvicorn.Config(
        app_module.app,
        host="0.0.0.0",
        port=port,
        log_config=None,
        log_level="warning",
        access_log=False,
        ws="auto",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    thread.start()
    return server


def main(argv=None):
    fix_std_streams()
    argv = argv if argv is not None else sys.argv[1:]
    port = DEFAULT_PORT
    no_tray = "--no-tray" in argv or "--headless" in argv
    no_browser = "--no-browser" in argv
    base_dir = None
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            port = int(argv[i + 1])
        if a == "--data" and i + 1 < len(argv):
            base_dir = argv[i + 1]

    setup_logging()
    log = logging.getLogger("neardrop.launcher")

    # 已在运行则直接开界面
    for p in [port, port + 1, port + 2]:
        if already_running(p):
            try:
                from .splash import close as _sc
                _sc()
            except Exception:
                pass
            if not no_browser:
                webbrowser.open(f"http://127.0.0.1:{p}/")
            safe_print(f"{APP_NAME} 已在运行: http://127.0.0.1:{p}/")
            return 0

    # 找一个空闲端口
    chosen = None
    for p in range(port, port + 10):
        if port_free(p):
            chosen = p
            break
    if chosen is None:
        log.error("找不到可用端口")
        return 1
    port = chosen

    ips = get_lan_ips()
    url = f"http://{ips[0]}:{port}/"
    log.info("starting %s v%s on port %s, ips=%s", APP_NAME, VERSION, port, ips)
    safe_print("=" * 52)
    safe_print(f"  {APP_NAME} v{VERSION}")
    safe_print(f"  本机访问: http://127.0.0.1:{port}/")
    for ip in ips:
        safe_print(f"  局域网访问: http://{ip}:{port}/")
    safe_print("=" * 52)
    try:
        run_server(port, base_dir)
    except Exception:
        log.exception("uvicorn 启动失败")
        raise
    try:
        sid = app_module.store.server_id()
    except Exception:
        sid = ""
    Discovery(port, socket.gethostname(), sid).start()

    try:
        access_code = app_module.ensure_secrets()["code"]
    except Exception:
        access_code = "------"
    safe_print(f"  访问码: {access_code}   新设备连接时输入")
    log.info("access code: %s", access_code)

    # 等待服务起来
    for _ in range(50):
        if already_running(port):
            break
        time.sleep(0.1)

    try:
        from .splash import close as _splash_close
        _splash_close()
    except Exception:
        pass

    if not no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()

    if no_tray:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        return 0

    # 托盘
    try:
        import pystray
        from pystray import MenuItem as Item, Menu
    except ImportError:
        log.warning("pystray 未安装，转为无托盘模式")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        return 0

    def open_ui(icon=None, item=None):
        webbrowser.open(f"http://127.0.0.1:{port}/")

    def copy_addr(icon=None, item=None):
        try:
            subprocess.run("clip", input=url.encode("utf-16-le"), shell=True, check=False)
        except Exception:
            pass

    def copy_code(icon=None, item=None):
        try:
            subprocess.run("clip", input=access_code.encode("utf-16-le"), shell=True, check=False)
            icon.notify(f"访问码 {access_code} 已复制", APP_NAME)
        except Exception:
            pass

    def open_folder(icon=None, item=None):
        try:
            os.startfile(app_module.store.base)  # type: ignore[attr-defined]
        except Exception:
            pass

    def open_log(icon=None, item=None):
        try:
            os.startfile(LOG_PATH)
        except Exception:
            pass

    def autostart_on() -> bool:
        try:
            import winreg
            k = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r"Software\Microsoft\Windows\CurrentVersion\Run")
            winreg.QueryValueEx(k, "NearDrop")
            return True
        except Exception:
            return False

    def toggle_autostart(icon=None, item=None):
        import winreg
        path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE)
            if autostart_on():
                winreg.DeleteValue(k, "NearDrop")
                icon.notify("已关闭开机自启", APP_NAME)
            else:
                exe = sys.executable if getattr(sys, "frozen", False) else os.path.abspath(sys.argv[0])
                winreg.SetValueEx(k, "NearDrop", 0, winreg.REG_SZ, f'"{exe}" --no-browser')
                icon.notify("已设置开机自启，登录后自动在后台运行", APP_NAME)
        except Exception as e:
            log.warning("autostart failed: %s", e)

    def quit_app(icon, item=None):
        try:
            icon.stop()
        finally:
            os._exit(0)

    icon = pystray.Icon(
        "neardrop",
        make_icon_image(),
        f"{APP_NAME} —— {url}  访问码 {access_code}",
        menu=Menu(
            Item("打开界面", open_ui, default=True),
            Item(f"地址 {url}", copy_addr),
            Item(f"访问码 {access_code}", copy_code),
            Item("打开数据文件夹", open_folder),
            Item("开机自动启动", toggle_autostart, checked=lambda item: autostart_on()),
            Item("查看日志", open_log),
            Menu.SEPARATOR,
            Item("退出", quit_app),
        ),
    )
    try:
        icon.notify(f"访问码 {access_code}，手机连同一 Wi-Fi 后打开 {url}", APP_NAME)
    except Exception:
        pass
    icon.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

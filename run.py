"""NearDrop 近传 - 入口"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _fix_std_streams():
    """--noconsole 打包后 sys.stdout / sys.stderr 为 None，
    uvicorn、print、logging 都会因此崩溃，统一兜底到空设备。"""
    for name in ("stdout", "stderr", "stdin"):
        if getattr(sys, name, "missing") is None:
            try:
                devnull = os.devnull
                if name == "stdin":
                    setattr(sys, name, open(devnull, "r", encoding="utf-8", errors="ignore"))
                else:
                    setattr(sys, name, open(devnull, "w", encoding="utf-8", errors="ignore", buffering=1))
            except Exception:
                pass


def _fatal(message: str):
    """打包后没有控制台，用系统弹窗告知，同时写日志。"""
    log_path = ""
    try:
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        log_path = os.path.join(base, "NearDrop", "neardrop.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("\n" + "=" * 60 + "\n" + message + "\n")
    except Exception:
        pass

    text = message
    if log_path:
        text += "\n\n日志文件：\n" + log_path
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text[-1800:], "近传 NearDrop 启动失败", 0x10)
    except Exception:
        pass


_fix_std_streams()

if __name__ == "__main__":
    # 先弹启动提示窗，再导入 fastapi/uvicorn（这台机器上导入要好几秒，
    # 期间没有任何界面，用户会以为没打开）
    try:
        from server.splash import show as _splash_show, close as _splash_close
        _splash_show()
    except Exception:
        _splash_close = None
    try:
        from server.launcher import main
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        try:
            if _splash_close:
                _splash_close()
        except Exception:
            pass
        _fatal(traceback.format_exc())
        sys.exit(1)

"""极简原生启动提示窗

打包成 --noconsole 的 exe 后没有控制台，启动的十几秒里用户看不到任何反应，
容易以为程序没打开、反复双击。这里用 ctypes 直接建一个 Win32 小窗，
在导入 fastapi/uvicorn 之前就能显示出来（不依赖 tkinter）。
任何一步失败都静默降级，绝不影响主程序。
"""

import ctypes
import os
import threading
import traceback
from ctypes import wintypes as wt

W, H = 380, 132
TEXT = "近传 NearDrop 正在启动…\n首次启动需要十几秒，请不要重复双击"

WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WM_PAINT = 0x000F
WM_CLOSE = 0x0010
WM_DESTROY = 0x0002
DT_CENTER = 0x00000001
DT_VCENTER = 0x00000004
DT_SINGLELINE = 0x00000020
DT_WORDBREAK = 0x00000010

CLS = "NearDropSplash"

_hwnd = None
_thread = None
_ready = threading.Event()
_ok = False


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", ctypes.c_uint),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wt.HINSTANCE),
        ("hIcon", wt.HICON),
        ("hCursor", wt.HANDLE),
        ("hbrBackground", wt.HBRUSH),
        ("lpszMenuName", wt.LPCWSTR),
        ("lpszClassName", wt.LPCWSTR),
    ]


class PAINTSTRUCT(ctypes.Structure):
    _fields_ = [
        ("hdc", wt.HDC),
        ("fErase", wt.BOOL),
        ("rcPaint", wt.RECT),
        ("fRestore", wt.BOOL),
        ("fIncUpdate", wt.BOOL),
        ("rgbReserved", ctypes.c_byte * 32),
    ]


def _run():
    global _hwnd, _ok
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)

        user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
        user32.DefWindowProcW.restype = LRESULT
        user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        user32.RegisterClassW.restype = ctypes.c_ushort
        user32.CreateWindowExW.argtypes = [
            ctypes.c_uint, wt.LPCWSTR, wt.LPCWSTR, ctypes.c_uint,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID,
        ]
        user32.CreateWindowExW.restype = wt.HWND
        user32.BeginPaint.argtypes = [wt.HWND, ctypes.POINTER(PAINTSTRUCT)]
        user32.BeginPaint.restype = wt.HDC
        user32.EndPaint.argtypes = [wt.HWND, ctypes.POINTER(PAINTSTRUCT)]
        user32.FillRect.argtypes = [wt.HDC, ctypes.POINTER(wt.RECT), wt.HBRUSH]
        user32.DrawTextW.argtypes = [wt.HDC, wt.LPCWSTR, ctypes.c_int,
                                     ctypes.POINTER(wt.RECT), ctypes.c_uint]
        user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        user32.GetSystemMetrics.restype = ctypes.c_int
        user32.SetTimer.argtypes = [wt.HWND, ctypes.c_size_t, ctypes.c_uint, ctypes.c_void_p]
        gdi32.SetBkMode.argtypes = [wt.HDC, ctypes.c_int]
        gdi32.SetTextColor.argtypes = [wt.HDC, wt.COLORREF]
        gdi32.CreateSolidBrush.argtypes = [wt.COLORREF]
        gdi32.CreateSolidBrush.restype = wt.HBRUSH
        gdi32.GetStockObject.argtypes = [ctypes.c_int]
        gdi32.GetStockObject.restype = wt.HGDIOBJ
        gdi32.SelectObject.argtypes = [wt.HDC, wt.HGDIOBJ]
        gdi32.SelectObject.restype = wt.HGDIOBJ
        gdi32.DeleteObject.argtypes = [wt.HGDIOBJ]
        gdi32.DeleteObject.restype = wt.BOOL
        gdi32.CreateFontW.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.LPCWSTR,
        ]
        gdi32.CreateFontW.restype = wt.HFONT

        blue = gdi32.CreateSolidBrush(0x00EB6325)  # RGB(37,99,235)
        font = gdi32.CreateFontW(-16, 0, 0, 0, 400, 0, 0, 0, 134, 0, 0, 5, 0,
                                 "Microsoft YaHei UI") or gdi32.GetStockObject(17)

        def paint(hwnd):
            ps = PAINTSTRUCT()
            hdc = user32.BeginPaint(hwnd, ctypes.byref(ps))
            if hdc:
                rect = wt.RECT(0, 0, W, H)
                if blue:
                    user32.FillRect(hdc, ctypes.byref(rect), blue)
                gdi32.SetBkMode(hdc, 1)  # TRANSPARENT
                gdi32.SetTextColor(hdc, 0x00FFFFFF)
                old = gdi32.SelectObject(hdc, font) if font else None
                r = wt.RECT(20, 14, W - 20, H - 14)
                user32.DrawTextW(hdc, TEXT, -1, ctypes.byref(r),
                                 DT_CENTER | DT_VCENTER | DT_WORDBREAK)
                if old:
                    gdi32.SelectObject(hdc, old)
                user32.EndPaint(hwnd, ctypes.byref(ps))

        def proc(hwnd, msg, wparam, lparam):
            if msg == WM_PAINT:
                paint(hwnd)
                return 0
            if msg == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0
            if msg == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        wp = WNDPROC(proc)
        hinst = kernel32.GetModuleHandleW(None)
        wc = WNDCLASSW()
        wc.lpfnWndProc = ctypes.cast(wp, ctypes.c_void_p)
        wc.hInstance = hinst
        wc.lpszClassName = CLS
        wc.hbrBackground = blue
        if not user32.RegisterClassW(ctypes.byref(wc)):
            err = ctypes.get_last_error()
            if err not in (0, 1410):  # 1410 = class already exists
                _ready.set()
                return
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
        hwnd = user32.CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_APPWINDOW,
            CLS, "近传 NearDrop",
            WS_POPUP | WS_VISIBLE,
            int((sw - W) / 2), int(sh / 2) - H - 60, W, H,
            None, None, hinst, None,
        )
        if not hwnd:
            _ready.set()
            return
        _hwnd = hwnd
        _ok = True
        user32.ShowWindow(hwnd, 5)  # SW_SHOW
        user32.UpdateWindow(hwnd)
        _ready.set()

        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    except Exception:
        if os.environ.get("NEARDROP_SPLASH_DEBUG"):
            try:
                with open(os.path.join(os.environ.get("TEMP", "."), "neardrop_splash.log"),
                          "a", encoding="utf-8") as f:
                    f.write(traceback.format_exc() + "\n")
            except Exception:
                pass
    finally:
        _ready.set()


def show(timeout: float = 1.5):
    """在后台线程弹出提示窗，最多等 timeout 秒，失败就算了。"""
    global _thread
    try:
        _thread = threading.Thread(target=_run, name="splash", daemon=True)
        _thread.start()
        _ready.wait(timeout)
    except Exception:
        pass


def close():
    """关闭提示窗（在主线程关闭前调用）。"""
    global _hwnd
    if not _ok or not _hwnd:
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
        user32.PostMessageW(_hwnd, WM_CLOSE, 0, 0)
        _hwnd = None
    except Exception:
        pass

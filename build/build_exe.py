"""NearDrop 近传 - 打包 exe"""
import os
import sys
import shutil
import time
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

PY = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
if not os.path.exists(PY):
    PY = sys.executable


def make_icon():
    from PIL import Image, ImageDraw
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([6, 6, size - 6, size - 6], radius=58, fill=(37, 99, 235, 255))
    d.polygon([(56, 88), (104, 62), (104, 114)], fill=(255, 255, 255, 255))
    d.rectangle([100, 80, 192, 96], fill=(255, 255, 255, 255))
    d.polygon([(200, 168), (152, 142), (152, 194)], fill=(255, 255, 255, 230))
    d.rectangle([64, 160, 156, 176], fill=(255, 255, 255, 230))
    p = os.path.join(ROOT, "build", "neardrop.ico")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return p


def main():
    ico = make_icon()
    # 旧产物由 PyInstaller 的 --noconfirm 覆盖。若上一版进程还在跑，
    # CopyIcons 会报「拒绝访问」，所以这里失败后重试一次。
    old_exe = os.path.join(ROOT, "dist", "NearDrop", "NearDrop.exe")
    if os.path.exists(old_exe):
        print("提示：已存在旧产物，若打包报「拒绝访问」，先关掉正在运行的 NearDrop.exe")
    hidden = [
        "uvicorn.logging",
        "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
        "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
        "websockets", "websockets.legacy", "websockets.legacy.server",
        "pystray._win32", "PIL._tkinter_finder",
        "anyio._backends._asyncio",
    ]
    cmd = [
        PY, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onedir", "--noconsole",
        "--name", "NearDrop",
        "--icon", ico,
        "--add-data", os.path.join(ROOT, "server", "static") + ";static",
        "--distpath", os.path.join(ROOT, "dist"),
        "--workpath", os.path.join(ROOT, "build", "pyi"),
        "--specpath", os.path.join(ROOT, "build"),
    ]
    for h in hidden:
        cmd += ["--hidden-import", h]
    cmd.append("run.py")
    print(" ".join(cmd))
    for attempt in (1, 2):
        r = subprocess.run(cmd)
        if r.returncode == 0:
            break
        if attempt == 1:
            print("打包失败，5 秒后重试一次（多为杀软/残留进程占用 exe）")
            time.sleep(5)
    else:
        raise SystemExit("打包失败")

    src_dir = os.path.join(ROOT, "dist", "NearDrop")
    exe = os.path.join(src_dir, "NearDrop.exe")
    if not os.path.exists(exe):
        raise SystemExit("打包失败，未找到 " + exe)

    # 复制整个目录到交付目录（onedir 启动无需解压，秒开）
    out = os.path.join(ROOT, "交付", "近传 NearDrop")
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(src_dir, out)
    total = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(out) for f in fs
    )
    print("\nDONE:", os.path.join(out, "NearDrop.exe"), "%.0f MB" % (total / 1024 / 1024))


if __name__ == "__main__":
    main()

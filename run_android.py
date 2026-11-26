#!/usr/bin/env python3
# Windows:  python run_android.py
# macOS:    python3 run_android.py   or  ./run_android.py
"""Deploy the Android demo to a plugged-in phone. Works on Windows and macOS."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def which(name: str) -> str | None:
    hits = [shutil.which(name)]
    if IS_WIN:
        hits.extend([shutil.which(name + ".cmd"), shutil.which(name + ".exe")])
    return next((h for h in hits if h), None)


def need(name: str, hint: str) -> str:
    path = which(name)
    if not path:
        die(f"{name} is not on PATH. {hint}")
    return path


def run(args: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(a) for a in args))
    r = subprocess.run(args, cwd=str(cwd or ROOT))
    if r.returncode:
        raise SystemExit(r.returncode)


def npm() -> str:
    return need("npm", "Install Node.js from https://nodejs.org/")


def npx() -> str:
    return need("npx", "Install Node.js from https://nodejs.org/")


def stack() -> str:
    if (ROOT / "pubspec.yaml").is_file() and (ROOT / "example" / "pubspec.yaml").is_file():
        return "flutter"
    if (ROOT / "FaceRecognitionCapacitor.podspec").is_file():
        return "ionic"
    if (ROOT / "config.xml").is_file() and (ROOT / "FacePlugin").is_dir():
        return "cordova"
    if (ROOT / "face-recognition-sdk.podspec").is_file():
        return "rn"
    if (ROOT / "src" / "FaceRecognition.Net.Maui").is_dir():
        return "maui"
    die(f"unrecognized Face Recognition repo: {ROOT}")
    raise SystemExit(1)


def copy_if_missing(src: Path, dest: Path) -> bool:
    if dest.exists() or not src.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dest, symlinks=True)
    else:
        shutil.copy2(src, dest)
    print(f"copied {src} -> {dest}")
    return True


def ensure_aar(dest: Path) -> None:
    if dest.is_file():
        return
    apps = ROOT.parent
    for src in (
        apps / "Face-Recognition-LivenessDetection-Android" / "libs" / "facerecognitionsdk.aar",
    ):
        if copy_if_missing(src, dest):
            return
    die(f"missing {dest}\nPlace facerecognitionsdk.aar there.")


def adb_serial() -> str:
    adb = need("adb", "Install Android platform-tools and add them to PATH.")
    out = subprocess.check_output([adb, "devices"], text=True, errors="replace")
    serials = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            serials.append(parts[0])
    if not serials:
        die("no Android device. Plug in a phone and enable USB debugging.")
    physical = [s for s in serials if not s.startswith("emulator-")]
    chosen = (physical or serials)[0]
    print(f"Android device: {chosen}")
    return chosen


def npm_install(cwd: Path) -> None:
    if not (cwd / "node_modules").is_dir():
        run([npm(), "install"], cwd=cwd)


def flutter_android() -> None:
    flutter = need("flutter", "Install Flutter and add it to PATH.")
    run([flutter, "pub", "get"], cwd=ROOT)
    run([flutter, "pub", "get"], cwd=ROOT / "example")
    ensure_aar(ROOT / "example" / "android" / "libfacesdk" / "facerecognitionsdk.aar")
    device = adb_serial()
    raw = subprocess.check_output([flutter, "devices", "--machine"], text=True, errors="replace")
    try:
        for d in json.loads(raw):
            if str(d.get("targetPlatform") or "").startswith("android"):
                device = str(d.get("id") or device)
                break
    except json.JSONDecodeError:
        pass
    run([flutter, "run", "-d", device], cwd=ROOT / "example")


def ionic_android() -> None:
    npm_install(ROOT)
    run([npm(), "run", "build"], cwd=ROOT)
    example = ROOT / "example"
    npm_install(example)
    run([npm(), "run", "build"], cwd=example)
    ensure_aar(example / "android" / "libfacesdk" / "facerecognitionsdk.aar")
    target = adb_serial()
    run([npx(), "cap", "sync", "android"], cwd=example)
    run([npx(), "cap", "run", "android", "--no-sync", "--target", target], cwd=example)


def cordova_android() -> None:
    npm_install(ROOT)
    ensure_aar(ROOT / "FacePlugin" / "src" / "android" / "facerecognitionsdk.aar")
    run([npm(), "run", "android"], cwd=ROOT)


def rn_android() -> None:
    example = ROOT / "example"
    npm_install(ROOT)
    npm_install(example)
    ensure_aar(example / "android" / "libfacesdk" / "facerecognitionsdk.aar")
    ensure_aar(ROOT / "android" / "libs" / "facerecognitionsdk.aar")
    serial = adb_serial()
    run([npx(), "react-native", "run-android", "--deviceId", serial], cwd=example)


def maui_android() -> None:
    dotnet = need("dotnet", "Install the .NET 8 SDK.")
    proj = ROOT / "src" / "FaceRecognition.Net.Maui" / "FaceRecognition.Net.Maui.csproj"
    ensure_aar(proj.parent / "Platforms" / "Android" / "libs" / "facerecognitionsdk.aar")
    adb_serial()
    run([dotnet, "build", str(proj), "-f", "net8.0-android", "-t:Run"], cwd=ROOT)


def main() -> None:
    kind = stack()
    print(f"{ROOT.name}: android ({kind}, {'windows' if IS_WIN else sys.platform})")
    {
        "flutter": flutter_android,
        "ionic": ionic_android,
        "cordova": cordova_android,
        "rn": rn_android,
        "maui": maui_android,
    }[kind]()


if __name__ == "__main__":
    main()

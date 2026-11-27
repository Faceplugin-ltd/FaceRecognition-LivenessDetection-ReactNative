#!/usr/bin/env python3
"""Download FacePlugin native runtimes from GitHub Releases.

Each public App repo vendors a copy of this module so a solo clone can fetch
binaries without sibling monorepo folders. Sibling copy is tried first when
present (org convenience only).
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REC_ANDROID_REPO = "FaceRecognition-LivenessDetection-Android"
REC_IOS_REPO = "FaceRecognition-LivenessDetection-iOS"
LIV_ANDROID_REPO = "FaceLivenessDetection-Android"
LIV_IOS_REPO = "FaceLivenessDetection-iOS"

AAR_NAME = "facerecognitionsdk.aar"
AAR_URL = (
    f"https://github.com/Faceplugin-ltd/{REC_ANDROID_REPO}"
    f"/releases/download/latest/{AAR_NAME}"
)
AAR_PAGE = f"https://github.com/Faceplugin-ltd/{REC_ANDROID_REPO}/releases/tag/latest"

RUNTIME_ZIP_URL = (
    f"https://github.com/Faceplugin-ltd/{REC_IOS_REPO}"
    f"/releases/download/latest/runtime.zip"
)
RUNTIME_PAGE = f"https://github.com/Faceplugin-ltd/{REC_IOS_REPO}/releases/tag/latest"

BRIDGE_ZIP_URL = (
    f"https://github.com/Faceplugin-ltd/{LIV_IOS_REPO}"
    f"/releases/download/latest/bridge.zip"
)
BRIDGE_PAGE = f"https://github.com/Faceplugin-ltd/{LIV_IOS_REPO}/releases/tag/latest"

LIVENESS_LIBS_URL = (
    f"https://github.com/Faceplugin-ltd/{LIV_ANDROID_REPO}"
    f"/releases/download/latest/liveness-libs.zip"
)
LIVENESS_LIBS_PAGE = (
    f"https://github.com/Faceplugin-ltd/{LIV_ANDROID_REPO}/releases/latest"
)

ENGINE_IOS_NAMES = (
    "facerecognitionsdk.framework",
    "FacePluginSDK.xcframework",
    "FacePlugin.xcframework",
    "FaceDetect.xcframework",
)
BRIDGE_IOS_NAMES = (
    "FaceLivenessBridge.xcframework",
    "FaceLivenessKit.xcframework",
)
LIVENESS_AAR_NAMES = (
    "face-liveness-kit.aar",
    "face-liveness-active.aar",
)

# Org-folder siblings (optional shortcut when developing inside private_develop_org).
SIBLING_AAR = (
    "Face-Recognition-LivenessDetection-Android/libs/facerecognitionsdk.aar",
    "Face-LivenessDetection-Android/libs/facerecognitionsdk.aar",
)
SIBLING_IOS = (
    "Face-Recognition-LivenessDetection-iOS",
    "Face-LivenessDetection-iOS",
)


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _download(url: str, dest: Path, page: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=300) as resp, dest.open("wb") as out:
            shutil.copyfileobj(resp, out)
    except (urllib.error.URLError, OSError) as exc:
        if dest.is_file():
            dest.unlink(missing_ok=True)
        _die(f"download failed: {exc}\nGet the file from {page}")


def _copy_if_missing(src: Path, dest: Path) -> bool:
    if dest.exists() or not src.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dest, symlinks=True)
    else:
        shutil.copy2(src, dest)
    print(f"copied {src} -> {dest}")
    return True


def _extract_zip_members(zip_path: Path, dest: Path, names: tuple[str, ...]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = zf.namelist()
        for name in names:
            # Prefer top-level entries; skip __MACOSX.
            prefixes = [n for n in members if n.startswith(name) and "__MACOSX" not in n]
            if not prefixes:
                _die(f"{zip_path.name} is missing {name}\nGet a fresh archive from the Releases page.")
            for member in prefixes:
                zf.extract(member, dest)
    # zip may extract into dest/name; already correct when name is top-level.


def _slice_xcframeworks(dest: Path) -> None:
    """Also place ios-arm64 *.framework next to xcframeworks (Cordova / some pods)."""
    for xc, preferred in (
        ("FacePluginSDK.xcframework", "FacePluginSDK.framework"),
        ("FacePlugin.xcframework", "FacePPlugin.framework"),
        ("FaceDetect.xcframework", "FaceDetect.framework"),
    ):
        slice_fw = dest / xc / "ios-arm64" / preferred
        if slice_fw.is_dir():
            _copy_if_missing(slice_fw, dest / preferred)
            continue
        slice_dir = dest / xc / "ios-arm64"
        if not slice_dir.is_dir():
            continue
        fws = list(slice_dir.glob("*.framework"))
        if fws:
            _copy_if_missing(fws[0], dest / fws[0].name)


def ensure_engine_aar(root: Path, dest: Path) -> None:
    if dest.is_file() and dest.stat().st_size > 0:
        return
    apps = root.parent
    for rel in SIBLING_AAR:
        if _copy_if_missing(apps / rel, dest):
            return
    with tempfile.TemporaryDirectory(prefix="fp-aar-") as tmp:
        tmp_aar = Path(tmp) / AAR_NAME
        _download(AAR_URL, tmp_aar, AAR_PAGE)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tmp_aar, dest)
        print(f"staged {dest}")


def ensure_liveness_libs(root: Path, libs_dir: Path) -> None:
    """Stage face-liveness-kit.aar and face-liveness-active.aar next to the engine."""
    libs_dir.mkdir(parents=True, exist_ok=True)
    missing = [n for n in LIVENESS_AAR_NAMES if not (libs_dir / n).is_file()]
    if not missing:
        return
    apps = root.parent
    native = apps / "Face-LivenessDetection-Android"
    for name in LIVENESS_AAR_NAMES:
        stem = name.replace(".aar", "")
        built = native / stem / "build" / "outputs" / "aar" / f"{stem}-release.aar"
        if (native / "libs" / name).is_file():
            _copy_if_missing(native / "libs" / name, libs_dir / name)
        elif built.is_file():
            _copy_if_missing(built, libs_dir / name)
    missing = [n for n in LIVENESS_AAR_NAMES if not (libs_dir / n).is_file()]
    if not missing:
        return
    with tempfile.TemporaryDirectory(prefix="fp-liv-") as tmp:
        zpath = Path(tmp) / "liveness-libs.zip"
        _download(LIVENESS_LIBS_URL, zpath, LIVENESS_LIBS_PAGE)
        with zipfile.ZipFile(zpath) as zf:
            zf.extractall(tmp)
        for name in LIVENESS_AAR_NAMES:
            src = Path(tmp) / name
            if not src.is_file():
                _die(
                    f"liveness-libs.zip missing {name}\n"
                    f"Download from {LIVENESS_LIBS_PAGE}"
                )
            shutil.copy2(src, libs_dir / name)
            print(f"staged {libs_dir / name}")


def ensure_ios_engine(root: Path, dest: Path, *, with_bridge: bool = False) -> None:
    need = list(ENGINE_IOS_NAMES)
    if with_bridge:
        need.extend(BRIDGE_IOS_NAMES)
    if all((dest / n).exists() for n in need):
        return

    apps = root.parent
    for sibling_name in SIBLING_IOS:
        sibling = apps / sibling_name
        if all((sibling / n).exists() for n in ENGINE_IOS_NAMES):
            dest.mkdir(parents=True, exist_ok=True)
            for n in ENGINE_IOS_NAMES:
                _copy_if_missing(sibling / n, dest / n)
            _slice_xcframeworks(dest)
            break

    if with_bridge and not all((dest / n).exists() for n in BRIDGE_IOS_NAMES):
        # Bridge only ships on Liveness iOS release / native checkout build output.
        liv = apps / "Face-LivenessDetection-iOS"
        for n in BRIDGE_IOS_NAMES:
            for cand in (
                liv / n,
                liv / "build" / "xcframeworks" / n,
            ):
                if _copy_if_missing(cand, dest / n):
                    break

    if all((dest / n).exists() for n in need):
        return

    with tempfile.TemporaryDirectory(prefix="fp-ios-") as tmp:
        tmp_path = Path(tmp)
        if not all((dest / n).exists() for n in ENGINE_IOS_NAMES):
            zpath = tmp_path / "runtime.zip"
            _download(RUNTIME_ZIP_URL, zpath, RUNTIME_PAGE)
            extract_root = tmp_path / "runtime"
            extract_root.mkdir()
            with zipfile.ZipFile(zpath) as zf:
                for member in zf.namelist():
                    if member.startswith("__MACOSX"):
                        continue
                    zf.extract(member, extract_root)
            dest.mkdir(parents=True, exist_ok=True)
            for n in ENGINE_IOS_NAMES:
                src = extract_root / n
                if not src.exists():
                    _die(f"runtime.zip missing {n}\nGet it from {RUNTIME_PAGE}")
                if src.is_dir():
                    if (dest / n).exists():
                        shutil.rmtree(dest / n)
                    shutil.copytree(src, dest / n, symlinks=True)
                else:
                    shutil.copy2(src, dest / n)
                print(f"staged {dest / n}")
            _slice_xcframeworks(dest)

        if with_bridge and not all((dest / n).exists() for n in BRIDGE_IOS_NAMES):
            zpath = tmp_path / "bridge.zip"
            _download(BRIDGE_ZIP_URL, zpath, BRIDGE_PAGE)
            extract_root = tmp_path / "bridge"
            extract_root.mkdir()
            with zipfile.ZipFile(zpath) as zf:
                for member in zf.namelist():
                    if member.startswith("__MACOSX"):
                        continue
                    zf.extract(member, extract_root)
            for n in BRIDGE_IOS_NAMES:
                src = extract_root / n
                if not src.exists():
                    _die(f"bridge.zip missing {n}\nGet it from {BRIDGE_PAGE}")
                if (dest / n).exists():
                    shutil.rmtree(dest / n)
                shutil.copytree(src, dest / n, symlinks=True)
                print(f"staged {dest / n}")

    missing = [n for n in need if not (dest / n).exists()]
    if missing:
        _die(
            "missing iOS runtimes: "
            + ", ".join(missing)
            + f"\nEngine: {RUNTIME_PAGE}"
            + (f"\nBridge: {BRIDGE_PAGE}" if with_bridge else "")
        )

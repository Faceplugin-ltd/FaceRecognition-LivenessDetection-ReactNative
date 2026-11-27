#!/usr/bin/env python3
"""Fetch iOS frameworks if missing, then run the React Native iOS example (macOS only).

Mirrors the README: stage runtimes, yarn install, embed main.jsbundle (gitignored;
Xcode Copy Bundle Resources needs it), pod install, then yarn example ios.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"
FW = ROOT / "ios" / "Frameworks"
BUNDLE = ROOT / "example" / "ios" / "FaceRecognitionSdkExample" / "main.jsbundle"


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


def yarn_cmd() -> list[str]:
    yarn_js = ROOT / ".yarn" / "releases" / "yarn-3.6.1.cjs"
    if yarn_js.is_file():
        return [need("node", "Install Node.js from https://nodejs.org/"), str(yarn_js)]
    return [need("yarn", "Enable Yarn (corepack enable) or install Yarn 3.")]


def ensure_main_jsbundle() -> None:
    """Xcode lists FaceRecognitionSdkExample/main.jsbundle in Resources; clones lack it."""
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    print(f"bundling JS -> {BUNDLE.relative_to(ROOT)}")
    run(
        [
            *yarn_cmd(),
            "example",
            "react-native",
            "bundle",
            "--platform",
            "ios",
            "--dev",
            "true",
            "--entry-file",
            "index.js",
            "--bundle-output",
            str(BUNDLE),
            "--assets-dest",
            str(ROOT / "example" / "ios"),
        ]
    )
    if not BUNDLE.is_file() or BUNDLE.stat().st_size == 0:
        die(f"failed to create {BUNDLE}")


def main() -> None:
    import fp_releases

    if sys.platform != "darwin":
        die("iOS builds need macOS and Xcode. Use python run_android.py on this machine.")
    print(f"{ROOT.name}: ios (react-native)")
    fp_releases.ensure_ios_engine(ROOT, FW, with_bridge=False)
    run([*yarn_cmd(), "install"])
    ensure_main_jsbundle()
    ios = ROOT / "example" / "ios"
    if which("pod") and (ios / "Podfile").is_file():
        run(["pod", "install"], cwd=ios)
    run([*yarn_cmd(), "example", "ios"])


if __name__ == "__main__":
    main()

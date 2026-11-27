#!/usr/bin/env python3
"""Fetch facerecognitionsdk.aar if missing, then run the React Native Android example.

Mirrors the README manual steps: fetch missing native binaries, then the
standard yarn / React Native commands for this repo.
"""
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


def yarn_cmd() -> list[str]:
    yarn_js = ROOT / ".yarn" / "releases" / "yarn-3.6.1.cjs"
    if yarn_js.is_file():
        return [need("node", "Install Node.js from https://nodejs.org/"), str(yarn_js)]
    return [need("yarn", "Enable Yarn (corepack enable) or install Yarn 3.")]


def yarn_install() -> None:
    """Yarn workspace install at the repo root (see package.json packageManager)."""
    run([*yarn_cmd(), "install"])


AAR = ROOT / "example" / "android" / "libfacesdk" / "facerecognitionsdk.aar"


def main() -> None:
    import fp_releases

    print(f"{ROOT.name}: android (react-native)")
    fp_releases.ensure_engine_aar(ROOT, AAR)
    yarn_install()
    run([*yarn_cmd(), "example", "android"])


if __name__ == "__main__":
    main()

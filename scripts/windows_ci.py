#!/usr/bin/env python3
"""Run independent CI suites with native processes and retained failure logs.

Does not install dependencies, contact OXR/models, or operate Zotero.
The workflow installs its pinned test dependencies in the disposable runner.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "windows-ci"
REPORTS = OUTPUT / "reports"


def run_logged(command, name):
    log = REPORTS / (name + ".log")
    print("Running: " + name, flush=True)
    with log.open("wb") as handle:
        result = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
    print("Exit code: {} | {}".format(result.returncode, log.relative_to(ROOT)), flush=True)
    if result.returncode:
        print(log.read_text(encoding="utf-8", errors="replace")[-16000:], flush=True)
        raise subprocess.CalledProcessError(result.returncode, command)


def javascript():
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required")
    run_logged([node, "--version"], "node-version")
    for directory in ("plugin", "tests"):
        for path in sorted((ROOT / directory).rglob("*.js")):
            # A syntax failure must also fail the suite, before running tests.
            run_logged([node, "--check", str(path)], "syntax-" + path.relative_to(ROOT).as_posix().replace("/", "_"))
    tests = sorted(str(path) for path in (ROOT / "tests").glob("*.test.js"))
    if not tests:
        raise RuntimeError("No JavaScript tests discovered")
    run_logged([node, "--test", "--test-reporter=junit",
                "--test-reporter-destination=" + str(REPORTS / "javascript-junit.xml"), *tests], "javascript")


def python_tests():
    # Always run the complete PDF/dependency suite, even if the caller normally
    # uses progress-only mode. No test failures are converted into skips.
    os.environ["SPT_TEST_FULLTEXT_PROGRESS_ONLY"] = "0"
    run_logged([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests",
                "-p", "fulltext_worker_test.py", "-v"], "python")


def package():
    run_logged([sys.executable, "-B", "scripts/validate_static.py"], "static")
    manifest = json.loads((ROOT / "plugin/manifest.json").read_text(encoding="utf-8"))
    target = OUTPUT / "packages"
    command = [sys.executable, "-B", "scripts/build_xpi.py", "plugin", "--output", str(target),
               "--slug", "smart-paper-translator"]
    run_logged(command, "build-first")
    archive = target / ("smart-paper-translator-" + manifest["version"] + ".xpi")
    first = hashlib.sha256(archive.read_bytes()).hexdigest()
    run_logged(command, "build-second")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != first:
        raise RuntimeError("XPI build is not reproducible")
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        expected = {path.relative_to(ROOT / "plugin").as_posix()
                    for path in (ROOT / "plugin").rglob("*") if path.is_file()
                    and "__pycache__" not in path.parts}
        if bundle.testzip() is not None or len(names) != len(set(names)) or set(names) != expected:
            raise RuntimeError("Invalid XPI contents or CRC")
        if not {"manifest.json", "bootstrap.js"}.issubset(names):
            raise RuntimeError("XPI runtime entry points missing")
        if json.loads(bundle.read("manifest.json")) != manifest:
            raise RuntimeError("XPI manifest mismatch")
    (REPORTS / "xpi-members.txt").write_text("\n".join(names) + "\n", encoding="utf-8")
    (target / "SHA256SUMS").write_text(first + "  " + archive.name + "\n", encoding="ascii")
    print("Validated {} runtime files; SHA256 {}".format(len(names), first), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=("javascript", "python", "package"))
    args = parser.parse_args()
    REPORTS.mkdir(parents=True, exist_ok=True)
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["NODE_DISABLE_COMPILE_CACHE"] = "1"
    environment = {"suite": args.suite, "python": sys.version, "platform": platform.platform(),
                   "commit": os.environ.get("GITHUB_SHA", "local"),
                   "runnerImage": os.environ.get("ImageVersion", "local")}
    (REPORTS / (args.suite + "-environment.json")).write_text(json.dumps(environment, indent=2), encoding="utf-8")
    try:
        {"javascript": javascript, "python": python_tests, "package": package}[args.suite]()
    except subprocess.CalledProcessError as error:
        return error.returncode if 1 <= error.returncode <= 125 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

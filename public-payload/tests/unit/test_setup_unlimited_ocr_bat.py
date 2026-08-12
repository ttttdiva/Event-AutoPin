from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "nt", reason="Windows BAT launcher contract")
def test_uv_failure_falls_back_to_python(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    marker = tmp_path / "python-called.txt"
    (fake_bin / "uv.cmd").write_text("@echo off\r\nexit /b 9\r\n", encoding="ascii")
    (fake_bin / "python.cmd").write_text(
        f'@echo off\r\necho %* > "{marker}"\r\nexit /b 0\r\n',
        encoding="ascii",
    )
    repo = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env.pop("UNLIMITED_OCR_PYTHON", None)
    env["PATH"] = str(fake_bin) + os.pathsep + str(Path(os.environ["SystemRoot"]) / "System32")

    completed = subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(repo / "scripts" / "setup_unlimited_ocr.bat"), "--doctor"],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 0
    assert marker.exists()
    assert "scripts\\setup_unlimited_ocr.py --doctor" in marker.read_text(encoding="utf-8")
    assert "python/py" in completed.stdout

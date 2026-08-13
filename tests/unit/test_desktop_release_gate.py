import base64
import json
import os
import shutil
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_desktop_release_gate.ps1"


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def write_desktop(root: Path, version: str, source: str = "export const value = 1;\n") -> None:
    files = {
        "desktop-app/package.json": json.dumps({"version": version}),
        "desktop-app/src-tauri/tauri.conf.json": json.dumps({"package": {"version": version}}),
        "desktop-app/src-tauri/Cargo.toml": f'[package]\nname = "fixture"\nversion = "{version}"\n',
        "desktop-app/src/main.ts": source,
    }
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def commit(root: Path, message: str = "fixture") -> None:
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message)


def repositories(tmp_path: Path, version: str = "1.2.3") -> tuple[Path, Path]:
    private, public = tmp_path / "private", tmp_path / "public"
    for root in (private, public):
        root.mkdir()
        git(root, "init", "--initial-branch=main")
        write_desktop(root, version)
    git(public, "remote", "add", "origin", "https://github.com/test/public.git")
    manifest = private / "scripts" / "public-sync-manifest.txt"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        "\n".join(
            [
                "desktop-app/package.json",
                "desktop-app/src-tauri/tauri.conf.json",
                "desktop-app/src-tauri/Cargo.toml",
                "desktop-app/src/main.ts",
                "scripts/public-sync-manifest.txt",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    latest = {
        "desktop": {
            "version": version,
            "url": f"https://github.com/test/public/releases/download/desktop-v{version}/EventAutoPin.exe",
        }
    }
    (public / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
    commit(private)
    commit(public)
    return private, public


def fake_gh(tmp_path: Path, asset: str = "EventAutoPin.exe") -> Path:
    tools = tmp_path / "tools"
    tools.mkdir(exist_ok=True)
    (tools / "gh.cmd").write_text(f"@echo off\necho {asset}\n", encoding="ascii")
    return tools


def run(
    private: Path,
    public: Path,
    tmp_path: Path,
    *,
    fail: bool = True,
    asset: str = "EventAutoPin.exe",
    base: str = "HEAD",
):
    command = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(SCRIPT),
        "-SourceRoot",
        str(private),
        "-PublicRoot",
        str(public),
        "-PublicRepository",
        "test/public",
        "-Base",
        base,
        "-Target",
        "HEAD",
    ]
    if fail:
        command.append("-FailOnMismatch")
    env = os.environ.copy()
    env["PATH"] = str(fake_gh(tmp_path, asset)) + os.pathsep + env["PATH"]
    return subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, env=env)


def test_strict_gate_accepts_matching_source_versions_latest_and_asset(tmp_path: Path) -> None:
    private, public = repositories(tmp_path)
    result = run(private, public, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "MISMATCH_COUNT=0" in result.stdout
    assert "PUBLIC_SOURCE_MISMATCH=False" in result.stdout


def test_strict_gate_rejects_source_changed_without_version_or_release_metadata(tmp_path: Path) -> None:
    private, public = repositories(tmp_path)
    write_desktop(private, "1.2.3", "export const value = 2;\n")
    commit(private, "desktop changed")

    result = run(private, public, tmp_path, base="HEAD^")

    assert result.returncode == 1
    assert "PUBLIC_SOURCE_MISMATCH=True" in result.stdout
    assert "private/public desktop source mismatch" in result.stdout
    assert "desktop source changed without a version increase" in result.stdout


def test_strict_gate_rejects_internal_version_latest_url_and_asset_mismatches(tmp_path: Path) -> None:
    private, public = repositories(tmp_path)
    (private / "desktop-app" / "src-tauri" / "Cargo.toml").write_text(
        '[package]\nname="fixture"\nversion="9.9.9"\n', encoding="utf-8"
    )
    commit(private, "bad versions")
    latest = json.loads((public / "latest.json").read_text(encoding="utf-8"))
    latest["desktop"]["url"] = "https://example.invalid/wrong.exe"
    (public / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
    commit(public, "bad latest")

    result = run(private, public, tmp_path, asset="wrong.exe", base="HEAD^")

    assert result.returncode == 1
    assert "private desktop versions disagree" in result.stdout
    assert "latest.json desktop URL mismatch" in result.stdout
    assert "missing EventAutoPin.exe" in result.stdout

import os
import json
import re
import shutil
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "sync_public_repo.ps1"
REMOTE = "https://github.com/ttttdiva/autocircle.git"


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def commit_all(root: Path) -> None:
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")


def source_repo(tmp_path: Path, secret: bool = False) -> Path:
    root = tmp_path / "source"
    (root / "src").mkdir(parents=True)
    fake_token = "gh" + "p_123456789012345678901234567890"
    content = "value='" + (fake_token if secret else "safe") + "'\n"
    (root / "src" / "app.py").write_text(content, encoding="utf-8")
    (root / "scripts").mkdir()
    (root / "scripts" / "public-sync-manifest.txt").write_text("src/app.py\n", encoding="utf-8")
    (root / "untracked.py").write_text("must not publish", encoding="utf-8")
    git(root, "init")
    git(root, "add", "src/app.py", "scripts/public-sync-manifest.txt")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
    return root


def destination_repo(tmp_path: Path, remote: str = REMOTE) -> Path:
    root = tmp_path / "public"
    root.mkdir()
    git(root, "init")
    git(root, "remote", "add", "origin", remote)
    (root / ".github").mkdir()
    (root / ".github" / "workflows.yml").write_text("keep", encoding="utf-8")
    (root / "release").mkdir()
    (root / "release" / "asset.txt").write_text("keep", encoding="utf-8")
    for name in ("README.md", "LICENSE", "latest.json"):
        (root / name).write_text("keep", encoding="utf-8")
    commit_all(root)
    return root


def run(source: Path, destination: Path, tmp_path: Path, apply: bool = False, visibility: str = "public", corrupt: bool = False):
    tools = tmp_path / "tools"
    tools.mkdir(exist_ok=True)
    (tools / "gh.cmd").write_text(f"@echo off\necho {visibility}\n", encoding="ascii")
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
               "-SourceRoot", str(source), "-DestinationRoot", str(destination)]
    if apply:
        command.append("-Apply")
    env = os.environ.copy()
    env["PATH"] = str(tools) + os.pathsep + env["PATH"]
    if corrupt:
        env["CAICO_SYNC_TEST_CORRUPT_AFTER_SWAP"] = "1"
    return subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, env=env)


def test_dry_run_uses_only_exact_committed_manifest(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    result = run(source, destination, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "[candidates] 1" in result.stdout and "INCLUDE src/app.py" in result.stdout
    assert "all uncommitted" in result.stdout and "untracked.py" not in result.stdout
    assert "[scan] 0 findings" in result.stdout and "dry-run" in result.stdout
    assert not (destination / "public-payload").exists()


def test_secret_fails_closed(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path, secret=True), destination_repo(tmp_path)
    result = run(source, destination, tmp_path, apply=True)
    assert result.returncode != 0 and "BLOCK src/app.py" in result.stdout
    assert not (destination / "public-payload").exists()


def test_apply_only_replaces_payload_and_preserves_destination_owned_files(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    result = run(source, destination, tmp_path, apply=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "public-payload" / "src" / "app.py").exists()
    for path in ("README.md", "LICENSE", "latest.json", ".github/workflows.yml", "release/asset.txt"):
        assert (destination / path).read_text(encoding="utf-8") == "keep"
    assert (destination / ".git").is_dir()


def test_hash_failure_after_swap_rolls_back_old_payload(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    old = destination / "public-payload" / "old.txt"
    old.parent.mkdir()
    old.write_text("old", encoding="utf-8")
    commit_all(destination)
    result = run(source, destination, tmp_path, apply=True, corrupt=True)
    assert result.returncode != 0 and "hash verification failed" in result.stderr
    assert old.read_text(encoding="utf-8") == "old"
    assert not (destination / "public-payload" / "src" / "app.py").exists()


def test_rejects_wrong_remote_dirty_private_and_nested_destinations(tmp_path: Path) -> None:
    source = source_repo(tmp_path)
    wrong = destination_repo(tmp_path, "https://github.com/example/wrong.git")
    assert run(source, wrong, tmp_path).returncode != 0

    # Retarget, then prove dirty and non-public gates independently.
    git(wrong, "remote", "set-url", "origin", REMOTE)
    (wrong / "dirty.txt").write_text("dirty", encoding="utf-8")
    assert "not clean" in run(source, wrong, tmp_path).stderr
    (wrong / "dirty.txt").unlink()
    assert "not confirmed public" in run(source, wrong, tmp_path, visibility="private").stderr

    nested = source / "nested-public"
    nested.mkdir()
    git(nested, "init")
    result = run(source, nested, tmp_path)
    assert result.returncode != 0 and "non-nested" in result.stderr


def test_manifest_allows_dotfiles_but_rejects_traversal(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    (source / ".gitignore").write_text("*.tmp\n", encoding="utf-8")
    (source / "scripts" / "public-sync-manifest.txt").write_text(".gitignore\n", encoding="utf-8")
    commit_all(source)
    assert run(source, destination, tmp_path).returncode == 0
    (source / "scripts" / "public-sync-manifest.txt").write_text("../secret\n", encoding="utf-8")
    commit_all(source)
    result = run(source, destination, tmp_path)
    assert result.returncode != 0 and "Unsafe manifest path" in result.stderr


def test_repository_manifest_candidates_pass_sensitive_data_scan(tmp_path: Path) -> None:
    repository = SCRIPT.parents[1]
    manifest = repository / "scripts" / "public-sync-manifest.txt"
    paths = [
        line.strip()
        for line in manifest.read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip("\ufeff").startswith("#")
    ]
    source = tmp_path / "manifest-source"
    for relative in paths:
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repository / relative, target)
    git(source, "init")
    git(source, "add", ".")
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "manifest fixture")
    destination = destination_repo(tmp_path)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert f"[candidates] {len(paths)} committed manifest files" in result.stdout
    assert "[scan] 0 findings" in result.stdout
    package = json.loads((repository / "desktop-app" / "package.json").read_text(encoding="utf-8"))
    state_script = package["scripts"]["test:state"]
    referenced_typescript = sorted(set(re.findall(r"(?<![\w./-])(src/[\w./-]+\.ts)\b", state_script)))
    assert referenced_typescript
    for relative in referenced_typescript:
        public_path = destination / "public-payload" / "desktop-app" / relative
        assert public_path.is_file(), f"test:state dependency missing from public payload: {relative}"

import os
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "sync_public_repo.ps1"
REMOTE = "https://github.com/ttttdiva/Event-AutoPin-Publish.git"
REAL_GIT = shutil.which("git")


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def commit_all(root: Path) -> None:
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")


def destination_origin(root: Path) -> Path:
    return root.parent / f"{root.name}-origin.git"


def publish_destination_head(root: Path, branch: str = "main") -> None:
    origin = destination_origin(root)
    git(root, "push", "--force", str(origin), f"HEAD:refs/heads/{branch}")
    git(root, "fetch", str(origin), f"+refs/heads/*:refs/remotes/origin/*")


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
    origin = destination_origin(root)
    origin.mkdir()
    git(origin, "init", "--bare", "--initial-branch=main")
    git(root, "init", "--initial-branch=main")
    git(root, "remote", "add", "origin", remote)
    (root / ".github").mkdir()
    (root / ".github" / "workflows.yml").write_text("keep", encoding="utf-8")
    (root / "release").mkdir()
    (root / "release" / "asset.txt").write_text("keep", encoding="utf-8")
    for name in ("README.md", "LICENSE", "latest.json"):
        (root / name).write_text("keep", encoding="utf-8")
    commit_all(root)
    publish_destination_head(root)
    git(root, "branch", "--set-upstream-to=origin/main", "main")
    return root


def run(source: Path, destination: Path, tmp_path: Path, apply: bool = False, visibility: str = "public", corrupt: bool = False):
    tools = tmp_path / "tools"
    tools.mkdir(exist_ok=True)
    (tools / "gh.cmd").write_text(f"@echo off\necho {visibility}\n", encoding="ascii")
    local_origin = destination_origin(destination)
    git_wrapper = f'''@echo off
if /I "%~3"=="fetch" if /I "%~4"=="--prune" if /I "%~5"=="--quiet" if /I "%~6"=="origin" (
  "{REAL_GIT}" -C "%~2" fetch --prune --quiet "{local_origin}" "+refs/heads/*:refs/remotes/origin/*"
  if errorlevel 1 exit /b 1
  exit /b 0
)
if /I "%~3"=="ls-remote" if /I "%~4"=="--symref" if /I "%~5"=="origin" (
  "{REAL_GIT}" -C "%~2" ls-remote --symref "{local_origin}" HEAD
  if errorlevel 1 exit /b 1
  exit /b 0
)
"{REAL_GIT}" %*
'''
    (tools / "git.cmd").write_text(git_wrapper, encoding="ascii")
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
               "-SourceRoot", str(source), "-DestinationRoot", str(destination)]
    if apply:
        command.append("-Apply")
    env = os.environ.copy()
    env["PATH"] = str(tools) + os.pathsep + env["PATH"]
    if corrupt:
        env["EVENT_AUTOPIN_SYNC_TEST_CORRUPT_AFTER_SWAP"] = "1"
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
    publish_destination_head(destination)
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


def test_rejects_non_default_current_branch(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    git(destination, "switch", "-c", "feature")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    assert "current branch 'feature'" in result.stderr and "origin default" in result.stderr


def test_rejects_detached_head(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    git(destination, "checkout", "--detach")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    assert "HEAD is detached" in result.stderr


def test_rejects_upstream_other_than_origin_default(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    publish_destination_head(destination, "other")
    git(destination, "branch", "--set-upstream-to=origin/other", "main")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    assert "upstream 'origin/other'" in result.stderr and "origin/main" in result.stderr


def test_fetches_origin_before_rejecting_stale_head(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    updater = tmp_path / "updater"
    git(tmp_path, "clone", str(destination_origin(destination)), str(updater))
    (updater / "remote-change.txt").write_text("new", encoding="utf-8")
    commit_all(updater)
    git(updater, "push", "origin", "main")

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert "HEAD does not match fetched origin/main" in result.stderr
    fetched = subprocess.run(
        [REAL_GIT, "-C", str(destination), "show", "origin/main:remote-change.txt"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert fetched.stdout.strip() == "new"


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


@pytest.mark.parametrize(
    ("content", "finding"),
    [
        ("cache = '" + "Z:" + "\\private\\cache'\n", "Windows absolute path"),
        ("cache = '" + "C:" + "\\nk\\private\\cache'\n", "Windows absolute path"),
        ("pass" + "word = 'secret-value'\n", "credential assignment"),
        ("PASS" + "WORD=real-secret-value\n", "credential assignment"),
        ("pass" + "word=huntertwo\n", "credential assignment"),
        ("api_" + "key: real-api-secret\n", "credential assignment"),
        ("pass" + "wd: 'secret-value'\n", "credential assignment"),
        ("bear" + "er = 'secret-value'\n", "credential assignment"),
        ("sess" + "ion = 'secret-value'\n", "credential assignment"),
        ("sess" + "ion=unquoted-session-secret\n", "credential assignment"),
        ("sess" + "ion=abcdefgh\n", "credential assignment"),
        ("cook" + "ie = 'secret-value'\n", "credential assignment"),
        ("DATABASE_URL='" + "post" + "gresql://user:secret@db.invalid/app'\n", "database URL"),
    ],
)
def test_sensitive_assignments_paths_and_database_urls_fail_closed(
    tmp_path: Path, content: str, finding: str
) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    (source / "src" / "app.py").write_text(content, encoding="utf-8")
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert f"src/app.py ({finding})" in result.stdout


@pytest.mark.parametrize("content", ["password=short\n", "session=placeholder-value\n"])
def test_short_or_placeholder_unquoted_credentials_are_not_findings(tmp_path: Path, content: str) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    (source / "src" / "app.py").write_text(content, encoding="utf-8")
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "[scan] 0 findings" in result.stdout


def test_exact_hash_manifest_entry_allows_only_matching_image(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    image = b"\x89PNG\r\n\x1a\n" + b"\x00fixture"
    asset = source / "assets" / "sample.png"
    asset.parent.mkdir()
    asset.write_bytes(image)
    digest = hashlib.sha256(image).hexdigest()
    (source / "scripts" / "public-sync-manifest.txt").write_text(
        f"src/app.py\nsha256:{digest} assets/sample.png\n", encoding="utf-8"
    )
    commit_all(source)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "public-payload" / "assets" / "sample.png").read_bytes() == image


@pytest.mark.parametrize(
    ("filename", "image"),
    [
        ("icon.ico", b"\x00\x00\x01\x00fixture"),
        ("native.icns", b"icns\x00\x00\x00\x08fixture"),
        ("tauri.icns", b"\x89PNG\r\n\x1a\n\x00fixture"),
    ],
)
def test_exact_hash_manifest_supports_ico_and_reviewed_icns_signatures(
    tmp_path: Path, filename: str, image: bytes
) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    asset = source / "assets" / filename
    asset.parent.mkdir()
    asset.write_bytes(image)
    digest = hashlib.sha256(image).hexdigest()
    (source / "scripts" / "public-sync-manifest.txt").write_text(
        f"sha256:{digest} assets/{filename}\n", encoding="utf-8"
    )
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize(
    ("manifest_digest", "image", "finding"),
    [
        ("0" * 64, b"\x89PNG\r\n\x1a\n\x00fixture", "image SHA256 mismatch"),
        (hashlib.sha256(b"not-an-image").hexdigest(), b"not-an-image", "invalid image signature"),
    ],
)
def test_hash_allowlisted_image_fails_closed_on_mismatch_or_invalid_signature(
    tmp_path: Path, manifest_digest: str, image: bytes, finding: str
) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    asset = source / "assets" / "sample.png"
    asset.parent.mkdir()
    asset.write_bytes(image)
    (source / "scripts" / "public-sync-manifest.txt").write_text(
        f"sha256:{manifest_digest} assets/sample.png\n", encoding="utf-8"
    )
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert f"assets/sample.png ({finding})" in result.stdout


def test_image_without_exact_hash_manifest_entry_fails_closed(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    asset = source / "assets" / "sample.png"
    asset.parent.mkdir()
    asset.write_bytes(b"\x89PNG\r\n\x1a\n\x00fixture")
    (source / "scripts" / "public-sync-manifest.txt").write_text("assets/sample.png\n", encoding="utf-8")
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert "image missing exact SHA256 allowlist" in result.stdout


def test_repository_manifest_candidates_pass_sensitive_data_scan(tmp_path: Path) -> None:
    repository = SCRIPT.parents[1]
    manifest = repository / "scripts" / "public-sync-manifest.txt"
    entries = [
        line.strip()
        for line in manifest.read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip("\ufeff").startswith("#")
    ]
    paths = [re.sub(r"^sha256:[0-9a-fA-F]{64}\s+", "", entry) for entry in entries]
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

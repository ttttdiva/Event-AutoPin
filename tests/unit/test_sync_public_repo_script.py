import os
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "sync_public_repo.ps1"
DEPENDENCY_CHECKER = Path(__file__).resolve().parents[2] / "scripts" / "check_public_dependency_closure.py"
REMOTE = "https://github.com/ttttdiva/Event-AutoPin.git"
REAL_GIT = shutil.which("git")
MANIFEST_PATH = "scripts/public-sync-manifest.txt"


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def compact_output(value: str) -> str:
    """Ignore PowerShell's path-dependent display wrapping in error assertions."""

    return re.sub(r"\s+", "", value).casefold()


def commit_all(root: Path) -> None:
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")


def write_manifest(root: Path, entries: list[str], include_self: bool = True) -> None:
    paths = list(entries)
    checker_relative = "scripts/check_public_dependency_closure.py"
    checker = root / checker_relative
    if not checker.exists():
        checker.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEPENDENCY_CHECKER, checker)
    if checker_relative not in paths:
        paths.append(checker_relative)
    if include_self and MANIFEST_PATH not in paths:
        paths.append(MANIFEST_PATH)
    target = root / MANIFEST_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(paths) + "\n", encoding="utf-8")


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
    write_manifest(root, ["src/app.py"])
    (root / "untracked.py").write_text("must not publish", encoding="utf-8")
    git(root, "init")
    git(root, "add", "src/app.py", "scripts/public-sync-manifest.txt", "scripts/check_public_dependency_closure.py")
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


def install_legacy_payload(root: Path, files: dict[str, str]) -> None:
    payload = root / "public-payload"
    for relative, content in files.items():
        target = payload / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    write_manifest(payload, sorted(files))
    commit_all(root)
    publish_destination_head(root)


def install_root_payload(root: Path, files: dict[str, str]) -> None:
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    write_manifest(root, sorted(files))
    commit_all(root)
    publish_destination_head(root)


def run(
    source: Path,
    destination: Path,
    tmp_path: Path,
    apply: bool = False,
    visibility: str = "public",
    corrupt: bool = False,
    fail_pre_swap: bool = False,
    fail_rollback: bool = False,
):
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
    if fail_pre_swap:
        env["EVENT_AUTOPIN_SYNC_TEST_FAIL_PRE_SWAP"] = "1"
    if fail_rollback:
        env["EVENT_AUTOPIN_SYNC_TEST_FAIL_ROLLBACK"] = "1"
    return subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True, env=env)


def test_dry_run_uses_only_exact_committed_manifest(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    result = run(source, destination, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "[candidates] 3" in result.stdout and "INCLUDE src/app.py" in result.stdout
    assert "[dependency-closure] OK" in result.stdout
    assert "all uncommitted" in result.stdout and "untracked.py" not in result.stdout
    assert "[scan] 0 findings" in result.stdout and "dry-run" in result.stdout
    assert not (destination / "src" / "app.py").exists()
    assert not (destination / "public-payload").exists()


def test_dependency_closure_failure_stops_before_destination_changes(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    entry = source / "desktop-app" / "src" / "main.ts"
    entry.parent.mkdir(parents=True)
    entry.write_text('import "./missing-from-manifest";\n', encoding="utf-8")
    missing = entry.parent / "missing-from-manifest.ts"
    missing.write_text("export const missing = true;\n", encoding="utf-8")
    write_manifest(source, ["desktop-app/src/main.ts"])
    commit_all(source)
    latest_before = (destination / "latest.json").read_bytes()

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode != 0
    assert "[dependency-closure] 1 finding" in result.stdout
    assert "missing-from-manifest.ts" in result.stdout
    assert not (destination / "desktop-app").exists()
    assert (destination / "latest.json").read_bytes() == latest_before


def test_dependency_closure_executes_committed_checker_not_working_copy(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    entry = source / "desktop-app" / "src" / "main.ts"
    entry.parent.mkdir(parents=True)
    entry.write_text('import "./missing-from-manifest";\n', encoding="utf-8")
    missing = entry.parent / "missing-from-manifest.ts"
    missing.write_text("export const missing = true;\n", encoding="utf-8")
    write_manifest(source, ["desktop-app/src/main.ts"])
    commit_all(source)
    (source / "scripts" / "check_public_dependency_closure.py").write_text(
        "raise SystemExit(0)\n", encoding="utf-8"
    )
    latest_before = (destination / "latest.json").read_bytes()

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode != 0
    assert "[dependency-closure] 1 finding" in result.stdout
    assert "missing-from-manifest.ts" in result.stdout
    assert not (destination / "desktop-app").exists()
    assert (destination / "latest.json").read_bytes() == latest_before


def test_source_manifest_must_include_itself(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    write_manifest(source, ["src/app.py"], include_self=False)
    commit_all(source)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode != 0
    assert "mustincludeitself" in compact_output(result.stderr)
    assert not (destination / "src" / "app.py").exists()
    assert (destination / "latest.json").read_text(encoding="utf-8") == "keep"


def test_large_manifest_is_archived_in_safe_chunks_and_literal_paths_are_preserved(tmp_path: Path) -> None:
    source = tmp_path / "source"
    (source / "scripts").mkdir(parents=True)
    entries = []
    for index in range(300):
        relative = f"assets/group-{index:03d}/catalog-entry-{index:03d}-with-a-long-name.txt"
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"entry {index}\n", encoding="utf-8")
        entries.append(relative)
    literal = "assets/literal [brackets] name.txt"
    literal_path = source / literal
    literal_path.write_text("literal path\n", encoding="utf-8")
    entries.append(literal)
    unicode_name = "assets/日本語のカタログ.txt"
    (source / unicode_name).write_text("unicode path\n", encoding="utf-8")
    entries.append(unicode_name)
    bang_name = "assets/!literal.txt"
    (source / bang_name).write_text("bang path\n", encoding="utf-8")
    entries.append(bang_name)
    write_manifest(source, entries)
    git(source, "init")
    git(source, "add", ".")
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
    destination = destination_repo(tmp_path)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert f"[candidates] {len(entries) + 2}" in result.stdout
    assert (destination / literal).read_text(encoding="utf-8") == "literal path\n"
    assert (destination / unicode_name).read_text(encoding="utf-8") == "unicode path\n"
    assert (destination / bang_name).read_text(encoding="utf-8") == "bang path\n"
    assert (destination / entries[299]).read_text(encoding="utf-8") == "entry 299\n"


def test_secret_fails_closed(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path, secret=True), destination_repo(tmp_path)
    result = run(source, destination, tmp_path, apply=True)
    assert result.returncode != 0 and "BLOCK src/app.py" in result.stdout
    assert not (destination / "src" / "app.py").exists()


def test_apply_syncs_root_and_preserves_destination_owned_files(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    result = run(source, destination, tmp_path, apply=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "src" / "app.py").exists()
    assert not (destination / "public-payload").exists()
    for path in ("README.md", "LICENSE", "latest.json", ".github/workflows.yml", "release/asset.txt"):
        assert (destination / path).read_text(encoding="utf-8") == "keep"
    assert (destination / ".git").is_dir()


def test_apply_migrates_exact_legacy_payload_to_root_and_preserves_latest(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_legacy_payload(destination, {"old.txt": "old"})
    latest_before = (destination / "latest.json").read_bytes()

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "validated legacy public-payload" in result.stdout
    assert (destination / "src" / "app.py").read_text(encoding="utf-8") == "value='safe'\n"
    assert not (destination / "public-payload").exists()
    assert (destination / "latest.json").read_bytes() == latest_before
    assert (destination / ".git").is_dir()


def test_rejects_legacy_payload_not_matching_its_committed_manifest(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_legacy_payload(destination, {"old.txt": "old"})
    (destination / "public-payload" / "unexpected.txt").write_text("unexpected", encoding="utf-8")
    commit_all(destination)
    publish_destination_head(destination)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode != 0
    assert "legacypayload/manifestmismatch" in compact_output(result.stderr)
    assert (destination / "public-payload" / "old.txt").read_text(encoding="utf-8") == "old"


def test_hash_failure_after_install_rolls_back_legacy_payload(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_legacy_payload(destination, {"old.txt": "old"})
    old = destination / "public-payload" / "old.txt"
    result = run(source, destination, tmp_path, apply=True, corrupt=True)
    assert result.returncode != 0 and "hashverificationfailed" in compact_output(result.stderr)
    assert old.read_text(encoding="utf-8") == "old"
    assert not (destination / "public-payload" / "src" / "app.py").exists()


def test_hash_failure_after_root_update_rolls_back_previous_manifest_files(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_root_payload(destination, {"old.txt": "old"})

    result = run(source, destination, tmp_path, apply=True, corrupt=True)

    assert result.returncode != 0 and "hashverificationfailed" in compact_output(result.stderr)
    assert (destination / "old.txt").read_text(encoding="utf-8") == "old"
    assert (destination / "scripts" / "public-sync-manifest.txt").is_file()
    assert not (destination / "src" / "app.py").exists()
    assert not list(destination.glob(".event-autopin-sync.*"))


def test_rollback_failure_retains_backup_and_reports_its_path(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_root_payload(destination, {"old.txt": "old"})

    result = run(source, destination, tmp_path, apply=True, corrupt=True, fail_rollback=True)

    assert result.returncode != 0
    assert "rollbackfailed:testrollbackfailure" in compact_output(result.stderr)
    backups = list(destination.glob(".event-autopin-sync.backup-*"))
    assert len(backups) == 1
    assert str(backups[0]) in re.sub(r"\s+", "", result.stderr)
    assert (backups[0] / "root" / "old.txt").read_text(encoding="utf-8") == "old"
    assert (backups[0] / "root" / MANIFEST_PATH).is_file()


def test_pre_swap_failure_preserves_legacy_payload(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    install_legacy_payload(destination, {"old.txt": "old"})
    old = destination / "public-payload" / "old.txt"
    result = run(source, destination, tmp_path, apply=True, fail_pre_swap=True)
    assert result.returncode != 0 and "testpre-swapfailure" in compact_output(result.stderr)
    assert old.read_text(encoding="utf-8") == "old"
    assert not (destination / "public-payload" / "src" / "app.py").exists()
    assert not list(destination.glob(".event-autopin-sync.*"))


def test_rejects_mismatched_push_url(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    git(destination, "remote", "set-url", "--push", "origin", "https://github.com/example/push.git")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    assert "pushurlmismatch" in compact_output(result.stderr)


def test_rejects_wrong_remote_dirty_private_and_nested_destinations(tmp_path: Path) -> None:
    source = source_repo(tmp_path)
    wrong = destination_repo(tmp_path, "https://github.com/example/wrong.git")
    assert run(source, wrong, tmp_path).returncode != 0

    # Retarget, then prove dirty and non-public gates independently.
    git(wrong, "remote", "set-url", "origin", REMOTE)
    (wrong / "dirty.txt").write_text("dirty", encoding="utf-8")
    assert "notclean" in compact_output(run(source, wrong, tmp_path).stderr)
    (wrong / "dirty.txt").unlink()
    assert "notconfirmedpublic" in compact_output(
        run(source, wrong, tmp_path, visibility="private").stderr
    )

    nested = source / "nested-public"
    nested.mkdir()
    git(nested, "init")
    result = run(source, nested, tmp_path)
    assert result.returncode != 0 and "non-nested" in compact_output(result.stderr)


def test_rejects_non_default_current_branch(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    git(destination, "switch", "-c", "feature")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    compact_error = compact_output(result.stderr)
    assert "currentbranch'feature'" in compact_error and "origindefault" in compact_error


def test_rejects_detached_head(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    git(destination, "checkout", "--detach")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    assert "headisdetached" in compact_output(result.stderr)


def test_rejects_upstream_other_than_origin_default(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    publish_destination_head(destination, "other")
    git(destination, "branch", "--set-upstream-to=origin/other", "main")
    result = run(source, destination, tmp_path)
    assert result.returncode != 0
    compact_error = compact_output(result.stderr)
    assert "upstream'origin/other'" in compact_error and "origin/main" in compact_error


def test_fetches_origin_before_rejecting_stale_head(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    updater = tmp_path / "updater"
    git(tmp_path, "clone", str(destination_origin(destination)), str(updater))
    (updater / "remote-change.txt").write_text("new", encoding="utf-8")
    commit_all(updater)
    git(updater, "push", "origin", "main")

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert "headdoesnotmatchfetchedorigin/main" in compact_output(result.stderr)
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
    write_manifest(source, [".gitignore"])
    commit_all(source)
    assert run(source, destination, tmp_path).returncode == 0
    write_manifest(source, ["../secret"])
    commit_all(source)
    result = run(source, destination, tmp_path)
    assert result.returncode != 0 and "unsafemanifestpath" in compact_output(result.stderr)


@pytest.mark.parametrize("protected", ["latest.json", ".git/config", ".github/workflow.yml", "release/app.exe"])
def test_manifest_cannot_manage_destination_protected_paths(tmp_path: Path, protected: str) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    if not protected.startswith(".git/"):
        target = source / protected
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("must not publish", encoding="utf-8")
    write_manifest(source, [protected])
    commit_all(source)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode != 0
    assert "protectedrootpath" in compact_output(result.stderr)
    assert (destination / "latest.json").read_text(encoding="utf-8") == "keep"


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
    write_manifest(source, ["src/app.py", f"sha256:{digest} assets/sample.png"])
    commit_all(source)

    result = run(source, destination, tmp_path, apply=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (destination / "assets" / "sample.png").read_bytes() == image


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
    write_manifest(source, [f"sha256:{digest} assets/{filename}"])
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
    write_manifest(source, [f"sha256:{manifest_digest} assets/sample.png"])
    commit_all(source)

    result = run(source, destination, tmp_path)

    assert result.returncode != 0
    assert f"assets/sample.png ({finding})" in result.stdout


def test_image_without_exact_hash_manifest_entry_fails_closed(tmp_path: Path) -> None:
    source, destination = source_repo(tmp_path), destination_repo(tmp_path)
    asset = source / "assets" / "sample.png"
    asset.parent.mkdir()
    asset.write_bytes(b"\x89PNG\r\n\x1a\n\x00fixture")
    write_manifest(source, ["assets/sample.png"])
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
        public_path = destination / "desktop-app" / relative
        assert public_path.is_file(), f"test:state dependency missing from public root: {relative}"

import subprocess
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_public_dependency_closure.py"
MANIFEST = "scripts/public-sync-manifest.txt"


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def commit_fixture(root: Path, files: dict[str, str], manifest: list[str]) -> None:
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    manifest_path = root / MANIFEST
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text("\n".join([MANIFEST, *manifest]) + "\n", encoding="utf-8")
    git(root, "init", "--initial-branch=main")
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")


def run(root: Path):
    return subprocess.run(
        ["python", str(SCRIPT), "--repository", str(root), "--revision", "HEAD"],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )


def test_repository_manifest_includes_python_runtime_dependencies() -> None:
    repository = SCRIPT.parents[1]
    manifest = {
        line.strip()
        for line in (repository / MANIFEST).read_text(encoding="utf-8-sig").splitlines()
        if line.strip() and not line.lstrip("\ufeff").startswith("#")
    }

    assert {
        "src/space_locator/catalog_geometry_assignment.py",
        "src/utils/atomic_json.py",
    } <= manifest


def test_accepts_recursive_alias_relative_export_and_app_plugin_closure(tmp_path: Path) -> None:
    files = {
        "desktop-app/src/main.ts": 'import "./styles.css"; export { value } from "./nested";\n',
        "desktop-app/src/nested.ts": "export const value = 1;\n",
        "desktop-app/src/styles.css": "body {}\n",
        "shopping-app/app.json": '{"expo":{"plugins":[["./plugins/local",{}],"expo-router"]}}',
        "shopping-app/plugins/local.js": 'require("expo/config-plugins");\n',
        "shopping-app/app/index.tsx": 'import { thing } from "@/lib/thing";\n',
        "shopping-app/lib/thing.ts": 'export { nested as thing } from "./nested";\n',
        "shopping-app/lib/nested.ts": "export const nested = 1;\n",
    }
    commit_fixture(tmp_path, files, list(files))

    result = run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "[dependency-closure] OK" in result.stdout


def test_accepts_python_relative_repo_absolute_stdlib_and_external_imports(tmp_path: Path) -> None:
    files = {
        "src/__init__.py": "",
        "src/runtime/__init__.py": "from .worker import run\n",
        "src/runtime/worker.py": (
            "import json\n"
            "import third_party_runtime\n"
            "from src.shared import VALUE\n"
            "from .helper import helper\n"
            "run = lambda: (VALUE, helper)\n"
        ),
        "src/runtime/helper.py": "helper = True\n",
        "src/shared.py": "VALUE = 1\n",
        "scripts/entry.py": "from src.runtime import run\n",
    }
    commit_fixture(tmp_path, files, list(files))

    result = run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "[dependency-closure] OK" in result.stdout


def test_fails_when_python_runtime_dependencies_are_absent_from_manifest(tmp_path: Path) -> None:
    files = {
        "src/__init__.py": "",
        "src/runtime.py": (
            "from src.utils.atomic_json import atomic_write_json\n"
            "from .space_locator.catalog_geometry_assignment import global_min_cost_association\n"
        ),
        "src/utils/__init__.py": "",
        "src/utils/atomic_json.py": "def atomic_write_json(): pass\n",
        "src/space_locator/__init__.py": "",
        "src/space_locator/catalog_geometry_assignment.py": (
            "def global_min_cost_association(): pass\n"
        ),
    }
    commit_fixture(
        tmp_path,
        files,
        [
            "src/__init__.py",
            "src/runtime.py",
            "src/utils/__init__.py",
            "src/space_locator/__init__.py",
        ],
    )

    result = run(tmp_path)

    assert result.returncode == 1
    assert "src/utils/atomic_json.py" in result.stdout
    assert "src/space_locator/catalog_geometry_assignment.py" in result.stdout
    assert result.stdout.count("resolved local Python dependency is absent from manifest") == 2


def test_fails_closed_for_unresolved_relative_and_repo_absolute_python_imports(
    tmp_path: Path,
) -> None:
    files = {
        "src/__init__.py": "",
        "src/runtime.py": "from .missing_relative import value\nfrom src.missing_absolute import value\n",
    }
    commit_fixture(tmp_path, files, list(files))

    result = run(tmp_path)

    assert result.returncode == 1
    assert ".missing_relative" in result.stdout
    assert "src.missing_absolute" in result.stdout
    assert result.stdout.count("local Python dependency is not committed") == 2


def test_fails_when_transitive_dependency_is_absent_from_manifest(tmp_path: Path) -> None:
    files = {
        "desktop-app/src/main.ts": 'import "./direct";\n',
        "desktop-app/src/direct.ts": 'import "./nested";\n',
        "desktop-app/src/nested.ts": "export const nested = true;\n",
    }
    commit_fixture(tmp_path, files, ["desktop-app/src/main.ts", "desktop-app/src/direct.ts"])

    result = run(tmp_path)

    assert result.returncode == 1
    assert "desktop-app/src/direct.ts" in result.stdout
    assert "./nested" in result.stdout
    assert "desktop-app/src/nested.ts" in result.stdout
    assert "absent from manifest" in result.stdout


def test_fails_when_local_app_plugin_is_absent_from_manifest(tmp_path: Path) -> None:
    files = {
        "shopping-app/app.json": '{"expo":{"plugins":["./plugins/local"]}}',
        "shopping-app/plugins/local.js": "module.exports = {};\n",
    }
    commit_fixture(tmp_path, files, ["shopping-app/app.json"])

    result = run(tmp_path)

    assert result.returncode == 1
    assert "shopping-app/app.json" in result.stdout
    assert "./plugins/local" in result.stdout
    assert "shopping-app/plugins/local.js" in result.stdout


def test_fails_closed_for_unresolved_ambiguous_and_computed_local_loads(tmp_path: Path) -> None:
    files = {
        "shopping-app/app/entry.ts": (
            'import "./missing";\n'
            'import "./ambiguous";\n'
            'const loaded = require(path.join("./lib", name));\n'
        ),
        "shopping-app/app/ambiguous.ts": "export {};\n",
        "shopping-app/app/ambiguous.js": "module.exports = {};\n",
    }
    commit_fixture(tmp_path, files, list(files))

    result = run(tmp_path)

    assert result.returncode == 1
    assert "not committed" in result.stdout
    assert "ambiguous local dependency" in result.stdout
    assert "computed require cannot be verified" in result.stdout


def test_uses_committed_revision_not_uncommitted_dependency(tmp_path: Path) -> None:
    files = {"desktop-app/src/main.ts": 'import "./later";\n'}
    commit_fixture(tmp_path, files, list(files))
    later = tmp_path / "desktop-app" / "src" / "later.ts"
    later.write_text("export {};\n", encoding="utf-8")
    with (tmp_path / MANIFEST).open("a", encoding="utf-8") as manifest:
        manifest.write("desktop-app/src/later.ts\n")

    result = run(tmp_path)

    assert result.returncode == 1
    assert "local dependency is not committed" in result.stdout


def test_package_script_references_are_roots_and_must_be_manifested(tmp_path: Path) -> None:
    files = {
        "shopping-app/package.json": '{"scripts":{"test":"node scripts/run-tests.cjs"}}',
        "shopping-app/scripts/run-tests.cjs": 'require("../lib/test-entry");\n',
        "shopping-app/lib/test-entry.ts": "export {};\n",
    }
    commit_fixture(tmp_path, files, ["shopping-app/package.json"])

    result = run(tmp_path)

    assert result.returncode == 1
    assert "scripts.test" in result.stdout
    assert "shopping-app/scripts/run-tests.cjs" in result.stdout
    assert "absent from manifest" in result.stdout


def test_literal_test_runner_closes_computed_require_without_weakening_other_computed_loads(
    tmp_path: Path,
) -> None:
    files = {
        "shopping-app/package.json": '{"scripts":{"test":"node scripts/run-tests.cjs"}}',
        "shopping-app/scripts/run-tests.cjs": (
            'const path = require("node:path");\n'
            'const appRoot = __dirname;\n'
            'const testCases = [["lib/one.test.ts"], ["lib/two.test.ts", "run"]];\n'
            'for (const [relativePath] of testCases) require(path.join(appRoot, relativePath));\n'
        ),
        "shopping-app/lib/one.test.ts": 'import "./runtime";\n',
        "shopping-app/lib/two.test.ts": "export const run = () => undefined;\n",
        "shopping-app/lib/runtime.ts": "export {};\n",
    }
    commit_fixture(tmp_path, files, list(files))

    result = run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr


def test_literal_test_runner_fails_when_listed_test_is_not_manifested(tmp_path: Path) -> None:
    files = {
        "shopping-app/package.json": '{"scripts":{"test":"node scripts/run-tests.cjs"}}',
        "shopping-app/scripts/run-tests.cjs": (
            'const path = require("node:path");\n'
            'const testCases = [["lib/listed.test.ts"]];\n'
            'for (const [relativePath] of testCases) require(path.join(appRoot, relativePath));\n'
        ),
        "shopping-app/lib/listed.test.ts": "export {};\n",
    }
    commit_fixture(
        tmp_path,
        files,
        ["shopping-app/package.json", "shopping-app/scripts/run-tests.cjs"],
    )

    result = run(tmp_path)

    assert result.returncode == 1
    assert "shopping-app/lib/listed.test.ts" in result.stdout
    assert "absent from manifest" in result.stdout

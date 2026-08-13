#!/usr/bin/env python3
"""Fail closed when the public manifest omits local source dependencies."""

from __future__ import annotations

import argparse
import ast
import json
import posixpath
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable


CODE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
PYTHON_SUFFIXES = (".py",)
RESOLUTION_SUFFIXES = CODE_SUFFIXES + (".json", ".css")
MANIFEST_LINE = re.compile(r"^sha256:[0-9a-fA-F]{64}\s+(.+)$")
STATIC_SPECIFIERS = re.compile(
    r"(?:"
    r"\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?"
    r"|\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+"
    r"|\bimport\s*\(\s*"
    r"|\b(?:require|[A-Za-z_$][\w$]*Require)(?:\.resolve)?\s*\(\s*"
    r")[\"']([^\"']+)[\"']",
    re.MULTILINE,
)


class ClosureError(RuntimeError):
    pass


@dataclass(frozen=True)
class Finding:
    importer: str
    specifier: str
    reason: str
    resolved: str | None = None

    def render(self) -> str:
        suffix = f" -> {self.resolved}" if self.resolved else ""
        return f"{self.importer}: {self.specifier!r}: {self.reason}{suffix}"


class GitTree:
    def __init__(self, root: Path, revision: str) -> None:
        self.root = root
        self.revision = revision
        command = [
            "git",
            "-C",
            str(root),
            "-c",
            "core.quotePath=false",
            "ls-tree",
            "-r",
            "--name-only",
            revision,
        ]
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        if completed.returncode:
            raise ClosureError(completed.stderr.strip() or "git ls-tree failed")
        self.paths = {line.strip().replace("\\", "/") for line in completed.stdout.splitlines() if line.strip()}
        self._text_cache: dict[str, str] = {}

    def text(self, path: str) -> str:
        if path in self._text_cache:
            return self._text_cache[path]
        completed = subprocess.run(
            ["git", "-C", str(self.root), "show", f"{self.revision}:{path}"],
            capture_output=True,
        )
        if completed.returncode:
            raise ClosureError(
                completed.stderr.decode("utf-8", errors="replace").strip()
                or f"unable to read {path} from {self.revision}"
            )
        try:
            text = completed.stdout.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ClosureError(f"{path} is not valid UTF-8: {error}") from error
        self._text_cache[path] = text
        return text


def safe_relative_path(value: str, label: str) -> str:
    path = value.strip().replace("\\", "/")
    pure = PurePosixPath(path)
    if (
        not path
        or path.startswith("/")
        or re.match(r"^[A-Za-z]:", path)
        or any(part in ("", ".", "..") for part in pure.parts)
    ):
        raise ClosureError(f"unsafe {label} path: {value}")
    return path


def parse_manifest(text: str) -> set[str]:
    paths: set[str] = set()
    for raw in text.splitlines():
        entry = raw.strip().lstrip("\ufeff")
        if not entry or entry.startswith("#"):
            continue
        match = MANIFEST_LINE.match(entry)
        if entry.lower().startswith("sha256:") and not match:
            raise ClosureError(f"invalid SHA256 manifest entry: {entry}")
        path = safe_relative_path(match.group(1).strip() if match else entry, "manifest")
        if path in paths:
            raise ClosureError(f"duplicate manifest path: {path}")
        paths.add(path)
    if not paths:
        raise ClosureError("public manifest is empty")
    return paths


def strip_comments(source: str) -> str:
    """Replace comments while preserving strings and newlines for safe regex scanning."""

    result: list[str] = []
    index = 0
    state = "code"
    quote = ""
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if char in ("'", '"', "`"):
                state, quote = "string", char
                result.append(char)
            elif char == "/" and next_char == "/":
                state = "line-comment"
                result.extend("  ")
                index += 1
            elif char == "/" and next_char == "*":
                state = "block-comment"
                result.extend("  ")
                index += 1
            else:
                result.append(char)
        elif state == "string":
            result.append(char)
            if char == "\\" and next_char:
                result.append(next_char)
                index += 1
            elif char == quote:
                state = "code"
        elif state == "line-comment":
            if char in "\r\n":
                state = "code"
                result.append(char)
            else:
                result.append(" ")
        else:
            if char == "*" and next_char == "/":
                state = "code"
                result.extend("  ")
                index += 1
            else:
                result.append(char if char in "\r\n" else " ")
        index += 1
    if state == "block-comment":
        raise ClosureError("unterminated block comment")
    return "".join(result)


def local_specifier(specifier: str) -> bool:
    return specifier.startswith(".") or specifier.startswith("@/")


def candidate_paths(importer: str, specifier: str) -> list[str]:
    if specifier.startswith("@/"):
        if not importer.startswith("shopping-app/"):
            raise ClosureError(f"unsupported alias outside shopping-app: {specifier}")
        base = "shopping-app/" + specifier[2:]
    else:
        base = posixpath.normpath(posixpath.join(posixpath.dirname(importer), specifier))
    base = safe_relative_path(base, "dependency")
    suffix = PurePosixPath(base).suffix.lower()
    if suffix:
        return [base]
    return [base + extension for extension in RESOLUTION_SUFFIXES] + [
        f"{base}/index{extension}" for extension in RESOLUTION_SUFFIXES
    ]


def resolve_local(importer: str, specifier: str, tracked: set[str]) -> str:
    matches = [candidate for candidate in candidate_paths(importer, specifier) if candidate in tracked]
    if not matches:
        raise ClosureError("local dependency is not committed at the checked revision")
    if len(matches) > 1:
        raise ClosureError(f"ambiguous local dependency ({', '.join(matches)})")
    return matches[0]


def python_module_candidates(module: str) -> list[str]:
    if not module or any(not part for part in module.split(".")):
        raise ClosureError(f"invalid Python module name: {module!r}")
    base = safe_relative_path(module.replace(".", "/"), "Python dependency")
    return [f"{base}.py", f"{base}/__init__.py"]


def python_module_is_local(module: str, tracked: set[str]) -> bool:
    """Use only the checked Git tree to distinguish local and external modules."""

    if not module:
        return False
    top_level = module.split(".", 1)[0]
    return (
        f"{top_level}.py" in tracked
        or f"{top_level}/__init__.py" in tracked
        or any(
            path.startswith(f"{top_level}/") and path.endswith(PYTHON_SUFFIXES)
            for path in tracked
        )
    )


def python_namespace_exists(module: str, tracked: set[str]) -> bool:
    base = safe_relative_path(module.replace(".", "/"), "Python dependency")
    return any(path.startswith(f"{base}/") and path.endswith(PYTHON_SUFFIXES) for path in tracked)


def resolve_python_module(module: str, tracked: set[str]) -> tuple[set[str], bool, bool]:
    """Return files executed by importing a local module and namespace status."""

    matches = [candidate for candidate in python_module_candidates(module) if candidate in tracked]
    if len(matches) > 1:
        raise ClosureError(f"ambiguous local Python dependency ({', '.join(matches)})")

    parts = module.split(".")
    dependencies = {
        initializer
        for index in range(1, len(parts))
        if (initializer := f"{'/'.join(parts[:index])}/__init__.py") in tracked
    }
    dependencies.update(matches)
    return dependencies, bool(matches), not matches and python_namespace_exists(module, tracked)


def relative_python_module(importer: str, module: str | None, level: int) -> str:
    package = list(PurePosixPath(importer).parent.parts)
    if level < 1 or level > len(package):
        raise ClosureError("relative Python import escapes its repository package")
    anchor = package[: len(package) - level + 1]
    if module:
        anchor.extend(module.split("."))
    if not anchor:
        raise ClosureError("relative Python import has no package target")
    return ".".join(anchor)


def python_dependencies(importer: str, source: str, tracked: set[str]) -> tuple[set[str], list[Finding]]:
    try:
        document = ast.parse(source, filename=importer)
    except SyntaxError as error:
        location = f"line {error.lineno}" if error.lineno else "unknown line"
        raise ClosureError(f"invalid Python syntax at {location}: {error.msg}") from error

    dependencies: set[str] = set()
    findings: list[Finding] = []
    imports = (
        node for node in ast.walk(document) if isinstance(node, (ast.Import, ast.ImportFrom))
    )
    for node in imports:
        if isinstance(node, ast.Import):
            for alias in node.names:
                module = alias.name
                if not python_module_is_local(module, tracked):
                    continue
                try:
                    resolved, target_exists, is_namespace = resolve_python_module(module, tracked)
                except ClosureError as error:
                    findings.append(Finding(importer, module, str(error)))
                    continue
                if not target_exists and not is_namespace:
                    findings.append(
                        Finding(importer, module, "local Python dependency is not committed at the checked revision")
                    )
                    continue
                dependencies.update(resolved)
            continue

        rendered = "." * node.level + (node.module or "")
        try:
            if node.level:
                module = relative_python_module(importer, node.module, node.level)
                is_local = True
            else:
                module = node.module or ""
                is_local = python_module_is_local(module, tracked)
        except ClosureError as error:
            findings.append(Finding(importer, rendered, str(error)))
            continue
        if not is_local:
            continue

        try:
            resolved, target_exists, is_namespace = resolve_python_module(module, tracked)
        except ClosureError as error:
            findings.append(Finding(importer, rendered, str(error)))
            continue

        alias_dependencies: set[str] = set()
        alias_target_exists = False
        alias_namespace = False
        has_star = False
        for alias in node.names:
            if alias.name == "*":
                has_star = True
                continue
            alias_module = f"{module}.{alias.name}"
            try:
                alias_resolved, alias_exists, alias_is_namespace = resolve_python_module(
                    alias_module, tracked
                )
            except ClosureError as error:
                findings.append(Finding(importer, f"{rendered}.{alias.name}", str(error)))
                continue
            alias_dependencies.update(alias_resolved)
            alias_target_exists = alias_target_exists or alias_exists
            alias_namespace = alias_namespace or alias_is_namespace

        if not target_exists and not alias_target_exists and not alias_namespace and not (
            is_namespace and has_star
        ):
            findings.append(
                Finding(importer, rendered, "local Python dependency is not committed at the checked revision")
            )
            continue
        dependencies.update(resolved)
        dependencies.update(alias_dependencies)

    return dependencies, findings


def literal_test_case_specifiers(source: str) -> set[str]:
    match = re.search(r"\btestCases\s*=\s*\[([\s\S]*?)\]\s*;", source)
    if not match:
        return set()
    return set(re.findall(r"\[\s*[\"']([^\"']+\.(?:ts|tsx|js|jsx|mjs|cjs))[\"']", match.group(1)))


def code_specifiers(source: str) -> Iterable[str]:
    scrubbed = strip_comments(source)
    scrubbed = re.sub(
        r"(?m)^\s*declare\s+function\s+require\s*\([^\r\n]*$",
        lambda match: " " * len(match.group(0)),
        scrubbed,
    )
    explicit_test_cases = literal_test_case_specifiers(scrubbed)
    yield from (f"../{specifier}" for specifier in explicit_test_cases)
    yield from (match.group(1) for match in STATIC_SPECIFIERS.finditer(scrubbed))
    # Computed local loads cannot be proven safe. Bare/external computed loads are
    # allowed (tests use eval("require") only to obtain Node's loader).
    for match in re.finditer(
        r"\b(?:require|[A-Za-z_$][\w$]*Require)(?:\.resolve)?\s*\(([^\r\n)]*)\)",
        scrubbed,
    ):
        argument = match.group(1).strip()
        if argument.startswith(("'", '"')):
            continue
        is_explicit_test_runner = (
            explicit_test_cases
            and re.fullmatch(r"path\.join\(\s*appRoot\s*,\s*relativePath\s*", argument) is not None
        )
        if not is_explicit_test_runner:
            raise ClosureError(f"computed require cannot be verified: {argument}")
    for match in re.finditer(r"\bimport\s*\(([^\r\n)]*)\)", scrubbed):
        argument = match.group(1).strip()
        if not argument.startswith(("'", '"')):
            raise ClosureError(f"computed dynamic import cannot be verified: {argument}")


def app_plugins(document: object, importer: str) -> Iterable[str]:
    if not isinstance(document, dict):
        raise ClosureError(f"{importer} must contain a JSON object")
    expo = document.get("expo")
    if not isinstance(expo, dict):
        return
    plugins = expo.get("plugins", [])
    if not isinstance(plugins, list):
        raise ClosureError(f"{importer} expo.plugins must be an array")
    for entry in plugins:
        plugin = entry[0] if isinstance(entry, list) and entry else entry
        if not isinstance(plugin, str):
            raise ClosureError(f"{importer} contains a non-string Expo plugin reference")
        if local_specifier(plugin):
            yield plugin


def package_roots(tree: GitTree, manifest: set[str]) -> tuple[set[str], list[Finding]]:
    roots: set[str] = set()
    findings: list[Finding] = []
    for package_path in sorted(path for path in manifest if path.endswith("/package.json")):
        try:
            document = json.loads(tree.text(package_path))
        except json.JSONDecodeError as error:
            raise ClosureError(f"invalid JSON in {package_path}: {error}") from error
        scripts = document.get("scripts", {}) if isinstance(document, dict) else {}
        if not isinstance(scripts, dict):
            raise ClosureError(f"{package_path} scripts must be an object")
        for name in ("test", "test:state", "typecheck", "build"):
            command = scripts.get(name)
            if command is not None and not isinstance(command, str):
                raise ClosureError(f"{package_path} script {name} must be a string")
            if not command:
                continue
            for token in re.findall(r"(?<![\w@./-])([\w@()\[\]./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json))\b", command):
                normalized = token.replace("\\", "/")
                # Generated compiler output and installed dependency paths are
                # not source inputs. The corresponding source files earlier in
                # the command remain checked as package-script roots.
                if normalized.startswith(("node_modules/", "dist/", "build/")):
                    continue
                path = posixpath.normpath(posixpath.join(posixpath.dirname(package_path), normalized))
                if path not in tree.paths:
                    findings.append(Finding(package_path, f"scripts.{name}", "referenced file is not committed", path))
                elif path not in manifest:
                    findings.append(Finding(package_path, f"scripts.{name}", "referenced file is absent from manifest", path))
                else:
                    roots.add(path)
    return roots, findings


def check_closure(tree: GitTree, manifest: set[str]) -> list[Finding]:
    findings: list[Finding] = []
    roots = {
        path
        for path in manifest
        if path.endswith(CODE_SUFFIXES + PYTHON_SUFFIXES) or path.endswith("/app.json")
    }
    package_script_roots, package_findings = package_roots(tree, manifest)
    roots.update(package_script_roots)
    findings.extend(package_findings)

    queue = sorted(roots)
    visited: set[str] = set()
    while queue:
        importer = queue.pop(0)
        if importer in visited:
            continue
        visited.add(importer)
        try:
            if importer.endswith("/app.json"):
                try:
                    document = json.loads(tree.text(importer))
                except json.JSONDecodeError as error:
                    raise ClosureError(f"invalid JSON: {error}") from error
                specifiers = app_plugins(document, importer)
            elif importer.endswith(CODE_SUFFIXES):
                specifiers = code_specifiers(tree.text(importer))
            elif importer.endswith(PYTHON_SUFFIXES):
                dependencies, python_findings = python_dependencies(
                    importer, tree.text(importer), tree.paths
                )
                findings.extend(python_findings)
                for resolved in sorted(dependencies):
                    if resolved not in manifest:
                        findings.append(
                            Finding(
                                importer,
                                resolved,
                                "resolved local Python dependency is absent from manifest",
                                resolved,
                            )
                        )
                    else:
                        queue.append(resolved)
                continue
            else:
                continue
            for specifier in specifiers:
                if not local_specifier(specifier):
                    continue
                try:
                    resolved = resolve_local(importer, specifier, tree.paths)
                except ClosureError as error:
                    findings.append(Finding(importer, specifier, str(error)))
                    continue
                if resolved not in manifest:
                    findings.append(Finding(importer, specifier, "resolved local dependency is absent from manifest", resolved))
                    continue
                if resolved.endswith(CODE_SUFFIXES + PYTHON_SUFFIXES) or resolved.endswith("/app.json"):
                    queue.append(resolved)
        except ClosureError as error:
            findings.append(Finding(importer, "<parse>", str(error)))
    return sorted(set(findings), key=lambda finding: finding.render())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--manifest", default="scripts/public-sync-manifest.txt")
    args = parser.parse_args(argv)
    try:
        repository = args.repository.resolve()
        manifest_path = safe_relative_path(args.manifest, "manifest")
        tree = GitTree(repository, args.revision)
        if manifest_path not in tree.paths:
            raise ClosureError(f"{manifest_path} is not committed at {args.revision}")
        manifest = parse_manifest(tree.text(manifest_path))
        absent = sorted(path for path in manifest if path not in tree.paths)
        findings = [Finding(manifest_path, path, "manifest path is not committed") for path in absent]
        findings.extend(check_closure(tree, manifest))
        if findings:
            print(f"[dependency-closure] {len(findings)} finding(s)")
            for finding in sorted(set(findings), key=lambda item: item.render()):
                print(f"  BLOCK {finding.render()}")
            return 1
        print(f"[dependency-closure] OK ({len(manifest)} manifest files checked at {args.revision})")
        return 0
    except (ClosureError, OSError) as error:
        print(f"[dependency-closure] BLOCK {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

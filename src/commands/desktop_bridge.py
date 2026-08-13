"""Desktop bridge entrypoint for Tauri <-> Python integration."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import glob
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import yaml


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


@contextmanager
def _atomic_zipfile(path: Path):
    """Yield a writable ZIP at a sibling temp path, then publish atomically.

    ZIP creation can fail after writing several members (for example when an
    event asset changes during a TOCTOU check).  Keeping the destination path
    untouched until the archive is closed and fsynced prevents consumers from
    observing a partial bundle and preserves a previously published bundle.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with zipfile.ZipFile(str(temp_path), "w", zipfile.ZIP_DEFLATED) as archive:
            # _zip_event_directory uses this to avoid re-ingesting the
            # temporary output when the requested final path is inside an
            # event directory.
            archive._eventtrail_temp_path = str(temp_path)
            yield archive
        # ZipFile.close() has flushed its central directory.  fsync the
        # closed archive before replacing the destination.
        with temp_path.open("r+b") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except BaseException:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        raise


def _resolve_output_image_path(output_dir: str, image_ref: str) -> Optional[Path]:
    image_ref = str(image_ref or "").strip()
    if not image_ref:
        return None
    path = Path(image_ref)
    if not path.is_absolute():
        path = Path(output_dir) / image_ref
    return path if path.exists() else None


def _apply_missing_circle_cut_from_catalog(
    project_root: Path,
    output_dir: str,
    latest_circle: Dict[str, Any],
    circle_patch: Dict[str, Any],
) -> None:
    if latest_circle.get("circle_cut_filename") or circle_patch.get("circle_cut_filename"):
        return

    image_ref = ""
    image_path: Optional[Path] = None
    for image in circle_patch.get("item_images") or latest_circle.get("item_images") or []:
        if isinstance(image, dict):
            image_ref = str(image.get("path") or "").strip()
        else:
            image_ref = str(image or "").strip()
        image_path = _resolve_output_image_path(output_dir, image_ref)
        if image_path:
            break

    if not image_ref or not image_path:
        return

    circle_patch["circle_cut_filename"] = image_ref
    try:
        from ..utils.circle_master import CircleMasterManager

        manager = CircleMasterManager(
            config_path=str(project_root / "circle_master.json"),
            cuts_dir=str(project_root / "default_cuts"),
        )
        manager.register_default_cut(
            str(latest_circle.get("name") or ""),
            str(latest_circle.get("penname") or ""),
            image_path,
        )
    except Exception:
        # event.jsonへのサークルカット反映は継続し、マスター登録失敗は再処理全体を落とさない。
        pass


def _default_mobile_full_sync_zip_path(project_root: Path) -> Path:
    root_key = hashlib.sha1(str(project_root).encode("utf-8")).hexdigest()[:12]
    return Path(tempfile.gettempdir()) / "eventtrail-studio" / root_key / "mobile_full_sync.zip"


def _matches_circle_identity(candidate: Dict[str, Any], identity: Dict[str, Any]) -> bool:
    checks = [
        ("name", "name"),
        ("penname", "penname"),
        ("space", "space"),
        ("hall", "hall"),
    ]
    matched_any = False
    for identity_key, circle_key in checks:
        expected = str(identity.get(identity_key) or "").strip()
        if not expected:
            continue
        matched_any = True
        actual = str(candidate.get(circle_key) or "").strip()
        if actual != expected:
            return False
    return matched_any


def _resolve_latest_circle_index(
    latest_circles: List[Dict[str, Any]],
    preferred_idx: int,
    identity: Dict[str, Any],
) -> int:
    if 0 <= preferred_idx < len(latest_circles):
        if not identity or _matches_circle_identity(latest_circles[preferred_idx], identity):
            return preferred_idx
    if identity:
        matches = [
            i
            for i, candidate in enumerate(latest_circles)
            if isinstance(candidate, dict) and _matches_circle_identity(candidate, identity)
        ]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(
                "circle_identity matched multiple circles; cannot apply reprocess result safely"
            )
    raise ValueError(
        f"target circle was changed or removed while reprocessing: index={preferred_idx}"
    )


def _normalized_item_key(item: Dict[str, Any]) -> tuple[str, str]:
    name = str(item.get("name") or "").strip().lower()
    item_type = str(item.get("type") or item.get("genre") or "").strip().lower()
    return name, item_type


def _merge_catalog_items(
    existing_items: List[Any],
    detected_items: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = [
        dict(item) for item in existing_items if isinstance(item, dict)
    ]
    key_to_index = {
        _normalized_item_key(item): index
        for index, item in enumerate(merged)
        if any(_normalized_item_key(item))
    }

    for detected in detected_items:
        if not isinstance(detected, dict):
            continue
        item = dict(detected)
        key = _normalized_item_key(item)
        if any(key) and key in key_to_index:
            current = merged[key_to_index[key]]
            for field, value in item.items():
                if value not in (None, ""):
                    current[field] = value
        else:
            merged.append(item)
            if any(key):
                key_to_index[key] = len(merged) - 1
    return merged


def _load_payload(args: argparse.Namespace) -> Dict[str, Any]:
    if args.payload and args.payload_json:
        raise ValueError("--payload and --payload-json cannot be used together")

    if args.payload_json:
        return json.loads(args.payload_json)

    if args.payload:
        payload_path = Path(args.payload)
        if not payload_path.exists():
            raise FileNotFoundError(f"Payload file not found: {payload_path}")
        return json.loads(payload_path.read_text(encoding="utf-8"))

    return {}


def _payload_url_list(payload: Dict[str, Any]) -> List[str]:
    raw_urls = payload.get("urls", payload.get("event_urls"))
    urls = _value_url_list(raw_urls)

    raw_url = payload.get("url")
    if isinstance(raw_url, str):
        for url in _value_url_list(raw_url):
            if url not in urls:
                urls.append(url)
    return urls


def _value_url_list(value: Any) -> List[str]:
    candidates: List[str] = []

    if isinstance(value, list):
        candidates.extend(str(url).strip() for url in value)
    elif isinstance(value, str):
        candidates.extend(re.findall(r"https?://[^\s,]+", value))

    urls: List[str] = []
    seen: set[str] = set()
    for url in candidates:
        cleaned = url.strip().rstrip(",])};")
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        urls.append(cleaned)
    return urls


def _payload_event_source_settings(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    settings: Dict[str, Dict[str, Any]] = {}
    raw_sources = payload.get("event_sources")
    if not isinstance(raw_sources, list):
        return settings

    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            continue
        url = raw_source.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        source_url = url.strip()
        source_settings: Dict[str, Any] = {}
        map_urls = _value_url_list(raw_source.get("map_urls"))
        for map_url in _value_url_list(raw_source.get("map_url")):
            if map_url not in map_urls:
                map_urls.append(map_url)
        if map_urls:
            source_settings["map_urls"] = map_urls

        prompt = raw_source.get("catalog_additional_prompt")
        if prompt is None:
            prompt = raw_source.get("additional_prompt")
        if isinstance(prompt, str):
            source_settings["catalog_additional_prompt"] = prompt

        if source_settings:
            settings[source_url] = source_settings
    return settings


def _build_extract_command(payload: Dict[str, Any]) -> list[str]:
    required = ["event_file", "event_date"]
    for key in required:
        if key not in payload or not payload[key]:
            raise ValueError(f"Missing required payload field: {key}")

    cmd = [
        sys.executable,
        "-m",
        "src.commands.extract_twitter_catalogs",
        str(payload["event_file"]),
        "--event-date",
        str(payload["event_date"]),
    ]

    if payload.get("output_dir"):
        cmd += ["--output-dir", str(payload["output_dir"])]
    if payload.get("days_before") is not None:
        cmd += ["--days-before", str(payload["days_before"])]
    if payload.get("days_after") is not None:
        cmd += ["--days-after", str(payload["days_after"])]
    if payload.get("backup"):
        cmd.append("--backup")

    return cmd


def _build_main_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    urls = _payload_url_list(payload)
    if not urls and not payload.get("reprocess"):
        raise ValueError("Missing required payload field: url")

    # model欄はカンマ区切りの文字列 → modelsリストに変換
    raw_model = payload.get("model", "gpt-5.6-sol")
    models = (
        [m.strip() for m in raw_model.split(",") if m.strip()]
        if isinstance(raw_model, str)
        else [raw_model]
    )

    # output_dirはtempディレクトリからの相対パスだと消えるため、project_rootからの絶対パスに変換
    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    output_dir = payload.get("output_dir")
    if not output_dir:
        raise ValueError("output_dir is required")
    if not Path(output_dir).is_absolute():
        output_dir = str(project_root / output_dir)

    config: Dict[str, Any] = {
        "url": urls[0] if urls else "",
        "output_dir": output_dir,
        "models": models,
        "enable_twitter_catalog": payload.get("enable_twitter_catalog", True),
    }
    if len(urls) > 1 and not payload.get("reprocess"):
        config["source_urls"] = urls

    map_urls = _value_url_list(payload.get("map_urls"))
    for map_url in _value_url_list(payload.get("map_url")):
        if map_url not in map_urls:
            map_urls.append(map_url)
    if map_urls:
        config["map_url"] = map_urls[0]
        config["map_urls"] = map_urls

    optional_keys = [
        "event_date",
        "event_name",
        "catalog_additional_prompt",
        "debug_limit",
        "use_grok_search",
        "text_llm_provider",
        "text_llm_cli_models",
        "text_llm_cli_efforts",
        "text_llm_cli_timeout",
        "api_reasoning_effort",
        "api_reasoning_effort_map",
        "text_fallback_llm_provider",
        "text_fallback_llm_model",
        "text_fallback_llm_effort",
        "image_llm_provider",
        "image_llm_model",
        "image_llm_effort",
        "image_fallback_llm_provider",
        "image_fallback_llm_model",
        "image_fallback_llm_effort",
        "image_api_reasoning_effort_map",
        "tweet_llm_cli_providers",
        "tweet_llm_cli_models",
        "tweet_llm_cli_efforts",
        "tweet_llm_cli_timeout",
        "skip_circle_images",
        "force_relearn_pattern",
        "site_parsing",
        "cookie_file",
        "pagination",
        "days_before",
        "days_after",
        # GUI の Unlimited OCR 設定は一つの辞書として main.py まで渡す。
        "ocr_config",
    ]
    for key in optional_keys:
        if key in payload and payload[key] not in (None, ""):
            config[key] = payload[key]

    # 旧版GUI/外部呼び出しがフラットなキーを送る場合も同じ契約へ寄せる。
    # ocr_config が明示されていれば優先し、空の値で既定を壊さない。
    if not isinstance(config.get("ocr_config"), dict):
        flat_ocr_keys = {
            "unlimited_ocr_model": "model",
            "unlimited_ocr_model_path": "model_path",
            "unlimited_ocr_venv": "venv_path",
            "unlimited_ocr_hf_home": "hf_home",
            "unlimited_ocr_revision": "revision",
            "unlimited_ocr_device": "device",
            "unlimited_ocr_mode": "mode",
            "unlimited_ocr_strategy": "strategy",
            "unlimited_ocr_prompt": "prompt",
            "unlimited_ocr_timeout_sec": "timeout_sec",
            "unlimited_ocr_max_length": "max_length",
            "unlimited_ocr_no_repeat_ngram_size": "no_repeat_ngram_size",
            "unlimited_ocr_ngram_window": "ngram_window",
            "unlimited_ocr_temperature": "temperature",
        }
        flat_config = {
            target: payload[source]
            for source, target in flat_ocr_keys.items()
            if source in payload and payload[source] not in (None, "")
        }
        if flat_config:
            config["ocr_config"] = flat_config

    return config


def _collect_coordinate_diagnostics(output_dir: str | Path) -> Dict[str, Any] | None:
    """main.py/auto generator が保存した座標結果をGUI応答へ要約する。"""
    root = Path(output_dir)
    summary_path = root / "coordinate_generation_summary.json"
    if summary_path.exists():
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
            if isinstance(summary, dict):
                return summary
        except (OSError, ValueError, TypeError):
            pass

    files = sorted(root.glob("coordinates_map_*.json")) if root.exists() else []
    if not files:
        return None
    maps: list[Dict[str, Any]] = []
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError, TypeError) as exc:
            maps.append({"file": str(path), "status": "failed", "error": str(exc)})
            continue
        if not isinstance(data, dict):
            maps.append({"file": str(path), "status": "failed", "error": "結果JSONがobjectではありません"})
            continue
        grid = data.get("complete_grid")
        failed = bool(data.get("error")) or not isinstance(grid, list) or not grid
        maps.append(
            {
                "file": str(path),
                "map_number": data.get("map_number"),
                "status": "failed" if failed else "success",
                "generated_count": len(grid) if isinstance(grid, list) else 0,
                "error": data.get("error"),
                "ocr_diagnostics": data.get("ocr_diagnostics", {}),
            }
        )
    succeeded = sum(1 for item in maps if item.get("status") == "success")
    return {
        "status": "success" if succeeded == len(maps) else ("partial" if succeeded else "failed"),
        "attempted": len(maps),
        "succeeded": succeeded,
        "failed": len(maps) - succeeded,
        "maps": maps,
    }


_DIAGNOSTIC_SECRET_RE = re.compile(
    r"(?i)\b(?:api[_-]?key|token|password|passwd|secret|authorization|cookie)\b"
    r"\s*[:=]\s*[^\s,;]+"
)
_DIAGNOSTIC_BEARER_RE = re.compile(r"(?i)\bBearer\s+[^\s,;]+")
_DIAGNOSTIC_TOKEN_RE = re.compile(
    r"(?i)\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,})"
)
_DIAGNOSTIC_WINDOWS_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\)[^\s\"'`;,)\]]+"
)
_DIAGNOSTIC_POSIX_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_:/])/(?:[^\s\"'`;,)\]]+)"
)


def _safe_diagnostic_text(value: Any, *, max_chars: int = 2000) -> str:
    """stderr/stdoutをGUIへ返す前にsecretと絶対パスを除去する。"""
    text = str(value or "")

    def redact_secret(match: re.Match[str]) -> str:
        raw = match.group(0)
        separator = max(raw.find("="), raw.find(":"))
        return f"{raw[: separator + 1] if separator >= 0 else 'secret:'}<redacted>"

    text = _DIAGNOSTIC_SECRET_RE.sub(redact_secret, text)
    text = _DIAGNOSTIC_BEARER_RE.sub("Bearer <redacted>", text)
    text = _DIAGNOSTIC_TOKEN_RE.sub("<redacted-token>", text)
    text = _DIAGNOSTIC_WINDOWS_PATH_RE.sub("<path>", text)
    text = _DIAGNOSTIC_POSIX_PATH_RE.sub("<path>", text)
    text = text.strip()
    if len(text) > max_chars:
        return "…" + text[-(max_chars - 1) :]
    return text


def _configured_flag(value: Any) -> bool:
    return bool(str(value or "").strip())


def _summarize_ocr_diagnostics(raw: Any) -> Dict[str, Any]:
    """OCR診断を機械可読の安全なGUI向け要約へ正規化する。

    runnerのstderrにはモデルロード時のパスや環境変数が混ざる可能性があるため、
    絶対パス/secretは除去し、復旧に必要なcode・returncode・モデル・device・
    専用venv等の設定状態だけを残す。
    """
    diagnostics = raw if isinstance(raw, dict) else {}
    error = diagnostics.get("error") if isinstance(diagnostics.get("error"), dict) else {}
    last_run = diagnostics.get("last_run") if isinstance(diagnostics.get("last_run"), dict) else {}
    config = diagnostics.get("config") if isinstance(diagnostics.get("config"), dict) else {}

    code = str(error.get("code") or "coordinate_generation_failed")
    message = _safe_diagnostic_text(error.get("message"))
    returncode = error.get("returncode")
    if not isinstance(returncode, int):
        returncode = None
    model = _safe_diagnostic_text(last_run.get("model") or config.get("model"))
    revision = _safe_diagnostic_text(last_run.get("revision") or config.get("revision"))
    device = _safe_diagnostic_text(last_run.get("device") or config.get("device"))
    mode = _safe_diagnostic_text(last_run.get("mode") or config.get("mode"))
    strategy = _safe_diagnostic_text(last_run.get("strategy") or config.get("strategy"))
    hints = {
        "cpu_unsupported": "CUDA対応PCでdevice=cuda/autoを使うか、CPU対応モデルへ切り替えてください。",
        "venv_missing": "専用OCR環境をセットアップし、設定画面のPython/venvを確認してください。",
        "runner_failed": "専用OCR環境のPython、モデルファイル、device設定を確認して再実行してください。",
        "runner_exception": "専用OCR環境のPython、モデルファイル、device設定を確認して再実行してください。",
        "image_read_failed": "マップ画像が読み込めません。画像ファイルの存在・形式・権限を確認してください。",
        "timeout": "OCRの入力サイズやtile設定を見直し、専用OCR環境を確認して再実行してください。",
    }
    return {
        "schema_version": 1,
        "error_code": code,
        "error_message": message,
        "returncode": returncode,
        "stderr": _safe_diagnostic_text(error.get("stderr")),
        "stdout": _safe_diagnostic_text(error.get("stdout"), max_chars=1000),
        "model": model,
        "revision": revision,
        "device": device,
        "mode": mode,
        "strategy": strategy,
        "venv": {"configured": _configured_flag(config.get("venv_path"))},
        "model_path": {"configured": _configured_flag(config.get("model_path"))},
        "hf_home": {"configured": _configured_flag(config.get("hf_home"))},
        "recovery_hint": hints.get(code, "OCR設定と入力マップを確認して再実行してください。"),
        "paths_redacted": True,
    }


def _job_ping(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "ok",
        "job": "ping",
        "timestamp": _utc_now_iso(),
        "echo": payload,
        "python": sys.executable,
    }


def _job_extract_twitter_catalogs(payload: Dict[str, Any]) -> Dict[str, Any]:
    cmd = _build_extract_command(payload)
    run_cwd = payload.get("project_root")
    sub_env = os.environ.copy()
    sub_env["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=run_cwd,
        env=sub_env,
    )

    return {
        "status": "ok" if completed.returncode == 0 else "error",
        "job": "extract_twitter_catalogs",
        "timestamp": _utc_now_iso(),
        "returncode": completed.returncode,
        "command": cmd,
        "cwd": run_cwd,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def _terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return

    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        proc.terminate()

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def _run_main_process(
    project_root: Path,
    main_py: Path,
    config: Dict[str, Any],
    payload: Dict[str, Any],
    run_dir: Path,
) -> Dict[str, Any]:
    run_dir.mkdir(parents=True, exist_ok=True)
    config_path = run_dir / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(config, allow_unicode=True), encoding="utf-8"
    )

    cmd = [sys.executable, str(main_py)]
    if payload.get("verbose"):
        cmd.append("--verbose")
    if payload.get("reprocess"):
        cmd.append("--reprocess")
    if payload.get("regenerate_coordinates"):
        cmd.append("--regenerate-coordinates")

    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        str(project_root)
        if not existing_pythonpath
        else f"{project_root}{os.pathsep}{existing_pythonpath}"
    )

    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(run_dir),
        env=env,
    )

    stderr_lines: List[str] = []
    stdout_output = ""
    try:
        if proc.stderr is not None:
            for line in proc.stderr:
                line_stripped = line.rstrip("\n").rstrip("\r")
                stderr_lines.append(line_stripped)
                sys.stderr.write(line_stripped + "\n")
                sys.stderr.flush()

        stdout_output = proc.stdout.read() if proc.stdout is not None else ""
        proc.wait()
    finally:
        _terminate_process_tree(proc)

    result = {
        "status": "ok" if proc.returncode == 0 else "error",
        "job": "run_main_pipeline",
        "timestamp": _utc_now_iso(),
        "returncode": proc.returncode,
        "command": cmd,
        "cwd": str(run_dir),
        "project_root": str(project_root),
        "config_used": config,
        "stdout": stdout_output,
        "stderr": "\n".join(stderr_lines),
    }
    coordinate_diagnostics = _collect_coordinate_diagnostics(config.get("output_dir"))
    if coordinate_diagnostics is not None:
        result["coordinate_generation"] = coordinate_diagnostics
        if (
            payload.get("regenerate_coordinates")
            and coordinate_diagnostics.get("status") == "failed"
            and proc.returncode == 0
        ):
            result["status"] = "error"
            result["returncode"] = 1
            result["stderr"] += "\n座標生成が全マップで失敗しました。"
    twitter_processing = _extract_twitter_processing_result(stderr_lines)
    if twitter_processing:
        result["twitter_processing"] = twitter_processing
    return result


def _extract_twitter_processing_result(
    stderr_lines: List[str],
) -> Optional[Dict[str, Any]]:
    marker = "TWITTER_PROCESSING_RESULT="
    for line in reversed(stderr_lines):
        marker_index = line.find(marker)
        if marker_index < 0:
            continue
        try:
            result = json.loads(line[marker_index + len(marker):])
        except (TypeError, json.JSONDecodeError):
            return None
        return result if isinstance(result, dict) else None
    return None


def _aggregate_twitter_processing_results(
    run_results: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    summaries = [
        result.get("twitter_processing")
        for result in run_results
        if isinstance(result.get("twitter_processing"), dict)
    ]
    if not summaries:
        return None
    failed = [summary for summary in summaries if summary.get("status") == "failed"]
    reasons = [str(summary.get("reason")) for summary in failed if summary.get("reason")]
    return {
        "status": "failed" if failed else "ok",
        "target_count": sum(int(s.get("target_count") or 0) for s in summaries),
        "processed_count": sum(int(s.get("processed_count") or 0) for s in summaries),
        "failed_count": sum(int(s.get("failed_count") or 0) for s in summaries),
        "invalid_url_count": sum(
            int(s.get("invalid_url_count") or 0) for s in summaries
        ),
        "reason": "; ".join(dict.fromkeys(reasons)) or None,
    }


def _clear_output_dir(output_dir: Path) -> None:
    from src.utils.output_cleanup import protected_output_entry_names

    output_dir.mkdir(parents=True, exist_ok=True)
    protected_names = protected_output_entry_names(output_dir)
    for item in output_dir.iterdir():
        if item.name in protected_names:
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()


def _copy_referenced_output_file(
    source_dir: Path, dest_dir: Path, value: Any, prefix: str
) -> Any:
    if not isinstance(value, str) or not value.strip():
        return value
    if re.match(r"^[a-z][a-z0-9+.-]*://", value, flags=re.IGNORECASE):
        return value

    raw_path = Path(value)
    src_path = raw_path if raw_path.is_absolute() else source_dir / raw_path
    if not src_path.exists() or not src_path.is_file():
        return value

    safe_name = f"{prefix}{src_path.name}"
    dest_path = dest_dir / safe_name
    counter = 1
    while dest_path.exists():
        safe_name = f"{prefix}{counter}_{src_path.name}"
        dest_path = dest_dir / safe_name
        counter += 1

    shutil.copy2(src_path, dest_path)
    return safe_name


def _first_non_empty(values: List[Any]) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _same_or_first(values: List[Any]) -> Any:
    filtered = [v for v in values if v not in (None, "")]
    if not filtered:
        return None
    unique = []
    for value in filtered:
        if value not in unique:
            unique.append(value)
    return unique[0]


def _merge_multi_event_outputs(
    sources: List[Dict[str, Any]],
    final_output_dir: Path,
    final_event_name: Optional[str] = None,
) -> Dict[str, Any]:
    _clear_output_dir(final_output_dir)

    source_events: List[Dict[str, Any]] = []
    source_urls: List[str] = []
    event_dicts: List[Dict[str, Any]] = []
    merged_maps: List[Dict[str, Any]] = []
    merged_circles: List[Dict[str, Any]] = []

    for source_index, source in enumerate(sources, start=1):
        source_dir = Path(source["output_dir"])
        event_json = source_dir / "event.json"
        if not event_json.exists():
            raise FileNotFoundError(f"event.json not found: {event_json}")
        data = json.loads(event_json.read_text(encoding="utf-8"))
        event = data.get("event") or {}
        circles = data.get("circles") or []
        source_url = str(source["url"])
        source_name = (
            str(event.get("name") or "").strip()
            or str(source.get("name") or "").strip()
            or source_url
        )
        prefix = f"ev{source_index:02d}_"

        raw_source_urls = event.get("source_urls")
        if isinstance(raw_source_urls, list) and raw_source_urls:
            for raw_url in raw_source_urls:
                if isinstance(raw_url, str) and raw_url and raw_url not in source_urls:
                    source_urls.append(raw_url)
        elif source_url not in source_urls:
            source_urls.append(source_url)
        event_dicts.append(event)
        raw_source_events = event.get("source_events")
        if isinstance(raw_source_events, list) and raw_source_events:
            for raw_event in raw_source_events:
                if not isinstance(raw_event, dict):
                    continue
                raw_event_url = str(raw_event.get("url") or "").strip()
                if raw_event_url and any(e.get("url") == raw_event_url for e in source_events):
                    continue
                source_events.append(dict(raw_event))
        else:
            source_events.append(
                {"name": source_name, "url": source_url, "circle_count": len(circles)}
            )

        map_number_map: Dict[int, int] = {}
        for event_map in event.get("maps") or []:
            if not isinstance(event_map, dict):
                continue
            original_map_number = int(event_map.get("map_number") or 1)
            map_url = str(event_map.get("url") or "").strip()
            existing_map_number = None
            if map_url:
                for merged_map in merged_maps:
                    if str(merged_map.get("url") or "").strip() == map_url:
                        existing_map_number = int(merged_map.get("map_number") or 1)
                        break
            if existing_map_number is not None:
                map_number_map[original_map_number] = existing_map_number
                continue

            new_map = dict(event_map)
            new_map_number = len(merged_maps) + 1
            new_map["map_number"] = new_map_number
            new_map["filename"] = _copy_referenced_output_file(
                source_dir, final_output_dir, new_map.get("filename"), prefix
            )
            map_number_map[original_map_number] = new_map_number
            merged_maps.append(new_map)

        for circle in circles:
            if not isinstance(circle, dict):
                continue
            merged_circle = dict(circle)
            merged_circle["circle_cut_filename"] = _copy_referenced_output_file(
                source_dir,
                final_output_dir,
                merged_circle.get("circle_cut_filename"),
                prefix,
            )
            item_images = []
            for image in merged_circle.get("item_images") or []:
                if not isinstance(image, dict):
                    continue
                new_image = dict(image)
                new_image["path"] = _copy_referenced_output_file(
                    source_dir, final_output_dir, new_image.get("path"), prefix
                )
                item_images.append(new_image)
            merged_circle["item_images"] = item_images

            if map_number_map and merged_circle.get("map_number") is not None:
                try:
                    original = int(merged_circle["map_number"])
                    merged_circle["map_number"] = map_number_map.get(original, original)
                except (TypeError, ValueError):
                    pass

            circle_source_name = (
                str(merged_circle.get("source_event_name") or "").strip()
                or source_name
            )
            circle_source_url = (
                str(merged_circle.get("source_event_url") or "").strip()
                or source_url
            )
            source_tag = f"併催:{circle_source_name}"
            tags = merged_circle.get("tags")
            if not isinstance(tags, list):
                tags = []
            if source_tag not in tags:
                tags = [*tags, source_tag]
            merged_circle["tags"] = tags
            merged_circle["source_event_name"] = circle_source_name
            merged_circle["source_event_url"] = circle_source_url
            merged_circles.append(merged_circle)

    event_name = final_event_name or " / ".join(e["name"] for e in source_events)
    merged_event = {
        "name": event_name,
        "url": source_urls[0] if source_urls else "",
        "event_url": source_urls[0] if source_urls else "",
        "source_urls": source_urls,
        "source_events": source_events,
        "date": _same_or_first([e.get("date") for e in event_dicts]),
        "venue": _same_or_first([e.get("venue") for e in event_dicts]),
        "organizer": _same_or_first([e.get("organizer") for e in event_dicts]),
        "maps": merged_maps,
        "memo": _first_non_empty([e.get("memo") for e in event_dicts])
        or "併催イベント:\n"
        + "\n".join(f"- {e['name']}: {e['url']}" for e in source_events),
        "created_at": _utc_now_iso(),
    }

    merged_data = {
        "event": merged_event,
        "circles": merged_circles,
        "metadata": {
            "generated_at": _utc_now_iso(),
            "format_version": "3.0",
            "total_circles": len(merged_circles),
            "source": "multi_event_pipeline",
            "source_urls": source_urls,
            "source_events": source_events,
        },
    }
    output_path = final_output_dir / "event.json"
    output_path.write_text(
        json.dumps(merged_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return merged_data


def _job_run_multi_main_pipeline(
    payload: Dict[str, Any], project_root: Path, main_py: Path, urls: List[str]
) -> Dict[str, Any]:
    base_config = _build_main_config(payload)
    final_output_dir = Path(base_config["output_dir"])
    run_results: List[Dict[str, Any]] = []
    source_outputs: List[Dict[str, Any]] = []
    source_settings = _payload_event_source_settings(payload)
    has_event_sources = isinstance(payload.get("event_sources"), list)

    with tempfile.TemporaryDirectory(prefix="eventtrail-studio-multi-") as temp_dir:
        temp_dir_path = Path(temp_dir)
        urls_to_crawl = urls

        if payload.get("reprocess") and (final_output_dir / "event.json").exists():
            existing_url = urls[0]
            try:
                existing_data = json.loads(
                    (final_output_dir / "event.json").read_text(encoding="utf-8")
                )
                existing_event = existing_data.get("event") or {}
                existing_source_urls = existing_event.get("source_urls")
                if isinstance(existing_source_urls, list) and existing_source_urls:
                    existing_urls = [
                        str(u).strip() for u in existing_source_urls if str(u).strip()
                    ]
                else:
                    existing_urls = [
                        str(existing_event.get("url") or existing_url).strip()
                    ]
                existing_url = existing_urls[0] if existing_urls else existing_url
            except Exception:
                existing_urls = [existing_url]

            reprocess_payload = dict(payload)
            reprocess_payload["url"] = existing_url
            reprocess_payload.pop("urls", None)
            reprocess_payload.pop("event_urls", None)
            reprocess_payload.pop("event_sources", None)
            reprocess_payload.pop("event_name", None)
            reprocess_payload["output_dir"] = str(final_output_dir)
            reprocess_config = _build_main_config(reprocess_payload)
            reprocess_run_dir = temp_dir_path / "existing_reprocess" / "run"
            reprocess_result = _run_main_process(
                project_root,
                main_py,
                reprocess_config,
                reprocess_payload,
                reprocess_run_dir,
            )
            run_results.append(reprocess_result)
            if reprocess_result["status"] != "ok":
                return {
                    "status": "error",
                    "job": "run_main_pipeline",
                    "timestamp": _utc_now_iso(),
                    "mode": "multi_event",
                    "returncode": reprocess_result["returncode"],
                    "project_root": str(project_root),
                    "config_used": base_config,
                    "source_results": run_results,
                    "stdout": str(reprocess_result.get("stdout", "")),
                    "stderr": str(reprocess_result.get("stderr", "")),
                }

            existing_output = temp_dir_path / "existing_reprocessed" / "output"
            shutil.copytree(final_output_dir, existing_output)
            source_outputs.append({"url": existing_url, "output_dir": str(existing_output)})
            urls_to_crawl = [url for url in urls if url not in existing_urls]

        for index, url in enumerate(urls_to_crawl, start=1):
            source_output = temp_dir_path / f"source_{index:02d}" / "output"
            source_payload = dict(payload)
            source_payload["url"] = url
            source_payload.pop("urls", None)
            source_payload.pop("event_urls", None)
            source_payload.pop("event_sources", None)
            source_payload.pop("event_name", None)
            source_payload.pop("map_url", None)
            source_payload.pop("map_urls", None)
            if has_event_sources:
                source_payload.pop("catalog_additional_prompt", None)
            source_payload["reprocess"] = False
            settings = source_settings.get(url)
            if settings:
                map_urls = settings.get("map_urls")
                if isinstance(map_urls, list) and map_urls:
                    source_payload["map_urls"] = map_urls
                    source_payload["map_url"] = map_urls[0]
                if "catalog_additional_prompt" in settings:
                    source_payload["catalog_additional_prompt"] = settings[
                        "catalog_additional_prompt"
                    ]
            source_payload["output_dir"] = str(source_output)
            source_config = _build_main_config(source_payload)
            run_dir = temp_dir_path / f"source_{index:02d}" / "run"
            result = _run_main_process(
                project_root, main_py, source_config, source_payload, run_dir
            )
            run_results.append(result)
            source_outputs.append({"url": url, "output_dir": str(source_output)})
            if result["status"] != "ok":
                return {
                    "status": "error",
                    "job": "run_main_pipeline",
                    "timestamp": _utc_now_iso(),
                    "mode": "multi_event",
                    "returncode": result["returncode"],
                    "project_root": str(project_root),
                    "config_used": base_config,
                    "source_results": run_results,
                    "stdout": "\n".join(str(r.get("stdout", "")) for r in run_results),
                    "stderr": "\n".join(str(r.get("stderr", "")) for r in run_results),
                }

        merged = _merge_multi_event_outputs(
            source_outputs,
            final_output_dir,
            final_event_name=str(payload.get("event_name") or "").strip() or None,
        )

        twitter_processing = _aggregate_twitter_processing_results(run_results)
        if twitter_processing:
            merged.setdefault("metadata", {})["twitter_processing"] = twitter_processing
            (final_output_dir / "event.json").write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    result = {
        "status": "ok",
        "job": "run_main_pipeline",
        "timestamp": _utc_now_iso(),
        "mode": "multi_event",
        "returncode": 0,
        "project_root": str(project_root),
        "config_used": base_config,
        "source_results": run_results,
        "merged_circle_count": len(merged.get("circles") or []),
        "merged_source_count": len(merged.get("event", {}).get("source_events") or []),
        "stdout": "\n".join(str(r.get("stdout", "")) for r in run_results),
        "stderr": "\n".join(str(r.get("stderr", "")) for r in run_results),
    }
    if twitter_processing:
        result["twitter_processing"] = twitter_processing
    return result


def _job_run_main_pipeline(payload: Dict[str, Any]) -> Dict[str, Any]:
    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    main_py = project_root / "main.py"
    if not main_py.exists():
        raise FileNotFoundError(f"main.py not found under project_root: {project_root}")

    urls = _payload_url_list(payload)
    if len(urls) > 1 and not payload.get("reprocess"):
        return _job_run_multi_main_pipeline(payload, project_root, main_py, urls)

    config = _build_main_config(payload)

    with tempfile.TemporaryDirectory(prefix="eventtrail-studio-") as temp_dir:
        temp_dir_path = Path(temp_dir)
        config_path = temp_dir_path / "config.yaml"
        config_path.write_text(
            yaml.safe_dump(config, allow_unicode=True), encoding="utf-8"
        )

        cmd = [sys.executable, str(main_py)]
        if payload.get("verbose"):
            cmd.append("--verbose")
        if payload.get("reprocess"):
            cmd.append("--reprocess")
        if payload.get("regenerate_coordinates"):
            cmd.append("--regenerate-coordinates")

        env = os.environ.copy()
        existing_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (
            str(project_root)
            if not existing_pythonpath
            else f"{project_root}{os.pathsep}{existing_pythonpath}"
        )

        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(temp_dir_path),
            env=env,
        )

        # stderrを1行ずつ読んで自身のstderrにリアルタイム転送
        stderr_lines: List[str] = []
        stdout_output = ""
        try:
            for line in proc.stderr:
                line_stripped = line.rstrip("\n").rstrip("\r")
                stderr_lines.append(line_stripped)
                sys.stderr.write(line_stripped + "\n")
                sys.stderr.flush()

            stdout_output = proc.stdout.read()
            proc.wait()
        finally:
            _terminate_process_tree(proc)

        result = {
            "status": "ok" if proc.returncode == 0 else "error",
            "job": "run_main_pipeline",
            "timestamp": _utc_now_iso(),
            "returncode": proc.returncode,
            "command": cmd,
            "cwd": str(temp_dir_path),
            "project_root": str(project_root),
            "config_used": config,
            "stdout": stdout_output,
            "stderr": "\n".join(stderr_lines),
        }
        coordinate_diagnostics = _collect_coordinate_diagnostics(config.get("output_dir"))
        if coordinate_diagnostics is not None:
            result["coordinate_generation"] = coordinate_diagnostics
            if (
                payload.get("regenerate_coordinates")
                and coordinate_diagnostics.get("status") == "failed"
                and proc.returncode == 0
            ):
                # 古い main.py が座標失敗を0で返してもGUIでは成功扱いにしない。
                result["status"] = "error"
                result["returncode"] = 1
                result["stderr"] += "\n座標生成が全マップで失敗しました。"
        twitter_processing = _extract_twitter_processing_result(stderr_lines)
        if twitter_processing:
            result["twitter_processing"] = twitter_processing
        return result


def _job_reprocess_circle_from_post(payload: Dict[str, Any]) -> Dict[str, Any]:
    """特定サークルをXポストURLから再処理する。

    Required payload:
        event_json: event.jsonのパス
        circle_index: 対象サークルのindex (circles配列内)
        post_url: X/TwitterのポストURL (例: https://x.com/user/status/1234567890)
        output_dir: 画像保存先ディレクトリ (通常はイベントディレクトリ)

    Optional payload:
        project_root, model, image_llm_provider,
        catalog_additional_prompt, event_date
    """
    import re

    event_json = payload.get("event_json")
    circle_index = payload.get("circle_index")
    post_url = payload.get("post_url")
    output_dir = payload.get("output_dir")

    for key, val in [
        ("event_json", event_json),
        ("post_url", post_url),
        ("output_dir", output_dir),
    ]:
        if not val:
            raise ValueError(f"Missing required payload field: {key}")
    if circle_index is None:
        raise ValueError("Missing required payload field: circle_index")

    # ポストURLからtweet_idを抽出
    match = re.search(r"(?:twitter\.com|x\.com)/[^/]+/status(?:es)?/(\d+)", str(post_url))
    if not match:
        raise ValueError(f"Invalid post URL (tweet_id not found): {post_url}")
    tweet_id = match.group(1)

    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    proj_str = str(project_root)
    if proj_str not in sys.path:
        sys.path.insert(0, proj_str)

    # .envをロード（APIキー用）
    try:
        from dotenv import load_dotenv
        load_dotenv(project_root / ".env")
    except ImportError:
        pass

    json_path = Path(event_json)
    if not json_path.exists():
        raise FileNotFoundError(f"event.json not found: {json_path}")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    circles = data.get("circles", [])
    idx = int(circle_index)
    if idx < 0 or idx >= len(circles):
        raise ValueError(f"circle_index out of range: {idx} (circles={len(circles)})")

    circle_identity = payload.get("circle_identity") or {}
    if not any(
        str(circle_identity.get(key) or "").strip()
        for key in ("name", "penname", "space", "hall")
    ):
        circle_identity = {}
    circle_dict = circles[idx]

    def _matches_identity(candidate: Dict[str, Any], identity: Dict[str, Any]) -> bool:
        checks = [
            ("name", "name"),
            ("penname", "penname"),
            ("space", "space"),
            ("hall", "hall"),
        ]
        matched_any = False
        for identity_key, circle_key in checks:
            expected = str(identity.get(identity_key) or "").strip()
            if not expected:
                continue
            matched_any = True
            actual = str(candidate.get(circle_key) or "").strip()
            if actual != expected:
                return False
        return matched_any

    def _resolve_latest_circle_index(
        latest_circles: List[Dict[str, Any]],
        preferred_idx: int,
        identity: Dict[str, Any],
    ) -> int:
        if 0 <= preferred_idx < len(latest_circles):
            if not identity or _matches_identity(latest_circles[preferred_idx], identity):
                return preferred_idx
        if identity:
            matches = [
                i
                for i, candidate in enumerate(latest_circles)
                if isinstance(candidate, dict) and _matches_identity(candidate, identity)
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise ValueError(
                    "circle_identity matched multiple circles; cannot apply reprocess result safely"
                )
        raise ValueError(
            f"target circle was changed or removed while reprocessing: index={preferred_idx}"
        )

    # Circleオブジェクト構築（更新対象フィールドのみ）
    from src.models import Circle, ItemImage
    from src.processors.twitter_post_processor import TwitterPostProcessor, TwitterConfig
    import asyncio

    circle_obj = Circle(
        name=circle_dict.get("name", ""),
        penname=circle_dict.get("penname"),
        space=circle_dict.get("space"),
        hall=circle_dict.get("hall"),
        twitter_url=circle_dict.get("twitter_url"),
        items=list(circle_dict.get("items", [])),
        memo=circle_dict.get("memo", "") or "",
        existing_only_status=circle_dict.get("existing_only_status"),
        catalog_status=circle_dict.get("catalog_status"),
    )
    # item_imagesはdict→ItemImageに変換
    for img_dict in circle_dict.get("item_images", []) or []:
        if isinstance(img_dict, dict) and img_dict.get("path"):
            circle_obj.item_images.append(
                ItemImage(path=img_dict["path"], source=img_dict.get("source", "unknown"))
            )

    twitter_config = TwitterConfig({
        "enabled": True,
        "model": payload.get("model", "gemini-pro"),
        "text_llm_provider": payload.get("text_llm_provider", "api"),
        "text_llm_cli_models": payload.get("text_llm_cli_models", {}),
        "text_llm_cli_efforts": payload.get("text_llm_cli_efforts", {}),
        "text_fallback_llm_provider": payload.get("text_fallback_llm_provider"),
        "text_fallback_llm_model": payload.get("text_fallback_llm_model"),
        "text_fallback_llm_effort": payload.get("text_fallback_llm_effort"),
        "output_dir": output_dir,
        "image_llm_provider": payload.get("image_llm_provider"),
        "image_llm_model": payload.get("image_llm_model"),
        "image_llm_effort": payload.get(
            "image_llm_effort",
            payload.get("api_reasoning_effort", "medium"),
        ),
        "image_fallback_llm_provider": payload.get("image_fallback_llm_provider"),
        "image_fallback_llm_model": payload.get("image_fallback_llm_model"),
        "image_fallback_llm_effort": payload.get("image_fallback_llm_effort"),
        "image_api_reasoning_effort_map": payload.get(
            "image_api_reasoning_effort_map", {}
        ),
        "tweet_llm_cli_providers": payload.get("tweet_llm_cli_providers", []),
        "tweet_llm_cli_models": payload.get(
            "tweet_llm_cli_models",
            {"codex": "gpt-5.3-codex"},
        ),
        "tweet_llm_cli_efforts": payload.get("tweet_llm_cli_efforts", {}),
        "tweet_llm_cli_timeout": payload.get("tweet_llm_cli_timeout", 900),
        "api_reasoning_effort": payload.get("api_reasoning_effort", "medium"),
        "api_reasoning_effort_map": payload.get("api_reasoning_effort_map", {}),
        "catalog_additional_prompt": payload.get("catalog_additional_prompt", ""),
        "event_date": payload.get("event_date"),
    })
    processor = TwitterPostProcessor(twitter_config)

    event_name = data.get("event", {}).get("name", "")

    async def _run() -> Dict[str, bool]:
        before_images = [
            (img.path, img.source)
            for img in circle_obj.item_images
        ]
        updated = await processor.process_circle_from_post_url(
            circle_obj,
            post_url,
            event_name,
            use_text_detail=True,
        )
        after_images = [
            (img.path, img.source)
            for img in circle_obj.item_images
        ]
        return {
            "updated": bool(updated),
            "image_updated": before_images != after_images,
        }

    run_result = asyncio.run(_run())
    success = bool(run_result.get("updated"))

    # 更新結果をパッチ化する。完了時に最新event.jsonへ差し込み、並行編集を巻き戻さない。
    circle_patch: Dict[str, Any] = {}
    if success or circle_obj.items or circle_obj.catalog_status or circle_obj.existing_only_status:
        circle_patch["items"] = list(circle_obj.items)
        if circle_obj.catalog_status:
            circle_patch["catalog_status"] = circle_obj.catalog_status
        if circle_obj.existing_only_status:
            circle_patch["existing_only_status"] = circle_obj.existing_only_status
        # item_imagesはdictに直す（新規追加分のみ置換ではなく、既存と合体しても良いが
        # 「そのポストで差し替え」の意図を踏まえ item_imagesは新規結果で置換）
        if circle_obj.item_images:
            circle_patch["item_images"] = [
                {"path": img.path, "source": img.source} for img in circle_obj.item_images
            ]

    # memoにポストURLを追記（成功/失敗に関わらず記録）
    existing_memo = circle_dict.get("memo", "") or ""
    if post_url not in existing_memo:
        circle_patch["memo"] = (existing_memo + "\n" + post_url) if existing_memo else post_url

    # 保存直前に最新のevent.jsonを読み直し、対象サークルだけへ反映する。
    latest_data = json.loads(json_path.read_text(encoding="utf-8"))
    latest_circles = latest_data.get("circles", [])
    if not isinstance(latest_circles, list):
        raise ValueError("event.json circles must be a list")
    resolved_idx = _resolve_latest_circle_index(latest_circles, idx, circle_identity)
    latest_circle = latest_circles[resolved_idx]
    if not isinstance(latest_circle, dict):
        raise ValueError(f"target circle is not an object: index={resolved_idx}")
    _apply_missing_circle_cut_from_catalog(
        project_root,
        output_dir,
        latest_circle,
        circle_patch,
    )
    latest_circle.update(circle_patch)
    _write_json_atomic(json_path, latest_data)

    return {
        "status": "ok",
        "job": "reprocess_circle_from_post",
        "timestamp": _utc_now_iso(),
        "event_json": str(json_path),
        "circle_index": resolved_idx,
        "requested_circle_index": idx,
        "circle_name": latest_circle.get("name", ""),
        "tweet_id": tweet_id,
        "post_url": post_url,
        "image_updated": bool(run_result.get("image_updated")),
        "items_count": len(latest_circle.get("items", [])),
        "updated_circle": latest_circle,
    }


def _job_reprocess_circle_from_image(payload: Dict[str, Any]) -> Dict[str, Any]:
    """特定サークルをローカルおしながき画像から再処理する。"""

    event_json = payload.get("event_json")
    circle_index = payload.get("circle_index")
    image_path = payload.get("image_path")
    image_filename = payload.get("image_filename")

    for key, val in [
        ("event_json", event_json),
        ("image_path", image_path),
    ]:
        if not val:
            raise ValueError(f"Missing required payload field: {key}")
    if circle_index is None:
        raise ValueError("Missing required payload field: circle_index")

    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    proj_str = str(project_root)
    if proj_str not in sys.path:
        sys.path.insert(0, proj_str)

    try:
        from dotenv import load_dotenv
        load_dotenv(project_root / ".env")
    except ImportError:
        pass

    json_path = Path(event_json)
    if not json_path.exists():
        raise FileNotFoundError(f"event.json not found: {json_path}")

    local_image_path = Path(str(image_path))
    if not local_image_path.exists():
        raise FileNotFoundError(f"image file not found: {local_image_path}")
    if not image_filename:
        image_filename = local_image_path.name

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    circles = data.get("circles", [])
    idx = int(circle_index)
    if idx < 0 or idx >= len(circles):
        raise ValueError(f"circle_index out of range: {idx} (circles={len(circles)})")

    circle_identity = payload.get("circle_identity") or {}
    if not any(
        str(circle_identity.get(key) or "").strip()
        for key in ("name", "penname", "space", "hall")
    ):
        circle_identity = {}
    circle_dict = circles[idx]
    existing_items = list(circle_dict.get("items", []) or [])
    previous_images = list(circle_dict.get("item_images", []) or [])

    from src.utils.catalog_image_analyzer import CatalogImageAnalyzer
    from src.utils.llm_attempts import api_models_from_attempts, build_image_llm_attempts

    raw_model = payload.get("model", "gemini-pro")
    primary_model = (
        [m.strip() for m in raw_model.split(",") if m.strip()][0]
        if isinstance(raw_model, str) and "," in raw_model
        else raw_model
    )
    image_attempts = build_image_llm_attempts(
        payload.get("image_llm_provider"),
        payload.get("image_llm_model") or primary_model,
        payload.get("image_llm_effort", payload.get("api_reasoning_effort", "medium")),
        payload.get("image_fallback_llm_provider"),
        payload.get("image_fallback_llm_model"),
        payload.get("image_fallback_llm_effort"),
    )
    has_image_cli = any(attempt.get("kind") == "cli" for attempt in image_attempts)
    analyzer = CatalogImageAnalyzer(
        model=api_models_from_attempts(image_attempts),
        use_cli=has_image_cli,
        api_reasoning_effort=payload.get(
            "image_llm_effort",
            payload.get("api_reasoning_effort", "medium"),
        ),
        api_reasoning_effort_map=payload.get("image_api_reasoning_effort_map", {}),
        attempts=image_attempts,
    )

    detected_items = analyzer.analyze_catalog_items(local_image_path) or []
    for item in detected_items:
        if isinstance(item, dict) and not item.get("image"):
            item["image"] = image_filename

    merged_items = _merge_catalog_items(existing_items, detected_items)
    circle_patch: Dict[str, Any] = {
        "items": merged_items,
        "item_images": [{"path": image_filename, "source": "local"}],
        "catalog_status": "confirmed" if detected_items else "no_extractable_items",
    }

    latest_data = json.loads(json_path.read_text(encoding="utf-8"))
    latest_circles = latest_data.get("circles", [])
    if not isinstance(latest_circles, list):
        raise ValueError("event.json circles must be a list")
    resolved_idx = _resolve_latest_circle_index(latest_circles, idx, circle_identity)
    latest_circle = latest_circles[resolved_idx]
    if not isinstance(latest_circle, dict):
        raise ValueError(f"target circle is not an object: index={resolved_idx}")
    _apply_missing_circle_cut_from_catalog(
        project_root,
        str(local_image_path.parent),
        latest_circle,
        circle_patch,
    )
    latest_circle.update(circle_patch)
    _write_json_atomic(json_path, latest_data)

    image_updated = previous_images != circle_patch["item_images"]
    return {
        "status": "ok",
        "job": "reprocess_circle_from_image",
        "timestamp": _utc_now_iso(),
        "event_json": str(json_path),
        "circle_index": resolved_idx,
        "requested_circle_index": idx,
        "circle_name": latest_circle.get("name", ""),
        "image_filename": image_filename,
        "image_path": str(local_image_path),
        "image_updated": image_updated,
        "detected_items_count": len(detected_items),
        "items_count": len(latest_circle.get("items", [])),
        "updated_circle": latest_circle,
    }


def _job_load_event_json(payload: Dict[str, Any]) -> Dict[str, Any]:
    event_json = payload.get("event_json")
    if not event_json:
        raise ValueError("Missing required payload field: event_json")

    path = Path(event_json)
    if not path.exists():
        raise FileNotFoundError(f"event.json not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8"))

    return {
        "status": "ok",
        "job": "load_event_json",
        "timestamp": _utc_now_iso(),
        "event_json": str(path),
        "data": data,
    }


def _job_save_event_json(payload: Dict[str, Any]) -> Dict[str, Any]:
    event_json = payload.get("event_json")
    data = payload.get("data")
    if not event_json:
        raise ValueError("Missing required payload field: event_json")
    if data is None:
        raise ValueError("Missing required payload field: data")

    path = Path(event_json)
    _write_json_atomic(path, data)

    circle_count = len(data.get("circles", []))
    return {
        "status": "ok",
        "job": "save_event_json",
        "timestamp": _utc_now_iso(),
        "event_json": str(path),
        "saved_circles": circle_count,
    }


def _job_validate_mobile_json(payload: Dict[str, Any]) -> Dict[str, Any]:
    json_file = payload.get("json_file")
    if not json_file:
        raise ValueError("Missing required payload field: json_file")

    path = Path(json_file)
    if not path.exists():
        raise FileNotFoundError(f"JSON file not found: {path}")

    data = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    warnings = []
    image_counts = {
        "map_image_data": 0,
        "circle_cut_data": 0,
        "item_image_data": 0,
    }

    if not isinstance(data, dict):
        errors.append("ルートがオブジェクトではありません")
    else:
        for k in ["event", "circles", "metadata"]:
            if k not in data:
                errors.append(f"必須キー不足: {k}")

        event_maps = (
            data.get("event", {}).get("maps", [])
            if isinstance(data.get("event"), dict)
            else []
        )
        if isinstance(event_maps, list):
            for m in event_maps:
                if isinstance(m, dict) and m.get("image_data"):
                    image_counts["map_image_data"] += 1

        circles = data.get("circles", [])
        if not isinstance(circles, list):
            errors.append("circles が配列ではありません")
        else:
            for i, c in enumerate(circles):
                if not isinstance(c, dict):
                    errors.append(f"circles[{i}] がオブジェクトではありません")
                    continue
                if "name" not in c:
                    errors.append(f"circles[{i}] name が不足")
                for compat_key in [
                    "pin_x",
                    "pin_y",
                    "map_number",
                    "absence_status",
                    "existing_only_status",
                ]:
                    if compat_key not in c:
                        warnings.append(f"circles[{i}] {compat_key} が不足")

                if c.get("circle_cut_data"):
                    image_counts["circle_cut_data"] += 1
                for img in (
                    c.get("item_images", [])
                    if isinstance(c.get("item_images"), list)
                    else []
                ):
                    if isinstance(img, dict) and img.get("image_data"):
                        image_counts["item_image_data"] += 1

    total_embedded = sum(image_counts.values())
    if total_embedded == 0:
        warnings.append(
            "画像埋め込み（image_data）が検出されませんでした。モバイル連携で画像が欠ける可能性があります"
        )

    return {
        "status": "ok" if not errors else "error",
        "job": "validate_mobile_json",
        "timestamp": _utc_now_iso(),
        "json_file": str(path),
        "errors": errors,
        "warnings": warnings,
        "image_counts": image_counts,
    }


def _find_event_map_image(
    event_dir: Path,
    event_data: Dict[str, Any],
    map_number: int,
) -> Optional[Path]:
    event = event_data.get("event", {})
    if isinstance(event, dict):
        for event_map in event.get("maps", []) or []:
            if not isinstance(event_map, dict):
                continue
            try:
                entry_map_number = int(event_map.get("map_number") or 1)
            except (TypeError, ValueError):
                entry_map_number = 1
            if entry_map_number != map_number:
                continue
            filename = str(event_map.get("filename") or "").strip()
            if not filename:
                continue
            candidate = Path(filename)
            if not candidate.is_absolute():
                candidate = event_dir / filename
            if candidate.exists():
                return candidate

    for folder in [event_dir / "maps", event_dir]:
        for suffix in ["jpg", "jpeg", "png", "webp"]:
            candidate = folder / f"map_{map_number:02d}.{suffix}"
            if candidate.exists():
                return candidate
    return None


def _job_auto_place_map_pins(payload: Dict[str, Any]) -> Dict[str, Any]:
    event_json_value = payload.get("event_json")
    event_dir_value = payload.get("event_dir")
    map_number = int(payload.get("map_number") or 1)

    if event_json_value:
        event_json_path = Path(str(event_json_value))
        event_dir = event_json_path.parent
    elif event_dir_value:
        event_dir = Path(str(event_dir_value))
        event_json_path = event_dir / "event.json"
    else:
        raise ValueError("Missing required payload field: event_json or event_dir")

    if not event_json_path.exists():
        raise FileNotFoundError(f"event.json not found: {event_json_path}")
    with open(event_json_path, "r", encoding="utf-8") as f:
        event_data = json.load(f)

    map_image_value = payload.get("map_image")
    map_image_path = Path(str(map_image_value)) if map_image_value else None
    if map_image_path is None:
        map_image_path = _find_event_map_image(event_dir, event_data, map_number)
    elif not map_image_path.is_absolute():
        map_image_path = event_dir / map_image_path
    if map_image_path is None or not map_image_path.exists():
        raise FileNotFoundError(f"map image not found for map_number={map_number}")

    model = str(
        payload.get("model")
        or payload.get("image_llm_model")
        or payload.get("fallback_model")
        or "gpt-5-mini"
    )
    output_json_path = event_dir / f"coordinates_map_{map_number}.json"

    # OCR設定は desktop.config.json 由来の ocr_config オブジェクト、または
    # 旧UI/CLI互換のフラットな unlimited_ocr_* キーのどちらでも受け付ける。
    ocr_config = payload.get("ocr_config")
    if not isinstance(ocr_config, dict):
        ocr_config = {}
    for payload_key, config_key in (
        ("unlimited_ocr_model", "model"),
        ("unlimited_ocr_model_path", "model_path"),
        ("unlimited_ocr_venv", "venv_path"),
        ("unlimited_ocr_hf_home", "hf_home"),
        ("unlimited_ocr_revision", "revision"),
        ("unlimited_ocr_device", "device"),
        ("unlimited_ocr_mode", "mode"),
        ("unlimited_ocr_strategy", "strategy"),
        ("unlimited_ocr_prompt", "prompt"),
    ):
        if payload_key in payload and payload[payload_key] not in (None, ""):
            ocr_config.setdefault(config_key, payload[payload_key])

    from src.space_locator import generate_coordinates_from_map
    from src.space_locator.json_updater import JSONUpdater

    generation_kwargs = {
        "image_path": str(map_image_path),
        "event_json_path": str(event_json_path),
        "output_json_path": str(output_json_path),
        "model": model,
        "map_number": map_number,
        "use_calibration": bool(payload.get("use_calibration", True)),
    }
    if ocr_config:
        generation_kwargs["ocr_config"] = ocr_config
    coord_map = generate_coordinates_from_map(**generation_kwargs)
    if coord_map is None:
        raw_diagnostics: Dict[str, Any] = {}
        try:
            failure_payload = json.loads(output_json_path.read_text(encoding="utf-8"))
            diagnostics = failure_payload.get("ocr_diagnostics")
            if isinstance(diagnostics, dict):
                raw_diagnostics = diagnostics
        except (OSError, ValueError, TypeError):
            pass
        ocr_diagnostics = _summarize_ocr_diagnostics(raw_diagnostics)
        error_code = ocr_diagnostics.get("error_code", "coordinate_generation_failed")
        error_message = f"map pin coordinate generation failed ({error_code})"
        if ocr_diagnostics.get("error_message"):
            error_message += f": {ocr_diagnostics['error_message']}"
        return {
            "status": "error",
            "job": "auto_place_map_pins",
            "timestamp": _utc_now_iso(),
            "error": error_message,
            "map_number": map_number,
            "ocr_diagnostics": ocr_diagnostics,
        }

    updater = JSONUpdater()
    update_result = updater.update_event_json(
        event_json_path=str(event_json_path),
        coordinate_map=coord_map.get("complete_grid", []),
        map_number=map_number,
    )

    return {
        "status": "ok",
        "job": "auto_place_map_pins",
        "timestamp": _utc_now_iso(),
        "event_json": str(event_json_path),
        "map_image": str(map_image_path),
        "map_number": map_number,
        "coordinate_json": str(output_json_path),
        "generated_count": len(coord_map.get("complete_grid", [])),
        "updated_count": update_result.get("updated_count", 0),
        "skipped_count": update_result.get("skipped_count", 0),
        "calibration": coord_map.get("calibration", {}),
        "ocr_diagnostics": coord_map.get("ocr_diagnostics", {}),
    }


def _job_unlimited_ocr_doctor(payload: Dict[str, Any]) -> Dict[str, Any]:
    """配布先PCのOCR専用venv・モデル設定をGUIから診断する。"""
    from src.space_locator.ocr_config import (
        DEFAULT_MODEL_CPU_UNSUPPORTED_REASON,
        UnlimitedOCRConfig,
        model_requires_cuda,
    )

    raw_config = payload.get("ocr_config")
    # GUIのフォームは空欄を「親環境の値を解除」として送るため、空欄を
    # stale env で補完しない。
    config = UnlimitedOCRConfig.from_mapping(
        raw_config if isinstance(raw_config, dict) else None,
        empty_overrides=isinstance(raw_config, dict),
    )
    repo_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    venv_dir = Path(
        config.venv_path
        or (
            repo_root / "temp" / "unlimited_ocr_venv"
            if isinstance(raw_config, dict)
            else os.environ.get("UNLIMITED_OCR_VENV", repo_root / "temp" / "unlimited_ocr_venv")
        )
    )
    python_path = venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    model_source = Path(config.model_path).expanduser() if config.model_path else None
    configured_hub_cache = "" if isinstance(raw_config, dict) else os.environ.get("HF_HUB_CACHE", "").strip()
    hf_home = Path(config.hf_home).expanduser() if config.hf_home else Path(
        repo_root / "temp" / "hf_cache"
        if isinstance(raw_config, dict)
        else os.environ.get("HF_HOME", repo_root / "temp" / "hf_cache")
    )
    hub_cache = Path(configured_hub_cache).expanduser() if configured_hub_cache else hf_home / "hub"
    model_cache = hub_cache / f"models--{config.model.replace('/', '--')}"
    cache_path = model_cache
    issues: list[str] = []

    def local_model_artifacts(path: Path) -> tuple[bool, list[str]]:
        if not path.is_dir():
            return False, ["directory"]
        missing: list[str] = []
        config_path = path / "config.json"
        if not config_path.is_file() or config_path.stat().st_size == 0:
            missing.append("config.json")
        else:
            try:
                if not isinstance(json.loads(config_path.read_text(encoding="utf-8")), dict):
                    missing.append("config.json(object)")
            except (OSError, ValueError, UnicodeError):
                missing.append("config.json(valid JSON)")
        if not any(
            candidate.is_file() and candidate.stat().st_size > 0
            for pattern in ("*.safetensors", "*.bin", "*.pt", "*.pth")
            for candidate in path.glob(pattern)
        ):
            missing.append("weights")
        if not any(
            (path / name).is_file() and (path / name).stat().st_size > 0
            for name in (
                "tokenizer.json", "tokenizer_config.json", "tokenizer.model", "spiece.model",
                "preprocessor_config.json", "processor_config.json",
            )
        ):
            missing.append("tokenizer/processor")
        return not missing, missing

    if not python_path.exists():
        issues.append(f"専用venvのPythonがありません: {python_path}")
    if model_source and not model_source.exists():
        issues.append(f"指定モデルパスがありません: {model_source}")
    elif model_source:
        model_ready, missing = local_model_artifacts(model_source)
        if not model_ready:
            issues.append(
                f"指定モデルパスに実ロード用ファイルが不足しています: {model_source} "
                f"({', '.join(missing)})"
            )
    if not model_source and not cache_path.exists():
        issues.append(f"モデルキャッシュがありません: {cache_path}")
    elif not model_source:
        snapshot = cache_path / "snapshots" / config.revision
        if not snapshot.is_dir():
            issues.append(f"指定revisionのモデルsnapshotがありません: {snapshot}")
        else:
            snapshot_ready, missing = local_model_artifacts(snapshot)
            if not snapshot_ready:
                issues.append(
                    f"モデルsnapshotに実ロード用ファイルが不足しています: {snapshot} "
                    f"({', '.join(missing)})"
                )

    torch_info: Dict[str, Any] = {}
    if python_path.exists():
        try:
            probe = subprocess.run(
                [str(python_path), "-c", "import torch; print(torch.__version__); print(torch.cuda.is_available())"],
                cwd=repo_root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
            )
            lines = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
            torch_info = {
                "returncode": probe.returncode,
                "version": lines[0] if lines else None,
                "cuda_available": any(line.lower() == "true" for line in lines),
                "stderr": probe.stderr[-1000:] if probe.returncode else "",
            }
            if probe.returncode != 0:
                issues.append("専用venvでtorchをimportできません")
            elif config.device == "cuda" and not torch_info.get("cuda_available"):
                issues.append("device=cuda ですが専用venvでCUDAが利用できません（fail-closed）")
        except (OSError, subprocess.TimeoutExpired) as exc:
            issues.append(f"専用venvの診断に失敗しました: {exc}")

    requires_cuda = model_requires_cuda(
        model=config.model,
        revision=config.revision,
        model_path=config.model_path,
    )
    if requires_cuda and config.device == "cpu":
        issues.append("device=cpu: " + DEFAULT_MODEL_CPU_UNSUPPORTED_REASON + "（fail-closed）")
    elif requires_cuda and config.device == "auto" and not torch_info.get("cuda_available"):
        issues.append("device=auto でCUDAを検出できません: " + DEFAULT_MODEL_CPU_UNSUPPORTED_REASON + "（fail-closed）")

    return {
        "status": "ok" if not issues else "error",
        "job": "unlimited_ocr_doctor",
        "ready": not issues,
        "issues": issues,
        "config": config.to_public_dict(),
        "python": str(python_path),
        "model_source": str(model_source or config.model),
        "hf_home": str(hf_home),
        "model_cache": str(cache_path),
        "model_cache_exists": cache_path.exists(),
        "model_requires_cuda": requires_cuda,
        "torch": torch_info,
        "timestamp": _utc_now_iso(),
    }


def _job_load_circle_master(payload: Dict[str, Any]) -> Dict[str, Any]:
    """circle_master.json を読み込んで返す"""
    from ..utils.circle_master import CircleMasterManager

    manager = CircleMasterManager()
    return {
        "status": "ok",
        "job": "load_circle_master",
        "timestamp": _utc_now_iso(),
        "data": manager.to_dict(),
    }


def _job_save_circle_master(payload: Dict[str, Any]) -> Dict[str, Any]:
    """circle_master.json を上書き保存する"""
    data = payload.get("data")
    if data is None:
        raise ValueError("Missing required payload field: data")
    from ..utils.circle_master import CircleMasterManager

    manager = CircleMasterManager()
    manager.data = data
    manager.save()
    return {
        "status": "ok",
        "job": "save_circle_master",
        "timestamp": _utc_now_iso(),
        "count": len(data.get("circles", {})),
    }


def _job_merge_circle_master(payload: Dict[str, Any]) -> Dict[str, Any]:
    """受け取ったデータを既存のcircle_masterとマージして保存する"""
    other_data = payload.get("data")
    if other_data is None:
        raise ValueError("Missing required payload field: data")
    from ..utils.circle_master import CircleMasterManager

    manager = CircleMasterManager()
    changed = manager.merge(other_data)
    manager.save()
    return {
        "status": "ok",
        "job": "merge_circle_master",
        "timestamp": _utc_now_iso(),
        "changed": changed,
        "total": len(manager.data.get("circles", {})),
    }


def _job_create_mobile_zip(payload: Dict[str, Any]) -> Dict[str, Any]:
    event_json_file = payload.get("event_json")
    output_dir = payload.get("output_dir")
    zip_output_path = payload.get("zip_output_path")

    for key, val in [
        ("event_json", event_json_file),
        ("output_dir", output_dir),
        ("zip_output_path", zip_output_path),
    ]:
        if not val:
            raise ValueError(f"Missing required payload field: {key}")

    json_path = Path(event_json_file)
    out_dir = Path(output_dir)
    zip_path = Path(zip_output_path)

    if not json_path.exists():
        raise FileNotFoundError(f"event.json not found: {json_path}")
    if not out_dir.exists():
        raise FileNotFoundError(f"Output directory not found: {out_dir}")

    # event.jsonを読み込み
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    circles = data.get("circles", [])

    # 画像ファイル名を抽出
    event_image_files: List[str] = []
    circle_image_files: List[str] = []
    item_image_files: List[str] = []

    event_info = data.get("event", {})
    if isinstance(event_info, dict):
        for key in ("event_image_filename", "event_image"):
            filename = event_info.get(key)
            if isinstance(filename, str) and filename.strip():
                event_image_files.append(filename.strip())

    for circle in circles:
        cut = circle.get("circle_cut_filename", "")
        if cut:
            circle_image_files.append(cut)
        for img in circle.get("item_images", []):
            path = img.get("path", "")
            if path:
                item_image_files.append(path)

    # マップ画像を収集
    map_image_files: List[str] = []
    for event_map in data.get("event", {}).get("maps", []) or []:
        if not isinstance(event_map, dict):
            continue
        filename = event_map.get("filename")
        if isinstance(filename, str) and filename.strip():
            map_image_files.append(filename.strip())
    for pattern in ["map_*.jpg", "map_*.png", "map_*.jpeg", "map_*.webp"]:
        for match in glob.glob(str(out_dir / pattern)):
            map_image_files.append(Path(match).name)

    # Resolve every referenced asset before opening the ZIP.  Absolute paths,
    # traversal segments, and symlinks escaping the owning root are rejected
    # instead of being silently skipped or copied from outside the event.
    from ..utils.circle_master import CircleMasterManager

    cm = CircleMasterManager()

    def prepare_asset(root: Path, ref: Any, archive_name: str, label: str) -> tuple[Path, str, Path]:
        if not isinstance(ref, str) or not ref.strip():
            raise ValueError(f"{label} asset reference must be a non-empty relative path")
        source_path, logical_ref = _resolve_contained_asset(root, ref, label=label)
        logical_archive = _safe_archive_path(archive_name)
        return source_path, logical_archive, root

    prepared_event_assets: List[tuple[Path, str, Path]] = []
    for fname in event_image_files:
        _source, logical_ref = _resolve_contained_asset(out_dir, fname, label="event image")
        archive_name = _safe_archive_path(
            f"event_image/{logical_ref.rsplit('/', 1)[-1]}"
        )
        prepared_event_assets.append((_source, archive_name, out_dir))

    prepared_circle_assets: List[tuple[Path, str, Path]] = []
    for fname in circle_image_files:
        _source, logical_ref, _root = prepare_asset(out_dir, fname, fname, "circle")
        prepared_circle_assets.append((_source, logical_ref, out_dir))

    prepared_item_assets: List[tuple[Path, str, Path]] = []
    for fname in item_image_files:
        _source, logical_ref, _root = prepare_asset(out_dir, fname, fname, "item")
        prepared_item_assets.append((_source, logical_ref, out_dir))

    prepared_map_assets: List[tuple[Path, str, Path]] = []
    for fname in map_image_files:
        _source, logical_ref, _root = prepare_asset(out_dir, fname, fname, "map")
        prepared_map_assets.append((_source, logical_ref, out_dir))

    prepared_default_assets: List[tuple[Path, str, Path]] = []
    if cm.cuts_dir.exists():
        cuts_root = cm.cuts_dir.resolve()
        for cut_path in cm.cuts_dir.iterdir():
            if not cut_path.is_file():
                continue
            relative_name = cut_path.relative_to(cm.cuts_dir).as_posix()
            _source, logical_ref, _root = prepare_asset(
                # Keep the legacy logical member based on the filename (the
                # mobile importer enumerates only the default_cuts root),
                # while still resolving the actual source relative to its
                # canonical root so nested files/symlinks cannot escape.
                cuts_root, relative_name, f"default_cuts/{cut_path.name}", "default cut"
            )
            prepared_default_assets.append((_source, logical_ref, cuts_root))

    zip_path.parent.mkdir(parents=True, exist_ok=True)

    circle_count = 0
    item_count = 0
    map_count = 0
    event_image_count = 0
    default_cut_count = 0

    asset_manifest: Dict[str, Any] = {
        "format": "eventtrail_asset_manifest",
        "format_version": 1,
        "assets": {},
        "aliases": {},
    }
    added_assets: set[str] = set()

    def add_asset(
        zf: zipfile.ZipFile,
        source_path: Path,
        archive_name: str,
        source_root: Path,
    ) -> bool:
        # Re-resolve at copy time as well as preflight time to close a symlink
        # swap TOCTOU window between validation and ZIP insertion.
        try:
            relative_ref = source_path.resolve().relative_to(source_root.resolve()).as_posix()
        except ValueError as exc:
            raise ValueError(f"asset escapes owning root: {source_path}") from exc
        source_path, _ = _resolve_contained_asset(
            source_root, relative_ref, label="asset"
        )
        logical_name = _safe_archive_path(archive_name)
        if not source_path.exists() or not source_path.is_file():
            return False
        digest = hashlib.sha256()
        with open(source_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        content_hash = digest.hexdigest()
        ext = source_path.suffix.lower() or Path(logical_name).suffix.lower() or ".bin"
        asset_name = f"assets/sha256/{content_hash[:2]}/{content_hash}{ext}"
        if asset_name not in added_assets:
            zf.write(str(source_path), asset_name)
            added_assets.add(asset_name)
        asset = asset_manifest["assets"].setdefault(
            content_hash,
            {
                "algorithm": "sha256",
                "hash": content_hash,
                "path": asset_name,
                "size": source_path.stat().st_size,
                "original_names": [],
            },
        )
        if logical_name not in asset["original_names"]:
            asset["original_names"].append(logical_name)
        asset_manifest["aliases"][logical_name] = asset_name
        return True

    with _atomic_zipfile(zip_path) as zf:
        # event.json
        zf.writestr("event.json", json.dumps(data, ensure_ascii=False, indent=2))

        # circle_master.json（サークルマスターデータ）
        zf.writestr(
            "circle_master.json", json.dumps(cm.to_dict(), ensure_ascii=False, indent=2)
        )

        for source_path, archive_name, source_root in prepared_default_assets:
            if add_asset(zf, source_path, archive_name, source_root):
                default_cut_count += 1

        for source_path, archive_name, source_root in prepared_event_assets:
            if add_asset(zf, source_path, archive_name, source_root):
                event_image_count += 1

        for source_path, archive_name, source_root in prepared_circle_assets:
            if add_asset(zf, source_path, archive_name, source_root):
                circle_count += 1

        for source_path, archive_name, source_root in prepared_item_assets:
            if add_asset(zf, source_path, archive_name, source_root):
                item_count += 1

        for source_path, archive_name, source_root in prepared_map_assets:
            if add_asset(zf, source_path, archive_name, source_root):
                map_count += 1

        zf.writestr(
            "asset_manifest.json",
            json.dumps(asset_manifest, ensure_ascii=False, indent=2),
        )

    total_size = zip_path.stat().st_size

    return {
        "status": "ok",
        "job": "create_mobile_zip",
        "timestamp": _utc_now_iso(),
        "zip_path": str(zip_path),
        "event_images": event_image_count,
        "circle_images": circle_count,
        "item_images": item_count,
        "map_images": map_count,
        "default_cuts": default_cut_count,
        "total_size": total_size,
    }


_FULL_SYNC_FORMAT = "eventtrail_full_sync"
# `format_version` is intentionally kept at 1 in the full-sync manifest.  The
# current mobile importer (and older released importers) treat this field as a
# capability gate, so changing it would make an otherwise complete payload
# unreadable.  New importers can opt into the additive v2 fields via
# `manifest_version`/`capabilities` below.
_FULL_SYNC_LEGACY_FORMAT_VERSION = 1
_FULL_SYNC_MANIFEST_VERSION = 2
_EVENT_UID_NAMESPACE = uuid.UUID("3f0f71f7-5f07-4e5c-9ad9-8f2f9a5f1c4a")


def _canonical_json_bytes(value: Any) -> bytes:
    """Return deterministic JSON bytes for hashes and manifest metadata.

    Event JSON is deliberately *not* rewritten with this representation.  It
    is used only for derived values, keeping unknown fields and the original
    on-disk bytes untouched in the sync archive.
    """

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _first_event_identifier(value: Any) -> Optional[str]:
    """Find an explicit stable identifier without interpreting arbitrary data.

    Existing event files have appeared with both root-level and ``event`` /
    ``metadata`` identifiers.  Keep this lookup narrow so an item/circle's
    generic ``id`` cannot accidentally become the event identity.
    """

    if not isinstance(value, dict):
        return None
    for key in (
        "event_uid",
        "event_id",
        "event_uuid",
        "stable_event_uid",
        "stable_uid",
        "uuid",
    ):
        candidate = value.get(key)
        if candidate not in (None, "") and not isinstance(candidate, (dict, list)):
            return str(candidate).strip() or None

    # ``id`` is accepted only in the nested event object, where legacy
    # generators used it for the upstream event identifier.
    event = value.get("event")
    if isinstance(event, dict):
        for key in ("event_uid", "event_id", "event_uuid", "stable_uid", "uuid", "id"):
            candidate = event.get(key)
            if candidate not in (None, "") and not isinstance(candidate, (dict, list)):
                return str(candidate).strip() or None

    metadata = value.get("metadata")
    if isinstance(metadata, dict):
        for key in ("event_uid", "event_id", "event_uuid", "stable_uid", "uuid"):
            candidate = metadata.get(key)
            if candidate not in (None, "") and not isinstance(candidate, (dict, list)):
                return str(candidate).strip() or None
    return None


def _stable_event_uid(event_data: Any, event_dir: Optional[Path] = None) -> str:
    """Return a slug-independent deterministic UID for an event.

    Prefer an explicit ID authored by the source data.  For older event files,
    derive a UUID5 from durable event identity fields (URL/date/name/venue and
    creation timestamp).  The directory slug is deliberately never included;
    a user can rename ``events/<slug>`` without changing the mobile event key.
    As a final fallback the complete parsed JSON is used, which still avoids a
    slug dependency and preserves deterministic behaviour for legacy/minimal
    files.  The desktop owner-aware preflight persists this initial value before
    invoking the read-only full-sync generator, so later metadata edits retain
    the same identifier.
    """

    explicit = _first_event_identifier(event_data)
    if explicit:
        seed = {"kind": "explicit", "value": explicit}
    else:
        root = event_data if isinstance(event_data, dict) else {}
        event = root.get("event") if isinstance(root.get("event"), dict) else {}
        # Include all common URL spellings as a sorted list.  URL is the
        # strongest identity signal for generated events, while the remaining
        # fields keep offline/manual events distinct.
        urls: list[str] = []
        for key in ("url", "event_url", "source_url"):
            value = event.get(key)
            if isinstance(value, str) and value.strip():
                urls.append(value.strip())
        for key in ("urls", "event_urls", "source_urls"):
            value = event.get(key)
            if isinstance(value, str) and value.strip():
                urls.append(value.strip())
            elif isinstance(value, list):
                urls.extend(str(item).strip() for item in value if str(item).strip())
        urls = sorted(set(urls))
        identity = {
            "url": urls,
            "date": event.get("date"),
            "name": event.get("name"),
            "venue": event.get("venue"),
            "organizer": event.get("organizer"),
            "created_at": event.get("created_at"),
        }
        if any(value not in (None, "", [], {}) for value in identity.values()):
            seed = {"kind": "identity", "value": identity}
        else:
            # No usable metadata (e.g. a hand-written minimal fixture).  The
            # content is still independent of the on-disk slug.
            seed = {"kind": "content", "value": root}

    return uuid.uuid5(_EVENT_UID_NAMESPACE, _canonical_json_bytes(seed).decode("utf-8")).hex


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_archive_path(path: str) -> str:
    """Normalize a relative ZIP member and reject traversal/absolute paths."""

    normalized = str(path).replace("\\", "/")
    if "\x00" in normalized:
        raise ValueError("archive path contains NUL byte")
    # Drive-qualified/drive-relative and UNC paths are not safe archive
    # members even when running on POSIX (``C:foo`` is drive-relative on
    # Windows and must not be treated as a normal logical name).
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or normalized.startswith("//"):
        raise ValueError(f"archive path must be relative: {path}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ValueError(f"archive path traversal is not allowed: {path}")
    if not parts:
        raise ValueError("archive path is empty")
    return "/".join(parts)


def _resolve_contained_asset(
    root: Path, reference: str, *, label: str
) -> tuple[Path, str]:
    """Resolve an asset reference while enforcing root containment.

    ``Path(root) / absolute`` resets the root on Windows, and ``..``/symlink
    paths can escape it on every platform.  Normalize and validate the
    logical reference before joining, then resolve the candidate to catch
    symlinks that point outside the owning output/default-cuts directory.
    """

    if not isinstance(reference, str) or not reference.strip():
        raise ValueError(f"{label} asset reference must be a non-empty relative path")
    logical = _safe_archive_path(reference.strip())
    root_resolved = root.resolve()
    candidate = root_resolved.joinpath(*logical.split("/"))
    candidate_resolved = candidate.resolve(strict=False)
    try:
        candidate_resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError(
            f"{label} asset escapes owning directory: {reference}"
        ) from exc
    return candidate_resolved, logical


def _event_asset_entries(event_dir: Path, skip_path: Path) -> List[Dict[str, Any]]:
    """Collect deterministic content metadata for every event-directory file."""

    entries: List[Dict[str, Any]] = []
    event_root = event_dir.resolve()
    skip_resolved = skip_path.resolve()
    event_json_resolved = (event_dir / "event.json").resolve()
    for file_path in sorted(event_dir.rglob("*"), key=lambda item: item.as_posix()):
        if not file_path.is_file():
            continue
        resolved = file_path.resolve()
        if (
            resolved in (skip_resolved, event_json_resolved)
            or file_path.suffix.lower() == ".zip"
        ):
            continue
        # Do not follow a symlink outside the event root.  Such a file would
        # otherwise make the manifest/hash depend on arbitrary host content.
        try:
            resolved.relative_to(event_root)
        except ValueError as exc:
            raise ValueError(f"event asset escapes event directory: {file_path}") from exc
        rel = _safe_archive_path(file_path.relative_to(event_dir).as_posix())
        entries.append(
            {
                "path": rel,
                "algorithm": "sha256",
                "hash": _sha256_file(file_path),
                "size": file_path.stat().st_size,
            }
        )
    return entries


def _asset_set_hash(asset_entries: Iterable[Dict[str, Any]]) -> str:
    """Hash the sorted logical-path/content set for one event."""

    sorted_entries = sorted(
        (
            {
                "path": str(entry.get("path") or ""),
                "algorithm": str(entry.get("algorithm") or "sha256"),
                "hash": str(entry.get("hash") or ""),
                "size": int(entry.get("size") or 0),
            }
            for entry in asset_entries
        ),
        key=lambda entry: entry["path"],
    )
    return hashlib.sha256(_canonical_json_bytes(sorted_entries)).hexdigest()


def _event_content_hash(
    event_data: Any, asset_entries: Optional[Iterable[Dict[str, Any]]] = None
) -> str:
    """Hash event JSON (including unknown fields) and, when supplied, assets.

    Passing the sorted asset descriptors makes the manifest's content hash
    change when an image/file changes while retaining a stable value across
    JSON formatting/key-order differences.
    """

    payload: Any = event_data
    if asset_entries is not None:
        payload = {
            "event": event_data,
            "assets": sorted(
                (
                    {
                        "path": str(entry.get("path") or ""),
                        "algorithm": str(entry.get("algorithm") or "sha256"),
                        "hash": str(entry.get("hash") or ""),
                        "size": int(entry.get("size") or 0),
                    }
                    for entry in asset_entries
                ),
                key=lambda entry: entry["path"],
            ),
        }
    return hashlib.sha256(_canonical_json_bytes(payload)).hexdigest()


def _zip_event_directory(
    zf: zipfile.ZipFile,
    event_dir: Path,
    archive_prefix: str,
    skip_path: Path,
) -> Dict[str, Any]:
    file_count = 0
    image_count = 0
    total_bytes = 0
    image_suffixes = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    asset_entries: List[Dict[str, Any]] = []
    archived_event_data: Optional[Dict[str, Any]] = None

    event_root = event_dir.resolve()
    skip_resolved = {skip_path.resolve()}
    temp_output = getattr(zf, "_eventtrail_temp_path", None)
    if temp_output:
        skip_resolved.add(Path(temp_output).resolve())
    for file_path in event_dir.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.resolve() in skip_resolved:
            continue
        if file_path.suffix.lower() == ".zip":
            continue
        is_event_json = file_path.resolve() == (event_dir / "event.json").resolve()

        try:
            discovered_lstat = file_path.lstat()
            # Resolve twice: the first result describes the path seen during
            # directory enumeration, while the second is the copy-time
            # identity check.  If a symlink is swapped between those points,
            # fail closed instead of following the new target.
            discovered_path = file_path.resolve(strict=True)
            discovered_path.relative_to(event_root)
            copy_path = file_path.resolve(strict=True)
            copy_path.relative_to(event_root)
            copy_lstat = file_path.lstat()
        except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
            raise ValueError(f"event asset escapes event directory: {file_path}") from exc
        if copy_path != discovered_path:
            raise ValueError(f"event asset changed during sync: {file_path}")
        if not os.path.samestat(discovered_lstat, copy_lstat):
            raise ValueError(f"event asset changed during sync: {file_path}")
        try:
            expected_stat = copy_path.stat()
        except OSError as exc:
            raise ValueError(f"event asset is not readable: {file_path}") from exc
        if not stat.S_ISREG(expected_stat.st_mode):
            raise ValueError(f"event asset is not a regular file: {file_path}")
        rel_path = _safe_archive_path(file_path.relative_to(event_dir).as_posix())
        member_name = _safe_archive_path(f"{archive_prefix}/{rel_path}")
        # Stream each file once through the ZIP writer while calculating its
        # digest.  The previous zf.write()+second traversal doubled disk I/O
        # for large full-sync bundles (hundreds of MB of images).
        digest = hashlib.sha256()
        size = 0
        captured_event_json = bytearray() if is_event_json else None
        # Open the resolved target rather than the original (possibly
        # symlinked) spelling.  Compare the descriptor identity after opening
        # so a regular file -> symlink swap between resolve() and os.open()
        # cannot leak bytes outside event_root.  On POSIX O_NOFOLLOW adds a
        # kernel-level final-component check; descriptor validation remains
        # useful on platforms without that flag (notably Windows).
        open_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        open_flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            source_fd = os.open(str(copy_path), open_flags)
        except OSError as exc:
            raise ValueError(f"event asset could not be opened safely: {file_path}") from exc
        try:
            actual_stat = os.fstat(source_fd)
            if not os.path.samestat(expected_stat, actual_stat):
                raise ValueError(f"event asset changed during sync: {file_path}")
            with os.fdopen(source_fd, "rb") as source, zf.open(
                member_name, "w", force_zip64=True
            ) as target:
                source_fd = -1
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    target.write(chunk)
                    size += len(chunk)
                    if captured_event_json is not None:
                        captured_event_json.extend(chunk)
        finally:
            if source_fd >= 0:
                os.close(source_fd)
        # event.json remains a complete logical payload for legacy importers,
        # but it is not an image/asset-set member (the event content hash
        # already covers its parsed JSON).
        if not is_event_json:
            asset_entries.append(
                {
                    "path": rel_path,
                    "algorithm": "sha256",
                    "hash": digest.hexdigest(),
                    "size": size,
                }
            )
        elif captured_event_json is not None:
            try:
                parsed_event = json.loads(bytes(captured_event_json).decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(f"archived event.json is invalid: {file_path}") from exc
            if not isinstance(parsed_event, dict):
                raise ValueError(f"archived event.json root must be an object: {file_path}")
            archived_event_data = parsed_event
        file_count += 1
        total_bytes += size
        if file_path.suffix.lower() in image_suffixes:
            image_count += 1

    return {
        "files": file_count,
        "images": image_count,
        "bytes": total_bytes,
        "assets": asset_entries,
        "event_data": archived_event_data,
    }


def _job_create_mobile_full_sync_zip(payload: Dict[str, Any]) -> Dict[str, Any]:
    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    zip_output_path = payload.get("zip_output_path")
    zip_path = (
        Path(zip_output_path)
        if zip_output_path
        else _default_mobile_full_sync_zip_path(project_root)
    )
    events_dir = project_root / "events"
    if not events_dir.exists():
        raise FileNotFoundError(f"events directory not found: {events_dir}")

    event_dirs = [
        p
        for p in sorted(events_dir.iterdir(), key=lambda item: item.name)
        if p.is_dir() and (p / "event.json").exists()
    ]

    zip_path.parent.mkdir(parents=True, exist_ok=True)
    zip_resolved = zip_path.resolve()
    bundle_events: List[Dict[str, Any]] = []
    event_count = 0
    file_count = 0
    image_count = 0
    default_cut_count = 0
    # Keep a top-level manifest in addition to the per-event hash fields.  It
    # is additive: logical event paths are still copied below, so old mobile
    # importers never need to understand content-addressed metadata.
    asset_manifest: Dict[str, Any] = {
        "format": "eventtrail_asset_manifest",
        "format_version": 1,
        "manifest_version": _FULL_SYNC_MANIFEST_VERSION,
        "algorithm": "sha256",
        "assets": {},
        "aliases": {},
        "events": {},
    }

    # UID persistence belongs to the desktop event owner lifecycle.  This
    # Python generator is deliberately read-only: it validates that preflight
    # completed before opening the atomic output archive and never rewrites an
    # event.json behind an open desktop session.
    prepared_events: List[tuple[Path, str]] = []
    for event_dir in event_dirs:
        event_json = event_dir / "event.json"
        try:
            event_data = json.loads(event_json.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"event.json is not readable valid JSON: {event_json}") from exc
        if not isinstance(event_data, dict):
            raise ValueError(f"event.json root must be an object: {event_json}")
        event_uid = _first_event_identifier(event_data)
        if not event_uid:
            raise ValueError(
                f"event UID is missing; run desktop full-sync preflight first: {event_json}"
            )
        prepared_events.append((event_dir, event_uid))

    with _atomic_zipfile(zip_path) as zf:
        for event_dir, event_uid in prepared_events:
            event_json = event_dir / "event.json"

            slug = event_dir.name
            archive_prefix = _safe_archive_path(f"events/{slug}")
            counts = _zip_event_directory(zf, event_dir, archive_prefix, zip_resolved)
            event_data = counts.get("event_data")
            if not isinstance(event_data, dict):
                raise ValueError(f"event.json was not archived: {event_json}")
            archived_uid = _first_event_identifier(event_data)
            if archived_uid != event_uid:
                raise ValueError(f"event UID changed during full sync: {event_json}")
            event_count += 1
            file_count += counts["files"]
            image_count += counts["images"]

            meta = event_data.get("event", {}) if isinstance(event_data, dict) else {}
            # _zip_event_directory computes content metadata while streaming
            # each file, avoiding a second full event-directory traversal.
            assets = counts.get("assets", [])
            content_hash = _event_content_hash(event_data, assets)
            asset_hash = _asset_set_hash(assets)
            event_asset_manifest: List[Dict[str, Any]] = []
            for asset in assets:
                logical_path = f"{archive_prefix}/{asset['path']}"
                manifest_asset = dict(asset)
                manifest_asset["path"] = logical_path
                event_asset_manifest.append(manifest_asset)
                digest = str(asset["hash"])
                shared_asset = asset_manifest["assets"].setdefault(
                    digest,
                    {
                        "algorithm": asset["algorithm"],
                        "hash": digest,
                        "size": asset["size"],
                        "paths": [],
                    },
                )
                if logical_path not in shared_asset["paths"]:
                    shared_asset["paths"].append(logical_path)
                # The direct logical file remains in the ZIP for old clients;
                # aliases let new clients locate an asset without re-reading
                # event JSON or copying duplicate bytes.
                asset_manifest["aliases"][logical_path] = logical_path
            asset_manifest["events"][event_uid] = {
                "event_uid": event_uid,
                "asset_set_hash": asset_hash,
                "assets": event_asset_manifest,
            }
            bundle_events.append(
                {
                    "slug": slug,
                    # Keep the v1 logical payload fields unchanged.
                    "path": f"{archive_prefix}/event.json",
                    "name": meta.get("name") or slug,
                    "date": meta.get("date"),
                    "file_count": counts["files"],
                    "image_count": counts["images"],
                    # Additive v2 fields.  They are optional for importers and
                    # do not turn this full payload into a delta manifest.
                    "event_uid": event_uid,
                    "content_hash": content_hash,
                    "asset_set_hash": asset_hash,
                    "asset_manifest_path": "asset_manifest.json",
                }
            )

        cm_path = project_root / "circle_master.json"
        if cm_path.exists():
            zf.write(str(cm_path), "circle_master.json")
            file_count += 1

        cuts_dir = project_root / "default_cuts"
        if cuts_dir.exists():
            for file_path in cuts_dir.rglob("*"):
                if not file_path.is_file():
                    continue
                try:
                    file_path.resolve().relative_to(cuts_dir.resolve())
                except ValueError as exc:
                    raise ValueError(
                        f"default cut asset escapes default_cuts directory: {file_path}"
                    ) from exc
                rel_path = file_path.relative_to(cuts_dir).as_posix()
                zf.write(str(file_path), _safe_archive_path(f"default_cuts/{rel_path}"))
                file_count += 1
                default_cut_count += 1

        manifest = {
            "format": _FULL_SYNC_FORMAT,
            # Keep v1 for old clients.  New importers can opt into the fields
            # below by checking manifest_version/capabilities.
            "format_version": _FULL_SYNC_LEGACY_FORMAT_VERSION,
            "manifest_version": _FULL_SYNC_MANIFEST_VERSION,
            "sync_mode": "full",
            "capabilities": [
                "stable_event_uid",
                "event_content_hash",
                "asset_set_hash",
                "asset_manifest",
            ],
            "generated_at": _utc_now_iso(),
            "event_count": event_count,
            "events": bundle_events,
            "includes": {
                "circle_master": cm_path.exists(),
                "default_cuts": default_cut_count,
            },
            "asset_manifest_path": "asset_manifest.json",
        }
        zf.writestr("sync_bundle.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr(
            "asset_manifest.json",
            json.dumps(asset_manifest, ensure_ascii=False, indent=2),
        )

    return {
        "status": "ok",
        "job": "create_mobile_full_sync_zip",
        "timestamp": _utc_now_iso(),
        "zip_path": str(zip_path),
        "event_count": event_count,
        "file_count": file_count,
        "image_count": image_count,
        "default_cut_count": default_cut_count,
        "total_size": zip_path.stat().st_size,
    }


def _job_parse_site_preview(payload: Dict[str, Any]) -> Dict[str, Any]:
    """HTML取得+サークル抽出のみ実行（画像DLなし）。プレビュー用。"""
    url = payload.get("url")
    if not url:
        raise ValueError("Missing required field: url")

    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()

    # プロジェクトルートをPYTHONPATHに追加
    proj_str = str(project_root)
    if proj_str not in sys.path:
        sys.path.insert(0, proj_str)

    # .envをロード（APIキー用）
    try:
        from dotenv import load_dotenv

        load_dotenv(project_root / ".env")
    except ImportError:
        pass

    from src.models import SiteConfig, SiteType, ExtractorConfig
    from src.models.config import SiteParsingConfig
    from src.adapters import AdapterFactory
    from src.utils.llm_client import LLMClient
    from src.utils.llm_attempts import api_models_from_attempts, build_text_llm_attempts
    from src.utils.pattern_manager import PatternManager
    from src.utils.downloader import Downloader
    from src.utils.cookie_loader import load_cookies_for_url
    from bs4 import BeautifulSoup

    site_type = AdapterFactory.detect_site_type(url)

    # モデル設定
    raw_model = payload.get("model", "gpt-5-mini")
    models = (
        [m.strip() for m in raw_model.split(",") if m.strip()]
        if isinstance(raw_model, str)
        else [raw_model]
    )

    # サイトパース専用モデル
    sp_raw = payload.get("site_parsing")
    site_parsing_config = None
    if sp_raw and isinstance(sp_raw, dict):
        site_reasoning_effort = sp_raw.get(
            "reasoning_effort",
            sp_raw.get("api_reasoning_effort", "medium"),
        )
        site_parsing_config = SiteParsingConfig(
            codex_model=sp_raw.get("codex_model", "gpt-5.4"),
            api_model=sp_raw.get("api_model", "gpt-5.6-sol"),
            reasoning_effort=site_reasoning_effort,
            api_reasoning_effort=site_reasoning_effort,
            prefer_cli=sp_raw.get("prefer_cli", True),
            cli_timeout=sp_raw.get(
                "cli_timeout",
                payload.get("text_llm_cli_timeout", 900),
            ),
        )

    site_config = SiteConfig(
        site_type=site_type,
        base_url=url,
        extractor_config=ExtractorConfig(),
        use_llm=True,
        llm_model=models[0] if models else "gpt-5.6-sol",
        text_llm_provider=payload.get("text_llm_provider", "api"),
        text_llm_cli_models=payload.get("text_llm_cli_models", {}),
        text_llm_cli_efforts=payload.get("text_llm_cli_efforts", {}),
        text_llm_cli_timeout=payload.get("text_llm_cli_timeout", 900),
        api_reasoning_effort=payload.get("api_reasoning_effort", "medium"),
        api_reasoning_effort_map=payload.get("api_reasoning_effort_map", {}),
        text_fallback_llm_provider=payload.get(
            "text_fallback_llm_provider", "cli:codex"
        ),
        text_fallback_llm_model=payload.get(
            "text_fallback_llm_model", "gpt-5.5"
        ),
        text_fallback_llm_effort=payload.get(
            "text_fallback_llm_effort", "medium"
        ),
        image_llm_provider=payload.get("image_llm_provider", "api:gemini"),
        image_llm_model=payload.get("image_llm_model")
        or (models[0] if models else "gpt-5.6-sol"),
        image_llm_effort=payload.get(
            "image_llm_effort",
            payload.get("api_reasoning_effort", "medium"),
        ),
        image_fallback_llm_provider=payload.get(
            "image_fallback_llm_provider", "openai"
        ),
        image_fallback_llm_model=payload.get(
            "image_fallback_llm_model", "gpt-5-mini"
        ),
        image_fallback_llm_effort=payload.get(
            "image_fallback_llm_effort", "medium"
        ),
        image_api_reasoning_effort_map=payload.get(
            "image_api_reasoning_effort_map", {}
        ),
        catalog_additional_prompt=payload.get("catalog_additional_prompt", ""),
        site_parsing_config=site_parsing_config,
        cookie_file=payload.get("cookie_file"),
    )

    # Cookie読み込み
    cookies = load_cookies_for_url(
        url,
        cookie_file=site_config.cookie_file,
        project_root=project_root,
    )

    # HTML取得
    downloader = Downloader(
        headers=site_config.headers, timeout=30, retry_count=3, cookies=cookies
    )
    html_content = downloader.fetch_content(url)
    soup = BeautifulSoup(html_content or "", "html.parser")

    # アダプター作成・サークル抽出
    text_attempts = build_text_llm_attempts(
        payload.get("text_llm_provider", "api"),
        site_config.llm_model,
        payload.get("text_llm_cli_models", {}),
        payload.get("text_llm_cli_efforts", {}),
        payload.get("text_fallback_llm_provider", "cli:codex"),
        payload.get("text_fallback_llm_model", "gpt-5.5"),
        payload.get("text_fallback_llm_effort", "medium"),
    )
    llm_client = LLMClient(
        model=api_models_from_attempts(text_attempts),
        attempts=text_attempts,
        cli_model_map=payload.get("text_llm_cli_models", {}),
        cli_effort_map=payload.get("text_llm_cli_efforts", {}),
        cli_timeout=payload.get("text_llm_cli_timeout", 900),
        cli_cwd=str(project_root),
        reasoning_effort=payload.get("api_reasoning_effort", "medium"),
        api_reasoning_effort_map=payload.get("api_reasoning_effort_map", {}),
    )
    pattern_manager = PatternManager()
    adapter = AdapterFactory.create_adapter(
        site_config, llm_client, pattern_manager, session=downloader.session
    )
    event = adapter.extract_event_info(soup)
    circles = adapter.extract_circles(soup)

    # LLMに渡したHTMLコンテキストを取得（再パース用）
    html_context = ""
    if hasattr(adapter, "_get_circle_context"):
        html_context = adapter._get_circle_context(soup)

    adapter_type = type(adapter).__name__

    return {
        "status": "ok",
        "job": "parse_site_preview",
        "timestamp": _utc_now_iso(),
        "event": event.to_dict() if hasattr(event, "to_dict") else {},
        "circles": [
            {
                "name": c.name,
                "penname": c.penname,
                "space": c.space,
                "hall": c.hall,
                "twitter_url": c.twitter_url,
                "website_url": c.website_url,
            }
            for c in circles
        ],
        "circle_count": len(circles),
        "html_context": html_context,
        "adapter_type": adapter_type,
    }


def _job_reparse_with_feedback(payload: Dict[str, Any]) -> Dict[str, Any]:
    """ユーザーの修正指示をもとにHTMLを再パースする。"""
    html_context = payload.get("html_context")
    feedback = payload.get("feedback")
    if not html_context:
        raise ValueError("Missing required field: html_context")
    if not feedback:
        raise ValueError("Missing required field: feedback")

    project_root = Path(payload.get("project_root") or Path.cwd()).resolve()
    proj_str = str(project_root)
    if proj_str not in sys.path:
        sys.path.insert(0, proj_str)

    # .envをロード（APIキー用）
    try:
        from dotenv import load_dotenv

        load_dotenv(project_root / ".env")
    except ImportError:
        pass

    from src.models.config import SiteParsingConfig
    from src.utils.site_parsing_llm import parse_with_high_end_model
    from src.utils.llm_client import LLMClient
    from src.utils.llm_attempts import api_models_from_attempts, build_text_llm_attempts

    # 前回の結果をプロンプトに含める
    previous_result = payload.get("previous_result", [])
    prev_sample = ""
    if previous_result:
        import json as _json

        prev_sample = f"\n\n前回の抽出結果（最初の5件）:\n```json\n{_json.dumps(previous_result[:5], ensure_ascii=False, indent=2)}\n```\n"

    prompt = f"""以下のHTMLからサークルリストの情報を抽出してください。

前回の抽出結果にユーザーから以下の修正指示がありました:
{feedback}
{prev_sample}
このフィードバックを反映して、正しく抽出し直してください。

HTML:
{html_context}

以下のJSON形式で返してください:
{{
    "circles": [
        {{
            "name": "サークル名",
            "penname": "ペンネーム（作者名）",
            "space": "スペース番号",
            "hall": "ホール名",
            "twitter_url": "Twitter/X URL",
            "website_url": "WebサイトURL"
        }}
    ]
}}

可能な限り多くのサークル情報を抽出してください。
JSONのみを返してください。
"""

    # サイトパース専用モデル設定
    sp_raw = payload.get("site_parsing")
    circles = []

    if sp_raw and isinstance(sp_raw, dict):
        site_reasoning_effort = sp_raw.get(
            "reasoning_effort",
            sp_raw.get("api_reasoning_effort", "medium"),
        )
        spc = SiteParsingConfig(
            codex_model=sp_raw.get("codex_model", "gpt-5.4"),
            api_model=sp_raw.get("api_model", "gpt-5.6-sol"),
            reasoning_effort=site_reasoning_effort,
            api_reasoning_effort=site_reasoning_effort,
            prefer_cli=sp_raw.get("prefer_cli", True),
            cli_timeout=sp_raw.get(
                "cli_timeout",
                payload.get("text_llm_cli_timeout", 900),
            ),
        )
        try:
            result = parse_with_high_end_model(prompt, spc)
            import json as _json

            data = _json.loads(result)
            circles = data.get("circles", [])
        except Exception as e:
            sys.stderr.write(f"高性能モデルでの再パース失敗: {e}\n")

    # 高性能モデルが使えない/失敗した場合は通常LLMにフォールバック
    if not circles:
        raw_model = payload.get("model", "gpt-5.6-sol")
        models = (
            [m.strip() for m in raw_model.split(",") if m.strip()]
            if isinstance(raw_model, str)
            else [raw_model]
        )
        try:
            primary_model = models[0] if models else "gpt-5.6-sol"
            text_attempts = build_text_llm_attempts(
                payload.get("text_llm_provider", "api"),
                primary_model,
                payload.get("text_llm_cli_models", {}),
                payload.get("text_llm_cli_efforts", {}),
                payload.get("text_fallback_llm_provider", "cli:codex"),
                payload.get("text_fallback_llm_model", "gpt-5.5"),
                payload.get("text_fallback_llm_effort", "medium"),
            )
            client = LLMClient(
                model=api_models_from_attempts(text_attempts),
                attempts=text_attempts,
                cli_model_map=payload.get("text_llm_cli_models", {}),
                cli_effort_map=payload.get("text_llm_cli_efforts", {}),
                cli_timeout=payload.get("text_llm_cli_timeout", 900),
                cli_cwd=str(project_root),
                reasoning_effort=payload.get("api_reasoning_effort", "medium"),
                api_reasoning_effort_map=payload.get(
                    "api_reasoning_effort_map", {}
                ),
            )
            result = client.extract_data(prompt)
            import json as _json

            data = _json.loads(result)
            circles = data.get("circles", [])
        except Exception as e:
            sys.stderr.write(f"通常LLMでの再パース失敗: {e}\n")

    return {
        "status": "ok" if circles else "error",
        "job": "reparse_with_feedback",
        "timestamp": _utc_now_iso(),
        "circles": circles,
        "circle_count": len(circles),
        "html_context": html_context,
    }


def run_job(job: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if job == "ping":
        return _job_ping(payload)
    if job == "extract_twitter_catalogs":
        return _job_extract_twitter_catalogs(payload)
    if job == "run_main_pipeline":
        return _job_run_main_pipeline(payload)
    if job == "load_event_json":
        return _job_load_event_json(payload)
    if job == "save_event_json":
        return _job_save_event_json(payload)
    if job == "validate_mobile_json":
        return _job_validate_mobile_json(payload)
    if job == "auto_place_map_pins":
        return _job_auto_place_map_pins(payload)
    if job == "unlimited_ocr_doctor":
        return _job_unlimited_ocr_doctor(payload)
    if job == "create_mobile_zip":
        return _job_create_mobile_zip(payload)
    if job == "create_mobile_full_sync_zip":
        return _job_create_mobile_full_sync_zip(payload)
    if job == "load_circle_master":
        return _job_load_circle_master(payload)
    if job == "save_circle_master":
        return _job_save_circle_master(payload)
    if job == "merge_circle_master":
        return _job_merge_circle_master(payload)
    if job == "parse_site_preview":
        return _job_parse_site_preview(payload)
    if job == "reparse_with_feedback":
        return _job_reparse_with_feedback(payload)
    if job == "reprocess_circle_from_post":
        return _job_reprocess_circle_from_post(payload)
    if job == "reprocess_circle_from_image":
        return _job_reprocess_circle_from_image(payload)
    if job == "list_jobs":
        return {
            "status": "ok",
            "job": "list_jobs",
            "jobs": [
                "ping",
                "list_jobs",
                "extract_twitter_catalogs",
                "run_main_pipeline",
                "parse_site_preview",
                "reparse_with_feedback",
                "reprocess_circle_from_post",
                "reprocess_circle_from_image",
                "load_event_json",
                "save_event_json",
                "validate_mobile_json",
                "auto_place_map_pins",
                "unlimited_ocr_doctor",
                "create_mobile_zip",
                "create_mobile_full_sync_zip",
                "load_circle_master",
                "save_circle_master",
                "merge_circle_master",
            ],
            "timestamp": _utc_now_iso(),
        }

    raise ValueError(f"Unknown job: {job}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Desktop bridge for Tauri integration")
    parser.add_argument("--job", default="ping", help="Job name (default: ping)")
    parser.add_argument("--payload", help="Path to JSON payload file")
    parser.add_argument("--payload-json", help="Inline JSON payload")
    return parser


def main() -> int:
    # Windows cp932環境でもUTF-8で出力する
    if sys.stdout.encoding != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    if sys.stderr.encoding != "utf-8":
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

    parser = _parser()
    args = parser.parse_args()

    try:
        payload = _load_payload(args)
        result = run_job(args.job, payload)
    except Exception as exc:
        result = {
            "status": "error",
            "job": args.job,
            "timestamp": _utc_now_iso(),
            "error": str(exc),
        }

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())

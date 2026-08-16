from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from src.space_locator import ocr_engine
from src.space_locator.ocr_engine import OCREngine


def _write_image(path: Path) -> None:
    image = np.full((16, 16, 3), 255, dtype=np.uint8)
    assert cv2.imwrite(str(path), image)


def test_extract_numbers_runs_runner_and_converts_payload(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    ocr_python = tmp_path / ("python.exe" if ocr_engine.os.name == "nt" else "python")
    ocr_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda *args, **kwargs: ocr_python)

    def fake_run(command, **kwargs):
        output_json = Path(command[command.index("--output-json") + 1])
        output_json.write_text(
            json.dumps(
                {
                    "results": [
                        {
                            "elements": [
                                {"text": "7", "x1": 10, "y1": 20, "x2": 30, "y2": 40}
                            ]
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ocr_engine.subprocess, "run", fake_run)

    numbers = OCREngine().extract_numbers_with_coordinates(str(image_path), min_confidence=100)

    assert numbers == [
        {
            "number": "07",
            "x": 10,
            "y": 20,
            "width": 20,
            "height": 20,
            "confidence": 99,
            "variant": "unlimited_ocr_0",
        }
    ]


def test_extract_numbers_passes_expected_candidate_count_and_keeps_diagnostics(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    ocr_python = tmp_path / ("python.exe" if ocr_engine.os.name == "nt" else "python")
    ocr_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda *args, **kwargs: ocr_python)
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        output_json = Path(command[command.index("--output-json") + 1])
        output_json.write_text(json.dumps({"results": [{
            "elements": [{"text": "12", "x1": 10, "y1": 20, "x2": 30, "y2": 40}],
            "tile_decision": {
                "candidate_count": 12,
                "expected_candidate_count": 73,
                "coverage": 12 / 73,
                "trigger_reason": "below_expected_coverage",
                "should_tile": True,
            },
            "context_fallback": {"enabled": True, "rectangle_count": 4},
        }]}), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ocr_engine.subprocess, "run", fake_run)
    engine = OCREngine()
    engine.extract_numbers_with_coordinates(str(image_path), expected_candidate_count=73)

    command = captured["command"]
    assert command[command.index("--expected-candidate-count") + 1] == "73"
    assert engine.diagnostics["last_run"]["expected_candidate_count"] == 73
    assert engine.diagnostics["last_run"]["tile_decision"]["trigger_reason"] == "below_expected_coverage"
    assert engine.diagnostics["last_run"]["context_fallback"]["rectangle_count"] == 4


def test_extract_numbers_returns_empty_on_runner_failure(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda: tmp_path / "python.exe")
    monkeypatch.setattr(
        ocr_engine.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(command, 1, stderr="boom"),
    )

    engine = OCREngine()
    assert engine.extract_numbers_with_coordinates(str(image_path)) == []
    assert engine.diagnostics["error"]["code"] == "runner_failed"


def test_extract_numbers_returns_empty_on_timeout(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda: tmp_path / "python.exe")

    def timeout_run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, timeout=1)

    monkeypatch.setattr(ocr_engine.subprocess, "run", timeout_run)

    engine = OCREngine()
    assert engine.extract_numbers_with_coordinates(str(image_path)) == []
    assert engine.diagnostics["error"]["code"] == "timeout"


def test_resolve_ocr_python_message_is_os_specific(tmp_path, monkeypatch):
    monkeypatch.setenv("UNLIMITED_OCR_VENV", str(tmp_path / "missing_venv"))

    with pytest.raises(RuntimeError) as exc_info:
        ocr_engine._resolve_ocr_python()

    message = str(exc_info.value)
    if ocr_engine.os.name == "nt":
        assert "scripts\\setup_unlimited_ocr.bat" in message
    else:
        assert "python3 scripts/setup_unlimited_ocr.py" in message


def test_runner_preserves_parent_hf_cache_for_legacy_env(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    ocr_python = tmp_path / ("python.exe" if ocr_engine.os.name == "nt" else "python")
    ocr_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda *args, **kwargs: ocr_python)
    monkeypatch.setenv("HF_HUB_CACHE", "X")
    monkeypatch.setenv("HUGGINGFACE_HUB_CACHE", "Y")
    captured = {}

    def fake_run(command, **kwargs):
        captured["env"] = dict(kwargs.get("env") or {})
        output_json = Path(command[command.index("--output-json") + 1])
        output_json.write_text(json.dumps({"results": []}), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ocr_engine.subprocess, "run", fake_run)

    OCREngine().extract_numbers_with_coordinates(str(image_path))

    assert captured["env"]["HF_HUB_CACHE"] == "X"
    assert captured["env"]["HUGGINGFACE_HUB_CACHE"] == "Y"


def test_runner_clears_stale_hf_env_for_explicit_gui_config(tmp_path, monkeypatch):
    image_path = tmp_path / "map.png"
    _write_image(image_path)
    ocr_python = tmp_path / ("python.exe" if ocr_engine.os.name == "nt" else "python")
    ocr_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(ocr_engine, "_resolve_ocr_python", lambda *args, **kwargs: ocr_python)
    monkeypatch.setenv("HF_HOME", "OLD")
    monkeypatch.setenv("HF_HUB_CACHE", "OLD2")
    captured = {}

    def fake_run(command, **kwargs):
        captured["env"] = dict(kwargs.get("env") or {})
        output_json = Path(command[command.index("--output-json") + 1])
        output_json.write_text(json.dumps({"results": []}), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(ocr_engine.subprocess, "run", fake_run)

    OCREngine({"hf_home": "Z", "model": "baidu/Unlimited-OCR"}).extract_numbers_with_coordinates(
        str(image_path)
    )

    assert "HF_HUB_CACHE" not in captured["env"]
    assert captured["env"]["HF_HOME"] == "Z"
    assert captured["env"]["UNLIMITED_OCR_MODEL"] == "baidu/Unlimited-OCR"

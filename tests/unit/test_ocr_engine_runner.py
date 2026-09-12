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


def test_context_candidate_budget_selects_best_context_segment(
    tmp_path,
    monkeypatch,
):
    image_path = tmp_path / "map.png"
    _write_image(image_path)

    ocr_python = tmp_path / (
        "python.exe" if ocr_engine.os.name == "nt" else "python"
    )
    ocr_python.write_text("", encoding="utf-8")

    monkeypatch.setattr(
        ocr_engine,
        "_resolve_ocr_python",
        lambda *args, **kwargs: ocr_python,
    )

    def element(number: int, x: int, y: int) -> dict:
        return {
            "text": f"{number:02d}",
            "x1": x,
            "y1": y,
            "x2": x + 10,
            "y2": y + 10,
        }

    base = [
        element(1, 10, 10),
        element(2, 30, 10),
        element(3, 50, 10),
        element(4, 70, 10),
    ]

    # total=6: useful but insufficient
    segment_0 = [
        element(5, 10, 100),
        element(6, 30, 100),
    ]

    # total=12: reaches expected but overshoots by 2
    segment_1 = [
        element(number, 10 + (number - 5) * 20, 200)
        for number in range(5, 13)
    ]

    # total=10 exactly: same capped progress as segment_1,
    # therefore lower overproduction must win.
    segment_2 = [
        element(number, 10 + (number - 5) * 20, 300)
        for number in range(5, 11)
    ]

    def fake_run(command, **kwargs):
        output_json = Path(
            command[command.index("--output-json") + 1]
        )

        elements = base + segment_0 + segment_1 + segment_2

        output_json.write_text(
            json.dumps(
                {
                    "model": "baidu/Unlimited-OCR",
                    "revision": (
                        "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead"
                    ),
                    "device": "cuda",
                    "results": [
                        {
                            "elements": elements,
                            "context_fallback": {
                                "enabled": True,
                                "call_count": 3,
                                "calls": [
                                    {
                                        "tier": "A",
                                        "rectangle_index": 0,
                                        "element_count": 2,
                                        "appended_element_count": 2,
                                    },
                                    {
                                        "tier": "A",
                                        "rectangle_index": 1,
                                        "element_count": 8,
                                        "appended_element_count": 8,
                                    },
                                    {
                                        "tier": "A",
                                        "rectangle_index": 2,
                                        "element_count": 6,
                                        "appended_element_count": 6,
                                    },
                                ],
                            },
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        return subprocess.CompletedProcess(
            command,
            0,
            stdout="",
            stderr="",
        )

    monkeypatch.setattr(
        ocr_engine.subprocess,
        "run",
        fake_run,
    )

    engine = OCREngine()
    numbers = engine.extract_numbers_with_coordinates(
        str(image_path),
        expected_candidate_count=10,
    )

    assert [item["number"] for item in numbers] == [
        "01",
        "02",
        "03",
        "04",
        "05",
        "06",
        "07",
        "08",
        "09",
        "10",
    ]

    selection = engine.diagnostics["last_run"]["context_selection"]

    assert selection["applied"] is True
    assert selection["base_candidate_count"] == 4
    assert selection["selected_candidate_count"] == 10
    assert selection["selected_calls"] == [
        {
            "order": 2,
            "tier": "A",
            "rectangle_index": 2,
            "appended_element_count": 6,
            "candidate_count_after": 10,
        }
    ]


def test_context_candidate_budget_prefers_compact_numeric_hypothesis_on_tie():
    def element(number: int, x: int) -> dict:
        return {
            "text": f"{number:02d}",
            "x1": x,
            "y1": 10,
            "x2": x + 10,
            "y2": 20,
        }

    base = [element(number, number * 20) for number in range(1, 5)]
    distractor = [
        {
            "text": f"{prefix}-01",
            "x1": (90 + index) * 20,
            "y1": 10,
            "x2": (90 + index) * 20 + 10,
            "y2": 20,
        }
        for index, prefix in enumerate("ABCDEF")
    ]
    useful = [element(number, number * 20) for number in range(5, 11)]
    result = {
        "elements": base + distractor + useful,
        "context_fallback": {
            "enabled": True,
            "call_count": 2,
            "calls": [
                {
                    "tier": "A",
                    "rectangle_index": 0,
                    "element_count": 6,
                    "appended_element_count": 6,
                },
                {
                    "tier": "A",
                    "rectangle_index": 1,
                    "element_count": 6,
                    "appended_element_count": 6,
                },
            ],
        },
    }

    selected, diagnostics = (
        ocr_engine._select_context_elements_by_candidate_budget(
            result,
            10,
        )
    )

    assert [item["number"] for item in ocr_engine._elements_to_numbers(selected)] == [
        f"{number:02d}"
        for number in range(1, 11)
    ]
    assert diagnostics["selected_calls"][0]["rectangle_index"] == 1


def test_context_candidate_budget_preserves_legacy_payload_without_provenance():
    result = {
        "elements": [
            {
                "text": "01",
                "x1": 10,
                "y1": 10,
                "x2": 20,
                "y2": 20,
            },
            {
                "text": "02",
                "x1": 30,
                "y1": 10,
                "x2": 40,
                "y2": 20,
            },
        ],
        "context_fallback": {
            "enabled": True,
            "calls": [
                {
                    "tier": "A",
                    "rectangle_index": 0,
                    "element_count": 1,
                }
            ],
        },
    }

    selected, diagnostics = (
        ocr_engine._select_context_elements_by_candidate_budget(
            result,
            10,
        )
    )

    assert selected == result["elements"]
    assert diagnostics["applied"] is False
    assert diagnostics["reason"] == "appended_element_count_missing"


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

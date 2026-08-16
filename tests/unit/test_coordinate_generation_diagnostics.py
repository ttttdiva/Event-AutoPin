from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from src.space_locator import auto_coordinate_generator as generator
from src.space_locator import ocr_engine
from src.space_locator.number_validator import NumberValidationResult


def _validation_validated(numbers):
    numbers = list(numbers)
    return NumberValidationResult(
        status="validated",
        numbers=numbers,
        diagnostics={
            "status": "validated",
            "raw_count": len(numbers),
            "validated_count": len(numbers),
        },
    )


_UNSET = object()


def _write_event(path: Path, *, circles=None, maps=None) -> None:
    path.write_text(
        json.dumps(
            {
                "event": {"maps": maps or [{"map_number": 1}]},
                "circles": circles
                or [{"space": "A-01", "map_number": 1}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


class _FakeOCREngine:
    def __init__(
        self,
        config=None,
        *,
        result=None,
        error=None,
        raises=None,
        runner_started=None,
        pattern=_UNSET,
    ):
        self.last_error = error
        self.last_run = {"number_count": len(result or [])}
        self._result = result
        self._raises = raises
        self._runner_started_override = runner_started
        self._pattern = pattern

    @property
    def diagnostics(self):
        return {
            "error": self.last_error,
            "last_run": dict(self.last_run),
            "config": {},
            "attempted": self._result is not None or self._raises is not None,
            "runner_started": (
                self._runner_started_override
                if self._runner_started_override is not None
                else self._raises is not None or bool(self._result)
            ),
            "candidate_count": len(self._result or []),
        }

    def extract_numbers_with_coordinates(self, image_path, **kwargs):
        if self._raises:
            raise self._raises
        return list(self._result or [])

    def analyze_grid_pattern(self, numbers):
        return self._pattern if self._pattern is not _UNSET else {"rows": 1, "cols": 1}


def _raw_number():
    return {
        "number": "01",
        "x": 10,
        "y": 10,
        "width": 10,
        "height": 10,
        "variant": "unlimited_ocr_0",
    }


def _read_failure(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert isinstance(payload["error"], dict)
    assert payload["map_number"] == 1
    assert "ocr" in payload
    return payload


def test_event_catalog_empty_artifact_is_stage_aware_and_does_not_claim_ocr(
    tmp_path: Path, monkeypatch
):
    event = tmp_path / "event.json"
    output = tmp_path / "coordinates.json"
    _write_event(
        event,
        maps=[{"map_number": 1}, {"map_number": 2}],
        circles=[
            {"space": "A-01"},
            {"space": "", "map_number": 1},
            {"space": "A-02", "map_number": 2},
        ],
    )
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: pytest.fail("OCR must not start for an empty catalog"),
    )

    assert (
        generator.generate_coordinates_from_map(
            str(tmp_path / "missing.png"), str(event), str(output), map_number=1
        )
        is None
    )
    payload = _read_failure(output)
    assert payload["stage"] == "event_catalog"
    assert payload["error"]["code"] == "event_catalog_empty"
    assert payload["ocr"]["attempted"] is False
    assert payload["ocr"]["runner_started"] is False
    assert payload["event_catalog"] == {
        "requested_map_number": 1,
        "map_count": 2,
        "circle_count": 3,
        "invalid_circle_count": 0,
        "space_blank_count": 1,
        "space_unparseable_count": 0,
        "map_mismatch_excluded_count": 1,
        "map_unassigned_excluded_count": 1,
        "target_space_count": 0,
    }


def test_event_catalog_counts_unparseable_space_without_assigning_it(tmp_path: Path):
    event = tmp_path / "event.json"
    _write_event(
        event,
        circles=[{"space": "1F-A01", "map_number": 1}],
    )
    catalog = generator.analyze_space_catalog_from_event(str(event), map_number=1)
    assert catalog["spaces"] == []
    assert catalog["event_catalog"]["space_unparseable_count"] == 1
    assert catalog["event_catalog"]["target_space_count"] == 0


def test_ocr_runner_failure_artifact_has_runner_state(
    tmp_path: Path, monkeypatch, caplog
):
    event = tmp_path / "event.json"
    output = tmp_path / "coordinates.json"
    _write_event(event)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(
            raises=RuntimeError("runner failed"),
            error={
                "code": "runner_failed",
                "message": r"runner failed /secret/map.png",
                "returncode": 17,
                "stderr": r"runner stderr /secret/model.bin Bearer secret-token",
            },
        ),
    )

    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["stage"] == "ocr"
    assert payload["error"]["code"] == "ocr_runner_failed"
    assert payload["ocr"]["attempted"] is True
    assert payload["ocr_diagnostics"]["error"]["returncode"] == 17
    assert payload["ocr_diagnostics"]["error"]["stderr"] == (
        r"runner stderr /secret/model.bin Bearer secret-token"
    )
    assert r"/secret/map.png" not in caplog.text
    assert "secret-token" not in caplog.text


def test_ocr_image_read_failure_is_input_stage_before_runner(
    tmp_path: Path, monkeypatch
):
    event = tmp_path / "event.json"
    output = tmp_path / "coordinates.json"
    _write_event(event)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(
            raises=ValueError("image"),
            runner_started=False,
            error={"code": "image_read_failed", "message": "image"},
        ),
    )

    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["stage"] == "input"
    assert payload["error"]["code"] == "image_read_failed"
    assert payload["ocr"]["attempted"] is True
    assert payload["ocr"]["runner_started"] is False


@pytest.mark.parametrize(
    ("error", "code"),
    [
        ({"code": "no_numbers", "message": "none"}, "ocr_no_numbers"),
    ],
)
def test_ocr_no_numbers_artifact(tmp_path: Path, monkeypatch, error, code):
    event = tmp_path / "event.json"
    output = tmp_path / "coordinates.json"
    _write_event(event)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[], error=error),
    )

    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["error"]["code"] == code
    assert payload["ocr"]["attempted"] is True
    assert payload["ocr"]["candidate_count"] == 0


def test_number_validation_failure_and_empty_are_distinct(tmp_path: Path, monkeypatch):
    event = tmp_path / "event.json"
    _write_event(event)

    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()]),
    )
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("validator")),
    )
    output = tmp_path / "failed.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["error"]["code"] == "number_validation_failed"
    assert payload["ocr"]["candidate_count"] == 1
    assert payload["ocr"]["validated_count"] == 0

    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator",
            (),
            {
                "validate_numbers": lambda self, image, raw: NumberValidationResult(
                    status="rejected_all",
                    numbers=[],
                    diagnostics={
                        "status": "rejected_all",
                        "raw_count": len(raw),
                        "validated_count": 0,
                    },
                )
            },
        )(),
    )
    output = tmp_path / "empty.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["error"]["code"] == "number_validation_empty"


def test_number_validator_image_read_failure_is_input_stage(tmp_path: Path, monkeypatch):
    event = tmp_path / "event.json"
    _write_event(event)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()]),
    )
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator",
            (),
            {
                "validate_numbers": lambda self, image, raw: (_ for _ in ()).throw(
                    generator.NumberValidatorImageReadError("image missing")
                )
            },
        )(),
    )
    output = tmp_path / "image-read-failed.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output)
    ) is None
    payload = _read_failure(output)
    assert payload["stage"] == "input"
    assert payload["error"]["code"] == "image_read_failed"
    assert payload["ocr"]["attempted"] is True
    assert payload["ocr"]["candidate_count"] == 1


def test_image_failure_geometry_and_calibration_gates_write_artifacts(tmp_path: Path, monkeypatch):
    event = tmp_path / "event.json"
    _write_event(event)
    fake_engine = lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()])
    monkeypatch.setattr(generator, "OCREngine", fake_engine)
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator", (), {"validate_numbers": lambda self, image, raw: _validation_validated(raw)}
        )(),
    )

    monkeypatch.setattr(generator, "_read_image_unicode_safe", lambda path: None)
    image_output = tmp_path / "image.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(image_output)
    ) is None
    assert _read_failure(image_output)["error"]["code"] == "image_read_failed"

    image = np.full((100, 100, 3), 255, dtype=np.uint8)
    monkeypatch.setattr(generator, "_read_image_unicode_safe", lambda path: image)
    monkeypatch.setattr(
        generator,
        "_build_catalog_geometry_grid",
        lambda *args, **kwargs: [{"space_id": "A01", "x": 10, "y": 10}],
    )
    monkeypatch.setattr(
        generator,
        "_catalog_geometry_quality",
        lambda *args, **kwargs: {"gate": {"passed": False}, "coverage": 0},
    )
    geometry_output = tmp_path / "geometry.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(geometry_output)
    ) is None
    assert (
        _read_failure(geometry_output)["error"]["code"]
        == "catalog_geometry_quality_gate_failed"
    )

    monkeypatch.setattr(
        generator,
        "_catalog_geometry_quality",
        lambda *args, **kwargs: {"gate": {"passed": True}},
    )
    monkeypatch.setattr(
        generator,
        "apply_calibration_points",
        lambda *args, **kwargs: (
            [{"space_id": "A01", "x": 10, "y": 10}],
            {"mode": "rejected", "reason": "unsafe"},
        ),
    )
    calibration_output = tmp_path / "calibration.json"
    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(calibration_output)
    ) is None
    assert (
        _read_failure(calibration_output)["error"]["code"]
        == "calibration_safety_gate_failed"
    )


def test_success_payload_retains_existing_grid_contract(tmp_path: Path, monkeypatch):
    event = tmp_path / "event.json"
    output = tmp_path / "success.json"
    _write_event(event)
    image = np.full((100, 100, 3), 255, dtype=np.uint8)
    monkeypatch.setattr(generator, "_read_image_unicode_safe", lambda path: image)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()]),
    )
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator", (), {"validate_numbers": lambda self, image, raw: _validation_validated(raw)}
        )(),
    )
    monkeypatch.setattr(
        generator,
        "PatternAnalyzer",
        lambda *args, **kwargs: type(
            "Analyzer",
            (),
            {
                "analyze_pattern": lambda self, *a, **k: {
                    "rows": {"count": 1},
                    "columns": {"count": 1},
                }
            },
        )(),
    )
    monkeypatch.setattr(
        generator,
        "_build_catalog_geometry_grid",
        lambda *args, **kwargs: [
            {
                "space_id": "A01",
                "x": 10,
                "y": 10,
                "normalized_x": 0.1,
                "normalized_y": 0.1,
            }
        ],
    )
    monkeypatch.setattr(
        generator,
        "_catalog_geometry_quality",
        lambda *args, **kwargs: {"gate": {"passed": True}},
    )
    result = generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output), use_calibration=False
    )
    assert result is not None
    assert result["status"] == "success"
    assert result["complete_grid"][0]["space_id"] == "A01"
    persisted = json.loads(output.read_text(encoding="utf-8"))
    assert persisted["status"] == "success"
    assert persisted["total_spaces"] == 1


@pytest.mark.parametrize("pattern", [None, {"rows": "not-a-number", "cols": 1}])
def test_malformed_grid_pattern_writes_geometry_failure_artifact(
    tmp_path: Path, monkeypatch, pattern
):
    event = tmp_path / "event.json"
    output = tmp_path / "malformed.json"
    _write_event(event)
    image = np.full((100, 100, 3), 255, dtype=np.uint8)
    monkeypatch.setattr(generator, "_read_image_unicode_safe", lambda path: image)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()], pattern=pattern),
    )
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator", (), {"validate_numbers": lambda self, image, raw: _validation_validated(raw)}
        )(),
    )

    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output), use_calibration=False
    ) is None
    payload = _read_failure(output)
    assert payload["stage"] == "geometry"
    assert payload["error"]["code"] == "geometry_result_invalid"


def test_malformed_llm_pattern_writes_geometry_failure_artifact(tmp_path: Path, monkeypatch):
    event = tmp_path / "event.json"
    output = tmp_path / "malformed-llm.json"
    _write_event(event)
    image = np.full((100, 100, 3), 255, dtype=np.uint8)
    monkeypatch.setattr(generator, "_read_image_unicode_safe", lambda path: image)
    monkeypatch.setattr(
        generator,
        "OCREngine",
        lambda *args, **kwargs: _FakeOCREngine(result=[_raw_number()]),
    )
    monkeypatch.setattr(
        generator,
        "NumberValidator",
        lambda *args, **kwargs: type(
            "Validator", (), {"validate_numbers": lambda self, image, raw: _validation_validated(raw)}
        )(),
    )
    monkeypatch.setattr(
        generator,
        "PatternAnalyzer",
        lambda *args, **kwargs: type(
            "Analyzer", (), {"analyze_pattern": lambda self, *a, **k: None}
        )(),
    )

    assert generator.generate_coordinates_from_map(
        str(tmp_path / "map.png"), str(event), str(output), use_calibration=False
    ) is None
    payload = _read_failure(output)
    assert payload["stage"] == "geometry"
    assert payload["error"]["code"] == "geometry_result_invalid"


def test_failure_writer_survives_malformed_ocr_diagnostics(tmp_path: Path):
    class BrokenEngine:
        @property
        def diagnostics(self):
            return "malformed"

    output = tmp_path / "broken-diagnostics.json"
    generator._write_failure_artifact(
        str(output),
        image_path="map.png",
        event_json_path="event.json",
        map_number=1,
        stage="ocr",
        code="ocr_runner_failed",
        message="runner failed",
        ocr_engine=BrokenEngine(),
        candidate_count="not-an-int",
        validated_count=object(),
    )
    payload = _read_failure(output)
    assert payload["error"]["code"] == "ocr_runner_failed"
    assert payload["ocr"]["candidate_count"] == 0
    assert payload["ocr"]["validated_count"] == 0
    assert payload["ocr_diagnostics"] == {}


def test_unicode_image_loader_handles_japanese_windows_style_path(tmp_path: Path):
    image = np.full((8, 8, 3), 255, dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    image_path = tmp_path / "イベント" / "マップ.png"
    image_path.parent.mkdir()
    image_path.write_bytes(encoded.tobytes())
    loaded = generator._read_image_unicode_safe(str(image_path))
    assert loaded is not None
    assert loaded.shape[:2] == (8, 8)


def test_ocr_engine_unicode_loader_falls_back_when_imread_returns_none(
    tmp_path: Path, monkeypatch
):
    image = np.full((8, 8, 3), 255, dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    image_path = tmp_path / "イベント" / "マップ.png"
    image_path.parent.mkdir()
    image_path.write_bytes(encoded.tobytes())
    monkeypatch.setattr(ocr_engine.cv2, "imread", lambda path: None)
    loaded = ocr_engine._read_image_unicode_safe(str(image_path))
    assert loaded is not None
    assert loaded.shape[:2] == (8, 8)

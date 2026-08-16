from __future__ import annotations

import json
from pathlib import Path

import yaml

import main as main_module


def _generator(tmp_path: Path) -> main_module.CircleListGenerator:
    output = tmp_path / "out"
    output.mkdir()
    (output / "event.json").write_text(
        json.dumps({"event": {"maps": [{"filename": "maps/map_01.jpg", "map_number": 1}]}, "circles": []}),
        encoding="utf-8",
    )
    (output / "maps").mkdir()
    (output / "maps" / "map_01.jpg").write_bytes(b"map")
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "url": "https://example.com",
                "output_dir": str(output),
                "map_url": "https://map.example/1.jpg",
                "models": ["gpt-5-mini"],
                "ocr_config": {
                    "model": "org/custom",
                    "model_path": str(tmp_path / "model"),
                    "device": "cpu",
                    "strategy": "single",
                },
            }
        ),
        encoding="utf-8",
    )
    return main_module.CircleListGenerator(str(config_path))


def test_coordinate_generation_passes_gui_ocr_config_and_reports_failure(tmp_path, monkeypatch):
    generator = _generator(tmp_path)
    captured: dict[str, object] = {}

    def fake_generate(**kwargs):
        captured.update(kwargs)
        return None

    monkeypatch.setattr(main_module, "generate_coordinates_from_map", fake_generate, raising=False)
    # _generate_coordinates imports the package attribute at call time.
    import src.space_locator as package

    monkeypatch.setattr(package, "generate_coordinates_from_map", fake_generate)
    assert generator._generate_coordinates() is False
    assert captured["ocr_config"]["model"] == "org/custom"
    assert generator.coordinate_generation_summary["status"] == "failed"
    assert generator.coordinate_generation_summary["failed"] == 1


def test_coordinate_generation_zero_updates_is_failed(tmp_path, monkeypatch):
    generator = _generator(tmp_path)

    def fake_generate(**kwargs):
        return {"complete_grid": [{"space_id": "A01", "x": 10, "y": 20, "normalized_x": 0.1, "normalized_y": 0.2}]}

    class ZeroUpdate:
        def update_event_json(self, **kwargs):
            return {"updated_count": 0, "skipped_count": 1}

    import src.space_locator as package
    import src.space_locator.json_updater as updater_module

    monkeypatch.setattr(package, "generate_coordinates_from_map", fake_generate)
    monkeypatch.setattr(updater_module, "JSONUpdater", ZeroUpdate)

    assert generator._generate_coordinates() is False
    summary = generator.coordinate_generation_summary
    assert summary["status"] == "failed"
    assert summary["succeeded"] == 0
    assert summary["failed"] == 1
    assert summary["maps"][0]["error_code"] == "coordinate_update_zero"


def _seed_stale_coordinate_artifacts(output: Path) -> tuple[Path, Path]:
    summary_path = output / "coordinate_generation_summary.json"
    map_path = output / "coordinates_map_1.json"
    summary_path.write_text(
        json.dumps(
            {
                "status": "failed",
                "stage": "ocr",
                "error": {"code": "stale_previous_run"},
            }
        ),
        encoding="utf-8",
    )
    map_path.write_text(json.dumps({"status": "failed", "stage": "ocr"}), encoding="utf-8")
    return summary_path, map_path


def test_coordinate_generation_invalidates_stale_artifacts_before_missing_map_input(tmp_path):
    generator = _generator(tmp_path)
    summary_path, map_path = _seed_stale_coordinate_artifacts(Path(generator.config["output_dir"]))
    generator.config["map_url"] = ""
    generator.config.pop("map_urls", None)

    assert generator._generate_coordinates() is False

    # A fresh input-stage summary may be written, but it must not contain the
    # previous run's OCR failure and no per-map artifact may survive.
    assert map_path.exists() is False
    saved = json.loads(summary_path.read_text(encoding="utf-8"))
    assert saved["error"]["code"] == "map_url_missing"
    assert saved["stage"] == "input"


def test_coordinate_generation_invalidates_stale_artifacts_before_missing_event_input(tmp_path):
    generator = _generator(tmp_path)
    summary_path, map_path = _seed_stale_coordinate_artifacts(Path(generator.config["output_dir"]))
    Path(generator.config["output_dir"], "event.json").unlink()

    assert generator._generate_coordinates() is False

    assert map_path.exists() is False
    saved = json.loads(summary_path.read_text(encoding="utf-8"))
    assert saved["error"]["code"] == "event_json_missing"
    assert saved["stage"] == "input"

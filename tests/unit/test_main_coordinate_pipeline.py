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

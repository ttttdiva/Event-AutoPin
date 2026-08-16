from __future__ import annotations

import json
from pathlib import Path

from src.space_locator.auto_coordinate_generator import (
    _build_catalog_geometry_grid,
    _catalog_geometry_quality,
    analyze_space_catalog_from_event,
    generate_coordinates_from_map,
)
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


def _validation_rejected_all(raw_count: int):
    return NumberValidationResult(
        status="rejected_all",
        numbers=[],
        diagnostics={
            "status": "rejected_all",
            "raw_count": raw_count,
            "validated_count": 0,
        },
    )


def _space(space_id: str, prefix: str, number: int, raw_space: str = "") -> dict:
    return {
        "space_id": space_id,
        "prefix": prefix,
        "number": number,
        "raw_space": raw_space or space_id,
        "circle_index": number,
    }


def test_catalog_geometry_global_lattice_and_range_center() -> None:
    catalog = {
        "order": ["A", "B", "C"],
        "horizontal_labels": ["A", "B", "C"],
        "vertical_labels": [],
        "spaces": [
            _space("A01", "A", 1),
            _space("A02", "A", 2),
            _space("A03", "A", 3),
            _space("B01", "B", 1),
            _space("B02", "B", 2, "B 02-03"),
            _space("B03", "B", 3, "B 02-03"),
            _space("C01", "C", 1),
            _space("C02", "C", 2),
            _space("C03", "C", 3),
        ],
    }
    numbers = [
        # A has a duplicate 02; the first monotonic observation wins.
        {"number": "01", "x": 90, "y": 90, "width": 20, "height": 20},
        {"number": "02", "x": 190, "y": 90, "width": 20, "height": 20},
        {"number": "02", "x": 196, "y": 90, "width": 20, "height": 20},
        {"number": "03", "x": 290, "y": 90, "width": 20, "height": 20},
        # B is missing 02; the global lattice imputes it from A/C.
        {"number": "01", "x": 100, "y": 190, "width": 20, "height": 20},
        {"number": "03", "x": 300, "y": 190, "width": 20, "height": 20},
        {"number": "01", "x": 110, "y": 290, "width": 20, "height": 20},
        {"number": "02", "x": 210, "y": 290, "width": 20, "height": 20},
        {"number": "03", "x": 310, "y": 290, "width": 20, "height": 20},
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (1000, 500))
    by_id = {item["space_id"]: item for item in grid}

    assert list(by_id) == ["A01", "A02", "A03", "B01", "B02", "B03", "C01", "C02", "C03"]
    assert by_id["B02"]["x"] == by_id["B03"]["x"]
    assert by_id["B02"]["x"] == 260
    assert by_id["B02"]["y"] == by_id["B03"]["y"] == 300
    assert by_id["B02"]["x"] == by_id["A02"]["x"] + 50


def test_catalog_geometry_all_vertical_far_right_uses_ocr_center() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [
            _space("V01", "V", 1),
            _space("V02", "V", 2),
            _space("V03", "V", 3, "V 03-04"),
            _space("V04", "V", 4, "V 03-04"),
        ],
    }
    numbers = [
        {"number": "01", "x": 940, "y": 90, "width": 40, "height": 20},
        {"number": "02", "x": 940, "y": 190, "width": 40, "height": 20},
        {"number": "03", "x": 940, "y": 290, "width": 40, "height": 20},
        {"number": "04", "x": 940, "y": 390, "width": 40, "height": 20},
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, {"width": 1000, "height": 500})
    by_id = {item["space_id"]: item for item in grid}

    assert [by_id[f"V{number:02d}"]["x"] for number in range(1, 5)] == [960, 960, 960, 960]
    assert by_id["V01"]["y"] == 100
    assert by_id["V02"]["y"] == 200
    assert by_id["V03"]["y"] == by_id["V04"]["y"] == 350


def test_catalog_geometry_mixed_right_gutter_retains_left_offset() -> None:
    catalog = {
        "order": ["H", "V"],
        "horizontal_labels": ["H"],
        "vertical_labels": ["V"],
        "spaces": [
            *[_space(f"H{number:02d}", "H", number) for number in range(1, 5)],
            *[_space(f"V{number:02d}", "V", number) for number in range(1, 5)],
        ],
    }
    numbers = [
        *[
            {"number": f"{number:02d}", "x": number * 100, "y": 40, "width": 20, "height": 20}
            for number in range(1, 5)
        ],
        *[
            {"number": f"{number:02d}", "x": 940, "y": number * 100, "width": 40, "height": 20}
            for number in range(1, 5)
        ],
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, {"width": 1000, "height": 500})
    by_id = {item["space_id"]: item for item in grid}

    assert [by_id[f"V{number:02d}"]["x"] for number in range(1, 5)] == [922, 922, 922, 922]


def test_catalog_geometry_non_gutter_vertical_ignores_wide_bbox_offset() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [_space(f"V{number:02d}", "V", number) for number in range(1, 5)],
    }
    numbers = [
        {"number": f"{number:02d}", "x": 400, "y": number * 80, "width": 100, "height": 20}
        for number in range(1, 5)
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, {"width": 1000, "height": 500})

    assert [item["x"] for item in grid] == [450, 450, 450, 450]


def test_catalog_geometry_folded_endpoint_pair_uses_track_axes_not_vertical_duplicate() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [_space(f"V{number:02d}", "V", number) for number in range(1, 11)],
    }
    numbers = [
        # OCR has incorrectly attached 01 vertically below 02.
        {"number": "01", "x": 190, "y": 510, "width": 20, "height": 20},
        *[
            {"number": f"{number:02d}", "x": 190, "y": 510 - number * 40, "width": 20, "height": 20}
            for number in range(2, 7)
        ],
        *[
            {"number": f"{number:02d}", "x": 240, "y": 270 + (number - 7) * 40, "width": 20, "height": 20}
            for number in range(7, 11)
        ],
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (500, 600))
    by_id = {item["space_id"]: item for item in grid}

    assert by_id["V02"]["x"] == 205
    assert by_id["V01"]["x"] == 245
    assert by_id["V01"]["y"] == by_id["V02"]["y"]


def test_catalog_geometry_imputation_prefers_strong_folded_track_over_detached_singleton() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [_space(f"V{number:02d}", "V", number) for number in range(2, 18)],
    }
    numbers = [
        # Detached 02 is its own x track; 03/04 are missing before the fold.
        {"number": "02", "x": 230, "y": 650, "width": 20, "height": 20},
        *[
            {"number": f"{number:02d}", "x": 250, "y": 590 - (number - 5) * 40, "width": 20, "height": 20}
            for number in range(5, 11)
        ],
        *[
            {"number": f"{number:02d}", "x": 290, "y": 390 + (number - 11) * 40, "width": 20, "height": 20}
            for number in range(11, 18)
        ],
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (500, 800))
    by_id = {item["space_id"]: item for item in grid}
    quality = _catalog_geometry_quality(numbers, catalog, grid, (500, 800))

    assert (by_id["V03"]["x"], by_id["V03"]["y"]) == (260, 680)
    assert (by_id["V03"]["x"], by_id["V03"]["y"]) != (by_id["V02"]["x"], by_id["V02"]["y"])
    assert quality["near_duplicate_circles"] == 0
    assert quality["gate"]["passed"] is True


def test_catalog_geometry_rejects_exact_endpoint_inconsistent_with_track_pitch() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [_space(f"V{number:02d}", "V", number) for number in range(3, 9)],
    }
    numbers = [
        {"number": "03", "x": 200, "y": 490, "width": 20, "height": 20},
        *[
            {"number": f"{number:02d}", "x": 190, "y": 550 - number * 40, "width": 20, "height": 20}
            for number in range(4, 9)
        ],
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (500, 600))
    by_id = {item["space_id"]: item for item in grid}

    assert by_id["V03"]["x"] == 200
    assert by_id["V03"]["y"] == 440


def test_catalog_geometry_quality_gate_rejects_low_observation_coverage() -> None:
    catalog = {
        "order": ["A"],
        "horizontal_labels": ["A"],
        "vertical_labels": [],
        "spaces": [_space(f"A{number:02d}", "A", number) for number in range(1, 4)],
    }
    numbers = [{"number": "01", "x": 90, "y": 90, "width": 20, "height": 20}]
    grid = _build_catalog_geometry_grid(numbers, catalog, (1000, 500))
    quality = _catalog_geometry_quality(numbers, catalog, grid, (1000, 500))

    assert quality["coverage"] == 1.0
    assert quality["observed_coverage"] < 0.5
    assert quality["gate"]["passed"] is False


def test_catalog_geometry_quality_rejects_coverage_between_44_and_50_percent() -> None:
    catalog = {
        "order": ["A"],
        "horizontal_labels": ["A"],
        "vertical_labels": [],
        "spaces": [_space(f"A{number:02d}", "A", number) for number in range(1, 10)],
    }
    grid = [
        {"space_id": f"A{number:02d}", "number": f"{number:02d}", "x": number * 50, "y": 100, "row": "A"}
        for number in range(1, 10)
    ]
    numbers = [
        {"number": f"{number:02d}", "x": number * 50 - 5, "y": 95, "width": 10, "height": 10}
        for number in range(1, 5)
    ]

    quality = _catalog_geometry_quality(numbers, catalog, grid, (600, 200))

    assert quality["observed_coverage"] == 0.444444
    assert quality["gate"]["min_observed_coverage"] == 0.50
    assert quality["gate"]["passed"] is False


def test_catalog_geometry_quality_rejects_distinct_circles_at_duplicate_point() -> None:
    catalog = {
        "order": ["A"],
        "horizontal_labels": ["A"],
        "vertical_labels": [],
        "spaces": [
            _space("A01", "A", 1),
            _space("A02", "A", 2),
            _space("A03", "A", 3, "A 03-04"),
            _space("A04", "A", 4, "A 03-04"),
        ],
    }
    catalog["spaces"][3]["circle_index"] = catalog["spaces"][2]["circle_index"]
    grid = [
        {"space_id": "A01", "number": "01", "x": 100, "y": 100, "row": "A"},
        {"space_id": "A02", "number": "02", "x": 100, "y": 100, "row": "A"},
        {"space_id": "A03", "number": "03", "x": 200, "y": 100, "row": "A"},
        {"space_id": "A04", "number": "04", "x": 200, "y": 100, "row": "A"},
    ]
    numbers = [
        {"number": f"{number:02d}", "x": x - 5, "y": 95, "width": 10, "height": 10}
        for number, x in ((1, 100), (2, 100), (3, 200), (4, 200))
    ]

    quality = _catalog_geometry_quality(numbers, catalog, grid, (400, 200))

    assert quality["near_duplicate_circles"] == 1
    assert quality["gate"]["passed"] is False


def test_catalog_geometry_quality_does_not_reuse_tokens_across_prefixes() -> None:
    catalog = {
        "order": ["A", "B"],
        "horizontal_labels": ["A", "B"],
        "vertical_labels": [],
        "spaces": [
            _space(f"{prefix}{number:02d}", prefix, number)
            for prefix in "AB"
            for number in range(1, 12)
        ],
    }
    grid = [
        {
            "space_id": f"{prefix}{number:02d}",
            "number": f"{number:02d}",
            "x": number * 50,
            "y": y,
            "row": prefix,
        }
        for prefix, y in (("A", 100), ("B", 200))
        for number in range(1, 12)
    ]
    numbers = [
        {"number": f"{number:02d}", "x": number * 50 - 5, "y": 95, "width": 10, "height": 10}
        for number in range(1, 6)
    ] + [
        {"number": f"{number:02d}", "x": number * 50 - 5, "y": 195, "width": 10, "height": 10}
        for number in range(7, 12)
    ]

    quality = _catalog_geometry_quality(numbers, catalog, grid, (700, 300))

    assert quality["observed"] <= 10
    assert quality["observed_coverage"] <= 10 / 22
    assert quality["gate"]["passed"] is False


def test_catalog_geometry_is_deterministic_and_ignores_pin_values() -> None:
    catalog = {
        "order": ["A"],
        "horizontal_labels": ["A"],
        "vertical_labels": [],
        "spaces": [_space(f"A{number:02d}", "A", number) for number in range(1, 4)],
    }
    numbers = [
        {"number": "01", "x": 90, "y": 90, "width": 20, "height": 20},
        {"number": "02", "x": 190, "y": 90, "width": 20, "height": 20},
        {"number": "03", "x": 290, "y": 90, "width": 20, "height": 20},
    ]
    baseline = _build_catalog_geometry_grid(numbers, catalog, (1000, 500))
    mutated_catalog = {
        **catalog,
        "spaces": [
            {**item, "pin_x": 0.99, "pin_y": 0.01}
            for item in catalog["spaces"]
        ],
    }

    assert baseline == _build_catalog_geometry_grid(numbers, mutated_catalog, (1000, 500))
    assert baseline == _build_catalog_geometry_grid(numbers, catalog, (1000, 500))


def test_generation_gate_returns_none_and_preserves_existing_pins(tmp_path, monkeypatch) -> None:
    event_json = tmp_path / "event.json"
    event_json.write_text(
        '{"event":{"maps":[{"map_number":1,"filename":"map.png"}]},'
        '"circles":[{"space":"A-01","pin_x":0.12,"pin_y":0.34},'
        '{"space":"A-02","pin_x":0.56,"pin_y":0.78},'
        '{"space":"A-03","pin_x":0.91,"pin_y":0.11}]}',
        encoding="utf-8",
    )
    # Reuse a tracked valid image; OCR itself is supplied through a tiny raw
    # fixture so this test never invokes a model or network.
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(
        '{"numbers":[{"number":"01","x":10,"y":10,"width":10,"height":10}]}',
        encoding="utf-8",
    )

    class FakeValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_validated(numbers)

    class FakeAnalyzer:
        def __init__(self, model=None):
            pass

        def analyze_pattern(self, *args, **kwargs):
            return {"layout_type": "横配置型", "rows": {"count": 1}, "columns": {"count": 3}}

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", FakeValidator)
    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.PatternAnalyzer", FakeAnalyzer)
    output = tmp_path / "coordinates.json"
    result = generate_coordinates_from_map(
        str(image_path),
        str(event_json),
        output_json_path=str(output),
        ocr_result_path=str(ocr_path),
        use_calibration=False,
    )

    assert result is None
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["error"]["code"] == "catalog_geometry_quality_gate_failed"
    assert payload["geometry_quality"]["gate"]["passed"] is False
    unchanged = json.loads(event_json.read_text(encoding="utf-8"))
    assert [(c["pin_x"], c["pin_y"]) for c in unchanged["circles"]] == [
        (0.12, 0.34),
        (0.56, 0.78),
        (0.91, 0.11),
    ]


def test_catalog_geometry_portrait_all_vertical_three_prefixes() -> None:
    catalog = {
        "order": ["A", "B", "C"],
        # Deliberately wrong catalog heuristic: geometry must override it.
        "horizontal_labels": ["A", "B", "C"],
        "vertical_labels": [],
        "spaces": [
            _space(f"{prefix}{number:02d}", prefix, number)
            for prefix in "ABC"
            for number in range(1, 9)
        ],
    }
    numbers = [
        {"number": f"{number:02d}", "x": x, "y": 100 + number * 80, "width": 30, "height": 20}
        for x in (150, 450, 750)
        for number in range(1, 9)
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (1000, 1000))
    quality = _catalog_geometry_quality(numbers, catalog, grid, (1000, 1000))

    assert len(grid) == 24
    assert quality["orientation"] == {"horizontal_labels": [], "vertical_labels": ["A", "B", "C"]}
    assert quality["gate"]["passed"] is True


def test_catalog_geometry_mixed_horizontal_rows_and_vertical_islands() -> None:
    catalog = {
        "order": ["A", "B", "C", "V", "W"],
        "horizontal_labels": ["A", "B", "C"],
        "vertical_labels": ["V", "W"],
        "spaces": [
            _space(f"{prefix}{number:02d}", prefix, number)
            for prefix in "ABC"
            for number in range(1, 7)
        ] + [
            _space(f"{prefix}{number:02d}", prefix, number)
            for prefix in "VW"
            for number in range(1, 5)
        ],
    }
    numbers = [
        {"number": f"{number:02d}", "x": 100 + number * 100, "y": y, "width": 30, "height": 20}
        for y in (100, 250, 400)
        for number in range(1, 7)
    ] + [
        {"number": f"{number:02d}", "x": x, "y": 100 + number * 140, "width": 30, "height": 20}
        for x in (850, 950)
        for number in range(1, 5)
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (1100, 800))
    quality = _catalog_geometry_quality(numbers, catalog, grid, (1100, 800))

    assert len(grid) == 26
    assert quality["orientation"] == {
        "horizontal_labels": ["A", "B", "C"],
        "vertical_labels": ["V", "W"],
    }
    assert quality["gate"]["passed"] is True


def test_analyze_catalog_excludes_unassigned_circles_only_for_multi_map(tmp_path) -> None:
    event_json = tmp_path / "event.json"
    payload = {
        "event": {"maps": [{"map_number": 1}, {"map_number": 2}]},
        "circles": [
            {"space": "N-01"},
            {"space": "A-01", "map_number": 1},
            {"space": "B-01", "map_number": 2},
        ],
    }
    event_json.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    assert [item["space_id"] for item in analyze_space_catalog_from_event(str(event_json), 1)["spaces"]] == ["A01"]
    assert [item["space_id"] for item in analyze_space_catalog_from_event(str(event_json), 2)["spaces"]] == ["B01"]

    payload["event"]["maps"] = [{"map_number": 1}]
    event_json.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    spaces = analyze_space_catalog_from_event(str(event_json), 1)["spaces"]
    assert [item["space_id"] for item in spaces] == ["N01", "A01"]


def test_analyze_catalog_single_map_includes_none_but_excludes_explicit_zero(tmp_path) -> None:
    event_json = tmp_path / "event.json"
    event_json.write_text(json.dumps({
        "event": {"maps": [{"map_number": 1}]},
        "circles": [
            {"space": "N-01"},
            {"space": "Z-01", "map_number": 0},
            {"space": "A-01", "map_number": 1},
        ],
    }), encoding="utf-8")

    spaces = analyze_space_catalog_from_event(str(event_json), 1)["spaces"]

    assert [item["space_id"] for item in spaces] == ["N01", "A01"]


def test_catalog_geometry_malformed_bbox_is_diagnostic_gate_failure() -> None:
    catalog = {
        "order": ["A"],
        "horizontal_labels": ["A"],
        "vertical_labels": [],
        "spaces": [_space(f"A{number:02d}", "A", number) for number in range(1, 4)],
    }
    numbers = [
        {"number": "01", "x": "bad", "y": 10, "width": 10, "height": 10},
        {"number": "02", "x": 20, "y": 10, "width": "bad", "height": 10},
        {"number": "03", "x": 30, "y": 10, "width": 10, "height": float("nan")},
    ]

    grid = _build_catalog_geometry_grid(numbers, catalog, (100, 100))
    quality = _catalog_geometry_quality(numbers, catalog, grid, (100, 100))

    assert grid == []
    assert quality["invalid_candidates"] == 3
    assert quality["gate"]["passed"] is False


def test_catalog_geometry_quality_rejects_out_of_bounds_extrapolation() -> None:
    catalog = {
        "order": ["V"],
        "horizontal_labels": [],
        "vertical_labels": ["V"],
        "spaces": [_space(f"V{number:02d}", "V", number) for number in range(1, 7)],
    }
    numbers = [
        {"number": f"{number:02d}", "x": 90, "y": 55 + number * 10, "width": 10, "height": 10}
        for number in range(1, 4)
    ]
    grid = [
        {
            "space_id": f"V{number:02d}",
            "number": f"{number:02d}",
            "x": 90,
            "y": 60 + number * 10,
            "row": "V",
        }
        for number in range(1, 7)
    ]
    quality = _catalog_geometry_quality(numbers, catalog, grid, (100, 100))

    assert quality["out_of_bounds"] > 0
    assert quality["gate"]["passed"] is False


def test_generator_resolves_right_to_left_horizontal_row_and_passes_quality(tmp_path, monkeypatch):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {
                    "maps": [{"map_number": 1}],
                    # Invalid calibration metadata must not affect disabled mode.
                    "map_calibration_points": [
                        {"space": "A-01", "map_number": "bad", "pin_x": "NaN", "pin_y": 0.2}
                    ],
                },
                "circles": [{"space": f"A-{number:02d}"} for number in range(1, 5)],
            }
        ),
        encoding="utf-8",
    )
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(
        json.dumps(
            {
                "numbers": [
                    {
                        "number": f"{number:02d}",
                        "x": 250 - (number - 1) * 60,
                        "y": 60,
                        "width": 20,
                        "height": 20,
                    }
                    for number in range(1, 5)
                ]
            }
        ),
        encoding="utf-8",
    )

    class KeepValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_validated(numbers)

    class FakeAnalyzer:
        def __init__(self, model=None):
            pass

        def analyze_pattern(self, *args, **kwargs):
            return {"layout_type": "横配置型", "rows": {"count": 1}, "columns": {"count": 4}}

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", KeepValidator)
    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.PatternAnalyzer", FakeAnalyzer)
    result = generate_coordinates_from_map(
        str(image_path),
        str(event_json),
        output_json_path=str(tmp_path / "coordinates.json"),
        ocr_result_path=str(ocr_path),
        use_calibration=False,
    )

    assert result is not None
    by_id = {item["space_id"]: item for item in result["complete_grid"]}
    assert [by_id[f"A{number:02d}"]["x"] for number in range(1, 5)] == [260, 200, 140, 80]
    assert result["geometry_quality"]["horizontal_directions"] == {"A": "right_to_left"}
    assert result["geometry_quality"]["monotonic"] is True
    assert result["geometry_quality"]["gate"]["passed"] is True


def test_generator_does_not_revert_validator_exclusions_to_raw_geometry(tmp_path, monkeypatch):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({
            "event": {"maps": [{"map_number": 1}]},
            "circles": [{"space": "A-01"}, {"space": "A-02"}],
        }), encoding="utf-8"
    )
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    raw = [
        {"number": "01", "x": 20, "y": 20, "width": 10, "height": 10},
        {"number": "02", "x": 120, "y": 20, "width": 10, "height": 10},
    ]
    ocr_path.write_text(json.dumps({"numbers": raw}), encoding="utf-8")

    class FakeValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_validated(numbers[1:])

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", FakeValidator)
    result = generate_coordinates_from_map(
        str(image_path), str(event_json), output_json_path=str(tmp_path / "coordinates.json"),
        ocr_result_path=str(ocr_path), use_calibration=False,
    )
    assert result is None
    payload = json.loads((tmp_path / "coordinates.json").read_text(encoding="utf-8"))
    assert payload["error"]["code"] == "catalog_geometry_quality_gate_failed"
    assert payload["geometry_quality"]["observed"] <= 1


def test_generator_excludes_remote_duplicate_and_updates_true_event_pin(tmp_path, monkeypatch):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({
            "event": {"maps": [{"map_number": 1}]},
            "circles": [{"space": "A-01"}, {"space": "A-02"}],
        }), encoding="utf-8"
    )
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(json.dumps({"numbers": [
        {"number": "01", "x": 20, "y": 20, "width": 10, "height": 10},
        {"number": "02", "x": 100, "y": 20, "width": 10, "height": 10},
        # Far-away duplicate 02 must be removed by validator.
        {"number": "02", "x": 280, "y": 20, "width": 10, "height": 10},
    ]}), encoding="utf-8")

    class DuplicateFilteringValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            filtered = [item for item in numbers if item["x"] < 200]
            return _validation_validated(filtered)

    class FakeAnalyzer:
        def __init__(self, model=None):
            pass

        def analyze_pattern(self, *args, **kwargs):
            return {"layout_type": "横配置型", "rows": {"count": 1}, "columns": {"count": 2}}

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", DuplicateFilteringValidator)
    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.PatternAnalyzer", FakeAnalyzer)
    output = tmp_path / "coordinates.json"
    result = generate_coordinates_from_map(
        str(image_path), str(event_json), output_json_path=str(output),
        ocr_result_path=str(ocr_path), use_calibration=False,
    )
    assert result is not None
    by_id = {item["space_id"]: item for item in result["complete_grid"]}
    assert by_id["A02"]["x"] == 105

    from src.space_locator.json_updater import JSONUpdater

    update_result = JSONUpdater().update_event_json(
        str(event_json), result["complete_grid"], map_number=1
    )
    circles = json.loads(event_json.read_text(encoding="utf-8"))["circles"]
    assert update_result["updated_count"] == 2
    assert circles[1]["pin_x"] == by_id["A02"]["normalized_x"]
    assert circles[1]["pin_x"] < 0.5  # not the remote duplicate at x=285


def test_generator_calibration_changes_grid_and_event_pins(tmp_path, monkeypatch):
    event_payload = {
        "event": {
            "maps": [{"map_number": 1}],
            "map_calibration_points": [{"space": "A-01", "map_number": 1, "pin_x": 0.20, "pin_y": 0.30}],
        },
        "circles": [{"space": "A-01"}, {"space": "A-02"}],
    }
    event_no = tmp_path / "event_no.json"
    event_yes = tmp_path / "event_yes.json"
    event_no.write_text(json.dumps(event_payload), encoding="utf-8")
    event_yes.write_text(json.dumps(event_payload), encoding="utf-8")
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(json.dumps({"numbers": [
        {"number": "01", "x": 20, "y": 20, "width": 10, "height": 10},
        {"number": "02", "x": 100, "y": 20, "width": 10, "height": 10},
    ]}), encoding="utf-8")

    class KeepValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_validated(numbers)

    class FakeAnalyzer:
        def __init__(self, model=None):
            pass

        def analyze_pattern(self, *args, **kwargs):
            return {"layout_type": "横配置型", "rows": {"count": 1}, "columns": {"count": 2}}

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", KeepValidator)
    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.PatternAnalyzer", FakeAnalyzer)
    no_calibration = generate_coordinates_from_map(
        str(image_path), str(event_no), output_json_path=str(tmp_path / "no.json"),
        ocr_result_path=str(ocr_path), use_calibration=False,
    )
    with_calibration = generate_coordinates_from_map(
        str(image_path), str(event_yes), output_json_path=str(tmp_path / "yes.json"),
        ocr_result_path=str(ocr_path), use_calibration=True,
    )
    assert no_calibration and with_calibration
    assert no_calibration["calibration"] == {"applied": False, "points": 0, "mode": "disabled"}
    assert with_calibration["calibration"] == {"applied": True, "points": 1, "mode": "translation"}
    no_by_id = {item["space_id"]: item for item in no_calibration["complete_grid"]}
    yes_by_id = {item["space_id"]: item for item in with_calibration["complete_grid"]}
    assert yes_by_id["A02"]["normalized_x"] != no_by_id["A02"]["normalized_x"]

    from src.space_locator.json_updater import JSONUpdater

    JSONUpdater().update_event_json(str(event_no), no_calibration["complete_grid"], map_number=1)
    JSONUpdater().update_event_json(str(event_yes), with_calibration["complete_grid"], map_number=1)
    no_pin = json.loads(event_no.read_text(encoding="utf-8"))["circles"][1]["pin_x"]
    yes_pin = json.loads(event_yes.read_text(encoding="utf-8"))["circles"][1]["pin_x"]
    assert yes_pin != no_pin


def test_generator_rejects_unsafe_affine_before_existing_pins_can_be_overwritten(tmp_path, monkeypatch):
    event_payload = {
        "event": {
            "maps": [{"map_number": 1}],
            "map_calibration_points": [
                {"space": space, "map_number": 1, "pin_x": 0.5, "pin_y": 0.5}
                for space in ("A-01", "A-02", "B-01")
            ],
        },
        "circles": [
            {
                "space": f"{prefix}-{number:02d}",
                "pin_x": 0.01 * number,
                "pin_y": 0.1 if prefix == "A" else 0.2,
            }
            for prefix in "AB"
            for number in range(1, 4)
        ],
    }
    event_json = tmp_path / "event.json"
    event_json.write_text(json.dumps(event_payload), encoding="utf-8")
    before = event_json.read_text(encoding="utf-8")
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(
        json.dumps(
            {
                "numbers": [
                    {
                        "number": f"{number:02d}",
                        "x": 40 + (number - 1) * 80,
                        "y": y,
                        "width": 20,
                        "height": 20,
                    }
                    for y in (30, 100)
                    for number in range(1, 4)
                ]
            }
        ),
        encoding="utf-8",
    )

    class KeepValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_validated(numbers)

    class FakeAnalyzer:
        def __init__(self, model=None):
            pass

        def analyze_pattern(self, *args, **kwargs):
            return {"layout_type": "横配置型", "rows": {"count": 2}, "columns": {"count": 3}}

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", KeepValidator)
    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.PatternAnalyzer", FakeAnalyzer)
    output = tmp_path / "coordinates.json"

    result = generate_coordinates_from_map(
        str(image_path),
        str(event_json),
        output_json_path=str(output),
        ocr_result_path=str(ocr_path),
        use_calibration=True,
    )

    assert result is None
    assert event_json.read_text(encoding="utf-8") == before
    failure = json.loads(output.read_text(encoding="utf-8"))
    assert failure["error"]["code"] == "calibration_safety_gate_failed"
    assert failure["calibration"]["applied"] is False
    assert failure["complete_grid"] == []


def test_generator_empty_validator_result_is_controlled_failure(tmp_path, monkeypatch):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({"event": {"maps": [{"map_number": 1}]}, "circles": [{"space": "A-01"}]}),
        encoding="utf-8",
    )
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(json.dumps({"numbers": [{"number": "01", "x": 20, "y": 20, "width": 10, "height": 10}]}), encoding="utf-8")

    class EmptyValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            return _validation_rejected_all(len(numbers))

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", EmptyValidator)
    output = tmp_path / "coordinates.json"
    assert generate_coordinates_from_map(
        str(image_path), str(event_json), output_json_path=str(output), ocr_result_path=str(ocr_path), use_calibration=False
    ) is None
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["error"]["code"] == "number_validation_empty"
    assert payload["raw_count"] == 1
    assert payload["stage"] == "number_validation"
    assert payload["ocr"]["attempted"] is False
    assert payload["ocr"]["candidate_count"] == 1
    assert payload["ocr"]["validated_count"] == 0


def test_generator_validator_exception_is_controlled_failure_without_raw_revert(tmp_path, monkeypatch):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({"event": {"maps": [{"map_number": 1}]}, "circles": [{"space": "A-01"}]}),
        encoding="utf-8",
    )
    image_path = Path(__file__).parents[1] / "fixtures" / "unlimited_ocr_pin_center" / "map_01.png"
    ocr_path = tmp_path / "ocr.json"
    ocr_path.write_text(
        json.dumps({"numbers": [{"number": "01", "x": 20, "y": 20, "width": 10, "height": 10}]}),
        encoding="utf-8",
    )

    class RaisingValidator:
        def __init__(self, model=None):
            pass

        def validate_numbers(self, image, numbers):
            raise RuntimeError("validator secret /private/token")

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.NumberValidator", RaisingValidator)
    monkeypatch.setattr(
        "src.space_locator.auto_coordinate_generator._build_catalog_geometry_grid",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("raw geometry must not run")),
    )
    output = tmp_path / "coordinates.json"
    assert generate_coordinates_from_map(
        str(image_path), str(event_json), output_json_path=str(output), ocr_result_path=str(ocr_path), use_calibration=False
    ) is None
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["error"]["code"] == "number_validation_failed"
    assert payload["ocr"]["validated_count"] == 0
    assert payload["raw_count"] == 1
    assert payload["complete_grid"] == []
    assert payload["stage"] == "number_validation"
    assert payload["ocr"]["attempted"] is False
    assert "private/token" not in json.dumps(payload, ensure_ascii=False)


def test_generator_forwards_deduplicated_expanded_catalog_count(tmp_path, monkeypatch) -> None:
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({
            "event": {"maps": [{"map_number": 1}]},
            "circles": [
                {"space": "A-01,02"},
                {"space": "A-02,03"},
            ],
        }),
        encoding="utf-8",
    )
    captured = {}

    class FakeOCR:
        last_error = None
        diagnostics = {"error": None, "last_run": {}, "config": {}}

        def __init__(self, config=None):
            pass

        def extract_numbers_with_coordinates(self, image, **kwargs):
            captured.update(kwargs)
            return []

    monkeypatch.setattr("src.space_locator.auto_coordinate_generator.OCREngine", FakeOCR)

    assert generate_coordinates_from_map(
        str(tmp_path / "unused.png"),
        str(event_json),
        output_json_path=str(tmp_path / "out.json"),
        use_calibration=False,
    ) is None
    assert captured["expected_candidate_count"] == 3

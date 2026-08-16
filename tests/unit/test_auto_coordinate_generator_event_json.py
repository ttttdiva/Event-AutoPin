from __future__ import annotations

import json
from pathlib import Path

from src.space_locator.auto_coordinate_generator import (
    analyze_space_catalog_from_event,
    apply_calibration_points,
    combine_hall_and_space,
    expand_circle_space_ids,
    expand_space_ids,
)
from src.space_locator.json_updater import JSONUpdater


def test_expand_space_ids_handles_ranges_and_comma():
    assert [item["space_id"] for item in expand_space_ids("A-01,02")] == [
        "A01",
        "A02",
    ]
    assert [item["space_id"] for item in expand_space_ids("B 03-04")] == [
        "B03",
        "B04",
    ]


def test_expand_circle_space_ids_combines_hall_prefix_with_numeric_space():
    assert combine_hall_and_space("14", "E-") == "E-14"
    assert [item["space_id"] for item in expand_circle_space_ids("14", "E-")] == ["E14"]
    assert [item["space_id"] for item in expand_circle_space_ids("15, 16", "E-")] == [
        "E15",
        "E16",
    ]
    assert [item["space_id"] for item in expand_circle_space_ids("14-16", "E-")] == [
        "E14",
        "E15",
        "E16",
    ]


def test_expand_circle_space_ids_rejects_dangerous_hall_space_combinations():
    assert expand_circle_space_ids("1F-A01", "E-") == []
    assert expand_circle_space_ids("14", "E1") == []
    assert expand_circle_space_ids("14", "East1") == []
    assert expand_circle_space_ids("14abc", "E-") == []
    assert expand_circle_space_ids("1F-A01", "E-") == []
    # space 単体で既存 parser が受理できる場合は hall を付け足さない
    assert [item["space_id"] for item in expand_circle_space_ids("abc14", "E-")] == ["abc14"]


def test_analyze_space_catalog_rejects_dangerous_hall_space(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {"maps": [{"map_number": 1}]},
                "circles": [
                    {"name": "bad", "space": "1F-A01", "hall": "E-"},
                    {"name": "good", "space": "14", "hall": "E-"},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    catalog = analyze_space_catalog_from_event(str(event_json), map_number=1)

    assert catalog["event_catalog"]["space_unparseable_count"] == 1
    assert catalog["event_catalog"]["target_space_count"] == 1
    assert [item["space_id"] for item in catalog["spaces"]] == ["E14"]


def test_expand_circle_space_ids_does_not_combine_when_space_already_parseable():
    assert combine_hall_and_space("A-01", "East") == "A-01"
    assert [item["space_id"] for item in expand_circle_space_ids("A-01", "East")] == ["A01"]


def test_analyze_space_catalog_from_event_uses_hall_with_numeric_space(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {"maps": [{"map_number": 1}]},
                "circles": [
                    {"name": "one", "space": "14", "hall": "E-"},
                    {"name": "two", "space": "15, 16", "hall": "E-"},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    catalog = analyze_space_catalog_from_event(str(event_json), map_number=1)

    assert catalog["event_catalog"]["space_unparseable_count"] == 0
    assert catalog["event_catalog"]["target_space_count"] == 3
    assert [item["space_id"] for item in catalog["spaces"]] == ["E14", "E15", "E16"]


def test_json_updater_matches_hall_prefixed_numeric_space(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "circles": [
                    {"name": "target", "space": "14", "hall": "E-", "pin_x": None, "pin_y": None},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = JSONUpdater().update_event_json(
        str(event_json),
        [{"space_id": "E14", "x": 10, "y": 20, "normalized_x": 0.1, "normalized_y": 0.2}],
        map_number=1,
    )

    circle = json.loads(event_json.read_text(encoding="utf-8"))["circles"][0]
    assert result["updated_count"] == 1
    assert circle["pin_x"] == 0.1
    assert circle["pin_y"] == 0.2


def test_analyze_space_catalog_from_event_uses_event_json(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {
                    "maps": [{"map_number": 1, "filename": "maps/map_01.png"}],
                    "map_calibration_points": [
                        {"space": "A-01", "map_number": 1, "pin_x": 0.25, "pin_y": 0.5}
                    ],
                },
                "circles": [
                    {"name": "one", "space": "A-01,02"},
                    {"name": "two", "space": "B 03-04"},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    catalog = analyze_space_catalog_from_event(str(event_json), map_number=1)

    assert catalog["order"] == ["A", "B"]
    assert catalog["number_map"] == {"A": [1, 2], "B": [3, 4]}
    assert len(catalog["spaces"]) == 4
    assert catalog["calibration_points"] == [
        {"space": "A-01", "pin_x": 0.25, "pin_y": 0.5, "map_number": 1}
    ]


def test_apply_calibration_points_translates_grid():
    grid = [
        {"space_id": "A01", "x": 10, "y": 20, "normalized_x": 0.10, "normalized_y": 0.20},
        {"space_id": "A02", "x": 20, "y": 20, "normalized_x": 0.20, "normalized_y": 0.20},
    ]

    adjusted, summary = apply_calibration_points(
        grid,
        [{"space": "A-01", "pin_x": 0.15, "pin_y": 0.25}],
        image_width=100,
        image_height=100,
    )

    assert summary == {"applied": True, "points": 1, "mode": "translation"}
    assert round(adjusted[0]["normalized_x"], 6) == 0.15
    assert round(adjusted[0]["normalized_y"], 6) == 0.25
    assert round(adjusted[1]["normalized_x"], 6) == 0.25
    assert round(adjusted[1]["normalized_y"], 6) == 0.25


def test_calibration_points_skip_malformed_non_finite_and_wrong_map_values(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {
                    "maps": [{"map_number": 1}],
                    "map_calibration_points": [
                        None,
                        {"space": "A-01", "map_number": "not-a-number", "pin_x": 0.1, "pin_y": 0.2},
                        {"space": "A-01", "map_number": 0, "pin_x": 0.1, "pin_y": 0.2},
                        {"space": "A-01", "map_number": 1, "pin_x": "NaN", "pin_y": 0.2},
                        {"space": "A-01", "map_number": 1, "pin_x": "Infinity", "pin_y": 0.2},
                        {"space": "A-01", "map_number": 1, "pin_x": 1.1, "pin_y": 0.2},
                        {"space": "A-01", "map_number": 1, "pin_x": 0.25, "pin_y": 0.5},
                    ],
                },
                "circles": [{"space": "A-01"}],
            }
        ),
        encoding="utf-8",
    )

    catalog = analyze_space_catalog_from_event(str(event_json), map_number=1)

    assert catalog["calibration_points"] == [
        {"space": "A-01", "pin_x": 0.25, "pin_y": 0.5, "map_number": 1}
    ]


def test_apply_calibration_rejects_degenerate_affine_without_mutating_grid():
    grid = [
        {"space_id": "A01", "row": "A", "number": "01", "normalized_x": 0.1, "normalized_y": 0.1, "x": 10, "y": 10},
        {"space_id": "A02", "row": "A", "number": "02", "normalized_x": 0.3, "normalized_y": 0.1, "x": 30, "y": 10},
        {"space_id": "B01", "row": "B", "number": "01", "normalized_x": 0.1, "normalized_y": 0.3, "x": 10, "y": 30},
    ]
    before = json.loads(json.dumps(grid))
    points = [
        {"space": space, "pin_x": 0.5, "pin_y": 0.5}
        for space in ("A-01", "A-02", "B-01")
    ]

    adjusted, summary = apply_calibration_points(grid, points, 100, 100)

    assert summary["applied"] is False
    assert summary["mode"] == "rejected"
    assert adjusted == before
    assert grid == before


def test_apply_calibration_rejects_unsafe_affine_scale_shear_and_residual():
    grid = [
        {
            "space_id": f"{chr(65 + row_index)}{number:02d}",
            "row": chr(65 + row_index),
            "number": f"{number:02d}",
            "normalized_x": x,
            "normalized_y": y,
            "x": round(x * 100),
            "y": round(y * 100),
        }
        for row_index, y in enumerate((0.2, 0.5, 0.8))
        for number, x in enumerate((0.2, 0.5, 0.8), 1)
    ]
    before = json.loads(json.dumps(grid))

    def points_for(transform):
        return [
            {
                "space": item["space_id"],
                "pin_x": transform(item["normalized_x"], item["normalized_y"])[0],
                "pin_y": transform(item["normalized_x"], item["normalized_y"])[1],
            }
            for item in grid
        ]

    unsafe_cases = [
        (points_for(lambda x, y: (0.4 * x, 0.4 * y)), "unsafe_affine_scale"),
        (points_for(lambda x, y: (x + 0.4 * (y - 0.5), y)), "unsafe_affine_shear"),
    ]
    residual_points = points_for(lambda x, y: (x, y))
    residual_points[4]["pin_x"] += 0.1
    unsafe_cases.append((residual_points, "affine_residual_too_large"))

    for points, reason in unsafe_cases:
        adjusted, summary = apply_calibration_points(grid, points, 100, 100)
        assert summary["applied"] is False
        assert summary["reason"] == reason
        assert adjusted == before
        assert grid == before


def test_apply_calibration_rejects_out_of_bounds_translation_without_clamping():
    grid = [
        {"space_id": "A01", "normalized_x": 0.1, "normalized_y": 0.2, "x": 10, "y": 20},
        {"space_id": "A02", "normalized_x": 0.4, "normalized_y": 0.2, "x": 40, "y": 20},
    ]
    before = json.loads(json.dumps(grid))

    adjusted, summary = apply_calibration_points(
        grid,
        [{"space": "A-01", "pin_x": 0.9, "pin_y": 0.2}],
        100,
        100,
    )

    assert summary == {
        "applied": False,
        "points": 1,
        "mode": "rejected",
        "reason": "transformed_grid_out_of_bounds",
    }
    assert adjusted == before
    assert grid == before


def test_apply_calibration_rejects_affine_rotation_that_changes_row_direction():
    grid = [
        {"space_id": "A01", "row": "A", "number": "01", "normalized_x": 0.2, "normalized_y": 0.2, "x": 20, "y": 20},
        {"space_id": "A02", "row": "A", "number": "02", "normalized_x": 0.4, "normalized_y": 0.2, "x": 40, "y": 20},
        {"space_id": "B01", "row": "B", "number": "01", "normalized_x": 0.2, "normalized_y": 0.4, "x": 20, "y": 40},
    ]
    before = json.loads(json.dumps(grid))
    # x' = y, y' = 1 - x is finite, in bounds, unit scale, and exactly fits
    # the anchors, but it rotates horizontal numbering onto the vertical axis.
    points = [
        {"space": "A-01", "pin_x": 0.2, "pin_y": 0.8},
        {"space": "A-02", "pin_x": 0.2, "pin_y": 0.6},
        {"space": "B-01", "pin_x": 0.4, "pin_y": 0.8},
    ]

    adjusted, summary = apply_calibration_points(grid, points, 100, 100)

    assert summary["applied"] is False
    assert summary["reason"] == "transformed_grid_direction_changed"
    assert adjusted == before
    assert grid == before


def test_build_coordinate_patches_is_pure_and_contains_auditable_identity():
    event_data = {
        "event": {"maps": [{"map_number": 1}, {"map_number": 2}]},
        "circles": [
            {
                "name": "Circle A",
                "penname": "A",
                "space": "A-01",
                "hall": "East",
                "map_number": 1,
                "metadata": {"keep": True},
            },
            {"name": "Other map", "space": "A-02", "map_number": 2},
            {"name": "Unassigned", "space": "A-03"},
        ],
    }
    before = json.loads(json.dumps(event_data))
    result = JSONUpdater().build_coordinate_patches(
        event_data,
        [{"space_id": "A01", "x": 10, "y": 20, "normalized_x": 0.1, "normalized_y": 0.2}],
        map_number=1,
    )

    assert event_data == before
    assert result["updated_count"] == 1
    assert result["skipped_count"] == 2
    patch = result["circle_patches"][0]
    assert patch["circle_index"] == 0
    assert patch["circle_identity"] == {
        "name": "Circle A", "penname": "A", "space": "A-01", "hall": "East"
    }
    assert patch["base_circle"]["metadata"] == {"keep": True}
    assert patch["changes"] == {"pin_x": 0.1, "pin_y": 0.2}


def test_json_updater_only_changes_pins_and_skips_other_maps(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "circles": [
                    {
                        "name": "target",
                        "space": "A-01",
                        "map_number": None,
                        "pin_x": 0.9,
                        "pin_y": 0.8,
                        "metadata": {"unchanged": True},
                    },
                    {"name": "other", "space": "A-02", "map_number": 2},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = JSONUpdater().update_event_json(
        str(event_json),
        [
            {"space_id": "A01", "x": 10, "y": 20, "normalized_x": 0.1, "normalized_y": 0.2},
            {"space_id": "A02", "x": 30, "y": 40, "normalized_x": 0.3, "normalized_y": 0.4},
        ],
        map_number=1,
    )

    data = json.loads(event_json.read_text(encoding="utf-8"))
    assert result["updated_count"] == 1
    assert data["circles"] == [
        {
            "name": "target",
            "space": "A-01",
            "map_number": None,
            "pin_x": 0.1,
            "pin_y": 0.2,
            "metadata": {"unchanged": True},
        },
        {"name": "other", "space": "A-02", "map_number": 2},
    ]


def test_json_updater_multi_map_does_not_claim_unassigned_circle(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "event": {"maps": [{"map_number": 1}, {"map_number": 2}]},
                "circles": [
                    {"name": "unassigned", "space": "A-01", "pin_x": 0.9, "pin_y": 0.8},
                    {"name": "target", "space": "A-01", "map_number": 1},
                    {"name": "zero", "space": "A-01", "map_number": 0},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = JSONUpdater().update_event_json(
        str(event_json),
        [{"space_id": "A01", "x": 10, "y": 20, "normalized_x": 0.1, "normalized_y": 0.2}],
        map_number=1,
    )

    circles = json.loads(event_json.read_text(encoding="utf-8"))["circles"]
    assert result["updated_count"] == 1
    assert circles[0] == {"name": "unassigned", "space": "A-01", "pin_x": 0.9, "pin_y": 0.8}
    assert circles[1]["pin_x"] == 0.1
    assert "pin_x" not in circles[2]


def test_json_updater_updates_comma_slash_and_range_groups_only_when_complete(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "circles": [
                    {"space": "A-01,02"},
                    {"space": "B-03/04"},
                    {"space": "C 05-06"},
                    {"space": "D-07、08", "pin_x": 0.9, "pin_y": 0.8},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    coordinates = [
        {"space_id": f"{prefix}{number:02d}", "x": number * 10, "y": number * 20,
         "normalized_x": number / 100, "normalized_y": number / 50}
        for prefix, numbers in (("A", (1, 2)), ("B", (3, 4)), ("C", (5, 6)))
        for number in numbers
    ] + [
        {"space_id": "D07", "x": 70, "y": 140, "normalized_x": 0.07, "normalized_y": 0.14}
    ]

    result = JSONUpdater().update_event_json(str(event_json), coordinates)
    circles = json.loads(event_json.read_text(encoding="utf-8"))["circles"]

    assert result["updated_count"] == 3
    assert result["skipped_count"] == 1
    assert circles[0]["pin_x"] == 0.015
    assert circles[1]["pin_x"] == 0.035
    assert circles[2]["pin_x"] == 0.055
    assert circles[3]["pin_x"] == 0.9


def test_calibrated_final_grid_updates_event_json_pins(tmp_path: Path):
    """Calibration is applied after deterministic geometry and reaches event.json."""
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps({"circles": [{"space": "A-01"}, {"space": "A-02"}]}),
        encoding="utf-8",
    )
    deterministic_grid = [
        {"space_id": "A01", "x": 20, "y": 20, "normalized_x": 0.20, "normalized_y": 0.20},
        {"space_id": "A02", "x": 40, "y": 20, "normalized_x": 0.40, "normalized_y": 0.20},
    ]
    calibrated_grid, summary = apply_calibration_points(
        deterministic_grid,
        [{"space": "A-01", "pin_x": 0.30, "pin_y": 0.35}],
        image_width=100,
        image_height=100,
    )
    assert summary == {"applied": True, "points": 1, "mode": "translation"}
    assert calibrated_grid[0]["normalized_x"] != 0.20

    result = JSONUpdater().update_event_json(str(event_json), calibrated_grid)
    circles = json.loads(event_json.read_text(encoding="utf-8"))["circles"]
    assert result["updated_count"] == 2
    assert circles[0]["pin_x"] == calibrated_grid[0]["normalized_x"]
    assert circles[1]["pin_x"] == calibrated_grid[1]["normalized_x"]

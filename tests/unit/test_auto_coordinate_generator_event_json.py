from __future__ import annotations

import json
from pathlib import Path

from src.space_locator.auto_coordinate_generator import (
    analyze_space_catalog_from_event,
    apply_calibration_points,
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


def test_json_updater_sets_map_number_and_skips_other_maps(tmp_path: Path):
    event_json = tmp_path / "event.json"
    event_json.write_text(
        json.dumps(
            {
                "circles": [
                    {"name": "target", "space": "A-01"},
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
    assert data["circles"][0]["pin_x"] == 0.1
    assert data["circles"][0]["map_number"] == 1
    assert data["circles"][1]["map_number"] == 2
    assert "pin_x" not in data["circles"][1]


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

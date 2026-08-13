from __future__ import annotations

from src.space_locator.ocr_engine import _elements_to_numbers


def test_elements_to_numbers_accepts_single_number_and_preserves_contract():
    numbers = _elements_to_numbers([{"text": "7", "x1": 10, "y1": 20, "x2": 30, "y2": 45}])

    assert numbers == [
        {
            "number": "07",
            "x": 10,
            "y": 20,
            "width": 20,
            "height": 25,
            "confidence": 99,
            "variant": "unlimited_ocr_0",
        }
    ]


def test_elements_to_numbers_filters_out_of_range_and_non_numbers():
    numbers = _elements_to_numbers(
        [
            {"text": "0", "x1": 0, "y1": 0, "x2": 10, "y2": 10},
            {"text": "100", "x1": 0, "y1": 0, "x2": 10, "y2": 10},
            {"text": "A12", "x1": 0, "y1": 0, "x2": 10, "y2": 10},
            {"text": "", "x1": 0, "y1": 0, "x2": 10, "y2": 10},
        ]
    )

    assert numbers == []


def test_elements_to_numbers_splits_numeric_ref_by_token_position():
    numbers = _elements_to_numbers(
        [{"text": "1 2 3 4", "x1": 100, "y1": 20, "x2": 300, "y2": 40}]
    )

    assert [item["number"] for item in numbers] == ["01", "02", "03", "04"]
    assert [item["x"] for item in numbers] == [100, 150, 200, 250]
    assert all(item["width"] == 50 for item in numbers)


def test_elements_to_numbers_splits_newline_group_vertically():
    numbers = _elements_to_numbers(
        [{"text": "02\n03\n04", "x1": 2918, "y1": 100, "x2": 2960, "y2": 302}]
    )

    assert [item["number"] for item in numbers] == ["02", "03", "04"]
    assert [item["x"] for item in numbers] == [2918, 2918, 2918]
    assert [item["y"] for item in numbers] == [100, 167, 234]


def test_elements_to_numbers_keeps_space_group_horizontal_even_in_tall_box():
    numbers = _elements_to_numbers(
        [{"text": "02 03 04", "x1": 0, "y1": 100, "x2": 42, "y2": 302}]
    )

    assert [item["x"] for item in numbers] == [0, 14, 28]
    assert all(item["y"] == 100 and item["height"] == 202 for item in numbers)


def test_elements_to_numbers_splits_html_table_grouped_numbers():
    numbers = _elements_to_numbers(
        [
            {
                "text": "<table><tr><td>01</td><td>A</td><td>02</td></tr></table>",
                "x1": 0,
                "y1": 0,
                "x2": 300,
                "y2": 30,
            }
        ]
    )

    assert [item["number"] for item in numbers] == ["01", "02"]
    assert [item["x"] for item in numbers] == [0, 200]


def test_elements_to_numbers_accepts_eighty_percent_numeric_tokens():
    numbers = _elements_to_numbers(
        [{"text": "1 2 X 4 5", "x1": 0, "y1": 0, "x2": 500, "y2": 20}]
    )

    assert [item["number"] for item in numbers] == ["01", "02", "04", "05"]
    assert [item["x"] for item in numbers] == [0, 100, 300, 400]


def test_elements_to_numbers_rejects_below_eighty_percent_numeric_tokens():
    numbers = _elements_to_numbers(
        [{"text": "1 2 X Y 5", "x1": 0, "y1": 0, "x2": 500, "y2": 20}]
    )

    assert numbers == []


def test_elements_to_numbers_splits_short_row_with_non_numeric_heading():
    numbers = _elements_to_numbers(
        [{"text": "あ 01 02", "x1": 100, "y1": 20, "x2": 220, "y2": 50}]
    )

    assert [item["number"] for item in numbers] == ["01", "02"]
    assert [item["x"] for item in numbers] == [140, 180]
    assert [item["prefix"] for item in numbers] == ["あ", "あ"]


def test_elements_to_numbers_prefix_policy_rejects_dates_and_long_ids():
    accepted = _elements_to_numbers(
        [
            {"text": "企業-01", "x1": 0, "y1": 0, "x2": 20, "y2": 20},
            {"text": "A-01", "x1": 40, "y1": 0, "x2": 60, "y2": 20},
            {"text": "P-12", "x1": 80, "y1": 0, "x2": 100, "y2": 20},
        ]
    )
    rejected = _elements_to_numbers(
        [
            {"text": "2025-01", "x1": 0, "y1": 0, "x2": 20, "y2": 20},
            {"text": "2025/01", "x1": 30, "y1": 0, "x2": 50, "y2": 20},
            {"text": "123-45", "x1": 60, "y1": 0, "x2": 80, "y2": 20},
            {"text": "AB-12", "x1": 90, "y1": 0, "x2": 110, "y2": 20},
        ]
    )

    assert [item["number"] for item in accepted] == ["01", "01", "12"]
    assert rejected == []


def test_elements_to_numbers_merges_near_duplicates_and_sorts_by_y_x():
    numbers = _elements_to_numbers(
        [
            {"text": "2", "x1": 80, "y1": 30, "x2": 110, "y2": 60},
            {"text": "1", "x1": 50, "y1": 10, "x2": 70, "y2": 30},
            {"text": "1", "x1": 52, "y1": 12, "x2": 68, "y2": 28},
        ]
    )

    assert [item["number"] for item in numbers] == ["01", "02"]
    assert numbers[0]["x"] == 50
    assert numbers[0]["width"] == 20


def test_elements_to_numbers_deduplicates_overlap_but_keeps_distinct_same_number():
    numbers = _elements_to_numbers(
        [
            {"text": "12", "x1": 100, "y1": 100, "x2": 150, "y2": 140},
            {"text": "12", "x1": 125, "y1": 100, "x2": 165, "y2": 140},
            {"text": "12", "x1": 220, "y1": 100, "x2": 260, "y2": 140},
        ]
    )

    assert len(numbers) == 2
    assert [item["x"] for item in numbers] == [100, 220]
    assert numbers[0]["width"] == 65


def test_elements_to_numbers_skips_missing_coordinates_and_invalid_boxes():
    numbers = _elements_to_numbers(
        [
            {"text": "1", "x1": 10, "y1": 10, "x2": 5, "y2": 20},
            {"text": "2", "x1": 10, "y1": 10, "x2": 20},
            {"text": "3", "x1": 30, "y1": 5, "x2": 40, "y2": 15},
        ]
    )

    assert [item["number"] for item in numbers] == ["03"]


def test_elements_to_numbers_preserves_prefix_space_id_and_raw_context():
    numbers = _elements_to_numbers(
        [
            {"text": "A-01", "x1": 10, "y1": 10, "x2": 30, "y2": 30},
            {"text": "B-01", "x1": 40, "y1": 10, "x2": 60, "y2": 30},
        ]
    )

    assert [(item["space_id"], item["prefix"], item["raw_text"]) for item in numbers] == [
        ("A01", "A", "A-01"),
        ("B01", "B", "B-01"),
    ]


def test_elements_to_numbers_preserves_prefix_for_merged_group_members():
    numbers = _elements_to_numbers(
        [{"text": "M-03,04", "x1": 100, "y1": 20, "x2": 180, "y2": 40}]
    )

    assert [(item["space_id"], item["number"]) for item in numbers] == [
        ("M03", "03"),
        ("M04", "04"),
    ]
    assert all(item["raw_text"] == "M-03,04" for item in numbers)


def test_elements_to_numbers_does_not_merge_adjacent_same_number_without_overlap():
    numbers = _elements_to_numbers(
        [
            {"text": "01", "x1": 100, "y1": 100, "x2": 120, "y2": 120},
            {"text": "01", "x1": 125, "y1": 100, "x2": 145, "y2": 120},
        ]
    )

    assert len(numbers) == 2
    assert [item["x"] for item in numbers] == [100, 125]


def test_elements_to_numbers_does_not_merge_overlapping_different_prefixes():
    numbers = _elements_to_numbers(
        [
            {"text": "A-01", "x1": 100, "y1": 100, "x2": 130, "y2": 120},
            {"text": "B-01", "x1": 101, "y1": 100, "x2": 131, "y2": 120},
        ]
    )

    assert [item["space_id"] for item in numbers] == ["A01", "B01"]


def test_elements_to_numbers_merges_bare_and_prefixed_duplicate_and_keeps_context():
    numbers = _elements_to_numbers(
        [
            {"text": "01", "x1": 100, "y1": 100, "x2": 130, "y2": 120},
            {"text": "A-01", "x1": 101, "y1": 100, "x2": 131, "y2": 120},
        ]
    )

    assert len(numbers) == 1
    assert numbers[0]["space_id"] == "A01"
    assert numbers[0]["prefix"] == "A"


def test_elements_to_numbers_keeps_table_row_prefix_for_duplicate_numbers():
    numbers = _elements_to_numbers(
        [
            {
                "text": (
                    "<table>"
                    "<tr><td>A</td><td>01</td></tr>"
                    "<tr><td>B</td><td>01</td></tr>"
                    "</table>"
                ),
                "x1": 0,
                "y1": 0,
                "x2": 200,
                "y2": 100,
            }
        ]
    )

    assert [item["space_id"] for item in numbers] == ["A01", "B01"]
    assert [item["y"] for item in numbers] == [0, 50]

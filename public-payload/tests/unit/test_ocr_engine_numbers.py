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


def test_elements_to_numbers_merges_near_duplicates_and_sorts_by_y_x():
    numbers = _elements_to_numbers(
        [
            {"text": "2", "x1": 80, "y1": 30, "x2": 110, "y2": 60},
            {"text": "1", "x1": 50, "y1": 10, "x2": 70, "y2": 30},
            {"text": "1", "x1": 52, "y1": 12, "x2": 68, "y2": 28},
        ]
    )

    assert [item["number"] for item in numbers] == ["01", "02"]
    assert numbers[0]["x"] == 52
    assert numbers[0]["width"] == 16


def test_elements_to_numbers_skips_missing_coordinates_and_invalid_boxes():
    numbers = _elements_to_numbers(
        [
            {"text": "1", "x1": 10, "y1": 10, "x2": 5, "y2": 20},
            {"text": "2", "x1": 10, "y1": 10, "x2": 20},
            {"text": "3", "x1": 30, "y1": 5, "x2": 40, "y2": 15},
        ]
    )

    assert [item["number"] for item in numbers] == ["03"]

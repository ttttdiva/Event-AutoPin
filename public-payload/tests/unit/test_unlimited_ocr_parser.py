from __future__ import annotations

from src.space_locator.unlimited_ocr_parser import parse_grounding_output


def test_parse_single_box_list_converts_normalized_coordinates():
    raw = "<|ref|>12<|/ref|><|det|>[[0, 100, 999, 999]]<|/det|>"

    assert parse_grounding_output(raw, image_width=2000, image_height=1000) == [
        {"text": "12", "x1": 0, "y1": 100, "x2": 2000, "y2": 1000}
    ]


def test_parse_single_box_without_outer_list():
    raw = "<|ref|>7<|/ref|><|det|>[10, 20, 30, 40]<|/det|>"

    assert parse_grounding_output(raw, image_width=999, image_height=999) == [
        {"text": "7", "x1": 10, "y1": 20, "x2": 30, "y2": 40}
    ]


def test_parse_multiple_boxes_and_multiline_ref():
    raw = (
        "<|ref|>A\n12<|/ref|><|det|>"
        "[[10, 20, 30, 40], [50, 60, 70, 80]]"
        "<|/det|>"
    )

    assert parse_grounding_output(raw, image_width=999, image_height=999) == [
        {"text": "A\n12", "x1": 10, "y1": 20, "x2": 30, "y2": 40},
        {"text": "A\n12", "x1": 50, "y1": 60, "x2": 70, "y2": 80},
    ]


def test_parse_skips_invalid_det_and_invalid_box():
    raw = (
        "<|ref|>bad<|/ref|><|det|>not-a-list<|/det|>"
        "<|ref|>reversed<|/ref|><|det|>[[30, 20, 10, 40]]<|/det|>"
        "<|ref|>ok<|/ref|><|det|>[[10, 20, 30, 40]]<|/det|>"
    )

    assert parse_grounding_output(raw, image_width=999, image_height=999) == [
        {"text": "ok", "x1": 10, "y1": 20, "x2": 30, "y2": 40}
    ]


def test_parse_det_text_format_observed_from_unlimited_ocr():
    raw = (
        "<|det|>text [81, 294, 117, 316]<|/det|>16 17\n"
        "<|det|>text [155, 320, 191, 336]<|/det|>15 18"
    )

    assert parse_grounding_output(raw, image_width=3840, image_height=2714) == [
        {"text": "16 17", "x1": 311, "y1": 798, "x2": 449, "y2": 858},
        {"text": "15 18", "x1": 595, "y1": 869, "x2": 734, "y2": 912},
    ]

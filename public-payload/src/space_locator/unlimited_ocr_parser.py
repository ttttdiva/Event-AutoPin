"""Baidu Unlimited OCR の grounding 出力を座標要素へ変換する。"""

from __future__ import annotations

import ast
import re
from typing import Any


REF_DET_PATTERN = re.compile(
    r"<\|ref\|>(.*?)<\|/ref\|><\|det\|>(.*?)<\|/det\|>",
    re.DOTALL,
)
DET_TEXT_PATTERN = re.compile(
    r"<\|det\|>[^\[]*(\[.*?\])<\|/det\|>(.*?)(?=<\|det\|>|$)",
    re.DOTALL,
)


def _to_pixel(value: Any, size: int) -> int:
    return int(float(value) / 999 * size)


def _normalize_boxes(raw_boxes: Any) -> list[list[Any]]:
    if not isinstance(raw_boxes, list) or not raw_boxes:
        return []
    if all(isinstance(item, (int, float)) for item in raw_boxes):
        return [raw_boxes]
    return [box for box in raw_boxes if isinstance(box, list)]


def _append_box_elements(
    elements: list[dict[str, Any]],
    text: str,
    raw_boxes: Any,
    image_width: int,
    image_height: int,
) -> None:
    for box in _normalize_boxes(raw_boxes):
        if len(box) != 4:
            continue
        try:
            x1 = _to_pixel(box[0], image_width)
            y1 = _to_pixel(box[1], image_height)
            x2 = _to_pixel(box[2], image_width)
            y2 = _to_pixel(box[3], image_height)
        except (TypeError, ValueError):
            continue
        if x1 >= x2 or y1 >= y2:
            continue
        elements.append(
            {
                "text": text,
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
            }
        )


def parse_grounding_output(
    raw_text: str,
    image_width: int,
    image_height: int,
) -> list[dict[str, Any]]:
    """ref/det付き生出力を要素リストに変換する。

    det部は JSON ではなく Python リテラル形式の場合があるため
    ast.literal_eval で解釈する。変換不能な det や不正な box は捨てて続行する。
    """
    elements: list[dict[str, Any]] = []
    if not raw_text or image_width <= 0 or image_height <= 0:
        return elements

    for match in REF_DET_PATTERN.finditer(raw_text):
        text = match.group(1).strip()
        det_text = match.group(2).strip()
        try:
            raw_boxes = ast.literal_eval(det_text)
        except (ValueError, SyntaxError):
            continue
        _append_box_elements(elements, text, raw_boxes, image_width, image_height)

    for match in DET_TEXT_PATTERN.finditer(raw_text):
        det_text = match.group(1).strip()
        text = match.group(2).strip()
        if not text:
            continue
        try:
            raw_box = ast.literal_eval(det_text)
        except (ValueError, SyntaxError):
            continue
        _append_box_elements(elements, text, raw_box, image_width, image_height)
    return elements

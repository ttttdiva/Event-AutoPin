#!/usr/bin/env python3
"""
マップ画像から event.json のピン座標を自動生成する。

入力はマップ画像と event.json のみ。
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Mapping

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

from .coordinate_mapper import CoordinateMapper
from .catalog_geometry_assignment import global_min_cost_association
from .number_validator import NumberValidator
from .ocr_engine import OCREngine
from .pattern_analyzer import PatternAnalyzer


DASH_CHARS = "\u2010\u2011\u2012\u2013\u2014\u2212\u30fc\uff0d"
SEPARATOR_RE = re.compile(r"[\s\-_/]+")


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )


def normalize_space_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("\u3000", " ").strip()
    for dash in DASH_CHARS:
        text = text.replace(dash, "-")
    return re.sub(r"\s+", " ", text)


def normalize_space_key(value: str) -> str:
    text = normalize_space_text(value)
    text = SEPARATOR_RE.sub("", text)
    match = re.match(r"^([^0-9]+)(\d+)([A-Za-z]?)$", text)
    if match:
        suffix = match.group(3) or ""
        return f"{match.group(1)}{int(match.group(2)):02d}{suffix}".lower()
    return text.lower()


def _split_space_prefix_suffix(space: str) -> Optional[Tuple[str, str]]:
    compact = normalize_space_text(space).replace(" ", "")
    match = re.match(r"^([^0-9]+)(.*)$", compact)
    if not match:
        return None
    prefix = match.group(1).rstrip("-")
    suffix = match.group(2).lstrip("-")
    if not prefix or not suffix:
        return None
    return prefix, suffix


def expand_space_ids(space: str) -> List[Dict[str, Any]]:
    """A-01,02 / A01-02 / あ 01 などを単一スペースIDへ展開する。"""
    split = _split_space_prefix_suffix(space)
    if split is None:
        return []
    prefix, suffix = split
    suffix = suffix.replace("、", ",").replace("，", ",").replace("・", ",")

    numbers: List[int] = []
    for part in re.split(r"[,/]+", suffix):
        part = part.strip("- ")
        if not part:
            continue
        range_match = re.match(r"^(\d+)[A-Za-z]?\s*-\s*(\d+)[A-Za-z]?$", part)
        if range_match:
            start = int(range_match.group(1))
            end = int(range_match.group(2))
            step = 1 if start <= end else -1
            numbers.extend(range(start, end + step, step))
            continue
        number_match = re.match(r"^(\d+)", part)
        if number_match:
            numbers.append(int(number_match.group(1)))

    results: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for number in numbers:
        key = (prefix, number)
        if key in seen:
            continue
        seen.add(key)
        results.append(
            {
                "space_id": f"{prefix}{number:02d}",
                "prefix": prefix,
                "number": number,
                "number_text": f"{number:02d}",
            }
        )
    return results


def load_event_json(event_json_path: str) -> Dict[str, Any]:
    with open(event_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("event.json のルートがオブジェクトではありません")
    return data


def calibration_points_from_event(
    event_data: Dict[str, Any],
    map_number: int,
) -> List[Dict[str, Any]]:
    def parse_map_number(value: Any) -> Optional[int]:
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            if not math.isfinite(value) or not value.is_integer():
                return None
            return int(value)
        text = str(value).strip()
        if not re.fullmatch(r"[+-]?\d+", text):
            return None
        try:
            return int(text)
        except (TypeError, ValueError, OverflowError):
            return None

    requested_map = parse_map_number(map_number)
    if requested_map is None:
        return []
    event = event_data.get("event", {})
    points = []
    if isinstance(event, dict):
        points = event.get("map_calibration_points") or []
    if not isinstance(points, list):
        return []

    result: List[Dict[str, Any]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        point_map_raw = point.get("map_number")
        if point_map_raw is None or point_map_raw == "":
            point_map = requested_map
        else:
            point_map = parse_map_number(point_map_raw)
            if point_map is None:
                continue
        if point_map != requested_map:
            continue
        space = str(point.get("space") or point.get("space_id") or "").strip()
        pin_x = point.get("pin_x", point.get("x"))
        pin_y = point.get("pin_y", point.get("y"))
        if isinstance(pin_x, bool) or isinstance(pin_y, bool):
            continue
        try:
            x = float(pin_x)
            y = float(pin_y)
        except (TypeError, ValueError, OverflowError):
            continue
        if not (
            space
            and math.isfinite(x)
            and math.isfinite(y)
            and 0 <= x <= 1
            and 0 <= y <= 1
        ):
            continue
        result.append({"space": space, "pin_x": x, "pin_y": y, "map_number": point_map})
    return result


def analyze_space_catalog_from_event(
    event_json_path: str,
    map_number: int = 1,
) -> Dict[str, Any]:
    event_data = load_event_json(event_json_path)
    circles = event_data.get("circles", [])
    if not isinstance(circles, list):
        raise ValueError("event.json の circles が配列ではありません")

    event = event_data.get("event", {})
    map_count = 1
    if isinstance(event, dict) and isinstance(event.get("maps"), list):
        map_count = max(1, len(event.get("maps") or []))

    order: List[str] = []
    counts: Dict[str, int] = defaultdict(int)
    number_map: Dict[str, set[int]] = defaultdict(set)
    spaces: List[Dict[str, Any]] = []
    target_keys: set[str] = set()

    for circle_index, circle in enumerate(circles):
        if not isinstance(circle, dict):
            continue
        circle_map_raw = circle.get("map_number")
        if circle_map_raw is None:
            circle_map = None
        else:
            try:
                circle_map = int(circle_map_raw)
            except (TypeError, ValueError):
                continue
        if map_count > 1 and circle_map is None:
            continue
        if circle_map is not None and circle_map != map_number:
            continue

        raw_space = str(circle.get("space") or "").strip()
        if not raw_space:
            continue
        expanded = expand_space_ids(raw_space)
        for item in expanded:
            prefix = item["prefix"]
            if prefix not in order:
                order.append(prefix)
            counts[prefix] += 1
            number_map[prefix].add(item["number"])
            space_item = {
                **item,
                "raw_space": raw_space,
                "circle_index": circle_index,
                "circle_name": circle.get("name", ""),
                "map_number": map_number,
            }
            spaces.append(space_item)
            target_keys.add(normalize_space_key(item["space_id"]))

    number_map_sorted = {
        prefix: sorted(values) for prefix, values in number_map.items()
    }

    horizontal_labels = [
        prefix
        for prefix in order
        if counts[prefix] > 6 or (number_map_sorted.get(prefix) and max(number_map_sorted[prefix]) > 6)
    ]
    vertical_labels = [prefix for prefix in order if prefix not in horizontal_labels]
    if not horizontal_labels and order:
        horizontal_labels = order[:]
        vertical_labels = []

    max_column_number = 0
    min_column_number = 1
    for label in horizontal_labels or order:
        numbers = number_map_sorted.get(label) or []
        if numbers:
            max_column_number = max(max_column_number, max(numbers))
            min_column_number = min(min_column_number, min(numbers))

    return {
        "order": order,
        "counts": dict(counts),
        "horizontal_labels": horizontal_labels,
        "vertical_labels": vertical_labels,
        "number_map": number_map_sorted,
        "max_column_number": max_column_number,
        "min_column_number": min_column_number,
        "spaces": spaces,
        "target_space_keys": sorted(target_keys),
        "calibration_points": calibration_points_from_event(event_data, map_number),
        "map_number": map_number,
    }


def build_fallback_pattern(
    pattern_info: Dict[str, Any],
    catalog_info: Dict[str, Any],
) -> Dict[str, Any]:
    horizontal_labels = catalog_info.get("horizontal_labels") or [
        f"Row{i + 1}" for i in range(pattern_info.get("rows", 3) or 3)
    ]
    row_count = len(horizontal_labels)
    col_count = (
        catalog_info.get("max_column_number")
        or pattern_info.get("cols")
        or 10
    )
    col_count = max(int(col_count), int(pattern_info.get("cols", 0) or 0), 1)
    min_col = int(catalog_info.get("min_column_number") or 1)

    return {
        "layout_type": "横配置型",
        "rows": {
            "labels": horizontal_labels,
            "direction": "上から下",
            "count": row_count,
            "numbering": "上から下",
            "range": [1, row_count],
        },
        "columns": {
            "numbering": "左から右",
            "range": [col_count, min_col],
            "count": col_count,
        },
        "floor": None,
        "confidence": 0.5,
    }


def _interpolate_positions(positions: List[Optional[float]], base_spacing: float) -> List[float]:
    result = positions[:]
    n = len(result)

    def ensure_spacing(idx: int) -> None:
        if idx > 0 and result[idx] is not None and result[idx - 1] is not None:
            if result[idx] <= result[idx - 1]:
                result[idx] = result[idx - 1] + base_spacing

    i = 0
    while i < n:
        if result[i] is not None:
            i += 1
            continue

        j = i
        while j < n and result[j] is None:
            j += 1

        prev_val = result[i - 1] if i > 0 else None
        next_val = result[j] if j < n else None
        gap = j - i

        if prev_val is not None and next_val is not None and next_val > prev_val:
            step = (next_val - prev_val) / (gap + 1)
            for offset in range(gap):
                result[i + offset] = prev_val + step * (offset + 1)
        elif prev_val is not None:
            for offset in range(gap):
                result[i + offset] = prev_val + base_spacing * (offset + 1)
        elif next_val is not None:
            for offset in range(gap, 0, -1):
                result[i + gap - offset] = max(next_val - base_spacing * offset, 0.0)
        else:
            for offset in range(gap):
                result[i + offset] = base_spacing * (offset + 1)

        i = j

    for idx in range(1, n):
        ensure_spacing(idx)

    return [val if val is not None else base_spacing * idx for idx, val in enumerate(result)]


def estimate_column_positions(
    numbers: List[Dict[str, Any]],
    image_width: int,
    target_count: int,
    right_threshold: float = 0.88,
    row_positions: Optional[List[float]] = None,
    image_height: Optional[int] = None,
) -> List[float]:
    if target_count <= 0 or image_width <= 0:
        return []

    column_values: Dict[int, List[float]] = defaultdict(list)
    normalized_rows: Optional[List[float]] = None
    if row_positions and image_height:
        normalized_rows = [pos / image_height for pos in row_positions if pos > 0]

    for entry in numbers:
        try:
            value = int(entry["number"])
        except (ValueError, TypeError):
            continue
        if value < 1 or value > target_count:
            continue

        width = entry.get("width", 0)
        center_x = entry["x"] + width / 2
        normalized_x = center_x / image_width
        center_y = entry["y"] + entry.get("height", 0) / 2
        normalized_y = center_y / image_height if image_height else None

        if normalized_x >= right_threshold or normalized_x <= 0.33:
            continue
        if normalized_rows is not None and normalized_y is not None:
            nearest_delta = min(abs(normalized_y - row) for row in normalized_rows)
            if nearest_delta > 0.075:
                continue

        column_values[value].append(center_x)

    filled: List[Optional[float]] = [None] * target_count
    for value, xs in column_values.items():
        if xs:
            filled[value - 1] = statistics.median(xs)

    known_indices = [idx for idx, val in enumerate(filled) if val is not None]
    if not known_indices:
        step = image_width / (target_count + 1)
        return [step * (i + 1) for i in range(target_count)]

    spacing_samples: List[float] = []
    for prev_idx, next_idx in zip(known_indices[:-1], known_indices[1:]):
        delta_idx = next_idx - prev_idx
        if delta_idx <= 0:
            continue
        assert filled[prev_idx] is not None and filled[next_idx] is not None
        delta_x = filled[next_idx] - filled[prev_idx]
        if delta_x > 0:
            spacing_samples.append(delta_x / delta_idx)

    base_spacing = (
        statistics.median(spacing_samples)
        if spacing_samples
        else image_width / (target_count + 1)
    )
    if base_spacing <= 0:
        base_spacing = image_width / (target_count + 1)

    return [
        min(value, image_width * right_threshold)
        for value in _interpolate_positions(filled, base_spacing)
    ]


def _kmeans_1d(values: List[float], k: int, max_iter: int = 25) -> List[float]:
    if not values or k <= 0:
        return []
    values_sorted = sorted(values)
    if len(values_sorted) <= k:
        return values_sorted + [values_sorted[-1]] * (k - len(values_sorted))

    centers = [values_sorted[int(len(values_sorted) * (i + 0.5) / k)] for i in range(k)]
    for _ in range(max_iter):
        clusters: List[List[float]] = [[] for _ in range(k)]
        for value in values_sorted:
            idx = min(range(k), key=lambda i: abs(value - centers[i]))
            clusters[idx].append(value)
        new_centers = [
            sum(cluster) / len(cluster)
            if cluster
            else values_sorted[int(len(values_sorted) * (idx + 0.5) / k)]
            for idx, cluster in enumerate(clusters)
        ]
        if all(abs(new - old) < 1e-3 for new, old in zip(new_centers, centers)):
            centers = new_centers
            break
        centers = new_centers
    return sorted(centers)


def estimate_row_positions(
    numbers: List[Dict[str, Any]],
    image_width: int,
    image_height: int,
    row_count: int,
    right_threshold: float = 0.9,
    max_value: int = 99,
) -> List[float]:
    if row_count <= 0 or image_height <= 0:
        return []

    bottom_ratio = 0.75 if row_count >= 3 else 0.8 if row_count == 2 else 0.65
    by_value: Dict[int, List[float]] = defaultdict(list)

    for entry in numbers:
        try:
            value = int(entry["number"])
        except (ValueError, TypeError):
            continue
        if value < 1 or value > max_value:
            continue

        width = entry.get("width", 0)
        height = entry.get("height", 0)
        center_x = entry["x"] + width / 2
        center_y = entry["y"] + height / 2
        if center_x / image_width >= right_threshold:
            continue
        if center_y / image_height > bottom_ratio:
            continue
        by_value[value].append(center_y)

    candidate_positions: List[float] = []
    gap_threshold = image_height * 0.05
    for ys in by_value.values():
        if not ys:
            continue
        sorted_ys = sorted(ys)
        cluster = [sorted_ys[0]]
        for y in sorted_ys[1:]:
            if y - cluster[-1] > gap_threshold:
                avg = sum(cluster) / len(cluster)
                candidate_positions.extend([avg] * len(cluster))
                cluster = [y]
            else:
                cluster.append(y)
        avg = sum(cluster) / len(cluster)
        candidate_positions.extend([avg] * len(cluster))

    filtered = [y for y in candidate_positions if y > 0]
    if not filtered:
        step = image_height * 0.09
        return [step * (i + 1.5) for i in range(row_count)]

    centers = _kmeans_1d(filtered, row_count)
    if len(centers) < row_count:
        last = centers[-1]
        step = image_height * 0.09
        while len(centers) < row_count:
            last += step
            centers.append(last)
    return sorted(centers[:row_count])


def extract_vertical_points(
    numbers: List[Dict[str, Any]],
    image_width: int,
    image_height: int,
    expected_count: Optional[int] = None,
) -> List[Tuple[float, float]]:
    points: List[Tuple[float, float]] = []
    for num in numbers:
        try:
            number_value = int(num["number"])
        except (ValueError, TypeError):
            continue
        if number_value > 18:
            continue
        cx = (num["x"] + num.get("width", 0) / 2) / image_width
        cy = (num["y"] + num.get("height", 0) / 2) / image_height
        if cx > 0.9:
            points.append((cx, cy))

    if not points:
        return []

    points.sort(key=lambda p: p[1])
    clusters: List[List[Tuple[float, float]]] = [[points[0]]]
    for pt in points[1:]:
        if pt[1] - clusters[-1][-1][1] <= 0.03:
            clusters[-1].append(pt)
        else:
            clusters.append([pt])

    target_clusters = expected_count if expected_count and expected_count > 0 else 5
    while len(clusters) > target_clusters:
        merge_index = min(
            range(len(clusters) - 1),
            key=lambda idx: clusters[idx + 1][0][1] - clusters[idx][-1][1],
        )
        clusters[merge_index].extend(clusters[merge_index + 1])
        clusters.pop(merge_index + 1)

    return [
        (
            sum(p[0] for p in cluster) / len(cluster),
            sum(p[1] for p in cluster) / len(cluster),
        )
        for cluster in clusters
    ]


def detect_vertical_labels_from_catalog(catalog_info: Dict[str, Any]) -> List[Dict[str, Any]]:
    vertical_prefixes = set(catalog_info.get("vertical_labels") or [])
    results: List[Dict[str, Any]] = []
    seen: set[Tuple[str, int]] = set()
    for space in catalog_info.get("spaces", []):
        prefix = space.get("prefix")
        number = space.get("number")
        if prefix not in vertical_prefixes or not isinstance(number, int):
            continue
        key = (prefix, number)
        if key in seen:
            continue
        seen.add(key)
        results.append(
            {
                "prefix": prefix,
                "number": f"{number:02d}",
                "source_suffix": space.get("raw_space", ""),
            }
        )
    return results


def _number_center(entry: Mapping[str, Any]) -> Tuple[float, float]:
    """Return the centre of an OCR bbox without mutating the input."""
    try:
        x = float(entry.get("x", 0) or 0)
        y = float(entry.get("y", 0) or 0)
        width = float(entry.get("width", 0) or 0)
        height = float(entry.get("height", 0) or 0)
    except (TypeError, ValueError):
        return 0.0, 0.0
    return x + width / 2.0, y + height / 2.0


def _catalog_geometry_bbox(entry: Mapping[str, Any]) -> Optional[Tuple[float, float, float, float]]:
    """Return a finite, positive OCR bbox or ``None`` for malformed input."""
    try:
        x = float(entry.get("x", 0))
        y = float(entry.get("y", 0))
        width = float(entry.get("width", 0))
        height = float(entry.get("height", 0))
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (x, y, width, height)):
        return None
    if width <= 0 or height <= 0:
        return None
    return x, y, width, height


def _catalog_geometry_grid_dimensions(image_size: Any) -> Tuple[float, float]:
    """Accept the common image-size spellings used by callers/tests."""
    if isinstance(image_size, Mapping):
        width = image_size.get("width", image_size.get("image_width", 0))
        height = image_size.get("height", image_size.get("image_height", 0))
    else:
        try:
            width, height = image_size  # type: ignore[misc]
        except (TypeError, ValueError):
            width = height = 0
    try:
        return max(float(width), 1.0), max(float(height), 1.0)
    except (TypeError, ValueError):
        return 1.0, 1.0


def _catalog_geometry_number(value: Any) -> Optional[int]:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if 1 <= number <= 99 else None


def _cluster_catalog_axis(values: Sequence[float], threshold: float) -> List[List[float]]:
    """Deterministically cluster sorted one-dimensional coordinates."""
    if not values:
        return []
    clusters: List[List[float]] = [[float(sorted(values)[0])]]
    for value in sorted(float(item) for item in values)[1:]:
        if value - clusters[-1][-1] <= threshold:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return clusters


def _catalog_expected_spaces(catalog_info: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Normalise catalog entries while preserving range/circle membership."""
    spaces = catalog_info.get("spaces") or []
    result: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in spaces:
        if not isinstance(item, Mapping):
            continue
        prefix = str(item.get("prefix") or "").strip()
        number = _catalog_geometry_number(item.get("number"))
        if not prefix or number is None:
            continue
        space_id = str(item.get("space_id") or f"{prefix}{number:02d}")
        key = normalize_space_key(space_id)
        if key in seen:
            continue
        seen.add(key)
        result.append({
            "space_id": space_id,
            "prefix": prefix,
            "number": number,
            "circle_index": item.get("circle_index"),
            "raw_space": item.get("raw_space", ""),
        })
    return result


def _catalog_geometry_row_clusters(
    numbers: Sequence[Mapping[str, Any]],
    image_width: float,
    image_height: float,
) -> Tuple[List[List[Dict[str, Any]]], List[List[Dict[str, Any]]]]:
    """Separate horizontal number bands from right-hand vertical labels."""
    valid: List[Dict[str, Any]] = []
    for raw in numbers:
        if not isinstance(raw, Mapping):
            continue
        number = _catalog_geometry_number(raw.get("number"))
        if number is None:
            continue
        bbox = _catalog_geometry_bbox(raw)
        if bbox is None:
            continue
        x, y, width, height = bbox
        cx, cy = x + width / 2.0, y + height / 2.0
        if not (0 < cx <= image_width * 1.05 and 0 < cy <= image_height * 1.05):
            continue
        item = dict(raw)
        item["number"] = number
        item["_cx"] = cx
        item["_cy"] = cy
        item["_width"] = width
        item["_height"] = height
        valid.append(item)

    # Vertical labels are isolated at the far right.  The 0.87 cut keeps
    # regular horizontal rows while accepting maps with a narrow right gutter.
    vertical = [item for item in valid if item["_cx"] >= image_width * 0.87]
    horizontal = [item for item in valid if item["_cx"] < image_width * 0.87]
    # Tiny 40px fragments are frequently a second OCR tile of a larger
    # grouped bbox (and can contain shifted/misread numbers).  Remove these
    # fragments from the horizontal resolver; vertical labels are handled
    # separately because their genuine bboxes are narrow by design.
    horizontal_widths = [item["_width"] for item in horizontal]
    if horizontal_widths:
        width_floor = statistics.median(horizontal_widths) * 0.75
        horizontal = [item for item in horizontal if item["_width"] >= width_floor]
    heights = [item["_height"] for item in valid]
    median_height = statistics.median(heights) if heights else 20.0
    # Keep adjacent map rows distinct (including the common 40-50px OCR
    # overlap bands), while still merging duplicate boxes for one label.
    y_threshold = max(18.0, min(55.0, median_height * 0.85))

    def by_y(items: Sequence[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        if not items:
            return []
        clusters = _cluster_catalog_axis([item["_cy"] for item in items], y_threshold)
        result: List[List[Dict[str, Any]]] = []
        for cluster in clusters:
            lo, hi = min(cluster), max(cluster)
            group = [item for item in items if lo - 1e-6 <= item["_cy"] <= hi + 1e-6]
            result.append(sorted(group, key=lambda item: item["_cx"]))
        return result

    return by_y(horizontal), by_y(vertical)


def _catalog_geometry_axis_tracks(
    numbers: Sequence[Mapping[str, Any]],
    image_width: float,
    image_height: float,
) -> Tuple[List[List[Dict[str, Any]]], List[List[Dict[str, Any]]], int]:
    """Build row and column hypotheses from every valid OCR candidate.

    Unlike the legacy right-gutter split, this treats orientation as a spatial
    property.  It therefore supports portrait maps made entirely of vertical
    columns as well as maps containing horizontal rows and vertical islands.
    """
    valid: List[Dict[str, Any]] = []
    invalid = 0
    for raw in numbers:
        if not isinstance(raw, Mapping):
            invalid += 1
            continue
        number = _catalog_geometry_number(raw.get("number"))
        bbox = _catalog_geometry_bbox(raw)
        if number is None or bbox is None:
            invalid += 1
            continue
        x, y, width, height = bbox
        cx, cy = x + width / 2.0, y + height / 2.0
        if not (0 < cx <= image_width * 1.05 and 0 < cy <= image_height * 1.05):
            invalid += 1
            continue
        item = dict(raw)
        item.update(number=number, _cx=cx, _cy=cy, _width=width, _height=height)
        valid.append(item)
    if not valid:
        return [], [], invalid

    median_width = statistics.median(item["_width"] for item in valid)
    median_height = statistics.median(item["_height"] for item in valid)
    # OCR text boxes are much narrower than the booth-to-booth jitter within a
    # physical line.  Four bbox widths merges that jitter without joining the
    # adjacent folded island (normally separated by several booth widths).
    x_threshold = max(10.0, min(image_width * 0.025, median_width * 0.9))
    y_threshold = max(10.0, min(image_height * 0.025, median_height * 0.9))

    def cluster(axis: str, threshold: float, sort_axis: str) -> List[List[Dict[str, Any]]]:
        groups = _cluster_catalog_axis([item[axis] for item in valid], threshold)
        result: List[List[Dict[str, Any]]] = []
        for values in groups:
            lo, hi = min(values), max(values)
            members = [item for item in valid if lo - 1e-6 <= item[axis] <= hi + 1e-6]
            result.append(sorted(members, key=lambda item: (item[sort_axis], item[axis], item["number"])))
        return result

    return cluster("_cy", y_threshold, "_cx"), cluster("_cx", x_threshold, "_cy"), invalid


def _catalog_lcs_length(left: Sequence[int], right: Sequence[int]) -> int:
    table = [0] * (len(right) + 1)
    for value in left:
        previous = 0
        for index, expected in enumerate(right, 1):
            saved = table[index]
            if value == expected:
                table[index] = previous + 1
            else:
                table[index] = max(table[index], table[index - 1])
            previous = saved
    return table[-1]


def _catalog_track_support(
    track: Sequence[Mapping[str, Any]],
    expected_numbers: Sequence[int],
    axis: str,
) -> Tuple[int, float]:
    expected = sorted({int(number) for number in expected_numbers})
    expected_set = set(expected)
    ordered: List[int] = []
    for item in sorted(track, key=lambda value: (float(value[axis]), int(value["number"]))):
        number = int(item["number"])
        if number in expected_set and (not ordered or number != ordered[-1]):
            ordered.append(number)
    unique = set(ordered)
    if not unique:
        return 0, 0.0
    forward = _catalog_lcs_length(ordered, expected)
    backward = _catalog_lcs_length(ordered, list(reversed(expected)))
    return len(unique), max(forward, backward) / len(unique)


def _catalog_infer_layout(
    numbers: Sequence[Mapping[str, Any]],
    expected: Sequence[Mapping[str, Any]],
    catalog_info: Mapping[str, Any],
    image_width: float,
    image_height: float,
) -> Dict[str, Any]:
    """Deterministically match catalog prefixes to spatial row/column tracks."""
    order = [str(label) for label in (catalog_info.get("order") or [])]
    for item in expected:
        prefix = str(item["prefix"])
        if prefix not in order:
            order.append(prefix)
    expected_by_prefix = {
        prefix: sorted({int(item["number"]) for item in expected if item["prefix"] == prefix})
        for prefix in order
    }
    rows, columns, invalid = _catalog_geometry_axis_tracks(numbers, image_width, image_height)

    # Catalog orientation is only a prior, but on mixed maps it provides a
    # useful tie-breaker between a sparse real row and a vertical cross-section.
    prior_horizontal = {str(label) for label in (catalog_info.get("horizontal_labels") or [])}
    prior_vertical = {str(label) for label in (catalog_info.get("vertical_labels") or [])}
    prior_is_mixed = bool(prior_horizontal and prior_vertical)
    pair_horizontal = pair_vertical = 0
    valid_candidates = [item for row in rows for item in row]
    unique_candidates = {id(item): item for item in valid_candidates}.values()
    candidate_list = list(unique_candidates)
    for index, left in enumerate(candidate_list):
        for right in candidate_list[index + 1 :]:
            delta = abs(int(left["number"]) - int(right["number"]))
            if not 1 <= delta <= 3:
                continue
            dx = abs(float(left["_cx"]) - float(right["_cx"]))
            dy = abs(float(left["_cy"]) - float(right["_cy"]))
            if math.hypot(dx / image_width, dy / image_height) > 0.16:
                continue
            if dx > dy * 2:
                pair_horizontal += 1
            elif dy > dx * 2:
                pair_vertical += 1
    geometry_is_vertical = pair_vertical > pair_horizontal * 1.35
    if geometry_is_vertical:
        prior_is_mixed = False

    # A horizontal row must contain a real number sequence.  Cross-sections of
    # vertical columns contain one repeated number and are rejected here.
    row_candidates: List[Tuple[float, int, int, int]] = []
    prefix_count = max(len(order), 1)
    for prefix_index, prefix in enumerate(order):
        expected_numbers = expected_by_prefix[prefix]
        for row_index, row in enumerate(rows):
            matched, sequence = _catalog_track_support(row, expected_numbers, "_cx")
            coverage = matched / len(expected_numbers) if expected_numbers else 0.0
            # A cross-section through portrait columns can look like a short
            # 01,02,03 row.  A genuine horizontal map has approximately one
            # dense spatial row per catalog prefix, not dozens of y slices.
            plausible_row_count = len(rows) <= max(prefix_count * 2, 6)
            if (
                plausible_row_count
                and matched >= min(3, len(expected_numbers))
                and coverage >= 0.45
                and sequence >= 0.60
            ):
                prior_bonus = 1.0 if prior_is_mixed and prefix in prior_horizontal else 0.0
                prior_penalty = 1.0 if prior_is_mixed and prefix in prior_vertical else 0.0
                row_candidates.append((coverage * 0.75 + sequence * 0.25 + prior_bonus - prior_penalty, prefix_index, row_index, matched))
    horizontal: Dict[str, List[List[Dict[str, Any]]]] = {}
    used_rows: set[int] = set()
    # Stable maximum-score matching; catalog/y order resolves identical rows.
    if geometry_is_vertical:
        row_candidates = []
    for _, prefix_index, row_index, _ in sorted(
        row_candidates,
        key=lambda item: (-item[0], statistics.median(v["_cy"] for v in rows[item[2]]), item[1]),
    ):
        prefix = order[prefix_index]
        if prefix in horizontal or row_index in used_rows:
            continue
        horizontal[prefix] = [rows[row_index]]
        used_rows.add(row_index)

    if prior_is_mixed:
        eligible_rows = sorted(
            [
                row
                for row in rows
                if len({_catalog_geometry_number(item.get("number")) for item in row}) >= 3
            ],
            key=lambda row: statistics.median(item["_cy"] for item in row),
        )
        if len(eligible_rows) >= len(prior_horizontal):
            prior_prefixes = [prefix for prefix in order if prefix in prior_horizontal]
            horizontal = {
                prefix: [row]
                for prefix, row in zip(prior_prefixes, eligible_rows[: len(prior_prefixes)])
            }
        else:
            horizontal = {prefix: tracks for prefix, tracks in horizontal.items() if prefix in prior_horizontal}
        used_rows = {
            rows.index(tracks[0])
            for tracks in horizontal.values()
            if tracks and tracks[0] in rows
        }

    # The score matching above determines which prefixes/rows are horizontal;
    # their final correspondence follows catalog and top-to-bottom spatial
    # order, which is stable even when one row is missing an OCR token.
    if horizontal:
        selected_prefixes = [prefix for prefix in order if prefix in horizontal]
        selected_rows = sorted(
            [tracks[0] for tracks in horizontal.values()],
            key=lambda row: statistics.median(item["_cy"] for item in row),
        )
        horizontal = {prefix: [row] for prefix, row in zip(selected_prefixes, selected_rows)}

    horizontal_item_ids = {
        id(item)
        for row_index in used_rows
        for item in rows[row_index]
    }
    columns = [
        [item for item in column if id(item) not in horizontal_item_ids]
        for column in columns
    ]
    columns = [column for column in columns if column]
    remaining = [prefix for prefix in order if prefix not in horizontal]
    vertical: Dict[str, List[List[Dict[str, Any]]]] = {}

    # Split x-aligned but vertically disconnected islands (for example a short
    # corporate column above an otherwise unrelated numbered column).
    split_columns: List[List[Dict[str, Any]]] = []
    for column in columns:
        ordered_column = sorted(column, key=lambda item: item["_cy"])
        gaps = [right["_cy"] - left["_cy"] for left, right in zip(ordered_column[:-1], ordered_column[1:])]
        typical_gap = statistics.median(gaps) if gaps else 0.0
        split_gap = max(image_height * 0.08, typical_gap * 2.5)
        segments: List[List[Dict[str, Any]]] = [[]]
        for index, item in enumerate(ordered_column):
            if index and gaps[index - 1] > split_gap:
                segments.append([])
            segments[-1].append(item)
        split_columns.extend(segments)
    columns = sorted(split_columns, key=lambda column: (statistics.median(item["_cx"] for item in column), statistics.median(item["_cy"] for item in column)))
    if prior_is_mixed and prior_vertical:
        # In a mixed row/side-column map, vertical components occupy a compact
        # side band.  Remove distant OCR fragments before prefix assignment;
        # this is a spatial relationship, not an event/prefix special case.
        side_columns = [
            column
            for column in columns
            if statistics.median(item["_cx"] for item in column) >= image_width * 0.85
        ]
        if len(side_columns) >= len(prior_vertical):
            columns = side_columns

    # Separate islands at effectively the same x have no left/right ordering.
    # Assign them to consecutive catalog prefixes by expected numeric support,
    # so an upper 01-02 label and lower 01-10 label do not get swapped merely
    # because their x medians differ by a few pixels.
    for index in range(len(columns) - 1):
        left = columns[index]
        right = columns[index + 1]
        x_distance = abs(
            statistics.median(item["_cx"] for item in left)
            - statistics.median(item["_cx"] for item in right)
        )
        if x_distance > statistics.median(item["_width"] for item in left + right):
            continue
        prefix_index = min(index, max(0, len(remaining) - 2))
        left_support = _catalog_track_support(left, expected_by_prefix[remaining[prefix_index]], "_cy")[0]
        right_support = _catalog_track_support(right, expected_by_prefix[remaining[prefix_index]], "_cy")[0]
        if right_support > left_support or (
            right_support == left_support
            and statistics.median(item["_cy"] for item in right)
            < statistics.median(item["_cy"] for item in left)
        ):
            columns[index], columns[index + 1] = right, left

    def vertical_group_score(prefix: str, group: Sequence[Sequence[Mapping[str, Any]]]) -> float:
        expected_numbers = expected_by_prefix[prefix]
        matched_numbers: set[int] = set()
        sequence_sum = 0.0
        useful_tracks = 0
        for track in group:
            matched, sequence = _catalog_track_support(track, expected_numbers, "_cy")
            if matched:
                useful_tracks += 1
                sequence_sum += sequence
                matched_numbers.update(
                    int(item["number"]) for item in track if int(item["number"]) in expected_numbers
                )
        if not useful_tracks or not expected_numbers:
            return -1.0
        coverage = len(matched_numbers) / len(expected_numbers)
        sequence = sequence_sum / useful_tracks
        expected_set = set(expected_numbers)
        precision = len(matched_numbers) / max(
            1,
            len({int(item["number"]) for track in group for item in track}),
        )
        track_sets = [
            {int(item["number"]) for item in track if int(item["number"]) in expected_set}
            for track in group
        ]
        continuity = 0.0
        track_xs = [statistics.median(item["_cx"] for item in track) for track in group]
        if len(track_xs) > 1 and max(track_xs) - min(track_xs) > image_width * 0.12:
            return -1.0
        for left, right in zip(track_sets[:-1], track_sets[1:]):
            if not left or not right:
                continuity -= 0.08
                continue
            overlap = len(left & right) / min(len(left), len(right))
            gap = max(0, min(right) - max(left) - 1, min(left) - max(right) - 1)
            continuity += 0.05 * (1.0 - overlap) - min(gap, 5) * 0.01
        return coverage * 0.68 + sequence * 0.17 + precision * 0.15 + continuity - (len(group) - 1) * 0.008

    # Partition all x tracks jointly.  Greedy assignment steals the second
    # island of one prefix when neighbouring prefixes share the same numeric
    # range; suffix DP evaluates the complete catalog-order correspondence.
    cache: Dict[Tuple[int, int], Tuple[float, Tuple[Tuple[int, int], ...], float]] = {}

    def partition(prefix_index: int, column_index: int) -> Tuple[float, Tuple[Tuple[int, int], ...], float]:
        key = (prefix_index, column_index)
        if key in cache:
            return cache[key]
        if prefix_index >= len(remaining):
            return (-0.03 * (len(columns) - column_index), (), float("inf"))
        prefixes_left = len(remaining) - prefix_index - 1
        candidates: List[Tuple[float, Tuple[Tuple[int, int], ...], float]] = []
        max_start = min(len(columns), column_index + 4)
        for start in range(column_index, max_start):
            max_count = min(4, len(columns) - start - prefixes_left)
            for count in range(1, max_count + 1):
                group_score = vertical_group_score(remaining[prefix_index], columns[start : start + count])
                if group_score < 0:
                    continue
                suffix_score, suffix, suffix_margin = partition(prefix_index + 1, start + count)
                total = group_score + suffix_score - 0.04 * (start - column_index)
                candidates.append((total, ((start, count),) + suffix, suffix_margin))
        if not candidates:
            best = (-float("inf"), (), 0.0)
        else:
            candidates.sort(key=lambda item: (-item[0], item[1]))
            best_score, best_assignment, suffix_margin = candidates[0]
            local_margin = best_score - candidates[1][0] if len(candidates) > 1 else float("inf")
            best = (best_score, best_assignment, min(local_margin, suffix_margin))
        cache[key] = best
        return best

    _, assignments, partition_margin = partition(0, 0)
    for prefix, assignment in zip(remaining, assignments):
        start, count = assignment
        vertical[prefix] = columns[start : start + count]

    return {
        "horizontal": horizontal,
        "vertical": vertical,
        "horizontal_labels": list(horizontal),
        "vertical_labels": list(vertical),
        "invalid_candidates": invalid,
        "partition_margin": partition_margin,
    }


def _catalog_monotonic_observations(
    row: Sequence[Mapping[str, Any]],
    expected_numbers: Sequence[int],
) -> Dict[int, float]:
    """Choose at most one observation per number in a monotonic row.

    OCR tiles can emit the same token more than once.  Taking the candidate
    closest to the monotonic number order (then the narrowest bbox) prevents a
    duplicate from shifting the lattice while remaining deterministic.
    """
    expected = [int(value) for value in expected_numbers if 1 <= int(value) <= 99]
    if not expected or not row:
        return {}
    candidates: Dict[int, List[Mapping[str, Any]]] = defaultdict(list)
    for item in row:
        number = _catalog_geometry_number(item.get("number"))
        if number in expected:
            candidates[number].append(item)
    selected: Dict[int, float] = {}
    previous_x = -float("inf")
    for number in expected:
        choices = candidates.get(number) or []
        if not choices:
            continue
        ranked = sorted(
            choices,
            key=lambda item: (
                0 if float(item.get("_cx", 0)) > previous_x else 1,
                float(item.get("_cx", 0)),
                float(item.get("_width", 0)),
            ),
        )
        chosen = ranked[0]
        x = float(chosen.get("_cx", 0))
        if x <= previous_x:
            continue
        selected[number] = x
        previous_x = x
    return selected


def _catalog_lcs_observations(
    row: Sequence[Mapping[str, Any]],
    expected_numbers: Sequence[int],
) -> Dict[int, float]:
    """Align OCR tokens to an ordered number sequence using LCS.

    Unlimited-OCR may duplicate tile edges or substitute one digit.  Exact
    monotonic matches are retained; unmatched tokens are intentionally treated
    as missing/imputed rather than allowed to shift every later slot.
    """
    observations, _ = _catalog_lcs_alignment(row, expected_numbers)
    return observations


def _catalog_lcs_alignment(
    row: Sequence[Mapping[str, Any]],
    expected_numbers: Sequence[int],
) -> Tuple[Dict[int, float], int]:
    """Return the strongest LCS alignment and its number-to-x direction.

    Rows are spatially sorted from left to right, but catalog numbering can run
    in either direction.  Comparing both catalog orders here prevents a valid
    right-to-left row from being reduced to one retained token before lattice
    construction.
    """
    expected = [int(value) for value in expected_numbers if 1 <= int(value) <= 99]
    tokens = sorted(
        [item for item in row if _catalog_geometry_number(item.get("number")) is not None],
        key=lambda item: float(item.get("_cx", _number_center(item)[0])),
    )
    if not expected or not tokens:
        return {}, 1
    values = [_catalog_geometry_number(item.get("number")) for item in tokens]
    # Keep one token for an adjacent duplicate before the DP; this is both
    # deterministic and matches the tile-overlap failure mode.
    deduped: List[Mapping[str, Any]] = []
    for item, value in zip(tokens, values):
        if deduped and value == _catalog_geometry_number(deduped[-1].get("number")):
            continue
        deduped.append(item)
    tokens = deduped
    values = [_catalog_geometry_number(item.get("number")) for item in tokens]
    n = len(tokens)

    def align(ordered_expected: Sequence[int]) -> Dict[int, float]:
        m = len(ordered_expected)
        table = [[0] * (m + 1) for _ in range(n + 1)]
        for i in range(n - 1, -1, -1):
            for j in range(m - 1, -1, -1):
                match = (
                    1 + table[i + 1][j + 1]
                    if values[i] == ordered_expected[j]
                    else 0
                )
                table[i][j] = max(match, table[i + 1][j], table[i][j + 1])
        result: Dict[int, float] = {}
        i = j = 0
        while i < n and j < m:
            if (
                values[i] == ordered_expected[j]
                and table[i][j] == 1 + table[i + 1][j + 1]
            ):
                result[int(ordered_expected[j])] = float(
                    tokens[i].get("_cx", _number_center(tokens[i])[0])
                )
                i += 1
                j += 1
            elif table[i + 1][j] >= table[i][j + 1]:
                i += 1
            else:
                j += 1
        return result

    forward = align(expected)
    reverse = align(list(reversed(expected)))
    if len(reverse) > len(forward):
        return reverse, -1
    if len(forward) > len(reverse):
        return forward, 1

    # Equal LCS lengths occur for sparse rows.  Use the observed endpoint trend
    # only as a deterministic tie-breaker; a singleton keeps the legacy LTR
    # default and will normally be rejected later by the observation gate.
    distinct_values = [value for index, value in enumerate(values) if value not in values[:index]]
    if len(distinct_values) >= 2 and distinct_values[-1] < distinct_values[0]:
        return reverse, -1
    return forward, 1


def _catalog_global_lattice(
    observations: Sequence[Mapping[int, float]],
    expected_numbers: Sequence[int],
    directions: Optional[Sequence[int]] = None,
) -> Dict[int, float]:
    """Build one robust x lattice from all horizontal rows."""
    expected = sorted({int(value) for value in expected_numbers if 1 <= int(value) <= 99})
    by_number: Dict[int, List[float]] = defaultdict(list)
    for row in observations:
        for number, x in row.items():
            by_number[int(number)].append(float(x))
    direct = {
        number: (
            max(xs)
            if len(xs) >= 2 and max(xs) - min(xs) > 60.0
            else statistics.median(xs)
        )
        for number, xs in by_number.items()
        if xs
    }
    slopes: List[float] = []
    direction_votes: List[int] = []
    for index, row in enumerate(observations):
        row_direction = (
            int(directions[index])
            if directions is not None and index < len(directions)
            else 0
        )
        ordered_numbers = sorted(int(number) for number in row)
        for left, right in zip(ordered_numbers[:-1], ordered_numbers[1:]):
            if right == left:
                continue
            slope = (float(row[right]) - float(row[left])) / (right - left)
            if not math.isfinite(slope) or abs(slope) <= 1e-9:
                continue
            slope_direction = 1 if slope > 0 else -1
            if row_direction and slope_direction != row_direction:
                continue
            slopes.append(slope)
            direction_votes.append(row_direction or slope_direction)

    if not slopes and len(direct) >= 2:
        direct_numbers = sorted(direct)
        slopes = [
            (direct[right] - direct[left]) / (right - left)
            for left, right in zip(direct_numbers[:-1], direct_numbers[1:])
            if right > left and abs(direct[right] - direct[left]) > 1e-9
        ]
        direction_votes.extend(1 if slope > 0 else -1 for slope in slopes)

    dominant_direction = 1
    if direction_votes and sum(direction_votes) < 0:
        dominant_direction = -1
    consistent_slopes = [
        slope for slope in slopes if (slope > 0) == (dominant_direction > 0)
    ]
    spacing = statistics.median(consistent_slopes) if consistent_slopes else 0.0
    if abs(spacing) <= 1e-9:
        # A single row may have only one OCR token.  Keep the fallback
        # data-derived and bounded; callers can reject a low-coverage result.
        spacing = float(dominant_direction)
    lattice: Dict[int, float] = dict(direct)
    if direct:
        anchor_number = min(direct, key=lambda number: (len(by_number[number]) * -1, number))
        anchor_x = direct[anchor_number]
        for number in expected:
            lattice.setdefault(number, anchor_x + spacing * (number - anchor_number))
    return {number: lattice[number] for number in expected if number in lattice}


def _catalog_geometry_group_center(
    expected: Mapping[str, Any],
    centers: Mapping[Tuple[str, int], Tuple[float, float]],
) -> Optional[Tuple[float, float]]:
    prefix = str(expected.get("prefix") or "")
    number = _catalog_geometry_number(expected.get("number"))
    if not prefix or number is None:
        return None
    raw_space = str(expected.get("raw_space") or "")
    members = expand_space_ids(raw_space) if raw_space else []
    member_numbers = [int(item["number"]) for item in members if item.get("prefix") == prefix]
    if len(member_numbers) <= 1:
        return centers.get((prefix, number))
    points = [centers.get((prefix, member)) for member in member_numbers]
    points = [point for point in points if point is not None]
    if not points:
        return None
    return (
        statistics.mean(point[0] for point in points),
        statistics.mean(point[1] for point in points),
    )


def _build_catalog_geometry_grid(
    numbers: Sequence[Mapping[str, Any]],
    catalog_info: Mapping[str, Any],
    image_size: Any,
) -> List[Dict[str, Any]]:
    """Resolve catalog booth centres directly from OCR geometry.

    The resolver intentionally has no event pin/calibration inputs.  Horizontal
    rows share a robust number-indexed lattice; vertical labels use the OCR
    text centre minus a bbox-derived left offset.  Expanded range members are
    emitted with the same centre as their source circle.
    """
    image_width, image_height = _catalog_geometry_grid_dimensions(image_size)
    expected = _catalog_expected_spaces(catalog_info)
    if not expected:
        return []
    layout = _catalog_infer_layout(numbers, expected, catalog_info, image_width, image_height)
    horizontal_labels = list(layout["horizontal_labels"])
    vertical_labels = set(layout["vertical_labels"])

    # Map observed y clusters to catalog labels in order.  If OCR reports an
    # extra decorative row, select the densest clusters rather than letting it
    # shift all subsequent rows.
    expected_horizontal = {
        label: sorted({int(item["number"]) for item in expected if item["prefix"] == label})
        for label in horizontal_labels
    }
    row_observations: Dict[str, Dict[int, float]] = {}
    row_directions: Dict[str, int] = {}
    row_y: Dict[str, float] = {}
    observed_expected_numbers = [number for values in expected_horizontal.values() for number in values]
    if observed_expected_numbers:
        number_range = list(range(min(observed_expected_numbers), max(observed_expected_numbers) + 1))
    else:
        number_range = []
    all_numbers = number_range
    for label in horizontal_labels:
        assigned = layout["horizontal"].get(label) or []
        row = assigned[0] if assigned else []
        observations, direction = _catalog_lcs_alignment(row, number_range)
        row_observations[label] = observations
        row_directions[label] = direction
        if row:
            row_y[label] = statistics.median(item["_cy"] for item in row)
    lattice = _catalog_global_lattice(
        [row_observations[label] for label in horizontal_labels],
        all_numbers,
        [row_directions[label] for label in horizontal_labels],
    )
    centers: Dict[Tuple[str, int], Tuple[float, float]] = {}
    for label in horizontal_labels:
        observations = row_observations.get(label, {})
        y = row_y.get(label)
        if y is None and row_y:
            y = statistics.median(row_y.values())
        if y is None:
            continue
        for number in expected_horizontal.get(label, []):
            centers[(label, number)] = (float(lattice.get(number, observations.get(number, 0.0))), float(y))

    # Vertical labels: assign y clusters by catalog order and derive a stable
    # left offset from observed bbox widths (not from pin/calibration values).
    vertical_expected = [item for item in expected if item["prefix"] in vertical_labels]
    by_prefix_vertical: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for item in vertical_expected:
        by_prefix_vertical[item["prefix"]].append(item)
    vertical_prefix_order = list(layout["vertical_labels"])
    for prefix in vertical_prefix_order:
        expected_items = sorted(by_prefix_vertical.get(prefix, []), key=lambda item: item["number"])
        if not expected_items:
            continue
        tracks = layout["vertical"].get(prefix) or []
        row = [item for track in tracks for item in track]
        widths = [float(item["_width"]) for item in row]
        # Grounding bbox width is not a booth displacement: in ordinary
        # vertical islands its centre already identifies the printed booth
        # number.  The Aria-style far-right gutter is the exception, where
        # labels sit immediately to the right of the booth strip.  Detect that
        # spatially rather than applying the old width subtraction everywhere.
        track_center_x = statistics.median(float(item["_cx"]) for item in row) if row else 0.0
        vertical_offset = (
            statistics.median(widths) * 0.95
            if horizontal_labels and widths and track_center_x >= image_width * 0.90
            else 0.0
        )
        by_number: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for candidate in row:
            number = _catalog_geometry_number(candidate.get("number"))
            if number is not None:
                by_number[number].append(candidate)
        track_models: List[Tuple[List[int], float, float, float, float]] = []
        for track in tracks:
            relevant = [item for item in track if int(item["number"]) in by_number]
            observations = sorted({int(item["number"]): float(item["_cy"]) for item in relevant}.items())
            observed_numbers = [number for number, _ in observations]
            slopes = [
                (right_y - left_y) / (right_number - left_number)
                for (left_number, left_y), (right_number, right_y) in zip(observations[:-1], observations[1:])
                if right_number != left_number
            ]
            slope = statistics.median(slopes) if slopes else 0.0
            intercept = statistics.median([y - slope * number for number, y in observations]) if observations else 0.0
            track_x = statistics.median(float(candidate["_cx"]) for candidate in track) - vertical_offset
            pitch = statistics.median(abs(value) for value in slopes) if slopes else 0.0
            track_models.append((observed_numbers, slope, intercept, track_x, pitch))

        for item in expected_items:
            number = item["number"]
            choices = by_number.get(number) or []
            observation = sorted(
                choices,
                key=lambda candidate: (float(candidate.get("_width", 0)), float(candidate.get("_cx", 0)), float(candidate.get("_cy", 0))),
            )[0] if choices else None
            # An exact OCR number at a folded endpoint may be a duplicate or a
            # misread from the neighbouring connector.  Validate it against a
            # supported assigned-track model before preferring it over the
            # sequence extrapolation.  Singleton fragments are not models.
            adjacent_models = [
                model
                for model in track_models
                if len(model[0]) >= 3
                and min(model[0]) - 1 <= number <= max(model[0]) + 1
                and model[4] > 0
            ]
            supported_models = [
                model
                for model in adjacent_models
                if observation is not None
                and abs(float(observation["_cx"]) - model[3])
                <= max(10.0, model[4] * 0.35)
            ]
            if observation is not None and number >= 3 and adjacent_models and not supported_models:
                observation = None
            if observation is not None and supported_models:
                model_residual = min(
                    abs(float(observation["_cy"]) - (model[1] * number + model[2])) / model[4]
                    for model in supported_models
                )
                if model_residual > 0.75:
                    observation = None
            if observation is not None:
                centers[(prefix, number)] = (
                    float(observation["_cx"]) - vertical_offset,
                    float(observation["_cy"]),
                )
                continue
            sequence_models = [
                model
                for model in track_models
                if len(model[0]) >= 3 and model[4] > 0
            ]
            usable_models = sequence_models or [model for model in track_models if model[0]]
            if not usable_models:
                continue
            observed_numbers, slope, intercept, track_x, _ = min(
                usable_models,
                key=lambda model: (
                    0 if min(model[0]) <= number <= max(model[0]) else 1,
                    min(abs(number - observed) for observed in model[0]),
                    model[3],
                ),
            )
            if slope == 0.0:
                nearest = min(observed_numbers, key=lambda observed: abs(number - observed))
                nearest_candidates = by_number.get(nearest) or []
                predicted_y = statistics.median(float(candidate["_cy"]) for candidate in nearest_candidates)
            else:
                predicted_y = slope * number + intercept
            centers[(prefix, number)] = (track_x, predicted_y)

        # Folded columns commonly end in a detached horizontal 02/01 pair.
        # When OCR instead places those two tokens vertically (or collapses
        # them), derive the connector from the two long-track axes and their
        # local pitch.  This uses only assigned OCR geometry and numbering.
        if {1, 2}.issubset({item["number"] for item in expected_items}):
            strong_models = [model for model in track_models if len(model[0]) >= 3 and model[4] > 0]
            if len(strong_models) >= 2:
                pair = centers.get((prefix, 1)), centers.get((prefix, 2))
                pair_is_horizontal = bool(
                    pair[0]
                    and pair[1]
                    and abs(pair[0][1] - pair[1][1])
                    <= statistics.median(model[4] for model in strong_models) * 0.5
                    and abs(pair[0][0] - pair[1][0]) > 1.0
                )
                if not pair_is_horizontal:
                    left_model, right_model = sorted(strong_models, key=lambda model: model[3])[:2]
                    local_pitch = statistics.median([left_model[4], right_model[4]])
                    midpoint_x = (left_model[3] + right_model[3]) / 2.0
                    endpoint_y_values = [point[1] for point in pair if point is not None]
                    if endpoint_y_values:
                        endpoint_y = min(endpoint_y_values)
                    else:
                        endpoint_y = max(
                            left_model[1] * 2 + left_model[2],
                            right_model[1] * 2 + right_model[2],
                        )
                    centers[(prefix, 2)] = (midpoint_x - local_pitch / 2.0, endpoint_y)
                    centers[(prefix, 1)] = (midpoint_x + local_pitch / 2.0, endpoint_y)

    result: List[Dict[str, Any]] = []
    for item in expected:
        point = _catalog_geometry_group_center(item, centers)
        if point is None:
            continue
        x, y = point
        result.append({
            "space_id": item["space_id"],
            "number": f"{item['number']:02d}",
            "x": int(round(x)),
            "y": int(round(y)),
            "normalized_x": round(x / image_width, 9),
            "normalized_y": round(y / image_height, 9),
            "row": item["prefix"],
            "col": item["number"],
        })
    return result


def _catalog_geometry_quality(
    numbers: Sequence[Mapping[str, Any]],
    catalog_info: Mapping[str, Any],
    grid: Sequence[Mapping[str, Any]],
    image_size: Any,
) -> Dict[str, Any]:
    """Compute deterministic resolver diagnostics and the generation gate."""
    image_width, image_height = _catalog_geometry_grid_dimensions(image_size)
    expected = _catalog_expected_spaces(catalog_info)
    layout = _catalog_infer_layout(numbers, expected, catalog_info, image_width, image_height)
    expected_keys = {normalize_space_key(item["space_id"]) for item in expected}
    output_keys = {normalize_space_key(str(item.get("space_id") or "")) for item in grid}
    complete_count = len(expected_keys & output_keys)
    expected_count = len(expected_keys)

    # Match OCR evidence one-to-one to catalog circles.  Expanded range members
    # intentionally share one circle identity and therefore receive joint
    # credit, but one OCR token can never make several unrelated prefixes look
    # observed merely because their generated slots are nearby.
    observed_keys: set[str] = set()
    residuals: List[float] = []
    expected_by_key = {
        normalize_space_key(item["space_id"]): item
        for item in expected
    }
    circle_grid: Dict[Any, List[Tuple[str, int, float, float]]] = defaultdict(list)
    for item in grid:
        key = normalize_space_key(str(item.get("space_id") or ""))
        expected_item = expected_by_key.get(key)
        if expected_item is None:
            continue
        try:
            number = int(str(item.get("number") or "0"))
            x = float(item.get("x", 0))
            y = float(item.get("y", 0))
        except (TypeError, ValueError):
            continue
        circle_identity = expected_item.get("circle_index")
        if circle_identity is None:
            circle_identity = key
        else:
            circle_identity = (
                circle_identity,
                expected_item.get("prefix"),
                expected_item.get("raw_space"),
            )
        circle_grid[circle_identity].append((key, number, x, y))

    # Associate OCR candidates to circle geometry globally.  Iteration-order
    # greedy matching can consume a near duplicate for the wrong circle;
    # Hungarian assignment keeps one-to-one evidence deterministic while
    # preserving grouped/range circle identity.
    targets: List[Dict[str, Any]] = []
    for circle_identity, slots in circle_grid.items():
        for key, number, x, y in slots:
            expected_item = expected_by_key.get(key)
            if expected_item is None:
                continue
            targets.append(
                {
                    "space_id": key,
                    "prefix": expected_item.get("prefix"),
                    "number": number,
                    "center_x": x,
                    "center_y": y,
                    "group_identity": repr(circle_identity),
                }
            )
    association = global_min_cost_association(
        numbers,
        targets,
        distance_threshold=max(110.0, image_width * 0.045, image_height * 0.07),
        require_number=True,
        require_prefix_when_present=True,
        group_aware=True,
    )
    for match in association.get("matches", []):
        distance = match.get("distance_px")
        if distance is None:
            continue
        for target_index in match.get("target_indices", []):
            if 0 <= int(target_index) < len(targets):
                observed_keys.add(str(targets[int(target_index)]["space_id"]))
        residuals.append(float(distance))

    # Duplicate candidates are useful ambiguity diagnostics but do not make a
    # valid map fail by themselves.
    horizontal_rows = [tracks[0] for tracks in layout["horizontal"].values() if tracks]
    vertical_rows = [track for tracks in layout["vertical"].values() for track in tracks]
    ambiguous = 0
    for row in list(horizontal_rows) + list(vertical_rows):
        counts: Dict[int, int] = defaultdict(int)
        for raw in row:
            number = _catalog_geometry_number(raw.get("number"))
            if number is not None:
                counts[number] += 1
        ambiguous += sum(max(0, count - 1) for count in counts.values())

    horizontal_labels = set(layout["horizontal_labels"])
    vertical_labels = set(layout["vertical_labels"])
    horizontal_directions: Dict[str, int] = {}
    for prefix, tracks in layout["horizontal"].items():
        row = tracks[0] if tracks else []
        expected_numbers = sorted(
            {int(item["number"]) for item in expected if item["prefix"] == prefix}
        )
        _, horizontal_directions[prefix] = _catalog_lcs_alignment(
            row,
            expected_numbers,
        )
    monotonic = True
    by_prefix: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for item in grid:
        by_prefix[str(item.get("row") or "")].append(item)
    for prefix, items in by_prefix.items():
        ordered = sorted(items, key=lambda item: int(str(item.get("number") or "0")))
        if prefix in vertical_labels and prefix not in horizontal_labels:
            # Folded/sparse vertical islands legitimately reverse direction or
            # share one circle centre.  Track sequence support was already
            # validated during assignment; do not impose a second global-axis
            # monotonic rule here.
            continue
        else:
            values = [float(item.get("x", 0)) for item in ordered]
            direction = horizontal_directions.get(prefix, 1)
            if direction < 0:
                violates_direction = any(
                    right > left for left, right in zip(values[:-1], values[1:])
                )
            else:
                violates_direction = any(
                    right < left for left, right in zip(values[:-1], values[1:])
                )
            if violates_direction:
                monotonic = False
        if not monotonic:
            break

    coverage = complete_count / expected_count if expected_count else 0.0
    out_of_bounds = 0
    for item in grid:
        try:
            point_x = float(item.get("x", 0))
            point_y = float(item.get("y", 0))
        except (TypeError, ValueError):
            out_of_bounds += 1
            continue
        if not (
            math.isfinite(point_x)
            and math.isfinite(point_y)
            and 0 <= point_x <= image_width
            and 0 <= point_y <= image_height
        ):
            out_of_bounds += 1
    observed_coverage = len(observed_keys) / expected_count if expected_count else 0.0
    residual = statistics.median(residuals) if residuals else None
    # Distinct catalog circles may not collapse onto effectively the same pin.
    # Expanded members of one grouped/range circle intentionally share a centre.
    near_duplicate_circles = 0
    grid_by_prefix: Dict[str, List[Tuple[Any, float, float]]] = defaultdict(list)
    seen_circle_points: set[Tuple[Any, int, int]] = set()
    for item in grid:
        key = normalize_space_key(str(item.get("space_id") or ""))
        expected_item = expected_by_key.get(key)
        if expected_item is None:
            continue
        identity: Any = expected_item.get("circle_index")
        if identity is None:
            identity = key
        else:
            identity = (identity, expected_item.get("prefix"), expected_item.get("raw_space"))
        try:
            point = (identity, round(float(item.get("x", 0))), round(float(item.get("y", 0))))
        except (TypeError, ValueError):
            continue
        if point in seen_circle_points:
            continue
        seen_circle_points.add(point)
        grid_by_prefix[str(expected_item.get("prefix") or "")].append(
            (identity, float(item.get("x", 0)), float(item.get("y", 0)))
        )
    for points in grid_by_prefix.values():
        distinct_distances = [
            math.hypot(right[1] - left[1], right[2] - left[2])
            for index, left in enumerate(points)
            for right in points[index + 1 :]
            if left[0] != right[0]
        ]
        positive = [distance for distance in distinct_distances if distance > 1.0]
        if not positive:
            near_duplicate_circles += sum(distance <= 1.0 for distance in distinct_distances)
            continue
        # The lower quartile of nearest distances approximates local booth pitch
        # without allowing a single collapsed pair to define its own threshold.
        local_pitch = statistics.median(sorted(positive)[: max(1, len(points) // 2)])
        near_duplicate_circles += sum(
            distance < max(2.0, local_pitch * 0.20)
            for distance in distinct_distances
        )
    prefix_densities: List[float] = []
    for prefix in layout["vertical_labels"]:
        values = sorted({int(item["number"]) for item in expected if item["prefix"] == prefix})
        if values:
            prefix_densities.append(len(values) / (max(values) - min(values) + 1))
    sparse_vertical_ambiguity = bool(
        len(layout["vertical_labels"]) >= 3
        and len(layout["vertical_labels"]) <= 5
        and prefix_densities
        and statistics.median(prefix_densities) < 0.75
    )
    passed = bool(
        expected_count > 0
        and coverage >= 0.999
        and observed_coverage >= 0.50
        and monotonic
        and int(layout["invalid_candidates"]) == 0
        and (
            not layout["vertical_labels"]
            or float(layout["partition_margin"]) >= 0.01
        )
        and not sparse_vertical_ambiguity
        and near_duplicate_circles == 0
        and out_of_bounds == 0
        and (residual is None or residual <= max(120.0, image_width * 0.05))
    )
    return {
        "expected": expected_count,
        "generated": len(output_keys),
        "complete": complete_count,
        "coverage": round(coverage, 6),
        "observed": len(observed_keys),
        "observed_coverage": round(observed_coverage, 6),
        "imputed": max(0, complete_count - len(observed_keys)),
        "ambiguous": ambiguous,
        "invalid_candidates": int(layout["invalid_candidates"]),
        "orientation": {
            "horizontal_labels": list(layout["horizontal_labels"]),
            "vertical_labels": list(layout["vertical_labels"]),
        },
        "partition_margin": (
            round(float(layout["partition_margin"]), 6)
            if math.isfinite(float(layout["partition_margin"]))
            else None
        ),
        "sparse_vertical_ambiguity": sparse_vertical_ambiguity,
        "near_duplicate_circles": near_duplicate_circles,
        "out_of_bounds": out_of_bounds,
        "monotonic": monotonic,
        "horizontal_directions": {
            prefix: ("right_to_left" if direction < 0 else "left_to_right")
            for prefix, direction in horizontal_directions.items()
        },
        "residual_px": round(float(residual), 3) if residual is not None else None,
        "gate": {
            "passed": passed,
            "min_coverage": 0.999,
            "min_observed_coverage": 0.50,
        },
    }


def merge_catalog_into_llm_pattern(
    llm_pattern: Dict[str, Any],
    catalog_info: Dict[str, Any],
) -> Dict[str, Any]:
    merged = json.loads(json.dumps(llm_pattern))
    layout_type = merged.get("layout_type") or "横配置型"
    merged["layout_type"] = layout_type

    horizontal_labels = catalog_info.get("horizontal_labels") or []
    max_column = int(catalog_info.get("max_column_number") or 0)
    min_column = int(catalog_info.get("min_column_number") or 1)

    if layout_type == "縦配置型":
        columns = merged.setdefault("columns", {})
        if horizontal_labels:
            columns["labels"] = horizontal_labels
            columns["count"] = len(horizontal_labels)
        rows = merged.setdefault("rows", {})
        if max_column > 0:
            rows["range"] = [min_column, max_column]
            rows["count"] = max(int(rows.get("count") or 0), max_column)
    else:
        rows = merged.setdefault("rows", {})
        if horizontal_labels:
            rows["labels"] = horizontal_labels
            rows["count"] = len(horizontal_labels)
        columns = merged.setdefault("columns", {})
        if max_column > 0:
            columns["range"] = [max_column, min_column]
            columns["count"] = max(int(columns.get("count") or 0), max_column)

    return merged


def filter_grid_to_catalog_spaces(
    grid: Sequence[Dict[str, Any]],
    catalog_info: Dict[str, Any],
) -> List[Dict[str, Any]]:
    target_keys = set(catalog_info.get("target_space_keys") or [])
    if not target_keys:
        return list(grid)
    filtered = [item for item in grid if normalize_space_key(item.get("space_id", "")) in target_keys]
    return filtered or list(grid)


def _coordinate_lookup(grid: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    lookup: Dict[str, Dict[str, Any]] = {}
    for item in grid:
        space_id = str(item.get("space_id") or "")
        if not space_id:
            continue
        lookup[normalize_space_key(space_id)] = item
    return lookup


def _coord_normalized(item: Dict[str, Any], image_width: int, image_height: int) -> Tuple[float, float]:
    if item.get("normalized_x") is not None and item.get("normalized_y") is not None:
        return float(item["normalized_x"]), float(item["normalized_y"])
    return float(item["x"]) / image_width, float(item["y"]) / image_height


def apply_calibration_points(
    grid: List[Dict[str, Any]],
    calibration_points: Sequence[Dict[str, Any]],
    image_width: int,
    image_height: int,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    if not grid or not calibration_points:
        return grid, {"applied": False, "points": 0, "mode": "none"}

    def rejected(points: int, reason: str) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        return grid, {
            "applied": False,
            "points": points,
            "mode": "rejected",
            "reason": reason,
        }

    try:
        width = float(image_width)
        height = float(image_height)
    except (TypeError, ValueError, OverflowError):
        return rejected(0, "invalid_image_dimensions")
    if not (
        math.isfinite(width)
        and math.isfinite(height)
        and width > 0
        and height > 0
    ):
        return rejected(0, "invalid_image_dimensions")

    lookup: Dict[str, Tuple[int, Dict[str, Any]]] = {}
    base_coordinates: List[Tuple[float, float]] = []
    for index, item in enumerate(grid):
        if not isinstance(item, dict):
            return rejected(0, "invalid_grid")
        try:
            nx, ny = _coord_normalized(item, int(round(width)), int(round(height)))
        except (KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError):
            return rejected(0, "invalid_grid")
        if not (
            math.isfinite(nx)
            and math.isfinite(ny)
            and 0 <= nx <= 1
            and 0 <= ny <= 1
        ):
            return rejected(0, "invalid_grid")
        base_coordinates.append((nx, ny))
        space_id = str(item.get("space_id") or "")
        if space_id:
            lookup[normalize_space_key(space_id)] = (index, item)

    source: List[Tuple[float, float]] = []
    target: List[Tuple[float, float]] = []
    matched_keys: Dict[str, Tuple[float, float]] = {}
    for point in calibration_points:
        if not isinstance(point, Mapping):
            continue
        space = str(point.get("space") or point.get("space_id") or "")
        key = normalize_space_key(space)
        matched = lookup.get(key)
        if not matched:
            continue
        if isinstance(point.get("pin_x"), bool) or isinstance(point.get("pin_y"), bool):
            continue
        try:
            target_point = (float(point["pin_x"]), float(point["pin_y"]))
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not (
            math.isfinite(target_point[0])
            and math.isfinite(target_point[1])
            and 0 <= target_point[0] <= 1
            and 0 <= target_point[1] <= 1
        ):
            continue
        if key in matched_keys:
            if math.hypot(
                matched_keys[key][0] - target_point[0],
                matched_keys[key][1] - target_point[1],
            ) > 1e-9:
                return rejected(len(source), "conflicting_calibration_points")
            continue
        matched_keys[key] = target_point
        source.append(base_coordinates[matched[0]])
        target.append(target_point)

    if not source:
        return grid, {"applied": False, "points": 0, "mode": "no_match"}

    mode = "translation"
    transform: Any
    if len(source) >= 3:
        try:
            import numpy as np

            a = np.array([[x, y, 1.0] for x, y in source], dtype=float)
            bx = np.array([x for x, _ in target], dtype=float)
            by = np.array([y for _, y in target], dtype=float)
            if np.linalg.matrix_rank(a) < 3 or not np.isfinite(np.linalg.cond(a)):
                return rejected(len(source), "degenerate_affine_source")
            if float(np.linalg.cond(a)) > 1e4:
                return rejected(len(source), "degenerate_affine_source")
            coef_x, *_ = np.linalg.lstsq(a, bx, rcond=None)
            coef_y, *_ = np.linalg.lstsq(a, by, rcond=None)
            coefficients = np.concatenate((coef_x, coef_y))
            if not np.all(np.isfinite(coefficients)):
                return rejected(len(source), "non_finite_affine")

            linear = np.array(
                [[coef_x[0], coef_x[1]], [coef_y[0], coef_y[1]]],
                dtype=float,
            )
            determinant = float(np.linalg.det(linear))
            singular_values = np.linalg.svd(linear, compute_uv=False)
            column_norms = [float(np.linalg.norm(linear[:, index])) for index in range(2)]
            shear = abs(
                float(np.dot(linear[:, 0], linear[:, 1]))
                / max(column_norms[0] * column_norms[1], 1e-12)
            )
            if not math.isfinite(determinant) or determinant <= 0.0:
                return rejected(len(source), "invalid_affine_determinant")
            if not (
                0.25 <= determinant <= 4.0
                and float(min(singular_values)) >= 0.5
                and float(max(singular_values)) <= 2.0
                and all(0.5 <= value <= 2.0 for value in column_norms)
            ):
                return rejected(len(source), "unsafe_affine_scale")
            if not math.isfinite(shear) or shear > 0.35:
                return rejected(len(source), "unsafe_affine_shear")

            residuals = [
                math.hypot(
                    float(coef_x[0] * sx + coef_x[1] * sy + coef_x[2]) - tx,
                    float(coef_y[0] * sx + coef_y[1] * sy + coef_y[2]) - ty,
                )
                for (sx, sy), (tx, ty) in zip(source, target)
            ]
            rms_residual = math.sqrt(
                sum(residual * residual for residual in residuals) / len(residuals)
            )
            if max(residuals) > 0.04 or rms_residual > 0.025:
                return rejected(len(source), "affine_residual_too_large")

            def transform(nx: float, ny: float) -> Tuple[float, float]:
                return (
                    float(coef_x[0] * nx + coef_x[1] * ny + coef_x[2]),
                    float(coef_y[0] * nx + coef_y[1] * ny + coef_y[2]),
                )

            mode = "affine"
        except Exception:
            return rejected(len(source), "affine_validation_failed")
    else:
        dx_values = [
            target_x - source_x
            for (source_x, _), (target_x, _) in zip(source, target)
        ]
        dy_values = [
            target_y - source_y
            for (_, source_y), (_, target_y) in zip(source, target)
        ]
        dx = statistics.median(dx_values)
        dy = statistics.median(dy_values)
        residuals = [
            math.hypot(source_x + dx - target_x, source_y + dy - target_y)
            for (source_x, source_y), (target_x, target_y) in zip(source, target)
        ]
        rms_residual = math.sqrt(
            sum(residual * residual for residual in residuals) / len(residuals)
        )
        if max(residuals) > 0.04 or rms_residual > 0.025:
            return rejected(len(source), "translation_residual_too_large")

        def transform(nx: float, ny: float) -> Tuple[float, float]:
            return nx + dx, ny + dy

    transformed_coordinates = [transform(nx, ny) for nx, ny in base_coordinates]
    if any(
        not (
            math.isfinite(nx)
            and math.isfinite(ny)
            and 0 <= nx <= 1
            and 0 <= ny <= 1
        )
        for nx, ny in transformed_coordinates
    ):
        return rejected(len(source), "transformed_grid_out_of_bounds")

    # Distinct source pins must remain distinct after calibration.  Exact
    # duplicates are allowed only when the deterministic grid already shared a
    # center (for example a grouped/range circle).
    transformed_buckets: Dict[Tuple[int, int], Tuple[float, float]] = {}
    for original, transformed_point in zip(base_coordinates, transformed_coordinates):
        bucket = (
            int(round(transformed_point[0] * width * 1000)),
            int(round(transformed_point[1] * height * 1000)),
        )
        previous = transformed_buckets.get(bucket)
        if previous is not None and math.hypot(
            (previous[0] - original[0]) * width,
            (previous[1] - original[1]) * height,
        ) > 1e-6:
            return rejected(len(source), "transformed_grid_not_distinct")
        transformed_buckets[bucket] = original

    # Preserve the deterministic numeric direction of every spatial row.  This
    # catches reflections, 90-degree rotations, and near-collapses even when an
    # exactly fitted affine happens to have small point residuals.
    by_row: Dict[str, List[Tuple[int, int]]] = defaultdict(list)
    for index, item in enumerate(grid):
        row = str(item.get("row") or "")
        number = _catalog_geometry_number(item.get("number", item.get("col")))
        if not row or number is None:
            expanded = expand_space_ids(str(item.get("space_id") or ""))
            if expanded:
                row = str(expanded[0]["prefix"])
                number = int(expanded[0]["number"])
        if row and number is not None:
            by_row[row].append((number, index))
    for row_items in by_row.values():
        ordered = sorted(row_items)
        for (_, left_index), (_, right_index) in zip(ordered[:-1], ordered[1:]):
            left = base_coordinates[left_index]
            right = base_coordinates[right_index]
            next_left = transformed_coordinates[left_index]
            next_right = transformed_coordinates[right_index]
            original_dx = (right[0] - left[0]) * width
            original_dy = (right[1] - left[1]) * height
            transformed_dx = (next_right[0] - next_left[0]) * width
            transformed_dy = (next_right[1] - next_left[1]) * height
            original_distance = math.hypot(original_dx, original_dy)
            transformed_distance = math.hypot(transformed_dx, transformed_dy)
            if original_distance <= 1.0:
                continue
            if transformed_distance < max(1.0, original_distance * 0.35):
                return rejected(len(source), "transformed_grid_not_distinct")
            if abs(original_dx) >= abs(original_dy):
                direction_ok = (
                    original_dx * transformed_dx > 0
                    and abs(transformed_dx) >= max(1.0, abs(original_dx) * 0.25)
                )
            else:
                direction_ok = (
                    original_dy * transformed_dy > 0
                    and abs(transformed_dy) >= max(1.0, abs(original_dy) * 0.25)
                )
            if not direction_ok:
                return rejected(len(source), "transformed_grid_direction_changed")

    adjusted: List[Dict[str, Any]] = []
    for item, (nx, ny) in zip(grid, transformed_coordinates):
        next_item = dict(item)
        next_item["normalized_x"] = nx
        next_item["normalized_y"] = ny
        next_item["x"] = int(round(nx * width))
        next_item["y"] = int(round(ny * height))
        adjusted.append(next_item)
    return adjusted, {"applied": True, "points": len(source), "mode": mode}


def _load_ocr_result(ocr_result_path: str) -> List[Dict[str, Any]]:
    with open(ocr_result_path, "r", encoding="utf-8") as f:
        ocr_data = json.load(f)
    if isinstance(ocr_data, dict) and "numbers" in ocr_data:
        return ocr_data["numbers"]
    if isinstance(ocr_data, list):
        return ocr_data
    raise ValueError("OCR結果JSONは numbers キー付きオブジェクトまたは配列である必要があります")


def _write_ocr_failure_diagnostics(
    output_json_path: Optional[str],
    *,
    image_path: str,
    event_json_path: str,
    map_number: int,
    ocr_engine: OCREngine,
) -> None:
    """OCR失敗時の機械可読診断を座標JSONへ保存する。

    診断には専用venvやモデルキャッシュの設定値が含まれるため、ここでは
    GUI向けに整形せず、bridgeの ``_summarize_ocr_diagnostics`` が既存の
    secret/path除去経路を通してから外へ返す。ファイル保存に失敗しても、
    呼び出し元の失敗ステータスは維持する。
    """
    if not output_json_path or not ocr_engine.last_error:
        return
    try:
        output_path = Path(output_json_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(
                {
                    "image_path": image_path,
                    "event_json_path": event_json_path,
                    "map_number": map_number,
                    "error": "ocr_no_numbers",
                    "ocr_diagnostics": ocr_engine.diagnostics,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass


def generate_coordinates_from_map(
    image_path: str,
    event_json_path: str,
    output_json_path: Optional[str] = None,
    model: str = "gpt-5-mini",
    ocr_result_path: Optional[str] = None,
    map_number: int = 1,
    use_calibration: bool = True,
    ocr_config: Optional[Mapping[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    logger = logging.getLogger(__name__)

    if output_json_path is None:
        output_json_path = str(Path(image_path).with_suffix(".json"))

    load_dotenv()
    catalog_info = analyze_space_catalog_from_event(event_json_path, map_number=map_number)
    if not catalog_info.get("spaces"):
        logger.error("event.json からスペース情報を取得できませんでした")
        return None

    logger.info("=" * 60)
    logger.info("マップピン座標の自動生成を開始")
    logger.info(f"入力画像: {image_path}")
    logger.info(f"event.json: {event_json_path}")
    logger.info(f"マップ番号: {map_number}")
    logger.info(f"対象スペース数: {len(catalog_info.get('spaces', []))}")
    logger.info("=" * 60)

    ocr_engine = OCREngine(dict(ocr_config) if ocr_config else None)
    if ocr_result_path:
        logger.info("[Step 1] 既存OCR結果を読み込み")
        raw_numbers = _load_ocr_result(ocr_result_path)
    else:
        logger.info("[Step 1] OCRで番号を検出")
        try:
            raw_numbers = ocr_engine.extract_numbers_with_coordinates(
                image_path,
                expected_candidate_count=len(_catalog_expected_spaces(catalog_info)),
            )
        except Exception as exc:
            # 専用venv未構築、画像読込失敗、runner起動例外などは
            # OCREngineが保持した診断を座標JSONへ保存してからNoneで返す。
            # bridge側はこのJSONを安全に要約してGUIへ返すため、mainの
            # generic outer errorでcode/messageだけに潰れない。
            if not ocr_engine.last_error:
                ocr_engine._set_error(
                    "runner_exception",
                    f"Unlimited OCR runner実行中に失敗しました: {exc}",
                )
            logger.error(
                "OCR診断付き例外: %s",
                json.dumps(ocr_engine.diagnostics, ensure_ascii=False),
            )
            _write_ocr_failure_diagnostics(
                output_json_path,
                image_path=image_path,
                event_json_path=event_json_path,
                map_number=map_number,
                ocr_engine=ocr_engine,
            )
            return None
        if not raw_numbers and ocr_engine.last_error:
            logger.error(
                "OCR診断: %s",
                json.dumps(ocr_engine.diagnostics, ensure_ascii=False),
            )
    logger.info(f"検出番号数: {len(raw_numbers)}")
    if not raw_numbers:
        logger.error("番号を検出できませんでした")
        # GUIが「原因不明の0件」と表示しないよう、出力JSONへ診断だけ残す。
        _write_ocr_failure_diagnostics(
            output_json_path,
            image_path=image_path,
            event_json_path=event_json_path,
            map_number=map_number,
            ocr_engine=ocr_engine,
        )
        return None

    logger.info("[Step 1.5] LLMでOCR番号を検証")
    try:
        validator = NumberValidator(model=model)
        numbers = validator.validate_numbers(image_path, raw_numbers)
    except Exception:
        # Validator 自体が実行不能な場合も raw 候補へ戻さない。未承認
        # OCRを pin 化せず、診断付き controlled failure として終了する。
        logger.warning("OCR番号検証に失敗したため座標生成を中断")
        try:
            output_path = Path(output_json_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            failure_diagnostics = dict(ocr_engine.diagnostics)
            failure_diagnostics["error"] = {
                "code": "number_validation_failed",
                "message": "NumberValidator failed before approving OCR candidates",
            }
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "image_path": image_path,
                        "event_json_path": event_json_path,
                        "map_number": map_number,
                        "error": "number_validation_failed",
                        "ocr_diagnostics": failure_diagnostics,
                        "validated_count": 0,
                        "raw_count": len(raw_numbers),
                        "complete_grid": [],
                        "total_spaces": 0,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError:
            pass
        return None

    # 空の検証結果を raw_numbers で補完しない。検証で候補が全て除外
    # された場合は、誤検出を pin として出力するより安全に失敗させる。
    if not isinstance(numbers, list) or not numbers:
        logger.error(
            "OCR番号検証結果が空のため座標生成を中断 (raw=%d)",
            len(raw_numbers),
        )
        try:
            output_path = Path(output_json_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            failure_diagnostics = dict(ocr_engine.diagnostics)
            failure_diagnostics["error"] = {
                "code": "number_validation_empty",
                "message": "NumberValidator returned no approved OCR candidates",
            }
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "image_path": image_path,
                        "event_json_path": event_json_path,
                        "map_number": map_number,
                        "error": "number_validation_empty",
                        "ocr_diagnostics": failure_diagnostics,
                        "validated_count": 0,
                        "raw_count": len(raw_numbers),
                        "complete_grid": [],
                        "total_spaces": 0,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError:
            pass
        return None

    import cv2

    img = cv2.imread(image_path)
    if img is None:
        logger.error(f"画像を読み込めません: {image_path}")
        return None
    image_height, image_width = img.shape[:2]

    def select_horizontal_numbers(source_numbers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        selected: List[Dict[str, Any]] = []
        for item in source_numbers:
            width = item.get("width", 0)
            height = item.get("height", 0)
            center_x = (item["x"] + width / 2) / image_width if image_width else 0.0
            center_y = (item["y"] + height / 2) / image_height if image_height else 0.0
            variant = str(item.get("variant", ""))
            if center_x >= 0.88 or center_x <= 0.33:
                continue
            if center_y >= 0.85 and not variant.endswith("_0"):
                continue
            if variant and any(suffix in variant for suffix in ["_90", "_-90"]):
                continue
            selected.append(item)
        return selected

    horizontal_candidates = select_horizontal_numbers(numbers)
    if len(horizontal_candidates) < max(12, len(numbers) // 3):
        # Filtered candidates are only used for the coarse pattern estimate;
        # retain the validator-approved list for final geometry resolution.
        horizontal_candidates = numbers

    logger.info("[Step 2] OCR結果からグリッド候補を推定")
    pattern_info = ocr_engine.analyze_grid_pattern(horizontal_candidates)
    expected_columns = int(catalog_info.get("max_column_number") or pattern_info.get("cols") or 18)
    row_count_hint = (
        pattern_info.get("rows")
        or len(catalog_info.get("horizontal_labels") or [])
        or 3
    )
    preliminary_rows = estimate_row_positions(
        horizontal_candidates,
        image_width,
        image_height,
        int(row_count_hint),
        max_value=max(expected_columns, int(row_count_hint)),
    )
    x_positions = estimate_column_positions(
        horizontal_candidates,
        image_width,
        expected_columns,
        row_positions=preliminary_rows,
        image_height=image_height,
    )
    if x_positions:
        pattern_info["x_positions"] = x_positions
        pattern_info["cols"] = len(x_positions)

    logger.info("[Step 3] LLMで画像の配置規則を判定")
    calibration_points = (catalog_info.get("calibration_points") or []) if use_calibration else []
    try:
        analyzer = PatternAnalyzer(model=model)
        llm_pattern = analyzer.analyze_pattern(
            image_path,
            numbers,
            catalog_info=catalog_info,
            calibration_points=calibration_points,
        )
        llm_pattern = merge_catalog_into_llm_pattern(llm_pattern, catalog_info)
    except Exception as exc:
        logger.warning(f"LLM配置判定に失敗したためフォールバックを使用: {exc}")
        llm_pattern = build_fallback_pattern(pattern_info, catalog_info)

    row_count = (
        llm_pattern.get("rows", {}).get("count")
        or len(catalog_info.get("horizontal_labels") or [])
        or pattern_info.get("rows")
        or 3
    )
    y_positions = estimate_row_positions(
        horizontal_candidates,
        image_width,
        image_height,
        int(row_count),
        max_value=max(expected_columns, int(row_count)),
    )
    if y_positions:
        pattern_info["y_positions"] = y_positions
        pattern_info["rows"] = len(y_positions)

    logger.info("[Step 4] catalog geometry resolverで座標を生成")
    # Final geometry is deliberately resolved from validator-approved OCR
    # bboxes and the expanded catalog only.  LLM pattern output and event
    # pin/calibration points remain diagnostics until the explicit post-gate
    # calibration step (evaluation-leak guard).
    complete_grid = _build_catalog_geometry_grid(
        numbers,
        catalog_info,
        (image_width, image_height),
    )
    geometry_quality = _catalog_geometry_quality(
        numbers,
        catalog_info,
        complete_grid,
        (image_width, image_height),
    )
    if not geometry_quality.get("gate", {}).get("passed"):
        logger.error("catalog geometry quality gate failed: %s", geometry_quality)
        failure_diagnostics = dict(ocr_engine.diagnostics)
        failure_diagnostics["error"] = {
            "code": "catalog_geometry_quality_gate_failed",
            "message": "catalog geometry coverage/observation quality is below threshold",
            "geometry_quality": geometry_quality,
        }
        try:
            output_path = Path(output_json_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "image_path": image_path,
                        "event_json_path": event_json_path,
                        "map_number": map_number,
                        "error": "catalog_geometry_quality_gate_failed",
                        "ocr_diagnostics": failure_diagnostics,
                        "geometry_quality": geometry_quality,
                        "complete_grid": [],
                        "total_spaces": 0,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
        except OSError:
            pass
        return None

    # Resolve deterministic catalog geometry first, then apply calibration as
    # an explicit coordinate transform.  Quality/evaluation remains based on
    # the pre-calibration geometry so existing event pins cannot influence the
    # resolver gate.
    if use_calibration:
        complete_grid, calibration_summary = apply_calibration_points(
            complete_grid,
            catalog_info.get("calibration_points") or [],
            image_width=image_width,
            image_height=image_height,
        )
        if calibration_summary.get("mode") == "rejected":
            logger.error("calibration safety gate failed: %s", calibration_summary)
            failure_diagnostics = dict(ocr_engine.diagnostics)
            failure_diagnostics["error"] = {
                "code": "calibration_safety_gate_failed",
                "message": "calibration transform was rejected before pin update",
                "calibration": calibration_summary,
            }
            try:
                output_path = Path(output_json_path)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(
                        {
                            "image_path": image_path,
                            "event_json_path": event_json_path,
                            "map_number": map_number,
                            "error": "calibration_safety_gate_failed",
                            "ocr_diagnostics": failure_diagnostics,
                            "geometry_quality": geometry_quality,
                            "calibration": calibration_summary,
                            "complete_grid": [],
                            "total_spaces": 0,
                        },
                        f,
                        ensure_ascii=False,
                        indent=2,
                    )
            except OSError:
                pass
            return None
    else:
        calibration_summary = {
            "applied": False,
            "points": 0,
            "mode": "disabled",
        }

    result = {
        "image_path": image_path,
        "event_json_path": event_json_path,
        "map_number": map_number,
        "ocr_diagnostics": ocr_engine.diagnostics,
        "pattern_info": pattern_info,
        "llm_pattern": llm_pattern,
        "catalog_info": {
            "order": catalog_info.get("order", []),
            "counts": catalog_info.get("counts", {}),
            "horizontal_labels": catalog_info.get("horizontal_labels", []),
            "vertical_labels": catalog_info.get("vertical_labels", []),
            "max_column_number": catalog_info.get("max_column_number", 0),
            "target_space_count": len(catalog_info.get("spaces", [])),
        },
        "calibration": calibration_summary,
        "geometry_quality": geometry_quality,
        "complete_grid": complete_grid,
        "total_spaces": len(complete_grid),
    }

    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    logger.info(f"座標マップを保存: {output_json_path}")
    logger.info(f"生成座標数: {len(complete_grid)}")
    logger.info("=" * 60)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="マップ画像から event.json 用のピン座標を自動生成"
    )
    parser.add_argument("image_path", help="マップ画像のパス")
    parser.add_argument("event_json_path", help="event.json のパス")
    parser.add_argument("--output-json", help="座標マップJSONの出力先")
    parser.add_argument("--map-number", type=int, default=1, help="対象マップ番号")
    parser.add_argument("--model", default="gpt-5-mini", help="画像解析に使うモデル")
    parser.add_argument("--ocr-result", help="既存OCR結果JSONのパス")
    args = parser.parse_args()

    setup_logging()
    result = generate_coordinates_from_map(
        image_path=args.image_path,
        event_json_path=args.event_json_path,
        output_json_path=args.output_json,
        model=args.model,
        ocr_result_path=args.ocr_result,
        map_number=args.map_number,
        use_calibration=True,
    )
    if result is None:
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

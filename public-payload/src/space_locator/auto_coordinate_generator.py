#!/usr/bin/env python3
"""
マップ画像から event.json のピン座標を自動生成する。

入力はマップ画像と event.json のみ。
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

from .coordinate_mapper import CoordinateMapper
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
        point_map = int(point.get("map_number") or map_number)
        if point_map != map_number:
            continue
        space = str(point.get("space") or point.get("space_id") or "").strip()
        pin_x = point.get("pin_x", point.get("x"))
        pin_y = point.get("pin_y", point.get("y"))
        try:
            x = float(pin_x)
            y = float(pin_y)
        except (TypeError, ValueError):
            continue
        if not space or not (0 <= x <= 1) or not (0 <= y <= 1):
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
        circle_map = int(circle_map_raw) if circle_map_raw else None
        if circle_map is not None and circle_map != map_number:
            continue
        if map_count > 1 and circle_map is not None and circle_map != map_number:
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

    lookup = _coordinate_lookup(grid)
    source: List[Tuple[float, float]] = []
    target: List[Tuple[float, float]] = []
    for point in calibration_points:
        space = str(point.get("space") or point.get("space_id") or "")
        item = lookup.get(normalize_space_key(space))
        if not item:
            continue
        source.append(_coord_normalized(item, image_width, image_height))
        target.append((float(point["pin_x"]), float(point["pin_y"])))

    if not source:
        return grid, {"applied": False, "points": 0, "mode": "no_match"}

    def apply_point(item: Dict[str, Any], nx: float, ny: float) -> None:
        nx = min(1.0, max(0.0, nx))
        ny = min(1.0, max(0.0, ny))
        item["normalized_x"] = nx
        item["normalized_y"] = ny
        item["x"] = int(round(nx * image_width))
        item["y"] = int(round(ny * image_height))

    if len(source) >= 3:
        try:
            import numpy as np

            a = np.array([[x, y, 1.0] for x, y in source], dtype=float)
            bx = np.array([x for x, _ in target], dtype=float)
            by = np.array([y for _, y in target], dtype=float)
            if np.linalg.matrix_rank(a) >= 3:
                coef_x, *_ = np.linalg.lstsq(a, bx, rcond=None)
                coef_y, *_ = np.linalg.lstsq(a, by, rcond=None)
                for item in grid:
                    nx, ny = _coord_normalized(item, image_width, image_height)
                    next_x = float(coef_x[0] * nx + coef_x[1] * ny + coef_x[2])
                    next_y = float(coef_y[0] * nx + coef_y[1] * ny + coef_y[2])
                    apply_point(item, next_x, next_y)
                return grid, {"applied": True, "points": len(source), "mode": "affine"}
        except Exception:
            pass

    dx_values = [target_x - source_x for (source_x, _), (target_x, _) in zip(source, target)]
    dy_values = [target_y - source_y for (_, source_y), (_, target_y) in zip(source, target)]
    dx = statistics.median(dx_values)
    dy = statistics.median(dy_values)
    for item in grid:
        nx, ny = _coord_normalized(item, image_width, image_height)
        apply_point(item, nx + dx, ny + dy)
    return grid, {"applied": True, "points": len(source), "mode": "translation"}


def _load_ocr_result(ocr_result_path: str) -> List[Dict[str, Any]]:
    with open(ocr_result_path, "r", encoding="utf-8") as f:
        ocr_data = json.load(f)
    if isinstance(ocr_data, dict) and "numbers" in ocr_data:
        return ocr_data["numbers"]
    if isinstance(ocr_data, list):
        return ocr_data
    raise ValueError("OCR結果JSONは numbers キー付きオブジェクトまたは配列である必要があります")


def generate_coordinates_from_map(
    image_path: str,
    event_json_path: str,
    output_json_path: Optional[str] = None,
    model: str = "gpt-5-mini",
    ocr_result_path: Optional[str] = None,
    map_number: int = 1,
    use_calibration: bool = True,
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

    ocr_engine = OCREngine()
    if ocr_result_path:
        logger.info("[Step 1] 既存OCR結果を読み込み")
        raw_numbers = _load_ocr_result(ocr_result_path)
    else:
        logger.info("[Step 1] OCRで番号を検出")
        raw_numbers = ocr_engine.extract_numbers_with_coordinates(image_path)
    logger.info(f"検出番号数: {len(raw_numbers)}")
    if not raw_numbers:
        logger.error("番号を検出できませんでした")
        return None

    logger.info("[Step 1.5] LLMでOCR番号を検証")
    try:
        validator = NumberValidator(model=model)
        numbers = validator.validate_numbers(image_path, raw_numbers)
        if not numbers:
            numbers = raw_numbers
    except Exception as exc:
        logger.warning(f"OCR番号検証をスキップ: {exc}")
        numbers = raw_numbers

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
        horizontal_candidates = select_horizontal_numbers(raw_numbers) or raw_numbers
        numbers = raw_numbers

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

    logger.info("[Step 4] event.json のスペース一覧と照合して座標を生成")
    mapper = CoordinateMapper(image_width=image_width, image_height=image_height)
    complete_grid = mapper.generate_complete_grid(pattern_info, llm_pattern, normalize=True)

    vertical_labels = detect_vertical_labels_from_catalog(catalog_info)
    if vertical_labels:
        vertical_points = extract_vertical_points(
            numbers,
            image_width,
            image_height,
            expected_count=len(vertical_labels),
        )
        complete_grid.extend(mapper.generate_vertical_columns(vertical_points, vertical_labels))

    complete_grid = filter_grid_to_catalog_spaces(complete_grid, catalog_info)
    complete_grid, calibration_summary = apply_calibration_points(
        complete_grid,
        calibration_points,
        image_width,
        image_height,
    )

    result = {
        "image_path": image_path,
        "event_json_path": event_json_path,
        "map_number": map_number,
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

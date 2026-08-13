"""実マップで Unlimited OCR のモデル/戦略と座標精度を比較する。

学習やモデルの変更は行わず、runner の出力と人手で作った ground-truth を
同じ指標で比較する。実画像が手元にない場合は ``--predictions`` で保存済み
runner JSONを評価できるため、CIではモデルをダウンロードしない。

ground-truth の例::

  {"map_01.png": [{"number": "12", "center_x": 478,
                   "center_y": 313}]}

``x/y/width/height`` の代わりに ``x1/y1/x2/y2`` も受け付ける。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_runner.py"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from src.space_locator.catalog_geometry_assignment import (
    global_min_cost_association,
    item_identity,
    item_point,
)
from src.space_locator.ocr_engine import _elements_to_numbers, _normalize_ocr_text


class GroundTruthPoints(list[dict[str, Any]]):
    """List-compatible GT container carrying optional image-level OCR text."""

    def __init__(self, values: Iterable[dict[str, Any]] = (), *, ocr_text: Any = None):
        super().__init__(values)
        self.ocr_text = None if ocr_text is None else str(ocr_text)


def _number(value: Any) -> str:
    text = str(value or "").strip()
    try:
        return f"{int(text):02d}"
    except (TypeError, ValueError):
        return text


def _box(item: Mapping[str, Any]) -> tuple[float, float, float, float] | None:
    try:
        if all(k in item for k in ("x1", "y1", "x2", "y2")):
            x1, y1, x2, y2 = (float(item[k]) for k in ("x1", "y1", "x2", "y2"))
        else:
            x1 = float(item["x"])
            y1 = float(item["y"])
            x2 = x1 + float(item["width"])
            y2 = y1 + float(item["height"])
        if x2 <= x1 or y2 <= y1:
            return None
        return x1, y1, x2, y2
    except (KeyError, TypeError, ValueError):
        return None


def _center(box: tuple[float, float, float, float]) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def _point(item: Mapping[str, Any]) -> tuple[float, float] | None:
    """pin-center GTを読み込む。box GTとの後方互換は _box が担う。"""
    try:
        x = float(item["center_x"])
        y = float(item["center_y"])
        return x, y
    except (KeyError, TypeError, ValueError):
        return None


def _iou(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> float:
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if intersection <= 0:
        return 0.0
    area_left = (left[2] - left[0]) * (left[3] - left[1])
    area_right = (right[2] - right[0]) * (right[3] - right[1])
    return intersection / max(area_left + area_right - intersection, 1e-9)


def _image_key(path: str | Path) -> str:
    candidate = Path(str(path)).expanduser()
    try:
        if candidate.exists():
            return str(candidate.resolve()).lower()
    except OSError:
        pass
    return candidate.name.lower()


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _ground_truth_by_image(path: Path | None) -> dict[str, list[dict[str, Any]]]:
    if path is None:
        return {}
    raw = _load_json(path)
    if isinstance(raw, dict) and isinstance(raw.get("images"), list):
        entries = raw["images"]
        result: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            image = entry.get("image") or entry.get("path")
            boxes = entry.get("points") or entry.get("boxes") or entry.get("ground_truth") or []
            if image:
                result[_image_key(image)] = GroundTruthPoints(
                    [x for x in boxes if isinstance(x, dict)],
                    ocr_text=entry.get("ocr_text", entry.get("ocr_reference")),
                )
        return result
    if not isinstance(raw, dict):
        raise ValueError("ground-truth は画像名をキーにしたJSONオブジェクトで指定してください")
    result: dict[str, list[dict[str, Any]]] = {}
    for image, value in raw.items():
        if isinstance(value, list):
            result[_image_key(image)] = GroundTruthPoints(
                [item for item in value if isinstance(item, dict)]
            )
        elif isinstance(value, dict):
            boxes = value.get("points") or value.get("boxes") or value.get("ground_truth") or []
            result[_image_key(image)] = GroundTruthPoints(
                [item for item in boxes if isinstance(item, dict)],
                ocr_text=value.get("ocr_text", value.get("ocr_reference")),
            )
    return result


def _predictions_by_image(payload: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in payload.get("results", []) or []:
        if not isinstance(item, dict):
            continue
        image = item.get("image")
        elements = item.get("elements") or []
        if image:
            # 本番 OCREngine と同じ grouped/table 分割・重複排除・契約変換を
            # 評価にも適用する。raw elements を直接採点すると "01 02" を
            # 1件として扱い、実際の座標出力との精度比較が破綻する。
            raw_elements: list[dict[str, Any]] = []
            normalized_elements: list[dict[str, Any]] = []
            for element in elements:
                if not isinstance(element, dict):
                    continue
                # 保存済み評価データが既に本番契約へ正規化済みの場合も
                # 後方互換で受け付ける。grouped出力由来のraw_textを再度
                # 分割すると各正規化要素が増殖するため、契約要素はそのまま
                # 1件として扱い、identity/contextも失わない。
                if "number" in element and all(
                    key in element for key in ("x", "y", "width", "height")
                ):
                    if _box(element) is not None:
                        normalized_elements.append(dict(element))
                    continue
                if "text" in element:
                    raw_elements.append(element)
            result[_image_key(image)].extend(normalized_elements)
            result[_image_key(image)].extend(_elements_to_numbers(raw_elements))
    return dict(result)


def _raw_ocr_by_image(payload: Mapping[str, Any]) -> dict[str, str]:
    return {
        _image_key(item.get("image")): str(item.get("raw_output") or "")
        for item in (payload.get("results") or [])
        if isinstance(item, dict) and item.get("image") and item.get("raw_output") is not None
    }


def _percentile(values: Iterable[float], quantile: float) -> float | None:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * min(max(quantile, 0.0), 1.0)
    low = int(math.floor(position))
    high = int(math.ceil(position))
    if low == high:
        return ordered[low]
    weight = position - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def _pin_error(values: Iterable[float]) -> dict[str, float | None]:
    distances = [float(value) for value in values]
    if not distances:
        return {"mean": None, "p50": None, "p95": None, "max": None}
    return {
        "mean": round(statistics.mean(distances), 3),
        "p50": round(float(_percentile(distances, 0.50)), 3),
        "p95": round(float(_percentile(distances, 0.95)), 3),
        "max": round(max(distances), 3),
    }


def _edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, 1):
        current = [row]
        for column, right_char in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def _cer_components(
    raw_text: str | None, reference_text: str | None
) -> tuple[int, int] | None:
    if raw_text is None or reference_text is None:
        return None
    prediction = unicodedata.normalize("NFKC", _normalize_ocr_text(raw_text)).casefold()
    reference = unicodedata.normalize("NFKC", _normalize_ocr_text(reference_text)).casefold()
    return _edit_distance(prediction, reference), len(reference)


def _cer(raw_text: str | None, reference_text: str | None) -> float | None:
    components = _cer_components(raw_text, reference_text)
    if components is None:
        return None
    edit_distance, reference_length = components
    return round(edit_distance / max(reference_length, 1), 6)


def score_image(
    predictions: Iterable[Mapping[str, Any]],
    ground_truth: Iterable[Mapping[str, Any]],
    *,
    distance_threshold: float = 30.0,
    raw_ocr_text: str | None = None,
    reference_ocr_text: str | None = None,
) -> dict[str, Any]:
    """Globally associate OCR boxes with catalog identities and report errors."""
    pred = [dict(item) for item in predictions if item_point(item) is not None]
    truth = [dict(item) for item in ground_truth if item_point(item) is not None]
    association = global_min_cost_association(
        pred,
        truth,
        distance_threshold=distance_threshold,
        require_number=True,
        require_prefix_when_present=True,
        group_aware=True,
        allow_identity_mismatch=True,
    )

    all_target_groups: dict[str, list[int]] = {}
    for index, item in enumerate(truth):
        group = item_identity(item)[2]
        all_target_groups.setdefault(group or f"__target_{index}", []).append(index)
    active_groups = [
        members
        for members in all_target_groups.values()
        if not any(bool(truth[index].get("missing_slot")) for index in members)
    ]
    missing_groups = [
        members
        for members in all_target_groups.values()
        if any(bool(truth[index].get("missing_slot")) for index in members)
    ]
    merged_groups = [
        members
        for members in active_groups
        if len(members) > 1
        or any(bool(truth[index].get("merged") or truth[index].get("shared")) for index in members)
    ]

    associations: list[dict[str, Any]] = []
    matches: list[dict[str, Any]] = []
    exact_group_keys: set[tuple[int, ...]] = set()
    resolved_active_keys: set[tuple[int, ...]] = set()
    missing_fp_keys: set[tuple[int, ...]] = set()
    wrong_neighbor = 0
    wrong_prefix = 0
    for assigned in association["matches"]:
        pred_index = int(assigned["prediction_index"])
        target_indices = tuple(int(index) for index in assigned["target_indices"])
        target_items = [truth[index] for index in target_indices]
        prediction = pred[pred_index]
        pred_prefix, pred_number, pred_group = item_identity(prediction)
        target_identities = [item_identity(item) for item in target_items]
        target_prefixes = {prefix for prefix, _, _ in target_identities if prefix}
        target_numbers = {number for _, number, _ in target_identities if number}
        target_groups = {group for _, _, group in target_identities if group}
        is_missing = any(bool(item.get("missing_slot")) for item in target_items)
        prefix_mismatch = bool(pred_prefix and target_prefixes and pred_prefix not in target_prefixes)
        group_mismatch = bool(pred_group and target_groups and pred_group not in target_groups)
        number_match = bool(pred_number and pred_number in target_numbers)
        exact = bool(not is_missing and number_match and not prefix_mismatch and not group_mismatch)
        neighbor = False
        if not is_missing and not exact and not prefix_mismatch and pred_number:
            neighbor = any(
                abs(int(pred_number) - int(target_number)) == 1
                for target_number in target_numbers
            )
        if is_missing:
            missing_fp_keys.add(target_indices)
        else:
            resolved_active_keys.add(target_indices)
            wrong_prefix += int(prefix_mismatch)
            wrong_neighbor += int(neighbor)
        target_index = int(assigned["target_index"])
        pbox = _box(prediction)
        tbox = _box(truth[target_index])
        association_entry = {
            "prediction_index": pred_index,
            "target_indices": list(target_indices),
            "space_ids": [
                str(item.get("space_id"))
                for item in target_items
                if item.get("space_id")
            ],
            "number": pred_number,
            "prefix": pred_prefix,
            "distance_px": round(float(assigned["distance_px"]), 3),
            "exact": exact,
            "wrong_neighbor": neighbor,
            "wrong_prefix": prefix_mismatch,
            "missing_slot": is_missing,
        }
        associations.append(association_entry)
        if not exact:
            continue
        exact_group_keys.add(target_indices)
        match_entry = {
            "number": pred_number,
            "prefix": pred_prefix,
            "space_ids": association_entry["space_ids"],
            "distance_px": association_entry["distance_px"],
            "iou": (
                round(_iou(pbox, tbox), 4)
                if pbox is not None and tbox is not None and _point(truth[target_index]) is None
                else None
            ),
        }
        matches.append(match_entry)

    true_positive = len(exact_group_keys)
    ground_truth_count = len(active_groups)
    space_ground_truth_count = sum(len(members) for members in active_groups)
    exact_spaces = sum(len(members) for members in exact_group_keys)
    false_positive = len(pred) - true_positive
    false_negative = ground_truth_count - true_positive
    distances = [float(match["distance_px"]) for match in matches]
    pin_error = _pin_error(distances)
    active_associations = len(resolved_active_keys)
    merged_keys = {tuple(members) for members in merged_groups}
    merged_correct = len(exact_group_keys & merged_keys)
    reference = reference_ocr_text
    if reference is None:
        reference = getattr(ground_truth, "ocr_text", None)
    return {
        "predicted": len(pred),
        "ground_truth": ground_truth_count,
        "matched": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "precision": round(true_positive / len(pred), 4) if pred else 0.0,
        "recall": round(true_positive / ground_truth_count, 4) if ground_truth_count else 0.0,
        "mean_center_error": pin_error["mean"],
        "mean_center_distance_px": pin_error["mean"],
        "exact_spaces": exact_spaces,
        "space_ground_truth": space_ground_truth_count,
        "exact_space_accuracy": round(exact_spaces / space_ground_truth_count, 4)
        if space_ground_truth_count
        else 0.0,
        "pin_error_px": pin_error,
        "wrong_neighbor_rate": round(wrong_neighbor / active_associations, 4)
        if active_associations
        else 0.0,
        "wrong_prefix_rate": round(wrong_prefix / active_associations, 4)
        if active_associations
        else 0.0,
        "merged_booth_accuracy": round(merged_correct / len(merged_groups), 4)
        if merged_groups
        else None,
        "missing_slot_false_positive_rate": round(len(missing_fp_keys) / len(missing_groups), 4)
        if missing_groups
        else 0.0,
        "unresolved_rate": round((ground_truth_count - active_associations) / ground_truth_count, 4)
        if ground_truth_count
        else 0.0,
        "resolved": active_associations,
        "wrong_neighbor": wrong_neighbor,
        "wrong_prefix": wrong_prefix,
        "merged_booths": len(merged_groups),
        "merged_booths_matched": merged_correct,
        "missing_slots": len(missing_groups),
        "missing_slot_false_positives": len(missing_fp_keys),
        "mean_iou": (
            round(sum(x["iou"] for x in matches if x["iou"] is not None) / len([x for x in matches if x["iou"] is not None]), 4)
            if any(x["iou"] is not None for x in matches)
            else None
        ),
        "coordinate_metric": "pin_center"
        if any(_point(item) is not None for item in truth)
        else "bbox_iou_and_center",
        "distance_threshold_px": distance_threshold,
        "ocr_raw": raw_ocr_text,
        "ocr_cer": _cer(raw_ocr_text, reference),
        "matches": matches,
        "associations": associations,
        "unmatched_prediction_indices": association["unmatched_prediction_indices"],
        "unresolved_target_indices": association["unresolved_target_indices"],
    }


def _run_runner(
    images: list[Path],
    *,
    runner_python: str,
    model: str | None,
    model_path: str | None,
    revision: str | None,
    mode: str,
    strategy: str,
    timeout_sec: int,
) -> dict[str, Any]:
    runner_python = _resolve_runner_python(runner_python)
    with tempfile.NamedTemporaryFile(prefix="unlimited_ocr_eval_", suffix=".json", delete=False) as f:
        output_path = Path(f.name)
    command = [runner_python, str(RUNNER), "--output-json", str(output_path), "--mode", mode, "--strategy", strategy, "--include-raw"]
    for image in images:
        command += ["--image", str(image.resolve())]
    if model:
        command += ["--model", model]
    if model_path:
        command += ["--model-path", model_path]
    if revision:
        command += ["--revision", revision]
    try:
        try:
            completed = subprocess.run(
                command,
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"Unlimited OCR runnerを起動できません: {exc}") from exc
        if completed.returncode != 0:
            raise RuntimeError(
                "Unlimited OCR runner が非0で終了しました "
                f"(returncode={completed.returncode}): {(completed.stderr or '')[-2000:]}"
            )
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError(
                "Unlimited OCR runner が空のJSONを出力しました: "
                f"returncode={completed.returncode}; {(completed.stderr or '')[-1000:]}"
            )
        try:
            payload = _load_json(output_path)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Unlimited OCR runnerのJSONを読めません: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise RuntimeError("Unlimited OCR runnerのJSONにresults配列がありません")
        if not payload["results"]:
            raise RuntimeError("Unlimited OCR runnerのresults配列が空です")
        if all(isinstance(item, dict) and item.get("error") for item in payload["results"]):
            errors = "; ".join(str(item.get("error")) for item in payload["results"][:3])
            raise RuntimeError(f"Unlimited OCR runnerが全画像で失敗しました: {errors}")
        payload["runner_returncode"] = completed.returncode
        payload["runner_stderr"] = completed.stderr[-2000:]
        return payload
    finally:
        output_path.unlink(missing_ok=True)


def _validate_runner_payload(payload: Any, *, source: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{source}: JSONのトップレベルがobjectではありません")
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise RuntimeError(f"{source}: results配列が空または存在しません")
    if all(isinstance(item, dict) and item.get("error") for item in results):
        errors = "; ".join(str(item.get("error")) for item in results[:3])
        raise RuntimeError(f"{source}: 全画像で推論に失敗しました: {errors}")
    return payload


def _resolve_runner_python(value: str | None = None) -> str:
    """評価本体ではなく専用 OCR venv の Python を選択する。"""
    if value:
        candidate = Path(value).expanduser()
        if candidate.exists():
            return str(candidate)
        resolved = shutil.which(value)
        if resolved:
            return resolved
        raise RuntimeError(f"指定された runner Python が見つかりません: {value}")

    configured = os.environ.get("UNLIMITED_OCR_PYTHON", "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.exists():
            return str(candidate)
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        raise RuntimeError(f"UNLIMITED_OCR_PYTHON が見つかりません: {configured}")

    venv = Path(
        os.environ.get("UNLIMITED_OCR_VENV", str(REPO_ROOT / "temp" / "unlimited_ocr_venv"))
    ).expanduser()
    candidate = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not candidate.exists():
        raise RuntimeError(
            "Unlimited OCR専用venvが見つかりません。"
            "scripts\\setup_unlimited_ocr.bat を実行するか --runner-python で指定してください: "
            f"{candidate}"
        )
    return str(candidate)


def evaluate(
    images: list[Path],
    ground_truth: dict[str, list[dict[str, Any]]],
    payload: Mapping[str, Any],
    *,
    distance_threshold: float,
    label: str,
) -> dict[str, Any]:
    predictions = _predictions_by_image(payload)
    raw_ocr = _raw_ocr_by_image(payload)
    per_image: dict[str, Any] = {}
    cer_components: list[tuple[int, int]] = []
    for image in images:
        key = _image_key(image)
        truth_boxes = ground_truth.get(key)
        if truth_boxes is None:
            # 手書きGTは ``map_01.png`` のbasenameだけをキーにすることが
            # 多いため、実ファイルの絶対パスキーと後方互換にする。
            truth_boxes = ground_truth.get(Path(str(image)).name.lower(), [])
        prediction_boxes = predictions.get(key)
        if prediction_boxes is None:
            prediction_boxes = predictions.get(Path(str(image)).name.lower(), [])
        raw_text = raw_ocr.get(key)
        if raw_text is None:
            raw_text = raw_ocr.get(Path(str(image)).name.lower())
        image_cer_components = _cer_components(
            raw_text, getattr(truth_boxes, "ocr_text", None)
        )
        if image_cer_components is not None:
            cer_components.append(image_cer_components)
        per_image[str(image)] = score_image(
            prediction_boxes,
            truth_boxes,
            distance_threshold=distance_threshold,
            raw_ocr_text=raw_text,
        )
    totals = [value for value in per_image.values()]
    predicted = sum(x["predicted"] for x in totals)
    truth = sum(x["ground_truth"] for x in totals)
    matched = sum(x["matched"] for x in totals)
    exact_spaces = sum(x["exact_spaces"] for x in totals)
    space_truth = sum(x["space_ground_truth"] for x in totals)
    distances = [m["distance_px"] for x in totals for m in x["matches"]]
    ious = [m["iou"] for x in totals for m in x["matches"] if m["iou"] is not None]
    pin_error = _pin_error(distances)
    resolved = sum(x["resolved"] for x in totals)
    wrong_neighbor = sum(x["wrong_neighbor"] for x in totals)
    wrong_prefix = sum(x["wrong_prefix"] for x in totals)
    merged_booths = sum(x["merged_booths"] for x in totals)
    merged_matched = sum(x["merged_booths_matched"] for x in totals)
    missing_slots = sum(x["missing_slots"] for x in totals)
    missing_false_positives = sum(x["missing_slot_false_positives"] for x in totals)
    cer_values = [float(x["ocr_cer"]) for x in totals if x.get("ocr_cer") is not None]
    cer_edit_distance = sum(distance for distance, _ in cer_components)
    cer_reference_length = sum(length for _, length in cer_components)
    return {
        "label": label,
        "model": payload.get("model"),
        "revision": payload.get("revision"),
        "device": payload.get("device"),
        "strategy": payload.get("results", [{}])[0].get("strategy") if payload.get("results") else None,
        "images": per_image,
        "summary": {
            "predicted": predicted,
            "ground_truth": truth,
            "matched": matched,
            "precision": round(matched / predicted, 4) if predicted else 0.0,
            "recall": round(matched / truth, 4) if truth else 0.0,
            "mean_center_error": pin_error["mean"],
            "mean_center_distance_px": pin_error["mean"],
            "exact_space_accuracy": round(exact_spaces / space_truth, 4) if space_truth else 0.0,
            "pin_error_px": pin_error,
            "wrong_neighbor_rate": round(wrong_neighbor / resolved, 4) if resolved else 0.0,
            "wrong_prefix_rate": round(wrong_prefix / resolved, 4) if resolved else 0.0,
            "merged_booth_accuracy": round(merged_matched / merged_booths, 4)
            if merged_booths
            else None,
            "missing_slot_false_positive_rate": round(
                missing_false_positives / missing_slots, 4
            )
            if missing_slots
            else 0.0,
            "unresolved_rate": round((truth - resolved) / truth, 4) if truth else 0.0,
            "ocr_cer": round(cer_edit_distance / cer_reference_length, 6)
            if cer_reference_length
            else None,
            "ocr_cer_macro": round(statistics.mean(cer_values), 6) if cer_values else None,
            "mean_iou": round(sum(ious) / len(ious), 4) if ious else None,
            "coordinate_metric": (
                "pin_center"
                if any(x.get("coordinate_metric") == "pin_center" for x in totals)
                else "bbox_iou_and_center"
            ),
            "distance_threshold_px": distance_threshold,
        },
    }


def _model_specs(values: list[str] | None, args: argparse.Namespace) -> list[dict[str, Any]]:
    """一括比較用のJSON model specを正規化する。

    各specはモデルID/ローカルpath/revisionだけでなく、modeとstrategyも
    独立指定できる。未指定値は従来CLI引数を継承する。
    """
    defaults = {
        "model_path": getattr(args, "model_path", None),
        "revision": getattr(args, "revision", None),
        "mode": getattr(args, "mode", "gundam"),
        "strategy": getattr(args, "strategy", "small_digits"),
    }
    if not values:
        return [
            {
                **defaults,
                "model": model,
                "label": model or "default",
            }
            for model in (getattr(args, "model", None) or [None])
        ]
    specs: list[dict[str, Any]] = []
    for index, raw in enumerate(values, start=1):
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise ValueError(f"--model-spec #{index} はJSON objectで指定してください: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ValueError(f"--model-spec #{index} はJSON objectで指定してください")
        unknown = set(parsed) - {"label", "model", "model_path", "revision", "mode", "strategy"}
        if unknown:
            raise ValueError(f"--model-spec #{index} の未知キー: {', '.join(sorted(unknown))}")
        spec = {**defaults, **parsed}
        if spec["mode"] not in {"gundam", "base"}:
            raise ValueError(f"--model-spec #{index}: mode={spec['mode']} は未対応です")
        if spec["strategy"] not in {"small_digits", "gundam_then_base", "balanced", "single"}:
            raise ValueError(f"--model-spec #{index}: strategy={spec['strategy']} は未対応です")
        spec["label"] = str(spec.get("label") or spec.get("model") or spec.get("model_path") or f"spec-{index}")
        specs.append(spec)
    return specs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unlimited OCRのモデル/座標精度評価")
    parser.add_argument("--image", action="append", help="評価対象画像（複数指定可）")
    parser.add_argument("--image-dir", help="画像ディレクトリ（map_*.png/jpg等）")
    parser.add_argument("--ground-truth", help="画像名→正解boxのJSON")
    parser.add_argument("--predictions", help="runnerの保存済み出力JSON（推論を実行しない）")
    parser.add_argument("--model", action="append", help="比較するHubモデルID（複数指定可）")
    parser.add_argument(
        "--model-spec",
        action="append",
        help=(
            "一括比較するJSON object（複数指定可）。"
            "label/model/model_path/revision/mode/strategyをspecごとに指定"
        ),
    )
    parser.add_argument("--model-path", help="比較するローカルモデルパス")
    parser.add_argument("--revision", help="Hub revision（モデル比較時に固定）")
    parser.add_argument("--mode", choices=("gundam", "base"), default="gundam")
    parser.add_argument("--strategy", choices=("small_digits", "gundam_then_base", "balanced", "single"), default="small_digits")
    parser.add_argument("--runner-python", default=None, help="OCR専用venvのPython（省略時はUNLIMITED_OCR_VENV）")
    parser.add_argument("--distance-threshold", type=float, default=30.0)
    parser.add_argument("--timeout-sec", type=int, default=1800)
    parser.add_argument("--output-json", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    images = [Path(x) for x in (args.image or [])]
    if args.image_dir:
        root = Path(args.image_dir)
        images.extend(sorted(x for x in root.iterdir() if x.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}))
    images = list(dict.fromkeys(images))
    if not images:
        raise SystemExit("--image または --image-dir を指定してください")
    truth = _ground_truth_by_image(Path(args.ground_truth) if args.ground_truth else None)
    results = []
    if args.predictions:
        try:
            payload = _validate_runner_payload(
                _load_json(Path(args.predictions)), source=f"保存済みrunner JSON ({args.predictions})"
            )
        except (OSError, ValueError, RuntimeError) as exc:
            output = {
                "schema_version": 3,
                "images": [str(x) for x in images],
                "results": [{"label": "saved", "error": str(exc)}],
            }
            Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output_json).write_text(
                json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(json.dumps(output, ensure_ascii=False, indent=2), file=sys.stderr)
            return 2
        results.append(evaluate(images, truth, payload, distance_threshold=args.distance_threshold, label="saved"))
    else:
        runner_python = _resolve_runner_python(args.runner_python)
        try:
            specs = _model_specs(args.model_spec, args)
        except ValueError as exc:
            output = {
                "schema_version": 3,
                "images": [str(x) for x in images],
                "results": [{"label": "configuration", "error": str(exc)}],
            }
            Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output_json).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(output, ensure_ascii=False, indent=2), file=sys.stderr)
            return 2
        for spec in specs:
            try:
                payload = _run_runner(
                    images,
                    runner_python=runner_python,
                    model=spec.get("model"),
                    model_path=spec.get("model_path"),
                    revision=spec.get("revision"),
                    mode=spec["mode"],
                    strategy=spec["strategy"],
                    timeout_sec=args.timeout_sec,
                )
            except RuntimeError as exc:
                results.append(
                    {
                        "label": spec["label"],
                        "error": str(exc),
                        "runner_python": runner_python,
                        "model_spec": spec,
                    }
                )
                continue
            evaluated = evaluate(
                images,
                truth,
                payload,
                distance_threshold=args.distance_threshold,
                label=spec["label"],
            )
            evaluated["model_spec"] = spec
            results.append(evaluated)
    output = {"schema_version": 3, "images": [str(x) for x in images], "results": results}
    Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_json).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if any(not item.get("error") for item in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())

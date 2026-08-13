"""Catalog/OCR association primitives with deterministic global assignment.

This module deliberately has no dependency on the coordinate generator.  It is
used by evaluation code and can be integrated into the generator's geometry
quality gate without creating an import cycle.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any


_SPACE_RE = re.compile(r"^\s*(?P<prefix>.*?)[\s\-‐‑‒–—−ー－]*(?P<number>\d{1,2})\s*$")


def normalize_prefix(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return text.casefold()


def normalize_number(value: Any) -> str | None:
    text = str(value or "").strip()
    try:
        number = int(text)
    except (TypeError, ValueError):
        return None
    return f"{number:02d}" if 1 <= number <= 99 else None


def split_space_id(value: Any) -> tuple[str | None, str | None]:
    match = _SPACE_RE.fullmatch(str(value or ""))
    if not match:
        return None, None
    return normalize_prefix(match.group("prefix")), normalize_number(match.group("number"))


def item_identity(item: Mapping[str, Any]) -> tuple[str | None, str | None, str | None]:
    """Return ``(prefix, number, group)`` without discarding explicit context."""
    prefix = normalize_prefix(item.get("prefix") or item.get("row"))
    number = normalize_number(item.get("number", item.get("text")))
    if item.get("space_id"):
        space_prefix, space_number = split_space_id(item.get("space_id"))
        prefix = prefix or space_prefix
        number = number or space_number
    group = item.get("group_identity", item.get("group_id"))
    group_text = str(group).strip() if group is not None else ""
    return prefix, number, group_text or None


def item_point(item: Mapping[str, Any]) -> tuple[float, float] | None:
    try:
        if "center_x" in item and "center_y" in item:
            return float(item["center_x"]), float(item["center_y"])
        if all(key in item for key in ("x1", "y1", "x2", "y2")):
            return (
                (float(item["x1"]) + float(item["x2"])) / 2.0,
                (float(item["y1"]) + float(item["y2"])) / 2.0,
            )
        if "width" in item and "height" in item:
            return (
                float(item["x"]) + float(item["width"]) / 2.0,
                float(item["y"]) + float(item["height"]) / 2.0,
            )
        return float(item["x"]), float(item["y"])
    except (KeyError, TypeError, ValueError):
        return None


def _hungarian(costs: Sequence[Sequence[float]]) -> list[int]:
    """Minimum-cost row-to-column assignment (rectangular Hungarian method).

    Returns the selected column for each row.  Callers provide at least as many
    columns as rows; dummy unmatched columns make partial association explicit.
    """
    row_count = len(costs)
    if not row_count:
        return []
    column_count = len(costs[0])
    if column_count < row_count or any(len(row) != column_count for row in costs):
        raise ValueError("assignment cost matrix must be rectangular with columns >= rows")
    u = [0.0] * (row_count + 1)
    v = [0.0] * (column_count + 1)
    p = [0] * (column_count + 1)
    way = [0] * (column_count + 1)
    for i in range(1, row_count + 1):
        p[0] = i
        j0 = 0
        minimum = [math.inf] * (column_count + 1)
        used = [False] * (column_count + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = math.inf
            j1 = 0
            for j in range(1, column_count + 1):
                if used[j]:
                    continue
                current = float(costs[i0 - 1][j - 1]) - u[i0] - v[j]
                if current < minimum[j] - 1e-12:
                    minimum[j] = current
                    way[j] = j0
                if minimum[j] < delta - 1e-12:
                    delta = minimum[j]
                    j1 = j
            if not math.isfinite(delta):
                raise ValueError("assignment matrix has no finite solution")
            for j in range(column_count + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minimum[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    assignment = [-1] * row_count
    for j in range(1, column_count + 1):
        if p[j]:
            assignment[p[j] - 1] = j - 1
    return assignment


def global_min_cost_association(
    predictions: Sequence[Mapping[str, Any]],
    targets: Sequence[Mapping[str, Any]],
    *,
    distance_threshold: float,
    require_number: bool = True,
    require_prefix_when_present: bool = True,
    group_aware: bool = True,
    allow_identity_mismatch: bool = False,
) -> dict[str, Any]:
    """Associate every prediction globally rather than in iteration order.

    A target can represent a merged/shared booth by repeating its
    ``group_identity``.  At most one prediction is consumed by that group; all
    target members are reported as resolved by the selected prediction.
    ``allow_identity_mismatch`` is intended only for evaluators that must
    classify a spatial association as wrong-prefix/wrong-neighbour; production
    resolver callers should keep the fail-closed default.
    """
    target_groups: list[list[int]] = []
    group_lookup: dict[str, int] = {}
    for index, target in enumerate(targets):
        _, _, group = item_identity(target)
        key = group if group_aware and group else f"__target_{index}"
        if key not in group_lookup:
            group_lookup[key] = len(target_groups)
            target_groups.append([])
        target_groups[group_lookup[key]].append(index)

    # Scale the cost tiers above the maximum aggregate distance.  This gives
    # lexicographic semantics: maximise feasible association cardinality,
    # maximise exact identity matches, then minimise distance.
    edge_bound = max(float(distance_threshold), 0.0) + 1.0
    problem_size = max(len(predictions), len(target_groups), 1)
    identity_mismatch_cost = edge_bound * (problem_size + 1)
    unmatched_cost = identity_mismatch_cost * (problem_size + 1)
    forbidden_cost = unmatched_cost * 1000000.0
    # Evaluators may allow mismatch edges solely to classify errors.  Penalise
    # each such edge above every possible aggregate distance so assignment is
    # lexicographic: cardinality, exact identity count, then spatial distance.
    real_costs: list[list[float]] = []
    real_members: list[list[int | None]] = []
    for prediction in predictions:
        pred_prefix, pred_number, pred_group = item_identity(prediction)
        pred_point = item_point(prediction)
        row: list[float] = []
        member_row: list[int | None] = []
        for members in target_groups:
            best = forbidden_cost
            best_member: int | None = None
            for target_index in members:
                target = targets[target_index]
                target_prefix, target_number, target_group = item_identity(target)
                target_point = item_point(target)
                if pred_point is None or target_point is None:
                    continue
                identity_mismatch = False
                if require_number and (pred_number is None or pred_number != target_number):
                    if not allow_identity_mismatch:
                        continue
                    identity_mismatch = True
                if (
                    require_prefix_when_present
                    and pred_prefix is not None
                    and target_prefix is not None
                    and pred_prefix != target_prefix
                ):
                    if not allow_identity_mismatch:
                        continue
                    identity_mismatch = True
                if group_aware and pred_group and target_group and pred_group != target_group:
                    if not allow_identity_mismatch:
                        continue
                    identity_mismatch = True
                distance = math.hypot(pred_point[0] - target_point[0], pred_point[1] - target_point[1])
                if distance <= distance_threshold:
                    candidate_cost = distance + (
                        identity_mismatch_cost if identity_mismatch else 0.0
                    )
                    if candidate_cost < best:
                        best = candidate_cost
                        best_member = target_index
            row.append(best)
            member_row.append(best_member)
        real_costs.append(row)
        real_members.append(member_row)

    # One private dummy column per prediction means unmatched choices never
    # compete, while the Hungarian solver still sees a complete finite matrix.
    matrix = [
        row
        + [
            unmatched_cost + (0.0 if dummy == pred_index else 1e-7)
            for dummy in range(len(predictions))
        ]
        for pred_index, row in enumerate(real_costs)
    ]
    assignment = _hungarian(matrix) if predictions else []
    matches: list[dict[str, Any]] = []
    used_predictions: set[int] = set()
    resolved_targets: set[int] = set()
    for pred_index, column in enumerate(assignment):
        if column < 0 or column >= len(target_groups):
            continue
        assigned_cost = real_costs[pred_index][column]
        if assigned_cost >= forbidden_cost:
            continue
        members = target_groups[column]
        prediction_point = item_point(predictions[pred_index])
        target_index = real_members[pred_index][column]
        if prediction_point is None or target_index is None:
            continue
        used_predictions.add(pred_index)
        resolved_targets.update(members)
        target_point = item_point(targets[target_index])
        if target_point is None:
            continue
        distance = math.hypot(
            prediction_point[0] - target_point[0],
            prediction_point[1] - target_point[1],
        )
        matches.append(
            {
                "prediction_index": pred_index,
                "target_index": target_index,
                "target_indices": list(members),
                "distance_px": round(distance, 6),
            }
        )
    matches.sort(key=lambda match: match["prediction_index"])
    return {
        "matches": matches,
        "unmatched_prediction_indices": [
            index for index in range(len(predictions)) if index not in used_predictions
        ],
        "unresolved_target_indices": [
            index for index in range(len(targets)) if index not in resolved_targets
        ],
    }


__all__ = [
    "global_min_cost_association",
    "item_identity",
    "item_point",
    "normalize_number",
    "normalize_prefix",
    "split_space_id",
]

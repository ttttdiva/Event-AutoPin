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
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "src" / "space_locator" / "unlimited_ocr_runner.py"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from src.space_locator.ocr_engine import _elements_to_numbers


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
                result[_image_key(image)] = [x for x in boxes if isinstance(x, dict)]
        return result
    if not isinstance(raw, dict):
        raise ValueError("ground-truth は画像名をキーにしたJSONオブジェクトで指定してください")
    return {
        _image_key(image): [x for x in boxes if isinstance(x, dict)]
        for image, boxes in raw.items()
        if isinstance(boxes, list)
    }


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
            raw_elements = []
            for element in elements:
                if not isinstance(element, dict):
                    continue
                if "text" in element:
                    raw_elements.append(element)
                    continue
                # 保存済み評価データが既に本番契約へ正規化済みの場合も
                # 後方互換で受け付ける。
                if "number" in element and all(
                    key in element for key in ("x", "y", "width", "height")
                ):
                    try:
                        raw_elements.append(
                            {
                                "text": str(element.get("number")),
                                "x1": element.get("x"),
                                "y1": element.get("y"),
                                "x2": float(element.get("x", 0)) + float(element.get("width", 0)),
                                "y2": float(element.get("y", 0)) + float(element.get("height", 0)),
                            }
                        )
                    except (TypeError, ValueError):
                        continue
            result[_image_key(image)].extend(_elements_to_numbers(raw_elements))
    return dict(result)


def score_image(
    predictions: Iterable[Mapping[str, Any]],
    ground_truth: Iterable[Mapping[str, Any]],
    *,
    distance_threshold: float = 30.0,
) -> dict[str, Any]:
    """番号一致 + 中心座標距離で一対一マッチし、精度を返す。"""
    pred = [(_number(x.get("text", x.get("number"))), _box(x), None) for x in predictions]
    truth = [(_number(x.get("number", x.get("text"))), _box(x), _point(x)) for x in ground_truth]
    pred = [(n, b, p) for n, b, p in pred if b is not None]
    truth = [(n, b, p) for n, b, p in truth if b is not None or p is not None]
    used: set[int] = set()
    matches: list[dict[str, Any]] = []
    for number, pbox, _ in pred:
        best_index: int | None = None
        best_distance = math.inf
        for index, (truth_number, tbox, tpoint) in enumerate(truth):
            if index in used or number != truth_number:
                continue
            px, py = _center(pbox)
            tx, ty = tpoint if tpoint is not None else _center(tbox)  # type: ignore[arg-type]
            distance = math.hypot(px - tx, py - ty)
            if distance < best_distance:
                best_distance, best_index = distance, index
        if best_index is not None and best_distance <= distance_threshold:
            used.add(best_index)
            matches.append(
                {
                    "number": number,
                    "distance_px": round(best_distance, 3),
                    "iou": (
                        None
                        if truth[best_index][2] is not None
                        else round(_iou(pbox, truth[best_index][1]), 4)  # type: ignore[arg-type]
                    ),
                }
            )
    true_positive = len(matches)
    false_positive = len(pred) - true_positive
    false_negative = len(truth) - true_positive
    return {
        "predicted": len(pred),
        "ground_truth": len(truth),
        "matched": true_positive,
        "false_positive": false_positive,
        "false_negative": false_negative,
        "precision": round(true_positive / len(pred), 4) if pred else 0.0,
        "recall": round(true_positive / len(truth), 4) if truth else 0.0,
        "mean_center_distance_px": round(
            sum(x["distance_px"] for x in matches) / len(matches), 3
        )
        if matches
        else None,
        "mean_iou": (
            round(sum(x["iou"] for x in matches if x["iou"] is not None) / len([x for x in matches if x["iou"] is not None]), 4)
            if any(x["iou"] is not None for x in matches)
            else None
        ),
        "coordinate_metric": "pin_center" if any(x[2] is not None for x in truth) else "bbox_iou_and_center",
        "distance_threshold_px": distance_threshold,
        "matches": matches,
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
    per_image: dict[str, Any] = {}
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
        per_image[str(image)] = score_image(
            prediction_boxes, truth_boxes, distance_threshold=distance_threshold
        )
    totals = [value for value in per_image.values()]
    predicted = sum(x["predicted"] for x in totals)
    truth = sum(x["ground_truth"] for x in totals)
    matched = sum(x["matched"] for x in totals)
    distances = [m["distance_px"] for x in totals for m in x["matches"]]
    ious = [m["iou"] for x in totals for m in x["matches"] if m["iou"] is not None]
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
            "mean_center_distance_px": round(sum(distances) / len(distances), 3) if distances else None,
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
                "schema_version": 1,
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
                "schema_version": 1,
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
    output = {"schema_version": 1, "images": [str(x) for x in images], "results": results}
    Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_json).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if any(not item.get("error") for item in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())

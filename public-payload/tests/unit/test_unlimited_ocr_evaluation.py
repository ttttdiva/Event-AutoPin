from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "evaluate_unlimited_ocr.py"
SPEC = importlib.util.spec_from_file_location("evaluate_unlimited_ocr", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_score_image_matches_number_and_reports_coordinate_error():
    result = MODULE.score_image(
        [{"text": "12", "x1": 100, "y1": 200, "x2": 120, "y2": 220}],
        [{"number": "12", "x": 102, "y": 201, "width": 20, "height": 20}],
        distance_threshold=30,
    )
    assert result["matched"] == 1
    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
    assert result["mean_center_distance_px"] is not None
    assert result["distance_threshold_px"] == 30


def test_score_image_separates_wrong_number_and_missing_box():
    result = MODULE.score_image(
        [{"text": "13", "x1": 100, "y1": 200, "x2": 120, "y2": 220}],
        [{"number": "12", "x": 100, "y": 200, "width": 20, "height": 20}],
    )
    assert result["matched"] == 0
    assert result["false_positive"] == 1
    assert result["false_negative"] == 1


def test_score_image_pin_center_gt_does_not_report_iou():
    result = MODULE.score_image(
        [{"text": "12", "x1": 100, "y1": 200, "x2": 120, "y2": 220}],
        [{"number": "12", "center_x": 110, "center_y": 210}],
        distance_threshold=1,
    )
    assert result["matched"] == 1
    assert result["coordinate_metric"] == "pin_center"
    assert result["matches"][0]["iou"] is None
    assert result["mean_iou"] is None


def test_predictions_are_normalized_like_production_engine():
    payload = {
        "results": [
            {
                "image": "map_01.png",
                "elements": [
                    {
                        "text": "<table><tr><td>01</td><td>02</td></tr></table>",
                        "x1": 0,
                        "y1": 0,
                        "x2": 200,
                        "y2": 20,
                    }
                ],
            }
        ]
    }
    predictions = MODULE._predictions_by_image(payload)
    assert [item["number"] for item in predictions["map_01.png"]] == ["01", "02"]


def test_saved_empty_runner_payload_is_rejected_with_diagnostic(tmp_path, monkeypatch):
    prediction_path = tmp_path / "empty.json"
    prediction_path.write_text(json.dumps({"results": []}), encoding="utf-8")
    output_path = tmp_path / "evaluation.json"
    monkeypatch.setattr(
        MODULE,
        "parse_args",
        lambda: type(
            "Args",
            (),
            {
                "image": [str(tmp_path / "map.png")],
                "image_dir": None,
                "ground_truth": None,
                "predictions": str(prediction_path),
                "model": None,
                "model_path": None,
                "mode": "gundam",
                "strategy": "small_digits",
                "runner_python": None,
                "distance_threshold": 30.0,
                "timeout_sec": 30,
                "output_json": str(output_path),
            },
        )(),
    )
    (tmp_path / "map.png").write_bytes(b"not-an-image")
    assert MODULE.main() == 2
    assert json.loads(output_path.read_text(encoding="utf-8"))["results"][0]["error"]


def test_model_specs_can_compare_model_path_revision_mode_and_strategy():
    args = SimpleNamespace(
        model=None,
        model_path=None,
        revision="fallback-revision",
        mode="gundam",
        strategy="small_digits",
    )
    specs = MODULE._model_specs(
        [
            json.dumps(
                {
                    "label": "pinned-gundam",
                    "model": "baidu/Unlimited-OCR",
                    "revision": "abc123",
                    "mode": "gundam",
                    "strategy": "small_digits",
                }
            ),
            json.dumps(
                {
                    "label": "local-base",
                    "model_path": "models/alternate",
                    "mode": "base",
                    "strategy": "single",
                }
            ),
        ],
        args,
    )

    assert specs[0]["model"] == "baidu/Unlimited-OCR"
    assert specs[0]["revision"] == "abc123"
    assert specs[1]["model_path"] == "models/alternate"
    assert specs[1]["revision"] == "fallback-revision"
    assert specs[1]["mode"] == "base"
    assert specs[1]["strategy"] == "single"


def test_model_specs_reject_unknown_keys():
    args = SimpleNamespace(model=None, model_path=None, revision=None, mode="gundam", strategy="single")
    try:
        MODULE._model_specs(['{"label":"bad","temperature":1}'], args)
    except ValueError as exc:
        assert "未知キー" in str(exc)
    else:
        raise AssertionError("unknown model-spec key must fail closed")


def test_canonical_repo_event_report_fixes_input_command_and_metrics():
    report_path = Path(__file__).resolve().parents[2] / "docs" / "ocr-evaluation.repo-events.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    canonical = report["canonical"]
    assert canonical["predictions"] == "temp/phase1_accuracy_roi_standard.json"
    assert canonical["distance_threshold_px"] == 50
    assert canonical["expected"] == {
        "predicted": 76,
        "ground_truth": 56,
        "matched": 35,
        "precision": 0.4605,
        "recall": 0.625,
        "mean_center_distance_px": 21.657,
    }
    comparison = next(
        item for item in report["comparisons"] if item["label"] == "small_digits_roi_tile_standard"
    )
    assert comparison["evaluation"]["results"][0]["summary"] == canonical["expected"] | {
        "mean_iou": None,
        "coordinate_metric": "pin_center",
        "distance_threshold_px": 50.0,
    }

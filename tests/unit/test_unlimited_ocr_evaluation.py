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


def test_schema_v3_normalized_grouped_predictions_are_not_resplit():
    normalized_elements = [
        {
            "number": "01",
            "x": 0,
            "y": 0,
            "width": 50,
            "height": 20,
            "prefix": "A",
            "space_id": "A01",
            "group_identity": "grouped-row-1",
            "raw_text": "A-01 A-02",
        },
        {
            "number": "02",
            "x": 50,
            "y": 0,
            "width": 50,
            "height": 20,
            "prefix": "A",
            "space_id": "A02",
            "group_identity": "grouped-row-1",
            "raw_text": "A-01 A-02",
        },
    ]
    payload = {
        "schema_version": 3,
        "results": [{"image": "map_01.png", "elements": normalized_elements}],
    }

    predictions = MODULE._predictions_by_image(payload)

    assert predictions["map_01.png"] == normalized_elements


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


def test_identity_metrics_cover_neighbor_prefix_merged_missing_and_unresolved():
    ground_truth = [
        {"space_id": "A01", "prefix": "A", "number": "01", "group_identity": "g1", "center_x": 0, "center_y": 0},
        {"space_id": "A02", "prefix": "A", "number": "02", "group_identity": "g2", "center_x": 100, "center_y": 0},
        {"space_id": "B01", "prefix": "B", "number": "01", "group_identity": "g3", "center_x": 0, "center_y": 100},
        {"space_id": "M03", "prefix": "M", "number": "03", "group_identity": "gm", "merged": True, "center_x": 200, "center_y": 0},
        {"space_id": "M04", "prefix": "M", "number": "04", "group_identity": "gm", "merged": True, "center_x": 200, "center_y": 0},
        {"space_id": "A05", "prefix": "A", "number": "05", "group_identity": "missing", "missing_slot": True, "center_x": 300, "center_y": 0},
        {"space_id": "A06", "prefix": "A", "number": "06", "group_identity": "unresolved", "center_x": 400, "center_y": 0},
    ]
    predictions = [
        {"space_id": "A01", "prefix": "A", "number": "01", "center_x": 0, "center_y": 0},
        {"space_id": "A03", "prefix": "A", "number": "03", "center_x": 100, "center_y": 0},
        {"space_id": "A01", "prefix": "A", "number": "01", "center_x": 0, "center_y": 100},
        {"space_id": "M03", "prefix": "M", "number": "03", "center_x": 200, "center_y": 0},
        {"space_id": "A05", "prefix": "A", "number": "05", "center_x": 300, "center_y": 0},
    ]

    result = MODULE.score_image(predictions, ground_truth, distance_threshold=10)

    assert result["ground_truth"] == 5
    assert result["matched"] == 2
    assert result["exact_space_accuracy"] == 0.5
    assert result["wrong_neighbor_rate"] == 0.25
    assert result["wrong_prefix_rate"] == 0.25
    assert result["merged_booth_accuracy"] == 1.0
    assert result["exact_spaces"] == 3
    assert result["space_ground_truth"] == 6
    assert result["missing_slot_false_positive_rate"] == 1.0
    assert result["unresolved_rate"] == 0.2
    assert result["pin_error_px"] == {"mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0}


def test_global_assignment_is_independent_of_prediction_order():
    targets = [
        {"number": "01", "center_x": 0, "center_y": 0},
        {"number": "01", "center_x": 20, "center_y": 0},
    ]
    predictions = [
        {"number": "01", "center_x": 9, "center_y": 0},
        {"number": "01", "center_x": 0, "center_y": 0},
    ]

    result = MODULE.score_image(predictions, targets, distance_threshold=12)

    assert result["matched"] == 2
    assert sorted(match["distance_px"] for match in result["matches"]) == [0.0, 11.0]


def test_exact_identity_is_preferred_over_nearer_wrong_prefix():
    ground_truth = [
        {"space_id": "A01", "prefix": "A", "number": "01", "center_x": 0, "center_y": 0},
        {"space_id": "B01", "prefix": "B", "number": "01", "center_x": 10, "center_y": 0},
    ]
    predictions = [
        {"space_id": "A01", "prefix": "A", "number": "01", "center_x": 9, "center_y": 0},
        {"space_id": "B01", "prefix": "B", "number": "01", "center_x": 1, "center_y": 0},
    ]

    result = MODULE.score_image(predictions, ground_truth, distance_threshold=20)

    assert result["matched"] == 2
    assert result["wrong_prefix_rate"] == 0.0
    assert result["pin_error_px"]["mean"] == 9.0


def test_exact_group_identity_is_preferred_over_nearer_same_space_number():
    ground_truth = [
        {"space_id": "A01", "prefix": "A", "number": "01", "group_identity": "left", "center_x": 0, "center_y": 0},
        {"space_id": "A01-duplicate", "prefix": "A", "number": "01", "group_identity": "right", "center_x": 10, "center_y": 0},
    ]
    predictions = [
        {"prefix": "A", "number": "01", "group_identity": "left", "center_x": 9, "center_y": 0},
        {"prefix": "A", "number": "01", "group_identity": "right", "center_x": 1, "center_y": 0},
    ]

    result = MODULE.score_image(predictions, ground_truth, distance_threshold=20)

    assert result["matched"] == 2
    assert result["pin_error_px"]["mean"] == 9.0


def test_raw_ocr_and_cer_are_reported_when_reference_is_available():
    result = MODULE.score_image(
        [{"number": "01", "center_x": 0, "center_y": 0}],
        [{"number": "01", "center_x": 0, "center_y": 0}],
        raw_ocr_text="A01 A03",
        reference_ocr_text="A01 A02",
    )

    assert result["ocr_raw"] == "A01 A03"
    assert result["ocr_cer"] == round(1 / len("A01 A02"), 6)


def test_summary_ocr_cer_is_corpus_weighted_and_macro_is_retained():
    ground_truth = {
        "short.png": MODULE.GroundTruthPoints([], ocr_text="A"),
        "long.png": MODULE.GroundTruthPoints([], ocr_text="BBBBBBBBB"),
    }
    payload = {
        "results": [
            {"image": "short.png", "raw_output": "X", "elements": []},
            {"image": "long.png", "raw_output": "BBBBBBBBB", "elements": []},
        ]
    }

    summary = MODULE.evaluate(
        [Path("short.png"), Path("long.png")],
        ground_truth,
        payload,
        distance_threshold=30,
        label="corpus-cer",
    )["summary"]

    assert summary["ocr_cer"] == 0.1
    assert summary["ocr_cer_macro"] == 0.5


def test_ground_truth_v3_preserves_identity_group_and_image_ocr_text(tmp_path):
    path = tmp_path / "ground_truth.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 3,
                "images": [
                    {
                        "image": "synthetic.png",
                        "ocr_text": "A01 A02",
                        "points": [
                            {
                                "space_id": "A01",
                                "prefix": "A",
                                "number": "01",
                                "group_identity": "circle-1",
                                "center_x": 10,
                                "center_y": 20,
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    loaded = MODULE._ground_truth_by_image(path)["synthetic.png"]

    assert loaded[0]["space_id"] == "A01"
    assert loaded[0]["prefix"] == "A"
    assert loaded[0]["group_identity"] == "circle-1"
    assert loaded.ocr_text == "A01 A02"

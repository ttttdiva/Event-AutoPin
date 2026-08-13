from __future__ import annotations

import argparse
import sys
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
import pytest

from src.space_locator import unlimited_ocr_runner as runner


class DummyModel:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def infer(self, tokenizer, **kwargs):
        self.calls.append(kwargs)
        if len(self.calls) == 1:
            return "<|det|>image [0, 0, 100, 100]<|/det|>"
        return "<|ref|>12<|/ref|><|det|>[[100, 100, 200, 200]]<|/det|>"


def test_small_digits_falls_back_when_first_output_has_no_numeric_text(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (1000, 1000), "white").save(image)
    model = DummyModel()
    monkeypatch.setattr(runner, "DEFAULT_OUTPUT_DIR", tmp_path / "out")
    args = argparse.Namespace(
        strategy="small_digits",
        mode="gundam",
        prompt=None,
        fallback=True,
        max_length=16,
        no_repeat_ngram_size=0,
        ngram_window=4,
        temperature=0.0,
        include_raw=False,
    )
    result = runner.infer_image(None, model, image, args)
    assert len(model.calls) == 2
    assert result["elements"][0]["text"] == "12"
    assert result["attempts"][0]["elements"] == 1
    assert result["attempts"][1]["elements"] == 1
    assert result["attempts"][0]["max_length"] == 16
    assert result["attempts"][1]["max_length"] == 4096


def test_small_digits_limits_explicit_large_max_length_per_attempt(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (1000, 1000), "white").save(image)
    model = DummyModel()
    monkeypatch.setattr(runner, "DEFAULT_OUTPUT_DIR", tmp_path / "out")
    args = argparse.Namespace(
        strategy="small_digits",
        mode="gundam",
        prompt=None,
        fallback=True,
        max_length=32768,
        no_repeat_ngram_size=0,
        ngram_window=4,
        temperature=0.0,
        include_raw=False,
    )
    result = runner.infer_image(None, model, image, args)
    assert [call["max_length"] for call in model.calls] == [4096, 8192]
    assert result["max_length"] == 32768


def test_tile_origins_are_bounded_and_cover_image_edges():
    origins = runner._tile_origins(3035, 1803, 320, 80, max_count=8)
    assert len(origins) == 8
    assert origins[0] == (0, 0)
    assert origins[-1] == (3035 - 320, 1803 - 320)


def test_default_sized_tile_scan_adds_relative_detail_rois_within_bound():
    origins = runner._tile_origins(3035, 1803, 320, 160, max_count=160)

    assert len(origins) <= 160
    assert (1000, 400) in origins
    assert (2400, 800) in origins
    assert (3035 - 320, 400) in origins


def test_tile_scan_uses_single_gundam_grounding_without_mutating_parent_args(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (100, 100), "white").save(image)
    model = DummyModel()
    # DummyModelは2回目にnumericを返すため、tile呼び出し前のロード済み
    # 状態を模して1call進めておく。
    model.calls.append({})
    monkeypatch.setattr(runner, "DEFAULT_OUTPUT_DIR", tmp_path / "out")
    args = argparse.Namespace(
        strategy="small_digits",
        mode="base",
        prompt="custom full-frame prompt",
        fallback=True,
        max_length=32768,
        no_repeat_ngram_size=0,
        ngram_window=4,
        temperature=0.0,
        include_raw=False,
    )

    merged = runner._merge_tile_results(image, [image], [(10, 20)], None, model, args)

    assert model.calls[1]["prompt"] == runner.DEFAULT_PROMPT
    assert model.calls[1]["crop_mode"] is True
    assert model.calls[1]["max_length"] == 4096
    assert args.strategy == "small_digits"
    assert args.mode == "base"
    assert merged[0]["text"] == "12"
    assert merged[0]["x1"] == 20
    assert merged[0]["y1"] == 30


def test_numeric_element_count_counts_grouped_and_compact_rows():
    elements = [
        {"text": "01 02 03", "x1": 0, "y1": 0, "x2": 90, "y2": 20},
        {"text": "04050607", "x1": 0, "y1": 30, "x2": 120, "y2": 50},
        {"text": "image", "x1": 0, "y1": 60, "x2": 100, "y2": 100},
    ]

    assert runner._numeric_element_count(elements) == 7


def test_default_revision_fails_closed_when_auto_has_no_cuda(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
    )

    with pytest.raises(RuntimeError, match="cpu_unsupported"):
        runner.resolve_device("auto")


def test_custom_model_can_resolve_cpu_when_cuda_is_unavailable(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)),
    )

    assert runner.resolve_device("auto", model_source="org/cpu-compatible") == "cpu"


def test_tile_exception_is_diagnostic_and_later_tiles_continue(tmp_path, monkeypatch):
    images = []
    for index in range(2):
        path = tmp_path / f"tile_{index}.png"
        Image.new("RGB", (100, 100), "white").save(path)
        images.append(path)

    class PartialModel:
        def __init__(self):
            self.calls = 0

        def infer(self, tokenizer, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("tile boom")
            return "<|ref|>12<|/ref|><|det|>[[100, 100, 200, 200]]<|/det|>"

    monkeypatch.setattr(runner, "DEFAULT_OUTPUT_DIR", tmp_path / "out")
    args = argparse.Namespace(
        strategy="small_digits", mode="gundam", prompt=None, fallback=True,
        max_length=4096, no_repeat_ngram_size=0, ngram_window=4,
        temperature=0.0, include_raw=False,
    )
    diagnostics = []
    merged = runner._merge_tile_results(
        images[0], images, [(0, 0), (100, 0)], None, PartialModel(), args,
        diagnostics=diagnostics,
    )

    assert len(diagnostics) == 1
    assert diagnostics[0]["tile_index"] == 0
    assert diagnostics[0]["error_code"] == "tile_inference_failed"
    assert diagnostics[0]["type"] == "RuntimeError"
    assert "tile boom" not in str(diagnostics[0])
    assert merged[0]["text"] == "12"
    assert merged[0]["x1"] == 110


def test_runner_numeric_success_accepts_explicit_prefix_number_formats_only():
    assert runner._contains_numeric_text("企業 - 01") is True
    assert runner._contains_numeric_text("A 01") is True
    assert runner._contains_numeric_text("A-01") is True
    assert runner._contains_numeric_text("C-01") is True
    assert runner._contains_numeric_text("A12") is False


def test_should_tile_uses_catalog_expected_coverage_at_legacy_boundary():
    assert runner.should_tile(12, 73) is True
    assert runner.should_tile(13, 73) is True
    assert runner.should_tile(12, 20) is False
    assert runner.should_tile(76, 56) is False
    assert runner.should_tile(10, 10) is True
    assert runner._tile_decision(12, 73)["trigger_reason"] == "below_expected_coverage"


def test_should_tile_without_expected_count_preserves_legacy_behavior():
    assert runner.should_tile(11) is True
    assert runner.should_tile(12) is False


def test_apply_tile_fallback_expected_mode_stops_after_context(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (100, 100), "white").save(image)
    calls = []
    monkeypatch.setattr(runner, "_write_tiles", lambda *args: ([image], [(0, 0)]))
    monkeypatch.setattr(
        runner,
        "_merge_tile_results",
        lambda *args, **kwargs: calls.append(True) or [
            {"text": "13", "x1": 30, "y1": 30, "x2": 40, "y2": 40}
        ],
    )
    result = {
        "elements": [
            {"text": f"{number:02d}", "x1": number, "y1": 1, "x2": number + 1, "y2": 2}
            for number in range(1, 13)
        ]
    }
    args = argparse.Namespace(
        expected_candidate_count=73,
        no_tile_fallback=False,
        tile_size=100,
        tile_overlap=20,
        tile_max_count=2,
    )

    runner._apply_tile_fallback(image, result, None, None, args)

    assert calls == []
    assert result["tile_decision"]["trigger_reason"] == "below_expected_coverage"
    assert "context_fallback" in result
    assert "tile_fallback" not in result


def test_apply_tile_fallback_disabled_records_decision_without_scanning(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (100, 100), "white").save(image)
    monkeypatch.setattr(runner, "_write_tiles", lambda *args: pytest.fail("must not tile"))
    result = {"elements": []}
    args = argparse.Namespace(
        expected_candidate_count=73,
        no_tile_fallback=True,
        tile_size=100,
        tile_overlap=20,
        tile_max_count=2,
    )

    runner._apply_tile_fallback(image, result, None, None, args)

    assert result["tile_decision"]["should_tile"] is True
    assert "tile_fallback" not in result


def test_context_rectangles_are_deterministic_and_cover_portrait_edges():
    image = Image.new("RGB", (1032, 1458), "white")
    size, origins = runner._context_rectangles(image)
    assert size == (512, 768)
    assert len(origins) <= 9
    assert {x for x, _ in origins} == {0, 260, 520}
    assert (0, 0) in origins and (520, 690) in origins
    middle_origins = [y for x, y in origins if x == 520 and y not in (0, 690)]
    assert middle_origins and all(172 <= y <= 518 for y in middle_origins)


@pytest.mark.parametrize("width,height", [(2000, 200), (200, 2000), (3840, 2714)])
def test_context_rectangles_cover_large_and_extreme_aspects_without_axis_gaps(width, height):
    (crop_width, crop_height), origins = runner._context_rectangles(
        Image.new("RGB", (width, height), "white")
    )
    assert len(origins) <= 9
    xs = sorted({x for x, _ in origins})
    assert xs[0] == 0 and xs[-1] + crop_width >= width
    assert all(right - left <= crop_width for left, right in zip(xs, xs[1:]))
    for x in xs:
        ys = sorted({y for origin_x, y in origins if origin_x == x})
        assert ys[0] == 0 and ys[-1] + crop_height >= height
        assert all(bottom - top <= crop_height for top, bottom in zip(ys, ys[1:]))


def test_context_tier_a_sufficient_skips_tier_c_and_square(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (1032, 1458), "white").save(image)
    paths = []
    for index in range(4):
        path = tmp_path / f"rect{index}.png"
        Image.new("RGB", (640, 896), "white").save(path)
        paths.append(path)
    monkeypatch.setattr(runner, "_write_context_rectangles", lambda _: (paths, [(0, 0)] * 4, (640, 896)))
    prompts = []

    def context(*args):
        prompt = args[5]
        args[6].append({"tier": "A", "rectangle_index": 0, "numeric_count": 40})
        prompts.append(prompt)
        return [
            {"text": f"{number:02d}", "x1": number, "y1": 1, "x2": number + 1, "y2": 2}
            for number in range(1, 41)
        ]

    monkeypatch.setattr(runner, "_merge_context_results", context)
    monkeypatch.setattr(runner, "_write_tiles", lambda *args: pytest.fail("square must be skipped"))
    args = argparse.Namespace(expected_candidate_count=73, no_tile_fallback=False, tile_size=320, tile_overlap=80, tile_max_count=70)
    result = {"elements": []}
    runner._apply_tile_fallback(image, result, None, None, args)
    assert prompts == [runner.DEFAULT_PROMPT]
    assert [tier["tier"] for tier in result["context_fallback"]["tiers"]] == ["A"]
    assert result["context_fallback"]["call_count"] == 1
    assert result["context_fallback"]["error_count"] == 0
    assert result["context_fallback"]["errors"] == []


def test_context_low_tier_a_invokes_tier_c_then_legacy_square(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (1032, 1458), "white").save(image)
    paths = [tmp_path / "rect.png"]
    Image.new("RGB", (640, 896), "white").save(paths[0])
    monkeypatch.setattr(runner, "_write_context_rectangles", lambda _: (paths, [(10, 20)], (640, 896)))
    prompts = []
    monkeypatch.setattr(runner, "_merge_context_results", lambda *args: prompts.append(args[5]) or [])
    monkeypatch.setattr(runner, "_write_tiles", lambda *args: ([], []))
    monkeypatch.setattr(runner, "_merge_tile_results", lambda *args, **kwargs: [])
    args = argparse.Namespace(expected_candidate_count=73, no_tile_fallback=False, tile_size=320, tile_overlap=80, tile_max_count=70)
    result = {"elements": []}
    runner._apply_tile_fallback(image, result, None, None, args)
    assert prompts == [runner.DEFAULT_PROMPT, runner.LAYOUT_DIGITS_PROMPT]
    assert "tile_fallback" not in result


def test_context_overlap_duplicates_do_not_fake_expected_coverage(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (1032, 1458), "white").save(image)
    paths = [tmp_path / f"rect{i}.png" for i in range(4)]
    for path in paths:
        Image.new("RGB", (640, 896), "white").save(path)
    monkeypatch.setattr(runner, "_write_context_rectangles", lambda _: (paths, [(0, 0)] * 4, (640, 896)))
    prompts = []
    duplicated = [
        {"text": f"{number:02d}", "x1": number * 10, "y1": 10, "x2": number * 10 + 5, "y2": 15}
        for number in range(1, 11)
    ] * 4
    monkeypatch.setattr(runner, "_merge_context_results", lambda *args: prompts.append(args[5]) or duplicated)
    monkeypatch.setattr(runner, "_write_tiles", lambda *args: ([], []))
    monkeypatch.setattr(runner, "_merge_tile_results", lambda *args, **kwargs: [])
    args = argparse.Namespace(expected_candidate_count=73, no_tile_fallback=False, tile_size=320, tile_overlap=80, tile_max_count=70)
    result = {"elements": []}
    runner._apply_tile_fallback(image, result, None, None, args)
    assert prompts == [runner.DEFAULT_PROMPT, runner.LAYOUT_DIGITS_PROMPT]
    assert "tile_fallback" not in result


def test_unique_numeric_count_deduplicates_shifted_overlap_boxes():
    elements = []
    for shift in (0, 25):
        elements.extend(
            {"text": f"{number:02d}", "x1": number * 40 + shift, "y1": 10, "x2": number * 40 + shift + 60, "y2": 40}
            for number in range(1, 11)
        )
    assert runner._unique_numeric_element_count(elements) == 10


def test_write_tiles_cleans_partially_written_file_on_save_error(tmp_path, monkeypatch):
    image = tmp_path / "map.png"
    Image.new("RGB", (700, 700), "white").save(image)
    monkeypatch.setattr(runner, "DEFAULT_OUTPUT_DIR", tmp_path / "out")
    original_save = Image.Image.save

    def partial_save(self, fp, *args, **kwargs):
        path = str(fp)
        if path.endswith("0001.png"):
            Path(path).write_bytes(b"partial")
            raise OSError("save failed")
        return original_save(self, fp, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "save", partial_save)
    with pytest.raises(OSError, match="save failed"):
        runner._write_tiles(image, 320, 0, 4)
    assert list((tmp_path / "out" / "tiles").rglob("*.png")) == []


def test_context_exception_diagnostic_omits_untrusted_message_and_continues(tmp_path, monkeypatch):
    paths = []
    for index in range(2):
        path = tmp_path / f"context_{index}.png"
        Image.new("RGB", (100, 120), "white").save(path)
        paths.append(path)

    token = "".join(("s", "k", "-", "secret"))
    windows_path = "".join(("C", ":", "\\", "private", "\\", "map.png"))
    posix_path = "".join(("/", "home", "/", "private", "/", "map.png"))
    hostile = " ".join((token, windows_path, posix_path, "X" * 100_000))
    calls = 0

    def infer(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError(hostile)
        return {"elements": [{"text": "12", "x1": 1, "y1": 2, "x2": 5, "y2": 8}]}

    monkeypatch.setattr(runner, "infer_image", infer)
    args = argparse.Namespace(max_length=4096)
    diagnostics = []
    merged = runner._merge_context_results(
        paths,
        [(0, 0), (100, 200)],
        None,
        None,
        args,
        runner.DEFAULT_PROMPT,
        diagnostics,
        "A",
    )

    assert len(diagnostics) == 2
    error = diagnostics[0]
    assert error["error_code"] == "context_inference_failed"
    assert error["type"] == "RuntimeError"
    serialized = str(error)
    assert len(serialized) < 500
    assert token not in serialized
    assert windows_path not in serialized
    assert posix_path not in serialized
    assert merged == [{"text": "12", "x1": 101.0, "y1": 202.0, "x2": 105.0, "y2": 208.0}]

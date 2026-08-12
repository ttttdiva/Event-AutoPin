from __future__ import annotations

import argparse
import sys
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
    assert "tile boom" in diagnostics[0]["error"]
    assert merged[0]["text"] == "12"
    assert merged[0]["x1"] == 110


def test_runner_numeric_success_accepts_explicit_prefix_number_formats_only():
    assert runner._contains_numeric_text("企業 - 01") is True
    assert runner._contains_numeric_text("A 01") is True
    assert runner._contains_numeric_text("A-01") is True
    assert runner._contains_numeric_text("C-01") is True
    assert runner._contains_numeric_text("A12") is False

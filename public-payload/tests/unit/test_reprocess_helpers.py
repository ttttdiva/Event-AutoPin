from __future__ import annotations

import math

from src.utils.reprocess_helpers import (
    append_unique_line,
    has_http_line,
    is_blank,
    starts_with_http,
    valid_index,
)


def test_is_blank_handles_none_nan_and_empty_string():
    assert is_blank(None)
    assert is_blank(math.nan)
    assert is_blank("  ")
    assert not is_blank("0")


def test_http_helpers_trim_values_and_lines():
    assert starts_with_http(" https://example.com ")
    assert has_http_line("メモ\nhttps://example.com/post\n補足")
    assert not has_http_line("メモだけ")


def test_append_unique_line_skips_duplicates():
    text = append_unique_line(
        "既存\nhttps://example.com/post",
        "https://example.com/post",
    )
    assert text == "既存\nhttps://example.com/post"
    assert append_unique_line(text, "https://example.com/next").endswith(
        "https://example.com/next"
    )


def test_valid_index_accepts_only_sequence_indexes():
    assert valid_index(0, 1)
    assert not valid_index(True, 1)
    assert not valid_index(-1, 1)
    assert not valid_index(1, 1)
    assert not valid_index("0", 1)

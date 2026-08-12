"""src.utils.date_utils のテスト。"""

from __future__ import annotations

import pytest

from src.utils.date_utils import format_event_date_jp


class TestFormatEventDateJp:
    def test_日曜日の日付を正しく整形する(self):
        # 2026-03-29 は日曜日
        result = format_event_date_jp("2026-03-29")
        assert result == "開催日は2026年3月29日(日)です。"

    def test_月曜日の日付を正しく整形する(self):
        # 2026-03-30 は月曜日
        result = format_event_date_jp("2026-03-30")
        assert result == "開催日は2026年3月30日(月)です。"

    def test_前後の空白を許容する(self):
        assert (
            format_event_date_jp("  2026-01-01  ") == "開催日は2026年1月1日(木)です。"
        )

    def test_Noneを渡すとNoneを返す(self):
        assert format_event_date_jp(None) is None

    def test_空文字列を渡すとNoneを返す(self):
        assert format_event_date_jp("") is None

    def test_不正な形式はNoneを返す(self):
        assert format_event_date_jp("2026/03/29") is None
        assert format_event_date_jp("March 29") is None
        assert format_event_date_jp("2026-13-01") is None  # 月が不正

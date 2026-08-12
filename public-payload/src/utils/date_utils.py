"""日付関連のユーティリティ"""

from datetime import datetime
from typing import Optional


_JP_WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]


def format_event_date_jp(date_str: Optional[str]) -> Optional[str]:
    """YYYY-MM-DD 文字列を日本語の開催日テキストに変換する。

    Args:
        date_str: "2026-03-29" 形式の日付文字列

    Returns:
        "開催日は2026年3月29日(日)です。" のような文字列。
        date_str が None/空/パース不能の場合は None。
    """
    if not date_str:
        return None
    try:
        dt = datetime.strptime(date_str.strip(), "%Y-%m-%d")
    except (ValueError, AttributeError):
        return None
    dow = _JP_WEEKDAYS[dt.weekday()]
    return f"開催日は{dt.year}年{dt.month}月{dt.day}日({dow})です。"

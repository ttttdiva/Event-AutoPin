"""再処理系ユーティリティの共通ヘルパー。"""

from __future__ import annotations

from collections import Counter
from numbers import Integral
from typing import Any, Iterable, Mapping


REASON_NO_CATALOG = "おしながき未取得"
REASON_PREVIEW_ONLY = "おしながき予告のみ"


def is_blank(value: Any) -> bool:
    """None / NaN / 空文字を空値として扱う。"""
    if value is None:
        return True

    try:
        if value != value:
            return True
    except Exception:
        pass

    return str(value).strip() == ""


def text_value(value: Any) -> str:
    """空値を空文字に寄せ、それ以外はtrim済み文字列にする。"""
    if is_blank(value):
        return ""
    return str(value).strip()


def starts_with_http(value: Any) -> bool:
    """値がHTTP(S) URLらしい文字列で始まるかを返す。"""
    return text_value(value).startswith(("http://", "https://"))


def has_http_line(value: Any) -> bool:
    """複数行テキスト内にHTTP(S) URLで始まる行があるかを返す。"""
    text = text_value(value)
    if not text:
        return False
    return any(starts_with_http(line) for line in text.splitlines())


def append_unique_line(existing: Any, line: Any) -> str:
    """既存テキスト末尾に行を追加する。既に同じ行があれば重複させない。"""
    new_line = text_value(line)
    current = text_value(existing)
    if not new_line:
        return current

    lines = [entry.strip() for entry in current.splitlines() if entry.strip()]
    if new_line in lines:
        return current
    if not current:
        return new_line
    return f"{current}\n{new_line}"


def valid_index(index: Any, size: int) -> bool:
    """シーケンスに対して安全に参照できる整数インデックスかを返す。"""
    return (
        isinstance(index, Integral)
        and not isinstance(index, bool)
        and 0 <= index < size
    )


def reason_counts(items: Iterable[Mapping[str, Any]]) -> Counter[str]:
    """再処理対象リストからreason別件数を数える。"""
    return Counter(text_value(item.get("reason")) for item in items)

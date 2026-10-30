"""サークルカットの採用元（出自）と優先順位。

優先順位: manual > site_cut（画像認識で確認した公式カット） >
default_cut（マスターの標準カット） > oshinagaki_substitute（おしながきでの代用）。
代用は本来のカットが見つからないときだけに使い、本物のカットが取得できたら置き換える。
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlsplit, urlunsplit

KIND_MANUAL = "manual"
KIND_SITE_CUT = "site_cut"
KIND_DEFAULT_CUT = "default_cut"
KIND_SUBSTITUTE = "oshinagaki_substitute"

_RANK = {
    KIND_MANUAL: 4,
    KIND_SITE_CUT: 3,
    KIND_DEFAULT_CUT: 2,
    KIND_SUBSTITUTE: 1,
}


def strip_url_query(url: Optional[str]) -> str:
    """署名付きURLの認証情報を残さず、取得元だけを追跡できる形にする。"""
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def make_origin(kind: str, **details: Any) -> Dict[str, Any]:
    origin: Dict[str, Any] = {"kind": kind}
    for key, value in details.items():
        if value not in (None, ""):
            origin[key] = value
    return origin


def origin_kind(circle: Mapping[str, Any]) -> Optional[str]:
    origin = circle.get("circle_cut_origin")
    if isinstance(origin, Mapping):
        return str(origin.get("kind") or "") or None
    return None


def is_substitute(circle: Mapping[str, Any]) -> bool:
    return origin_kind(circle) == KIND_SUBSTITUTE


def may_replace(existing_kind: Optional[str], new_kind: str) -> bool:
    """既存のカットを新しい採用元で置き換えてよいか。手動と同格以上は保持する。"""
    if existing_kind is None:
        return True
    if existing_kind == KIND_MANUAL:
        return False
    return _RANK.get(new_kind, 0) > _RANK.get(existing_kind, 0)

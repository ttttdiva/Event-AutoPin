"""event.json metadata.x_account_status の統合。

Grok再探索などで分かったXアカウントの状態(凍結・存在なし・未公開・取得失敗など)を、
実行をまたいで引き継ぐ。お品書きが取得できたサークルの古い状態は残さない。
"""

from typing import Any, Dict, Iterable, Optional


def _has_catalog(circle: Dict[str, Any]) -> bool:
    status = circle.get("catalog_status")
    return bool(status) and status != "none"


def merge_x_account_status(
    existing: Optional[Dict[str, Any]],
    new: Optional[Dict[str, Any]],
    circles: Iterable[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """既存の状態に今回の状態を重ねる。サークルがお品書き取得済みなら既存分は捨てる。"""
    has_catalog_by_name: Dict[str, bool] = {}
    for circle in circles or []:
        if isinstance(circle, dict) and circle.get("name"):
            name = str(circle["name"]).strip()
            has_catalog_by_name[name] = has_catalog_by_name.get(name, False) or _has_catalog(circle)
    merged: Dict[str, Dict[str, Any]] = {}
    for key, value in (existing or {}).items():
        base_name = str(key).split(" (", 1)[0].strip()
        if isinstance(value, dict) and not has_catalog_by_name.get(base_name, False):
            merged[str(key)] = value
    for key, value in (new or {}).items():
        if isinstance(value, dict):
            merged[str(key)] = value
    return merged

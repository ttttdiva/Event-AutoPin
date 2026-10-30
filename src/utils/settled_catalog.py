"""フル実行のやり直しで、取り込み済み（確定済み）のおしながきを保持する。

event.json が既にあるイベントをもう一度フル実行しても、おしながきが確定済みの
サークルは X の再取得・画像解析・上書きをしない。未取得・予告のみ・要再確認の
サークルだけが再処理の対象になる（判定は再処理モードと同じ JSONReprocessor）。
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..models.circle import ItemImage
from .json_reprocessor import TERMINAL_NO_ITEM_CATALOG_STATUSES
from .reprocess_helpers import text_value

# Circle.to_dict() / event.json にあるおしながき由来のフィールド
_MEMO_SEP = "\n"


def _top_level_name(reference: str) -> str:
    parts = [p for p in Path(reference.replace("\\", "/")).parts if p not in ("/", ".")]
    return parts[0] if parts else ""


def _is_settled(circle: Dict[str, Any]) -> bool:
    """おしながきが確定済み（品目あり）か、これ以上品目が取れないと確定したサークル。

    予告のみ（preview）・要再確認（needs_recheck）・未取得は含めない。
    """
    if not isinstance(circle, dict) or not circle.get("name"):
        return False
    status = circle.get("catalog_status")
    if status in ("preview", "needs_recheck"):
        return False
    if status in TERMINAL_NO_ITEM_CATALOG_STATUSES:
        return True
    return any(
        isinstance(item, dict) and (text_value(item.get("type", "")) or text_value(item.get("name", "")))
        for item in circle.get("items") or []
    )


class SettledCatalog:
    def __init__(self, circles: Optional[List[Dict[str, Any]]] = None):
        self.by_key: Dict[tuple, Dict[str, Any]] = {}
        self.by_name: Dict[str, List[Dict[str, Any]]] = {}
        for circle in circles or []:
            self.by_key[self._key(circle)] = circle
            self.by_name.setdefault(str(circle.get("name") or "").strip(), []).append(circle)

    @staticmethod
    def _key(circle: Any) -> tuple:
        get = circle.get if isinstance(circle, dict) else lambda k: getattr(circle, k, None)
        return (str(get("space") or "").strip(), str(get("name") or "").strip())

    def __len__(self) -> int:
        return len(self.by_key)

    def match(self, circle: Any) -> Optional[Dict[str, Any]]:
        old = self.by_key.get(self._key(circle))
        if old is None:
            same = self.by_name.get(self._key(circle)[1], [])
            old = same[0] if len(same) == 1 else None
        return old

    def protected_names(self) -> set:
        names = set()
        for circle in self.by_key.values():
            for image in circle.get("item_images") or []:
                path = image.get("path") if isinstance(image, dict) else None
                if isinstance(path, str) and path.strip():
                    names.add(_top_level_name(path.strip()))
        names.discard("")
        return names

    def apply(self, circles: List[Any]) -> int:
        """新しく作ったサークルへ、確定済みのおしながきを戻して X 処理の対象外にする。"""
        applied = 0
        for circle in circles:
            old = self.match(circle)
            if old is None:
                continue
            circle.items = list(old.get("items") or [])
            circle.item_images = [
                ItemImage(path=img["path"], source=img.get("source", "unknown"))
                for img in old.get("item_images") or []
                if isinstance(img, dict) and img.get("path")
            ]
            circle.catalog_status = old.get("catalog_status")
            circle.existing_only_status = old.get("existing_only_status")
            old_memo = [ln for ln in str(old.get("memo") or "").split(_MEMO_SEP) if ln]
            new_memo = [ln for ln in str(getattr(circle, "memo", "") or "").split(_MEMO_SEP) if ln]
            circle.memo = _MEMO_SEP.join(old_memo + [ln for ln in new_memo if ln not in old_memo])
            if old.get("genres") and not getattr(circle, "genres", None):
                circle.genres = list(old["genres"])
            for tag in old.get("tags") or []:
                if tag not in circle.tags:
                    circle.tags.append(tag)
            circle._catalog_settled = True
            applied += 1
        return applied


def load_settled_catalog(output_dir: Path) -> SettledCatalog:
    event_json = Path(output_dir) / "event.json"
    if not event_json.exists():
        return SettledCatalog()
    try:
        existing = json.loads(event_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return SettledCatalog()
    circles = [c for c in (existing.get("circles") or []) if _is_settled(c)]
    return SettledCatalog(circles)

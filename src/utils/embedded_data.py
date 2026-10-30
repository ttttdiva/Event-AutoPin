"""HTMLに埋め込まれた構造化データ（Astro island等）の復元。

一覧が表のHTMLではなくJSON propsとして埋め込まれたサイトでは、見える
HTMLだけを読むと一部しか認識できない。ここでは埋め込みJSONを復元し、
レコード配列（サークル一覧など）を全件取り出す。
"""

from __future__ import annotations

import html as html_lib
import json
import re
from typing import Any, Dict, List, Optional

_ISLAND_PROPS_RE = re.compile(r"<astro-island\b[^>]*?\sprops=\"([^\"]*)\"", re.S)
_SCRIPT_JSON_RE = re.compile(
    r"<script\b[^>]*\btype=\"(?:application/json|application/ld\+json)\"[^>]*>(.*?)</script>",
    re.S | re.I,
)
_NEXT_DATA_RE = re.compile(
    r"<script\b[^>]*\bid=\"__NEXT_DATA__\"[^>]*>(.*?)</script>", re.S | re.I
)


def decode_astro_value(value: Any) -> Any:
    """Astro islandのprops符号化 `[type, payload]` を通常のJSON値へ戻す。"""

    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], int):
        kind, payload = value
        if kind == 0:
            if isinstance(payload, dict):
                return {key: decode_astro_value(item) for key, item in payload.items()}
            return payload
        if kind == 1 and isinstance(payload, list):
            return [decode_astro_value(item) for item in payload]
        return payload
    return value


def extract_embedded_payloads(html: str) -> List[Any]:
    """HTML内の埋め込みJSONをすべて復元して返す（出現順）。"""

    payloads: List[Any] = []
    for match in _ISLAND_PROPS_RE.finditer(html or ""):
        try:
            raw = json.loads(html_lib.unescape(match.group(1)))
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(raw, dict):
            payloads.append({key: decode_astro_value(item) for key, item in raw.items()})
    for pattern in (_NEXT_DATA_RE, _SCRIPT_JSON_RE):
        for match in pattern.finditer(html or ""):
            try:
                payloads.append(json.loads(match.group(1)))
            except (json.JSONDecodeError, ValueError):
                continue
    return payloads


def find_record_lists(
    payload: Any,
    *,
    min_records: int = 2,
    max_depth: int = 6,
) -> List[List[Dict[str, Any]]]:
    """JSON内のdict配列（同じ種類のレコードが並ぶもの）を探す。"""

    found: List[List[Dict[str, Any]]] = []

    def walk(node: Any, depth: int) -> None:
        if depth > max_depth:
            return
        if isinstance(node, list):
            records = [item for item in node if isinstance(item, dict)]
            if len(records) >= min_records and len(records) >= len(node) * 0.9:
                found.append(records)
                return
            for item in node:
                walk(item, depth + 1)
        elif isinstance(node, dict):
            for item in node.values():
                walk(item, depth + 1)

    walk(payload, 0)
    return found


def find_largest_record_list(
    html: str,
    required_keys: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """埋め込みJSONから、必要キーを持つ最大のレコード配列を返す。無ければ空。"""

    best: List[Dict[str, Any]] = []
    for payload in extract_embedded_payloads(html):
        for records in find_record_lists(payload):
            if required_keys and not all(
                key in records[0] for key in required_keys
            ):
                continue
            if len(records) > len(best):
                best = records
    return best

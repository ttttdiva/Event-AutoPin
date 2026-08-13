"""リポジトリ内 event.json の実マップと既存 pin_x/pin_y から評価GTを作る。

これは手動ラベルの代替ではなく、過去に人手確認済みの event.json 座標を
同じ画像へ投影する再現可能な評価用データ生成器である。pinは番号の輪郭
boxではなくサークル中心を表すため、出力は ``center_x/center_y`` の
pin-center GTとし、IoU評価には使わない。座標がないサークルは推測で補完
せず除外し、出力に除外数を記録する。
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image


NUMBER_RE = re.compile(r"(?<!\d)(\d{1,2})(?!\d)")


def _space_numbers(value: Any) -> list[str]:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return [f"{int(match):02d}" for match in NUMBER_RE.findall(text) if 1 <= int(match) <= 99]


def _space_prefix(value: Any) -> str | None:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    first_number = re.search(r"\d", text)
    if first_number is None:
        return None
    prefix = text[: first_number.start()].rstrip(" -‐‑‒–—−ー－").strip()
    return prefix or None


def build_for_event(event_dir: Path, *, box_size: int = 24) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    event_dir = event_dir.resolve()
    event_path = event_dir / "event.json"
    data = json.loads(event_path.read_text(encoding="utf-8-sig"))
    circles = data.get("circles") or []
    maps = data.get("event", {}).get("maps") or []
    images: list[dict[str, Any]] = []
    skipped = 0
    for map_entry in maps:
        filename = str(map_entry.get("filename") or "")
        if not filename:
            continue
        image_path = event_dir / filename
        if not image_path.exists():
            skipped += 1
            continue
        with Image.open(image_path) as image:
            width, height = image.size
        map_number = map_entry.get("map_number")
        points: list[dict[str, Any]] = []
        for circle_index, circle in enumerate(circles):
            if not isinstance(circle, dict):
                continue
            circle_map_number = circle.get("map_number")
            # 複数マップでmap_numberが無いサークルを全画像へ複製しない。
            # 所属を推測せず、GTから除外して件数をsummaryへ残す。
            if len(maps) > 1 and circle_map_number is None:
                skipped += 1
                continue
            if map_number is not None and circle_map_number not in (None, map_number):
                continue
            try:
                pin_x = float(circle["pin_x"])
                pin_y = float(circle["pin_y"])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            if not (0 <= pin_x <= 1 and 0 <= pin_y <= 1):
                skipped += 1
                continue
            numbers = _space_numbers(circle.get("space"))
            prefix = _space_prefix(circle.get("space")) or ""
            if not numbers:
                skipped += 1
                continue
            cx, cy = pin_x * width, pin_y * height
            group_identity = f"map:{map_number if map_number is not None else 1}:circle:{circle_index}"
            merged = len(numbers) > 1
            for number in numbers:
                points.append(
                    {
                        "space_id": f"{prefix}{number}",
                        "prefix": prefix,
                        "number": number,
                        "group_identity": group_identity,
                        "merged": merged,
                        "missing_slot": bool(circle.get("missing_slot", False)),
                        "raw_space": str(circle.get("space") or ""),
                        "center_x": round(cx, 3),
                        "center_y": round(cy, 3),
                        "normalized_x": round(pin_x, 8),
                        "normalized_y": round(pin_y, 8),
                    }
                )
        try:
            image_ref = str(image_path.relative_to(Path.cwd()))
        except ValueError:
            image_ref = str(image_path)
        image_entry = {"image": image_ref, "points": points, "width": width, "height": height}
        if map_entry.get("ocr_text") is not None:
            image_entry["ocr_text"] = str(map_entry.get("ocr_text"))
        images.append(image_entry)
    try:
        event_ref = str(event_dir.relative_to(Path.cwd()))
    except ValueError:
        event_ref = str(event_dir)
    return images, {"event_dir": event_ref, "map_count": len(images), "point_count": sum(len(x["points"]) for x in images), "skipped": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description="event.jsonの実マップ座標からUnlimited OCR評価GTを生成")
    parser.add_argument("--event-dir", action="append", required=True, help="イベントディレクトリ（複数可）")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--box-size", type=int, default=24, help="旧CLI互換（pin-centerでは未使用）")
    args = parser.parse_args()
    images: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    for raw_dir in args.event_dir:
        entries, summary = build_for_event(Path(raw_dir), box_size=max(4, args.box_size))
        images.extend(entries)
        summaries.append(summary)
    output = {
        "schema_version": 3,
        "coordinate_metric": "pin_center",
        "iou_applicable": False,
        "source": "repo event.json pin_x/pin_y",
        "images": images,
        "events": summaries,
    }
    path = Path(args.output_json)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(path), "events": summaries}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

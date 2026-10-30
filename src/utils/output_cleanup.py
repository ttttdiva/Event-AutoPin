"""出力ディレクトリの再生成時に保持するファイル判定。"""

import json
from pathlib import Path


def _top_level_name(reference: str) -> str:
    """出力ディレクトリ直下の名前（`event_image/event_image.jpg` なら `event_image`）。"""
    parts = [part for part in Path(reference.replace("\\", "/")).parts if part not in ("/", ".")]
    return parts[0] if parts else ""


def protected_output_entry_names(output_dir: Path) -> set[str]:
    protected = {"logs", "event.json"}
    event_json = output_dir / "event.json"
    if event_json.exists():
        try:
            with open(event_json, "r", encoding="utf-8") as f:
                existing = json.load(f)
            event_image = existing.get("event", {}).get("event_image")
            if isinstance(event_image, str) and event_image.strip():
                # サブフォルダ内の画像なら、そのフォルダごと保持する
                protected.add(_top_level_name(event_image.strip()))
            # 手動で選んだサークルカットのファイルも再生成で消さない
            for circle in existing.get("circles") or []:
                origin = circle.get("circle_cut_origin") if isinstance(circle, dict) else None
                filename = circle.get("circle_cut_filename") if isinstance(circle, dict) else None
                if (
                    isinstance(origin, dict)
                    and origin.get("kind") == "manual"
                    and isinstance(filename, str)
                    and filename.strip()
                ):
                    protected.add(_top_level_name(filename.strip()))
        except (OSError, json.JSONDecodeError):
            pass

    for image_path in output_dir.glob("event_image*"):
        if image_path.is_file() or image_path.is_dir():
            protected.add(image_path.name)

    return protected

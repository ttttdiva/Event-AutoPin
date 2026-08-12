"""出力ディレクトリの再生成時に保持するファイル判定。"""

import json
from pathlib import Path


def protected_output_entry_names(output_dir: Path) -> set[str]:
    protected = {"logs", "event.json"}
    event_json = output_dir / "event.json"
    if event_json.exists():
        try:
            with open(event_json, "r", encoding="utf-8") as f:
                existing = json.load(f)
            event_image = existing.get("event", {}).get("event_image")
            if isinstance(event_image, str) and event_image.strip():
                protected.add(Path(event_image).name)
        except (OSError, json.JSONDecodeError):
            pass

    for image_path in output_dir.glob("event_image.*"):
        if image_path.is_file():
            protected.add(image_path.name)

    return protected

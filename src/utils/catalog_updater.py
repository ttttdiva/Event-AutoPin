"""
event.json におしながき抽出結果を反映するユーティリティ。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from ..utils.logger import setup_logger


logger = setup_logger(__name__)


class CatalogUpdater:
    """event.json の circles 配列を直接更新する。"""

    def __init__(self, event_file: str, catalog_column: str = "catalog_status"):
        self.event_file = Path(event_file)
        self.catalog_column = catalog_column

        if not self.event_file.exists():
            raise FileNotFoundError(f"File not found: {event_file}")

        with open(self.event_file, "r", encoding="utf-8") as f:
            self.data: Dict[str, Any] = json.load(f)

        circles = self.data.get("circles", [])
        if not isinstance(circles, list):
            raise ValueError("event.json の circles が配列ではありません")
        self.circles = circles

    def add_twitter_url_column(self) -> bool:
        """旧列追加APIの名残。event.json では列追加は不要。"""
        return False

    def update_catalog(self, circle_name: str, catalog_info: Dict[str, Any]) -> bool:
        circle = self._find_circle(circle_name)
        if circle is None:
            logger.warning(f"Circle not found: {circle_name}")
            return False

        twitter_url = catalog_info.get("twitter_url")
        if twitter_url and not circle.get("twitter_url"):
            circle["twitter_url"] = twitter_url

        status = catalog_info.get("status")
        if status:
            circle[self.catalog_column] = status

        if catalog_info.get("error"):
            circle["catalog_error"] = str(catalog_info["error"])

        latest_catalog = self._latest_catalog(catalog_info)
        if latest_catalog:
            url = latest_catalog.get("url")
            if url:
                circle["memo"] = self._append_unique_line(circle.get("memo", ""), str(url))

            image_path = latest_catalog.get("image_path")
            if image_path:
                circle.setdefault("item_images", [])
                if not any(img.get("path") == image_path for img in circle["item_images"]):
                    circle["item_images"].append({"path": image_path, "source": "twitter"})

        items = catalog_info.get("items")
        if isinstance(items, list) and items:
            circle["items"] = items

        logger.info(f"Updated catalog info for: {circle_name}")
        return True

    def update_from_results(self, results: Dict[str, Any]) -> int:
        updated_count = 0
        for circle_name, catalog_info in results.items():
            if self.update_catalog(circle_name, catalog_info):
                updated_count += 1
        logger.info(f"Updated {updated_count} circles")
        return updated_count

    def save(self, output_path: Optional[str] = None) -> str:
        save_path = Path(output_path) if output_path else self.event_file
        if not output_path:
            backup_path = self.event_file.with_suffix(".bak")
            backup_path.write_text(
                self.event_file.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            logger.info(f"Created backup: {backup_path}")

        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved updated event.json: {save_path}")
        return str(save_path)

    def _find_circle(self, circle_name: str) -> Optional[Dict[str, Any]]:
        for circle in self.circles:
            if isinstance(circle, dict) and circle.get("name") == circle_name:
                return circle
        return None

    @staticmethod
    def _latest_catalog(catalog_info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        catalogs = catalog_info.get("catalogs")
        if isinstance(catalogs, list) and catalogs:
            first = catalogs[0]
            return first if isinstance(first, dict) else None
        return None

    @staticmethod
    def _append_unique_line(current: str, line: str) -> str:
        line = line.strip()
        if not line:
            return current or ""
        lines = [part.strip() for part in (current or "").splitlines() if part.strip()]
        if line not in lines:
            lines.append(line)
        return "\n".join(lines)

"""
過去イベントデータからURL情報を補完するモジュール
"""

import json
from pathlib import Path
from typing import Dict, List, Optional
import logging

from ..utils.logger import setup_logger
from ..utils.url_validation import normalize_twitter_profile_url

logger = setup_logger(__name__)


class PastEventEnricher:
    """過去イベントのevent.jsonからURL情報を抽出して補完する"""

    def __init__(self, events_dir: str = "events"):
        """
        Args:
            events_dir: イベントデータのルートディレクトリ
        """
        project_root = Path(__file__).resolve().parent.parent.parent
        events_path = Path(events_dir)
        self.events_dir = events_path if events_path.is_absolute() else project_root / events_path

    def _load_past_circles(self) -> Dict[str, Dict]:
        """
        全過去イベントからサークル名→URL情報のマッピングを構築

        Returns:
            {サークル名: {twitter_url, website_url, pixiv_url, genres}} の辞書
        """
        circle_map: Dict[str, Dict] = {}

        if not self.events_dir.exists():
            logger.warning(f"イベントディレクトリが見つかりません: {self.events_dir}")
            return circle_map

        for event_dir in sorted(self.events_dir.iterdir()):
            if not event_dir.is_dir():
                continue
            event_json = event_dir / "event.json"
            if not event_json.exists():
                continue

            try:
                with open(event_json, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for circle in data.get("circles", []):
                    name = circle.get("name", "").strip()
                    if not name:
                        continue

                    # URL情報を蓄積（新しいイベントのデータで上書き）
                    urls = {}
                    twitter_url = normalize_twitter_profile_url(circle.get("twitter_url"))
                    if twitter_url:
                        urls["twitter_url"] = twitter_url
                    elif circle.get("twitter_url"):
                        logger.warning(
                            "不正なX/Twitter URLを過去イベント補完候補から除外: "
                            f"{name} -> {circle.get('twitter_url')}"
                        )
                    if circle.get("website_url"):
                        urls["website_url"] = circle["website_url"]
                    if circle.get("pixiv_url"):
                        urls["pixiv_url"] = circle["pixiv_url"]
                    if circle.get("genres"):
                        urls["genres"] = circle["genres"]

                    if urls:
                        if name in circle_map:
                            circle_map[name].update(urls)
                        else:
                            circle_map[name] = urls

            except Exception as e:
                logger.debug(f"過去イベント読み込みスキップ: {event_dir.name} ({e})")

        logger.info(f"過去イベントから{len(circle_map)}サークルのURL情報を取得")
        return circle_map

    def enrich_circles(self, circles: List[Dict], current_event_dir: Optional[str] = None) -> int:
        """
        URL情報が欠けているサークルに過去イベントのデータを補完する

        Args:
            circles: サークルデータのリスト（直接変更される）
            current_event_dir: 現在のイベントディレクトリ名（除外用）

        Returns:
            補完されたサークル数
        """
        past_circles = self._load_past_circles()
        if not past_circles:
            return 0

        enriched_count = 0
        for circle in circles:
            name = circle.get("name", "").strip()
            if not name or name not in past_circles:
                continue

            past = past_circles[name]
            current_twitter = circle.get("twitter_url")
            normalized_current_twitter = normalize_twitter_profile_url(current_twitter)
            if normalized_current_twitter:
                circle["twitter_url"] = normalized_current_twitter
            elif current_twitter:
                logger.warning(
                    f"不正な現在X/Twitter URLを除外: {name} -> {current_twitter}"
                )
                circle.pop("twitter_url", None)
            has_any_url = (
                circle.get("twitter_url")
                or circle.get("website_url")
                or circle.get("pixiv_url")
            )

            # URLが一切無い場合のみ補完
            if not has_any_url:
                updated = False
                for key in ["twitter_url", "website_url", "pixiv_url"]:
                    if past.get(key) and not circle.get(key):
                        circle[key] = past[key]
                        updated = True

                # ジャンル情報も補完
                if past.get("genres") and not circle.get("genres"):
                    circle["genres"] = past["genres"]

                if updated:
                    enriched_count += 1
                    logger.info(f"過去イベントからURL補完: {name}")

        return enriched_count

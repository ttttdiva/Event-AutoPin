"""
Picrea (picrea.jp) 専用アダプター

React SPAのためHTMLパースではなくAPI直接呼び出しでデータ取得。
Cookie認証が必要。
"""

import re
import logging
from typing import List, Optional, Tuple
from bs4 import BeautifulSoup

import requests

from ..core import BaseSiteAdapter
from ..models import Circle, Event

logger = logging.getLogger(__name__)


class PicreaAdapter(BaseSiteAdapter):
    """Picrea (picrea.jp) 専用アダプター"""

    def __init__(self, config, session: Optional[requests.Session] = None):
        super().__init__(config)
        self.session = session or requests.Session()
        self._api_data = None  # キャッシュ

    def can_handle(self, url: str) -> bool:
        return "picrea.jp" in url.lower()

    def _get_event_key(self) -> str:
        """URLからevent_keyを抽出"""
        match = re.search(r"/event/([a-f0-9]+)", self.config.base_url)
        if match:
            return match.group(1)
        raise ValueError(
            f"Picreaのevent_keyをURLから抽出できません: {self.config.base_url}"
        )

    def _fetch_api_data(self) -> dict:
        """Picrea APIからサークルデータを取得（キャッシュ付き）"""
        if self._api_data is not None:
            return self._api_data

        event_key = self._get_event_key()
        api_url = "https://api.picrea.jp/api/apply/circle_cut"
        payload = {"event_key": event_key, "paid": True}

        self.logger.info(
            f"Picrea API呼び出し: {api_url} (event_key={event_key[:16]}...)"
        )

        try:
            resp = self.session.post(api_url, json=payload, timeout=60)
            resp.raise_for_status()
        except requests.exceptions.HTTPError as e:
            if resp.status_code in (401, 403):
                raise ValueError(
                    f"Picrea APIが認証エラーを返しました (HTTP {resp.status_code})。\n"
                    "Cookieが必要な場合は cookies/picrea.jp_cookies.txt に配置してください。"
                ) from e
            raise
        data = resp.json()

        if "response" not in data:
            raise ValueError(f"Picrea APIレスポンスが不正です: {list(data.keys())}")

        self._api_data = data["response"]
        circle_count = len(self._api_data.get("list", []))
        self.logger.info(f"Picrea APIからデータ取得成功: {circle_count}サークル")
        return self._api_data

    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """APIレスポンスからイベント情報を抽出"""
        api_data = self._fetch_api_data()
        event_data = api_data.get("event", {})

        # catalog_additional_promptからイベント名を優先取得
        event_name = None
        if self.config.catalog_additional_prompt:
            match = re.search(
                r"イベント名は[「『](.+?)[」』]",
                self.config.catalog_additional_prompt,
            )
            if match:
                event_name = match.group(1)

        if not event_name:
            event_name = (
                event_data.get("title") or event_data.get("name") or "Picreaイベント"
            )

        event = Event(
            name=event_name,
            url=self.config.base_url,
            venue=event_data.get("venue"),
            organizer=event_data.get("organizer"),
        )

        # マップ情報
        maps_data = api_data.get("maps", [])
        if maps_data:
            self.logger.info(f"マップ情報: {len(maps_data)}件")

        event.maps = self.extract_event_maps(soup)
        return event

    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """APIレスポンスからサークル情報を抽出"""
        api_data = self._fetch_api_data()
        circle_list = api_data.get("list", [])

        circles = []
        for item in circle_list:
            circle = self._parse_circle(item)
            if circle and circle.name:
                circles.append(circle)

        self.logger.info(f"サークル抽出完了: {len(circles)}件")
        return circles

    def _parse_circle(self, item: dict) -> Optional[Circle]:
        """APIレスポンスの1サークル分をCircleモデルに変換"""
        name = item.get("name", "").strip()
        if not name:
            return None

        # ペンネーム
        pennames = item.get("pennames")
        penname = None
        if pennames:
            if isinstance(pennames, list):
                penname = ", ".join(str(p) for p in pennames if p)
            elif isinstance(pennames, str):
                penname = pennames

        # スペース
        space = item.get("circle_space", "")

        # Twitter URL
        twitter_url = item.get("twitter_url", "")

        # 説明
        description = item.get("description") or item.get("circleDescription") or ""

        return Circle(
            name=name,
            penname=penname,
            space=str(space) if space else None,
            hall=item.get("map_name"),
            twitter_url=twitter_url if twitter_url else None,
            description=description if description else None,
        )

    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """サークルカット画像URLを抽出"""
        api_data = self._fetch_api_data()
        circle_list = api_data.get("list", [])

        images = []
        for i, item in enumerate(circle_list):
            cut_url = item.get("circle_cut", "")
            if cut_url and isinstance(cut_url, str) and cut_url.startswith("http"):
                images.append((i, cut_url))

        self.logger.info(f"サークルカット画像: {len(images)}件")
        return images

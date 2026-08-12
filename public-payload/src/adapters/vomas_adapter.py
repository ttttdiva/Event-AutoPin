"""
THE VOC@LOiD M@STER（ボーマス）サイト専用アダプター
ketto.xsrv.jp/html/mimiken/clist.cgiのページに対応
"""

import logging
import re
from typing import List, Dict, Any, Optional
from bs4 import BeautifulSoup, Tag
import requests

from ..core import BaseSiteAdapter
from ..models import Circle, Event, CircleImage, SiteConfig


class VomasAdapter(BaseSiteAdapter):
    """ボーマス（THE VOC@LOiD M@STER）専用アダプター"""

    def __init__(self, site_config: SiteConfig):
        super().__init__(site_config)
        self.logger = logging.getLogger("circle_list_generator.vomas_adapter")
        # User-Agent設定（ボット対策）
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }

    def can_handle(self, url: str) -> bool:
        """このアダプタがURLを処理できるか判定"""
        return 'ketto.xsrv.jp/html/mimiken' in url.lower()

    def fetch_page(self) -> str:
        """ページを取得（User-Agent対応）"""
        try:
            self.logger.info(f"ボーマスページを取得中: {self.config.base_url}")
            response = requests.get(
                self.config.base_url,
                headers=self.headers,
                timeout=self.config.timeout
            )
            response.encoding = response.apparent_encoding or 'CP932'  # ボーマスサイトはCP932

            if response.status_code != 200:
                raise Exception(f"HTTP Error: {response.status_code}")

            # ボット対策チェック
            if "ロボ避けページ" in response.text:
                raise Exception("ボット対策ページが表示されました。User-Agentの設定を確認してください。")

            return response.text

        except Exception as e:
            self.logger.error(f"ページ取得エラー: {e}")
            raise

    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """イベント情報を抽出"""
        event_info = Event(name="", url=self.config.base_url)

        # タイトルからイベント名を取得
        title_elem = soup.find('title')
        if title_elem:
            title_text = title_elem.get_text(strip=True)
            # "THE VOC＠LOiD M＠STER 61 サークル名順リスト " のような形式から抽出
            match = re.search(r'(THE VOC.*?M.*?STER\s*\d+)', title_text, re.IGNORECASE)
            if match:
                event_info.name = match.group(1)
            else:
                event_info.name = title_text.replace('サークル名順リスト', '').strip()

        # configからイベント日付を取得（event_date優先、なければadditional_promptから抽出）
        if getattr(self.config, 'event_date', None):
            event_info.date = self.config.event_date
        elif hasattr(self.config, 'catalog_additional_prompt'):
            prompt = self.config.catalog_additional_prompt
            date_match = re.search(r'(\d{4})[年/](\d{1,2})[月/](\d{1,2})[日]', prompt)
            if date_match:
                event_info.date = f"{date_match.group(1)}-{date_match.group(2).zfill(2)}-{date_match.group(3).zfill(2)}"

        self.logger.info(f"イベント情報: {event_info.name} ({event_info.date})")
        return event_info

    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """サークル情報を抽出"""
        circles = []

        # メインテーブルを探す
        tables = soup.find_all('table')
        if not tables:
            self.logger.warning("テーブルが見つかりません")
            return circles

        # 最も大きいテーブルがサークルリスト
        main_table = max(tables, key=lambda t: len(t.find_all('tr')))
        rows = main_table.find_all('tr')

        self.logger.info(f"テーブルの行数: {len(rows)}")

        # ヘッダー行をスキップ（最初の行）
        data_rows = rows[1:] if rows else []

        for row in data_rows:
            cols = row.find_all('td')
            if len(cols) >= 5:  # 必要な列数があることを確認
                try:
                    circle_info = self._extract_circle_from_row(cols)
                    if circle_info and circle_info.name:  # 名前がある場合のみ追加
                        circles.append(circle_info)
                except Exception as e:
                    self.logger.warning(f"行の処理エラー: {e}")
                    continue

        self.logger.info(f"抽出されたサークル数: {len(circles)}")
        return circles

    def _extract_circle_from_row(self, cols: List[Tag]) -> Optional[Circle]:
        """テーブル行からサークル情報を抽出"""
        try:
            # 列構造:
            # 0: 空（画像用）
            # 1: 頭文字
            # 2: サークル名（リンク付き）
            # 3: ペンネーム（SNSリンク付き）
            # 4: 配置（スペース番号）

            circle_info = Circle(name="")

            # サークル名（列3）
            if len(cols) > 2:
                name_cell = cols[2]
                circle_info.name = name_cell.get_text(strip=True)

                # サークルのWebサイトリンク
                circle_link = name_cell.find('a', href=True)
                if circle_link:
                    href = circle_link['href']
                    if not href.startswith('ken.cgi'):  # ken.cgiは内部リンクなので無視
                        if not href.startswith('http'):
                            href = f"https://{href}" if '//' not in href else f"https:{href}"
                        circle_info.website_url = href

            # ペンネーム（列4）
            if len(cols) > 3:
                penname_cell = cols[3]
                # テキストからペンネームを取得（複数の場合はカンマ区切り）
                penname_text = penname_cell.get_text(strip=True)
                circle_info.penname = penname_text

                # SNSリンクを取得
                links = penname_cell.find_all('a', href=True)
                for link in links:
                    href = link['href']
                    if 'x.com' in href or 'twitter.com' in href:
                        circle_info.twitter_url = href
                    elif 'nicovideo' in href and not circle_info.website_url:
                        # ニコニコ動画のリンクをWebサイトとして保存（Twitter優先）
                        circle_info.website_url = href

            # 配置（列5）
            if len(cols) > 4:
                space_text = cols[4].get_text(strip=True)
                circle_info.space = space_text

                # ホール情報を抽出（最初の文字がホール）
                if space_text:
                    # "B41.42" → hall="B", space="B41.42"
                    # "W01.02" → hall="W", space="W01.02"
                    match = re.match(r'^([A-Z])', space_text)
                    if match:
                        circle_info.hall = match.group(1)

            return circle_info

        except Exception as e:
            self.logger.warning(f"サークル情報の抽出エラー: {e}")
            return None

    def fetch_circle_images(self, circles: List[Circle]) -> Dict[str, CircleImage]:
        """サークル画像を取得（ボーマスは画像なし）"""
        return {}

    def fetch_circle_items(self, circles: List[Circle]) -> Dict[str, List]:
        """サークルアイテムを取得（ボーマスは個別ページなし）"""
        return {}

    def extract_circle_images(self, soup: BeautifulSoup) -> Dict[str, CircleImage]:
        """サークル画像を抽出（ボーマスは画像なし）"""
        return {}

    def supports_circle_images(self) -> bool:
        """サークル画像取得をサポートするか"""
        return False

    def supports_circle_items(self) -> bool:
        """サークルアイテム取得をサポートするか"""
        return False

    def preprocess_html(self, html_content: str) -> str:
        """HTML前処理（実際のページ取得を行う）"""
        # downloader経由で来たHTMLは使わず、独自のfetch_pageを使う
        return self.fetch_page()
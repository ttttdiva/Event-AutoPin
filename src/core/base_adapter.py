from abc import ABC, abstractmethod
from typing import List, Optional, Tuple, Dict, Any
from bs4 import BeautifulSoup
import logging

from ..models import Circle, Event, EventMap, SiteConfig


class BaseSiteAdapter(ABC):
    """サイト別データ抽出の基底クラス"""

    # テーブルヘッダーからフィールドへのマッピング
    _HEADER_MAPPING = {
        '配置': 'space_raw',
        '配置番号': 'space_raw',
        'スペース': 'space',
        'スペース番号': 'space',
        'サークル名': 'name',
        '企業名': 'name',
        'サークル／企業名': 'name',
        '団体名': 'name',
        'ペンネーム': 'penname',
        '作者': 'penname',
        '作家名': 'penname',
        'Web': 'website_url',
        'Website': 'website_url',
        'HP': 'website_url',
        'Twitter': 'twitter_url',
        'X': 'twitter_url',
        'Pixiv': 'pixiv_url',
        'ホール': 'hall',
        'ホール名': 'hall',
        'エリア': 'hall',
        'ジャンル': 'genre',
        '説明': 'description',
        '頒布物': 'description',
    }

    def __init__(self, config: SiteConfig):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)

    @abstractmethod
    def can_handle(self, url: str) -> bool:
        """このアダプタがURLを処理できるか判定"""
        pass

    @abstractmethod
    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """イベント情報を抽出"""
        pass

    @abstractmethod
    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """サークル情報を抽出"""
        pass

    @abstractmethod
    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """サークル画像URLを抽出
        Returns: List of (index, image_url) tuples
        """
        pass

    def extract_event_maps(self, soup: BeautifulSoup) -> List[EventMap]:
        """イベントマップ情報を抽出（オプション）"""
        maps = []
        for i, map_url in enumerate(self.config.map_urls):
            maps.append(EventMap(
                url=map_url,
                filename=f"map_{i+1:02d}.jpg",
                map_number=i+1
            ))
        return maps

    def preprocess_html(self, html: str) -> str:
        """HTML前処理（必要に応じてオーバーライド）"""
        return html

    def validate_extraction(self, circles: List[Circle]) -> List[str]:
        """抽出結果の検証"""
        errors = []

        if not circles:
            errors.append("サークルが1件も抽出されませんでした")

        for i, circle in enumerate(circles):
            circle_errors = circle.validate()
            for error in circle_errors:
                errors.append(f"サークル {i+1} ({circle.name}): {error}")

        return errors

    def try_direct_table_extraction(
        self,
        soup: BeautifulSoup,
        header_mappings: Optional[Dict[int, Dict[int, str]]] = None,
        require_exact_headers: bool = True,
    ) -> List[Circle]:
        """HTMLテーブルのヘッダーを検出し、直接パースを試みる

        明確なヘッダー（配置、サークル名等）を持つテーブルがある場合、
        LLMや学習パターンを使わずに正確に抽出できる。
        """
        all_circles = []

        for table_index, table in enumerate(soup.find_all('table')):
            rows = table.find_all('tr')
            if len(rows) < 2:
                continue

            # ヘッダーを解析
            header_row = rows[0]
            headers = [cell.get_text(strip=True) for cell in header_row.find_all(['th', 'td'])]

            # ヘッダーのフィールドマッピングを構築
            supplied_mapping = (header_mappings or {}).get(table_index)
            if supplied_mapping is not None:
                field_map = supplied_mapping
            else:
                field_map = {
                    i: self._HEADER_MAPPING[header]
                    for i, header in enumerate(headers)
                    if header in self._HEADER_MAPPING
                }
                if require_exact_headers and any(
                    header and i not in field_map for i, header in enumerate(headers)
                ):
                    self.logger.info(
                        f"未知のテーブルヘッダーを検出したため直接パースを見送ります: {headers}"
                    )
                    continue

            # 名前フィールドが見つからない、またはマッチが2未満ならスキップ
            if 'name' not in field_map.values() or len(field_map) < 2:
                continue

            self.logger.info(f"テーブル直接パース: ヘッダー={headers}, マッピング={field_map}")

            # データ行を処理
            for row in rows[1:]:
                cells = row.find_all(['td', 'th'])
                if len(cells) != len(headers):
                    continue

                circle_data: Dict[str, Any] = {}
                for i, cell in enumerate(cells):
                    if i not in field_map:
                        continue

                    field = field_map[i]
                    text = cell.get_text(strip=True)

                    # リンクフィールドはhrefを優先
                    if field in ('twitter_url', 'website_url', 'pixiv_url'):
                        link = cell.find('a', href=True)
                        if link:
                            circle_data[field] = link['href']
                        elif text and text.startswith('http'):
                            circle_data[field] = text
                    elif field == 'space_raw':
                        # "と-16" などはスペース番号そのもの。ホール列が明示されていない
                        # テーブルでは推定分割せず、そのままスペースとして保持する。
                        if text:
                            circle_data['space'] = text
                    else:
                        if text:
                            circle_data[field] = text

                # マッピングされなかったセルからもリンクを探す
                for i, cell in enumerate(cells):
                    if i in field_map:
                        continue
                    link = cell.find('a', href=True)
                    if link:
                        href = link['href']
                        if ('twitter.com' in href or 'x.com' in href) and 'twitter_url' not in circle_data:
                            circle_data['twitter_url'] = href
                        elif 'pixiv' in href and 'pixiv_url' not in circle_data:
                            circle_data['pixiv_url'] = href
                        elif href.startswith('http') and 'website_url' not in circle_data:
                            circle_data['website_url'] = href

                # サークル名が存在する場合のみ追加
                if circle_data.get('name'):
                    circle = Circle(
                        name=circle_data.get('name', ''),
                        penname=circle_data.get('penname'),
                        space=circle_data.get('space'),
                        hall=circle_data.get('hall'),
                        twitter_url=circle_data.get('twitter_url'),
                        website_url=circle_data.get('website_url'),
                        description=circle_data.get('description'),
                        genres=[circle_data['genre']] if circle_data.get('genre') else [],
                    )
                    all_circles.append(circle)

        return all_circles

    def has_candidate_circle_table(self, soup: BeautifulSoup) -> bool:
        """列名が未知でも、複数行・複数列の候補テーブルがあるかを返す。"""
        for table in soup.find_all("table"):
            rows = table.find_all("tr")
            if len(rows) < 2:
                continue
            if len(rows[0].find_all(["th", "td"])) >= 2:
                return True
        return False

    @staticmethod
    def _split_space_raw(raw: str) -> Tuple[str, str]:
        """スペース番号をホール推定で分割しない。ホールは明示列だけを使う。"""
        return '', raw

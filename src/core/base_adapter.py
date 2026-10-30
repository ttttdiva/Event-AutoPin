from abc import ABC, abstractmethod
from typing import List, Optional, Tuple, Dict, Any
from bs4 import BeautifulSoup
import logging
import re
from collections import Counter
from urllib.parse import urljoin, urlparse

from ..models import Circle, Event, EventMap, SiteConfig


# BOM・ゼロ幅文字（列名比較の邪魔になる）
_INVISIBLE_CHARS = {code: None for code in (0xFEFF, 0x200B, 0x200C, 0x200D, 0x2060)}


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
        '出展者名': 'name',
        '出展者': 'name',
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

    # サークル情報として読まない（けれど未知の列名ではない）列。画像列など
    _IGNORED_HEADERS = {
        'サークルカット', 'サークルカット画像', 'カット', '画像', 'サムネイル',
        'お品書き', 'おしながき', '頒布物画像', 'No', 'No.', '#', '番号',
    }

    # 行内の画像がSNS・外部リンクのアイコンであることを示すホスト
    _SNS_HOSTS = (
        "x.com", "twitter.com", "pixiv.net", "instagram.com", "youtube.com",
        "youtu.be", "facebook.com", "bsky.app", "misskey.io", "fanbox.cc",
        "booth.pm", "skeb.jp", "nicovideo.jp", "tiktok.com", "line.me",
    )
    _DECORATIVE_IMG_ALT = {
        "x", "twitter", "x(twitter)", "x (twitter)", "pixiv", "web", "website",
        "home", "link", "youtube", "instagram", "booth", "mail",
    }
    _DECORATIVE_IMG_NAME = re.compile(
        r"(?:^|[/_-])(?:icon|btn|button|sprite|noimage|no-image|blank|spacer)(?:[._-]|$)",
        re.I,
    )

    def __init__(self, config: SiteConfig):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        # 表の行ごとに見つけた画像（soup単位）。サークルと画像を行で対応付けるために使う
        self._row_images_by_soup: Dict[int, List[Tuple[int, str]]] = {}

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

    @staticmethod
    def _normalize_header(text: str) -> str:
        """BOMやゼロ幅文字が混じった列名を比較できる形に整える。"""
        cleaned = text.translate(_INVISIBLE_CHARS) if text else ''
        return re.sub(r'\s+', ' ', cleaned).strip()

    def builtin_header_mapping(self, headers: List[str]) -> Optional[Dict[int, str]]:
        """組み込みの列名だけで全列を説明できるときの対応表。できなければNone。

        未知の列名が1つでもあれば推測しない（LLM判定へ回す）。
        """
        field_map: Dict[int, str] = {}
        for index, raw in enumerate(headers):
            header = self._normalize_header(raw)
            if not header:
                continue
            if header in self._HEADER_MAPPING:
                field_map[index] = self._HEADER_MAPPING[header]
            elif header not in self._IGNORED_HEADERS:
                return None
        if 'name' not in field_map.values() or len(field_map) < 2:
            return None
        return field_map

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
        row_images: List[Tuple[int, List[str]]] = []

        for table_index, table in enumerate(soup.find_all('table')):
            rows = table.find_all('tr')
            if len(rows) < 2:
                continue

            # ヘッダーを解析
            header_row = rows[0]
            headers = [
                self._normalize_header(cell.get_text(strip=True))
                for cell in header_row.find_all(['th', 'td'])
            ]
            ignored_columns = {
                i for i, header in enumerate(headers) if header in self._IGNORED_HEADERS
            }

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
                    header and i not in field_map and i not in ignored_columns
                    for i, header in enumerate(headers)
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

                    # 共通のSNS列でも、列名ではなくリンク先でX/Webを判別する。
                    if field in ('twitter_url', 'website_url', 'pixiv_url'):
                        for key, url in self._extract_link_fields(cell).items():
                            circle_data.setdefault(key, url)
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
                    if i in field_map or i in ignored_columns:
                        continue
                    for key, url in self._extract_link_fields(cell).items():
                        circle_data.setdefault(key, url)

                # サークル名が存在する場合のみ追加
                if circle_data.get('name'):
                    circle = Circle(
                        name=circle_data.get('name', ''),
                        penname=circle_data.get('penname'),
                        space=circle_data.get('space'),
                        hall=circle_data.get('hall'),
                        twitter_url=circle_data.get('twitter_url'),
                        website_url=circle_data.get('website_url'),
                        pixiv_url=circle_data.get('pixiv_url'),
                        description=circle_data.get('description'),
                        genres=[circle_data['genre']] if circle_data.get('genre') else [],
                    )
                    row_images.append(
                        (len(all_circles), self._row_image_urls(row))
                    )
                    all_circles.append(circle)

        self._remember_row_images(soup, row_images)
        return all_circles

    def _row_image_urls(self, row) -> List[str]:
        """行の中にある、アイコン・SNSリンクではない画像URLを出現順に返す。"""
        urls: List[str] = []
        base_url = getattr(self.config, 'base_url', '') or ''
        for img in row.find_all('img'):
            anchor = img.find_parent('a', href=True)
            if anchor is not None:
                try:
                    host = (urlparse(anchor['href'].strip()).hostname or '').lower()
                except ValueError:
                    host = ''
                if any(host == h or host.endswith('.' + h) for h in self._SNS_HOSTS):
                    continue
            if (img.get('alt') or '').strip().lower() in self._DECORATIVE_IMG_ALT:
                continue
            classes = ' '.join(img.get('class') or []).lower()
            if re.search(r'(?:^|[\s_-])(?:icon|sns|emoji)(?:$|[\s_-])', classes):
                continue
            src = ''
            for attr in ('data-src', 'data-lazy-src', 'data-original', 'src'):
                value = (img.get(attr) or '').strip()
                if value and not value.startswith('data:'):
                    src = value
                    break
            if not src:
                continue
            try:
                if min(int(img.get('width') or 999), int(img.get('height') or 999)) < 50:
                    continue
            except ValueError:
                pass
            absolute = urljoin(base_url, src)
            path = urlparse(absolute).path.lower()
            if urlparse(absolute).scheme not in {'http', 'https'} or path.endswith('.svg'):
                continue
            if self._DECORATIVE_IMG_NAME.search(path):
                continue
            if absolute not in urls:
                urls.append(absolute)
        return urls

    def _remember_row_images(
        self, soup: BeautifulSoup, row_images: List[Tuple[int, List[str]]]
    ) -> None:
        """行とサークルの対応を保持する。多数の行に共通する画像（装飾・代替画像）は除く。"""
        counts = Counter(url for _, urls in row_images for url in set(urls))
        common_limit = max(3, int(len(row_images) * 0.3))
        pairs: List[Tuple[int, str]] = []
        for circle_index, urls in row_images:
            for url in urls:
                if counts[url] >= common_limit and len(row_images) >= 5:
                    continue
                pairs.append((circle_index, url))
        self._row_images_by_soup[id(soup)] = pairs

    def row_bound_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """表の行に対応付いたサークル画像（index = 直前に抽出したサークルの位置）。"""
        return list(self._row_images_by_soup.get(id(soup), []))

    @staticmethod
    def _extract_link_fields(element) -> Dict[str, str]:
        """同じ欄の全リンクを確認し、XとWebを別々に保持する。"""
        links = [link['href'].strip() for link in element.find_all('a', href=True)]
        if not links:
            links = element.get_text(' ', strip=True).split()

        fields: Dict[str, str] = {}
        for url in links:
            if url.startswith('//'):
                url = 'https:' + url
            try:
                parsed = urlparse(url)
                host = (parsed.hostname or '').lower()
            except ValueError:
                continue
            if parsed.scheme.lower() not in {'http', 'https'} or not host:
                continue
            if host in {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'}:
                field = 'twitter_url'
            elif host == 'pixiv.net' or host.endswith('.pixiv.net'):
                field = 'pixiv_url'
            else:
                field = 'website_url'
            fields.setdefault(field, url)
        return fields

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

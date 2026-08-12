import re
from typing import List, Tuple, Optional
from bs4 import BeautifulSoup

from ..core import BaseSiteAdapter
from ..models import Circle, Event, CircleImage


# スペース番号の候補を抽出する際に使用する正規表現
SPACE_INLINE_PATTERN = re.compile(
    r'(?:[A-Za-z]{1,2}|[ぁ-ん]{1,2})\s*-?\s*\d{1,3}(?:\s*-\s*\d{1,3})?[a-zA-Z]?'
    r'|\d{1,3}(?:\s*-\s*\d{1,3})?[a-zA-Z]?'
)
SPACE_TOKEN_PATTERN = re.compile(
    r'^(?:[A-Za-z]{1,2}|[ぁ-ん]{1,2})-?\d{1,3}(?:-\d{1,3})?[a-zA-Z]?$'
    r'|^\d{1,3}(?:-\d{1,3})?[a-zA-Z]?$',
    re.IGNORECASE
)


class SockbaseAdapter(BaseSiteAdapter):
    """Sockbase (list.sockbase.net) 用アダプター"""
    
    def can_handle(self, url: str) -> bool:
        """Sockbase のURLかどうか判定"""
        return 'sockbase.net' in url
    
    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """イベント情報を抽出"""
        event_name = self._extract_event_name(soup)
        
        # イベントマップURLを抽出
        maps = self.extract_event_maps(soup)
        
        return Event(
            name=event_name,
            url=self.config.base_url,
            maps=maps
        )
    
    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """サークル情報を抽出"""
        circles = []
        
        # テーブルベースの抽出を試みる
        tables = soup.find_all('table')
        if tables:
            circles = self._extract_from_tables(tables)
        
        # テーブルがない場合はdivベースの抽出
        if not circles:
            circles = self._extract_from_divs(soup)
        
        self.logger.info(f"抽出されたサークル数: {len(circles)}")
        return circles
    
    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """サークル画像URLを抽出"""
        image_urls: List[Tuple[int, str]] = []
        seen_urls = set()
        global_index = 0

        # Webカタログβセクションをすべて探索
        catalog_sections = self._find_web_catalog_sections(soup)

        for section in catalog_sections:
            images = section.find_all('img')
            for img in images:
                src = self._normalize_image_url(img.get('src', ''))
                if not src or src in seen_urls:
                    continue

                seen_urls.add(src)
                image_urls.append((global_index, src))
                global_index += 1

        self.logger.info(f"抽出された画像数: {len(image_urls)}")
        return image_urls
    
    def _extract_event_name(self, soup: BeautifulSoup) -> str:
        """イベント名を抽出"""
        # タイトルタグから
        title_tag = soup.find('title')
        if title_tag:
            title = title_tag.get_text(strip=True)
            # "サークルリスト" などを除去
            event_name = re.sub(r'(サークルリスト|Circle List|List|\s*-\s*.*)', '', title).strip()
            if event_name:
                return event_name
        
        # h1タグから
        h1 = soup.find('h1')
        if h1:
            text = h1.get_text(strip=True)
            if 'サークルリスト' not in text:
                return text
        
        # URLから推測
        url_parts = self.config.base_url.split('/')
        for part in reversed(url_parts):
            if part and part not in ['circle-lists', 'list']:
                event_name = re.sub(r'[-_]', ' ', part)
                event_name = re.sub(r'\d+', '', event_name).strip()
                if event_name:
                    return event_name
        
        return "イベント"
    
    def _extract_from_tables(self, tables: List) -> List[Circle]:
        """テーブルからサークル情報を抽出"""
        circles = []
        
        # 最大のテーブルを選択
        main_table = max(tables, key=lambda t: len(str(t)))
        
        # ヘッダー行を解析
        headers = []
        header_row = main_table.find('tr')
        if header_row:
            for th in header_row.find_all(['th', 'td']):
                headers.append(th.get_text(strip=True))
        
        # データ行を処理
        for tr in main_table.find_all('tr')[1:]:
            cells = tr.find_all(['td', 'th'])
            if not cells:
                continue
            
            circle = self._parse_table_row(cells, headers)
            if circle and circle.name:
                circles.append(circle)

        return circles
    
    def _extract_from_divs(self, soup: BeautifulSoup) -> List[Circle]:
        """divベースの構造からサークル情報を抽出"""
        circles = []
        
        # サークル要素を探す
        circle_divs = soup.find_all('div', class_=re.compile(r'circle', re.I))
        
        for div in circle_divs:
            circle = self._parse_div_element(div)
            if circle and circle.name:
                circles.append(circle)
        
        return circles
    
    def _parse_table_row(self, cells: List, headers: List) -> Optional[Circle]:
        """テーブル行をパース"""
        circle = Circle(name="")

        for i, cell in enumerate(cells):
            text = cell.get_text(" ", strip=True)
            # data-label属性を優先的に使用（Sockbaseの新しい構造）
            label = cell.get('data-label', '')
            if not label:
                label = headers[i] if i < len(headers) else ""

            # サークル名
            if 'サークル' in label or 'circle' in label.lower():
                if text and text != '-':
                    self._parse_circle_cell(circle, cell, text)

            # スペース（配置番号）
            elif '配置' in label or 'スペース' in label or 'space' in label.lower():
                if text and text != '-':
                    if self._is_space_text(text):
                        circle.space = self._normalize_space_display(text)
                    elif not circle.hall:
                        circle.hall = text

            # ホール / イベント
            elif 'ホール' in label or 'hall' in label.lower() or 'イベント' in label or 'エリア' in label or 'area' in label.lower():
                if text and text != '-':
                    circle.hall = text

            # ペンネーム
            elif 'ペンネーム' in label or 'penname' in label.lower():
                if text and text != '-':
                    circle.penname = text

            # Twitter/X URL（全セルでリンクを確認）
            links = cell.find_all('a')
            for link in links:
                href = link.get('href', '')
                if 'twitter.com' in href or 'x.com' in href:
                    circle.twitter_url = href
                elif 'pixiv.net' in href:
                    circle.pixiv_url = href
                elif href and href != '#' and not circle.website_url:
                    # その他のWebサイト
                    if 'お品書き' not in label:
                        circle.website_url = href

        return circle if circle.name else None

    def _parse_circle_cell(self, circle: Circle, cell, raw_text: str) -> None:
        """サークル列からサークル名とスペース番号を分離する"""
        space_candidate = self._extract_space_candidate(cell, raw_text)
        name_candidate = self._extract_circle_name(cell, raw_text, space_candidate)

        if space_candidate:
            circle.space = self._normalize_space_display(space_candidate)

        if name_candidate:
            circle.name = name_candidate
        elif not circle.name and raw_text:
            cleaned_raw = self._cleanup_name_text(raw_text)
            if cleaned_raw and (not self._is_space_text(cleaned_raw) or cleaned_raw.isdigit()):
                circle.name = cleaned_raw

        # サークルセル内にホール情報が含まれるケースを補正
        if circle.space and not self._is_space_text(circle.space) and not circle.hall:
            circle.hall = circle.space
            circle.space = None

    def _extract_space_candidate(self, cell, raw_text: str) -> Optional[str]:
        """セル内からスペース番号を推測して抽出"""
        # data-*属性を確認
        for attr in ['data-space', 'data-space-number', 'data-placement']:
            value = cell.get(attr)
            if value and self._is_space_text(value):
                return value

        # class属性付き要素を優先的にチェック
        for child in cell.find_all(True, recursive=True):
            class_attr = ' '.join(child.get('class', []))
            if class_attr and re.search(r'space|配置|placement', class_attr, re.IGNORECASE):
                child_text = child.get_text(" ", strip=True)
                if child_text and self._is_space_text(child_text):
                    return child_text

        # テキストからパターンマッチ
        for match in SPACE_INLINE_PATTERN.finditer(raw_text):
            candidate = match.group().strip()
            if candidate and self._is_space_text(candidate):
                # 純粋な数字だけの場合はサークル名の可能性が高いので除外
                if not re.search(r'[A-Za-zぁ-んァ-ヶ]', candidate):
                    continue
                return candidate

        return None

    def _extract_circle_name(self, cell, raw_text: str, space_candidate: Optional[str]) -> Optional[str]:
        """セルのテキストからサークル名を抽出"""
        # クラス名でサークル名らしき要素を探す
        for child in cell.find_all(True, recursive=True):
            class_attr = ' '.join(child.get('class', []))
            if class_attr and re.search(r'circle|name|title', class_attr, re.IGNORECASE):
                text = child.get_text(" ", strip=True)
                cleaned = self._cleanup_name_text(text)
                if cleaned:
                    return cleaned

        text = raw_text
        if space_candidate:
            # スペース候補を除去
            pattern = re.escape(space_candidate)
            text = re.sub(pattern, ' ', text, count=1)

        text = self._cleanup_name_text(text)
        if not text:
            return None

        # スペース番号と判定される断片を除外
        parts = [part for part in re.split(r'[／/|｜]', text) if part.strip()]
        for part in parts:
            normalized_part = self._cleanup_name_text(part)
            if normalized_part and not self._is_space_text(normalized_part):
                return normalized_part

        if text.isdigit():
            return text

        return text if not self._is_space_text(text) else None

    def _cleanup_name_text(self, text: str) -> str:
        if not text:
            return ""
        cleaned = text.replace('　', ' ').strip(' ／|-　')
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()
        return cleaned

    def _is_space_text(self, value: Optional[str]) -> bool:
        if not value:
            return False
        normalized = self._normalize_space_token(value)
        if not normalized:
            return False
        return bool(SPACE_TOKEN_PATTERN.match(normalized))

    def _normalize_space_display(self, value: str) -> str:
        if not value:
            return ""
        value = value.replace('‐', '-').replace('ー', '-').replace('―', '-')
        value = value.replace('　', ' ')
        value = re.sub(r'\s*-\s*', '-', value)
        value = re.sub(r'\s+', ' ', value).strip()
        return value

    def _normalize_space_token(self, value: str) -> str:
        value = value.replace('‐', '-').replace('ー', '-').replace('―', '-')
        value = re.sub(r'\s+', '', value)
        return value.strip()
    
    def _parse_div_element(self, div) -> Optional[Circle]:
        """div要素をパース"""
        circle = Circle(name="")
        
        # サークル名
        name_elem = div.find(['h1', 'h2', 'h3', 'h4', 'strong'])
        if name_elem:
            circle.name = name_elem.get_text(strip=True)
        
        # スペース
        space_match = re.search(r'[あ-ん]-\d+[ab]?', div.get_text())
        if space_match:
            circle.space = space_match.group()
        
        # Twitter URL
        twitter_link = div.find('a', href=re.compile(r'twitter\.com|x\.com'))
        if twitter_link:
            circle.twitter_url = twitter_link.get('href')
        
        return circle if circle.name else None
    
    def _find_web_catalog_sections(self, soup: BeautifulSoup) -> List[BeautifulSoup]:
        """Webカタログβセクションを全て収集"""
        sections: List[BeautifulSoup] = []
        for text in soup.find_all(text=re.compile(r'Webカタログβ')):
            parent = text.parent
            if not parent:
                continue

            section = parent.find_parent()
            if section and section not in sections:
                sections.append(section)

        return sections
    
    def _normalize_image_url(self, url: str) -> str:
        """画像URLを正規化"""
        if not url:
            return ""
        
        if url.startswith('http'):
            return url
        
        if url.startswith('/'):
            base = '/'.join(self.config.base_url.split('/')[:3])
            return base + url
        
        base = '/'.join(self.config.base_url.split('/')[:-1])
        return base + '/' + url

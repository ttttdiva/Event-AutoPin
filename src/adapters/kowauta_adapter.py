"""古は歌詠み鳥 (kowa-uta.com) 専用アダプター"""

import re
from typing import List, Optional, Tuple
from bs4 import BeautifulSoup
import logging

from ..core import BaseSiteAdapter
from ..models import Circle, Event


class KowaUtaAdapter(BaseSiteAdapter):
    """古は歌詠み鳥サイト専用アダプター"""
    
    def __init__(self, config):
        super().__init__(config)
        self.logger = logging.getLogger("circle_list_generator")
    
    def can_handle(self, url: str) -> bool:
        """このアダプタがURLを処理できるか判定"""
        return 'kowa-uta.com' in url.lower()
    
    def extract_event_info(self, soup: BeautifulSoup) -> Optional[Event]:
        """イベント情報を抽出"""
        event = Event(name="", url=self.config.base_url)
        
        # URLからイベント名を推測（/5th/ などの部分から）
        url_match = re.search(r'/(\d+)(?:th|nd|rd|st)/', self.config.base_url)
        if url_match:
            event_num = url_match.group(1)
            event.name = f"声音の宴{event_num}次会"
        else:
            # タイトルから情報を抽出
            title = soup.find('title')
            if title:
                title_text = title.get_text(strip=True)
                # 例: "第5回 古は歌詠み鳥 サークルリスト"
                match = re.search(r'第(\d+)回\s*(.+?)(?:\s*サークルリスト)?$', title_text)
                if match:
                    event.name = f"第{match.group(1)}回 {match.group(2)}"
                else:
                    event.name = title_text
        
        # ヘッダー情報から日付と会場を探す
        headers = soup.find_all(['h1', 'h2', 'h3'])
        for header in headers:
            text = header.get_text(strip=True)
            # 日付パターン
            date_match = re.search(r'(\d{4})[年/](\d{1,2})[月/](\d{1,2})', text)
            if date_match:
                event.date = f"{date_match.group(1)}年{date_match.group(2)}月{date_match.group(3)}日"
            
            # 会場パターン
            if '会場' in text or 'ビッグサイト' in text or '東京' in text:
                event.venue = text
        
        # テキスト全体から日付を探すことも試みる
        if not event.date:
            page_text = soup.get_text()
            date_match = re.search(r'(\d{4})[年․s]*(\d{1,2})[月․s]*(\d{1,2})[日]?', page_text)
            if date_match:
                event.date = f"{date_match.group(1)}年{date_match.group(2)}月{date_match.group(3)}日"
        
        return event
    
    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """サークル情報を抽出"""
        circles = []
        self.logger.debug("Starting circle extraction from KowautaAdapter")
        
        # サークルリストのテーブルを探す
        tables = soup.find_all('table')
        
        for table in tables:
            # テーブルのヘッダーを確認
            headers = []
            header_row = table.find('tr')
            if header_row:
                headers = [th.get_text(strip=True) for th in header_row.find_all(['th', 'td'])]
            
            # サークル情報を含むテーブルかチェック
            if not any('サークル' in h or 'スペース' in h for h in headers):
                continue
            
            # 各行を処理
            rows = table.find_all('tr')[1:]  # ヘッダー行をスキップ
            for row in rows:
                cells = row.find_all(['td', 'th'])
                if len(cells) < 2:
                    continue
                
                circle = self._parse_circle_row(cells, headers)
                if circle and circle.name:
                    circles.append(circle)
        
        # テーブル以外の形式も確認
        if not circles:
            self.logger.debug("No circles found in tables, trying div extraction")
            circles = self._extract_from_divs(soup)
        else:
            self.logger.debug(f"Found {len(circles)} circles from tables")
        
        # Twitter URL の統計を出力
        circles_with_twitter = [c for c in circles if c.twitter_url]
        self.logger.debug(f"Total circles: {len(circles)}, with Twitter URL: {len(circles_with_twitter)}")
        
        return circles
    
    def _parse_circle_row(self, cells: List, headers: List) -> Optional[Circle]:
        """テーブル行からサークル情報を抽出"""
        circle = Circle(name="")
        
        for i, cell in enumerate(cells):
            text = cell.get_text(strip=True)
            header = headers[i] if i < len(headers) else ""
            
            # スペース番号（配置番号）- 最初のカラム（例: 1F-A01）
            if i == 0 or '配置' in header or 'スペース' in header:
                circle.space = text if text else None
                # Kowa-Uta publishes complete space labels such as "A-01,02".
                # Keeping a derived hall as "A" makes older display code render
                # "AA-01,02", so leave hall empty for this adapter.
                circle.hall = None
            
            # サークル名
            elif i == 1 or 'サークル' in header:
                # 括弧内の内容を一時的に削除（ジャンル情報の可能性）
                name_text = re.sub(r'[（(].*?[）)]', '', text).strip()
                circle.name = name_text if name_text else text
                
                # 括弧内の内容をジャンルとして抽出
                genre_match = re.search(r'[（(](.+?)[）)]', text)
                if genre_match:
                    circle.genres.append(genre_match.group(1))
            
            # ペンネーム
            elif i == 2 or 'ペンネーム' in header:
                circle.penname = text if text else None
            
            # Twitter/X リンク
            if i == 3 or 'twitter' in header.lower():  # 4番目のカラムに修正
                links = cell.find_all('a')
                for link in links:
                    href = link.get('href', '')
                    if 'twitter.com' in href or 'x.com' in href:
                        circle.twitter_url = href
                        self.logger.debug(f"Found Twitter URL for {circle.name}: {href}")
                        break
            
            # Webサイトリンク（同じカラムにあることが多い）
            if i == 3 or 'web' in header.lower():
                links = cell.find_all('a')
                for link in links:
                    href = link.get('href', '')
                    if 'http' in href and 'twitter.com' not in href and 'x.com' not in href:
                        circle.website_url = href
                        break
        
        return circle if circle.name else None
    
    def _extract_from_divs(self, soup: BeautifulSoup) -> List[Circle]:
        """div要素からサークル情報を抽出"""
        circles = []
        
        # サークル情報を含むdivを探す
        circle_divs = soup.find_all('div', class_=re.compile(r'circle|list', re.I))
        
        for div in circle_divs:
            # スペース番号を探す
            space_elem = div.find(text=re.compile(r'[あ-ん]-\d+'))
            if not space_elem:
                continue
            
            space = space_elem.strip()
            
            # サークル名を探す
            name_elem = div.find(['h3', 'h4', 'strong', 'b'])
            if not name_elem:
                continue
            
            name_text = name_elem.get_text(strip=True)
            
            circle = Circle(name="", space=space)
            
            # サークル名とペンネームを分離
            if '/' in name_text:
                parts = name_text.split('/', 1)
                circle.name = parts[0].strip()
                circle.penname = parts[1].strip() if len(parts) > 1 else None
            elif '（' in name_text or '(' in name_text:
                match = re.match(r'(.+?)[（(](.+?)[）)]', name_text)
                if match:
                    circle.name = match.group(1).strip()
                    circle.penname = match.group(2).strip()
                else:
                    circle.name = name_text
            else:
                circle.name = name_text
            
            # リンクを探す
            links = div.find_all('a')
            for link in links:
                href = link.get('href', '')
                if 'twitter.com' in href or 'x.com' in href:
                    circle.twitter_url = href
                    self.logger.debug(f"Found Twitter URL (div) for {circle.name}: {href}")
                elif 'http' in href and not circle.website_url:
                    circle.website_url = href
            
            if circle.name:
                circles.append(circle)
        
        return circles
    
    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """サークルカット画像のURLを抽出"""
        image_urls = []
        
        # サークルカット画像を探す
        images = soup.find_all('img')
        for i, img in enumerate(images):
            src = img.get('src', '')
            alt = img.get('alt', '')
            
            # サークルカット画像の判定
            if 'circle' in src.lower() or 'cut' in src.lower() or \
               'サークル' in alt or 'カット' in alt:
                full_url = self._normalize_url(src)
                if full_url:
                    image_urls.append((i, full_url))
        
        return image_urls
    
    def _normalize_url(self, url: str) -> Optional[str]:
        """相対URLを絶対URLに変換"""
        if not url:
            return None
        
        if url.startswith('http'):
            return url
        
        if url.startswith('//'):
            return f"https:{url}"
        
        if url.startswith('/'):
            return f"https://kowa-uta.com{url}"
        
        # 相対パス
        base_path = '/'.join(self.config.url.rstrip('/').split('/')[:-1])
        return f"{base_path}/{url}"

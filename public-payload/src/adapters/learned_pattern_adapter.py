"""
学習済みパターンを使用するアダプター
LLMを使わずに、以前学習したパターンを使って処理を行う
"""

import re
import logging
from typing import List, Optional, Dict, Any, Tuple
from bs4 import BeautifulSoup
from datetime import datetime
from urllib.parse import urljoin

from ..core import BaseSiteAdapter
from ..models import Circle, Event, EventMap, SiteType
from ..utils.pattern_manager import PatternManager
from ..utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


class LearnedPatternAdapter(BaseSiteAdapter):
    """学習済みパターンを使用するアダプター"""
    
    def __init__(
        self,
        site_config,
        pattern_manager: PatternManager,
        llm_client: Optional[LLMClient] = None,
    ):
        """
        Args:
            site_config: サイト設定
            pattern_manager: パターン管理オブジェクト
        """
        super().__init__(site_config)
        self.pattern_manager = pattern_manager
        self.pattern = pattern_manager.get_pattern(site_config.base_url)
        self.llm_client = llm_client
        
        if not self.pattern:
            raise ValueError(f"学習済みパターンが見つかりません: {site_config.base_url}")
        
        logger.info(f"学習済みパターンを適用: {self.pattern['site_key']}")
    
    def can_handle(self, url: str) -> bool:
        """このアダプタがURLを処理できるか判定"""
        return self.pattern_manager.has_pattern(url)
    
    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """学習済みパターンを使ってイベント情報を抽出"""
        event_structure = self.pattern.get('event_structure', {})
        extraction_rules = self.pattern.get('extraction_rules', {})

        event_data = {
            'name': None,
            'url': self.config.base_url,
            'date': None,
            'venue': None,
            'organizer': None
        }

        # catalog_additional_promptからイベント名を抽出
        event_name = None
        if self.config.catalog_additional_prompt:
            match = re.search(r'イベント名は[「『](.+?)[」』]', self.config.catalog_additional_prompt)
            if match:
                event_name = match.group(1)
                logger.info(f"catalog_additional_promptからイベント名を取得: {event_name}")

        # イベント名の抽出（catalog_additional_promptからの値を優先）
        if not event_name and 'name' in event_structure and event_structure['name'].get('present'):
            event_name = self._extract_by_rules(
                soup,
                extraction_rules.get('event_name_selectors', []),
                extraction_rules.get('event_name_patterns', [])
            ) or 'イベント'
        elif not event_name:
            event_name = 'イベント'

        event_data['name'] = event_name
        
        # 日付の抽出
        if 'date' in event_structure and event_structure['date'].get('present'):
            date_str = self._extract_by_rules(
                soup,
                extraction_rules.get('event_date_selectors', []),
                extraction_rules.get('event_date_patterns', [])
            )
            if date_str:
                event_data['date'] = self._parse_date(date_str)
        
        # 会場の抽出
        if 'venue' in event_structure and event_structure['venue'].get('present'):
            event_data['venue'] = self._extract_by_rules(
                soup,
                extraction_rules.get('event_venue_selectors', []),
                extraction_rules.get('event_venue_patterns', [])
            )
        
        # 主催者の抽出
        if 'organizer' in event_structure and event_structure['organizer'].get('present'):
            event_data['organizer'] = self._extract_by_rules(
                soup,
                extraction_rules.get('event_organizer_selectors', []),
                extraction_rules.get('event_organizer_patterns', [])
            )
        
        # イベントオブジェクトを作成
        event = Event(
            name=event_data['name'] or 'イベント',
            url=event_data['url'],
            date=event_data['date'],
            venue=event_data['venue'],
            organizer=event_data['organizer']
        )
        
        # マップ情報を追加
        maps = self.extract_event_maps(soup)
        event.maps = maps
        
        logger.info(f"イベント情報を抽出: {event.name}")
        return event
    
    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """保存済み列構造を照合し、不一致表だけ列名をLLMで再判定する。"""
        tables = soup.find_all("table")
        candidate_headers: Dict[int, List[str]] = {}
        for table_index, table in enumerate(tables):
            rows = table.find_all("tr")
            if len(rows) < 2:
                continue
            headers = [
                cell.get_text(strip=True)
                for cell in rows[0].find_all(["th", "td"])
            ]
            if len(headers) >= 2:
                candidate_headers[table_index] = headers

        if not candidate_headers:
            return self._extract_circles_with_pattern(soup)

        header_mappings: Dict[int, Dict[int, str]] = {}
        unmatched_indices: List[int] = []
        learned_schemas = (
            self.pattern.get("extraction_rules", {}).get("table_header_schemas", [])
        )
        for table_index, headers in candidate_headers.items():
            matched_schema = False
            for schema in learned_schemas:
                if not isinstance(schema, dict) or schema.get("headers") != headers:
                    continue
                raw_map = schema.get("field_map")
                if not isinstance(raw_map, dict):
                    continue
                parsed_map: Dict[int, str] = {}
                for index, field in raw_map.items():
                    try:
                        column_index = int(index)
                    except (TypeError, ValueError):
                        continue
                    if 0 <= column_index < len(headers) and isinstance(field, str):
                        parsed_map[column_index] = field
                if "name" in parsed_map.values() and len(parsed_map) >= 2:
                    header_mappings[table_index] = parsed_map
                    matched_schema = True
                break

            if matched_schema:
                continue

            # schema未保存の旧パターンだけ、組み込みラベルの完全一致を許可する。
            if not learned_schemas:
                exact_map = {
                    index: self._HEADER_MAPPING[header]
                    for index, header in enumerate(headers)
                    if header in self._HEADER_MAPPING
                }
                if (
                    all(not header or index in exact_map for index, header in enumerate(headers))
                    and "name" in exact_map.values()
                    and len(exact_map) >= 2
                ):
                    header_mappings[table_index] = exact_map
                    continue

            unmatched_indices.append(table_index)

        if unmatched_indices and self.llm_client is not None:
            logger.warning(
                "学習済みサイトの不一致テーブルだけ、列名をLLMで再判定します"
            )
            from .generic_adapter import GenericAdapter

            generic = GenericAdapter(
                self.config,
                llm_client=self.llm_client,
                pattern_manager=self.pattern_manager,
            )
            header_mappings.update(
                generic._infer_table_header_mappings(
                    soup, only_table_indices=unmatched_indices
                )
            )

        unresolved = [
            index for index in unmatched_indices if index not in header_mappings
        ]
        for table_index in candidate_headers:
            header_mappings.setdefault(table_index, {})

        circles = self.try_direct_table_extraction(
            soup, header_mappings=header_mappings
        )
        if unresolved:
            logger.error(
                "列名を安全に対応付けできず除外したテーブル: "
                + ", ".join(str(index) for index in unresolved)
            )
        if circles:
            logger.info(f"検証済み列構造で {len(circles)} 件のサークルを抽出しました")
        if unresolved:
            logger.warning(
                "列名LLMを利用できないテーブルは、既存の学習パターンで補完を試みます"
            )
            pattern_circles = self._extract_circles_with_pattern(soup)
            seen = {(circle.name, circle.space) for circle in circles}
            for circle in pattern_circles:
                key = (circle.name, circle.space)
                if key in seen:
                    continue
                circles.append(circle)
                seen.add(key)
        return circles

    def _extract_circles_with_pattern(self, soup: BeautifulSoup) -> List[Circle]:
        """学習済みパターンを使ってサークル情報を抽出"""
        circles = []
        circle_structure = self.pattern.get('circle_structure', {})
        extraction_rules = self.pattern.get('extraction_rules', {})
        
        # サークルコンテナの取得
        container_selectors = extraction_rules.get('circle_container_selectors', [])
        circle_elements = []
        
        for selector in container_selectors:
            try:
                elements = soup.select(selector)
                if elements:
                    circle_elements.extend(elements)
                    logger.debug(f"セレクタ '{selector}' で {len(elements)} 個の要素を発見")
            except Exception as e:
                logger.debug(f"セレクタ '{selector}' の処理でエラー: {e}")
        
        if not circle_elements:
            # フォールバック: テーブル行やリストアイテムを探す
            circle_elements = soup.select('tr') + soup.select('li') + soup.select('div.circle')
        
        logger.info(f"サークル候補要素: {len(circle_elements)} 個")
        
        # 各要素からサークル情報を抽出
        for element in circle_elements:
            circle_data = self._extract_circle_from_element(element, circle_structure, extraction_rules)
            
            # 最低限の情報があれば追加
            if circle_data.get('name'):
                circle = Circle(
                    name=circle_data.get('name', ''),
                    penname=circle_data.get('penname'),
                    space=circle_data.get('space'),
                    hall=circle_data.get('hall'),
                    twitter_url=circle_data.get('twitter_url'),
                    website_url=circle_data.get('website_url'),
                    description=circle_data.get('description'),
                    genres=circle_data.get('genres', [])
                )
                circles.append(circle)
        
        logger.info(f"抽出されたサークル数: {len(circles)}")
        return circles
    
    def _extract_circle_from_element(self, element, structure: Dict, rules: Dict) -> Dict[str, Any]:
        """要素から1つのサークル情報を抽出"""
        circle_data: Dict[str, Any] = {}

        # data-label属性を持つテーブル行がある場合は優先的に解析する
        label_based_data = self._extract_from_data_labels(element)
        if label_based_data:
            circle_data.update(label_based_data)

        # 各フィールドの抽出（既に取得できているフィールドはスキップ）
        field_mappings = {
            'name': 'circle_name',
            'penname': 'circle_penname',
            'space': 'circle_space',
            'hall': 'circle_hall',
            'twitter_url': 'circle_twitter',
            'website_url': 'circle_website',
            'description': 'circle_description'
        }

        for field_key, rule_key in field_mappings.items():
            if circle_data.get(field_key):
                continue

            if field_key in structure and structure[field_key].get('frequency', 0) > 0.5:
                # 頻度が50%以上のフィールドのみ抽出を試みる
                selectors = rules.get(f'{rule_key}_selectors', [])
                patterns = rules.get(f'{rule_key}_patterns', [])

                value = self._extract_from_element(element, selectors, patterns)
                if value:
                    circle_data[field_key] = value

        # Twitter URLの正規化
        if 'twitter_url' in circle_data:
            twitter_url = self._normalize_twitter_url(circle_data['twitter_url'])
            if twitter_url:
                circle_data['twitter_url'] = twitter_url
            else:
                circle_data.pop('twitter_url', None)

        return circle_data

    def _extract_from_data_labels(self, element) -> Dict[str, Any]:
        """data-label属性または通常のテーブルヘッダーを用いてカラムをマッピング"""
        cells = element.find_all(['td', 'th'])
        if not cells:
            return {}

        label_map: Dict[str, Any] = {}
        found_label = False

        # data-label属性がある場合
        for cell in cells:
            label = cell.get('data-label')
            if not label:
                continue

            found_label = True
            label = label.strip()
            text = cell.get_text(' ', strip=True)

            # ハイフンのみや空文字は情報なしとみなす
            if text in {'-', 'ー', '―'}:
                text = ''

            href = ''
            link = cell.find('a', href=True)
            if link:
                href = link.get('href', '').strip()

            normalized_label = label.lower()

            if label in {'イベント', 'ホール', 'エリア', 'ホール名'}:
                if text:
                    label_map['hall'] = text
            elif label in {'配置番号', 'スペース', 'スペース番号', '配置'}:
                if text:
                    label_map['space'] = text
            elif label in {'サークル', 'サークル名', 'サークル／企業名'}:
                if text:
                    label_map['name'] = text
            elif label in {'ペンネーム', '作者', '作家名'}:
                if text:
                    label_map['penname'] = text
            elif 'twitter' in normalized_label or 'x (' in normalized_label or normalized_label.startswith('x'):
                twitter_url = href or text
                if twitter_url:
                    label_map['twitter_url'] = twitter_url
            elif 'web' in normalized_label or 'site' in normalized_label:
                if href:
                    label_map['website_url'] = href

        # data-label属性がない場合、通常のテーブル構造を確認
        if not found_label:
            table = element.find_parent('table')
            if table:
                headers = []
                # theadからヘッダーを探す
                thead = table.find('thead')
                if thead:
                    headers = thead.find_all('th')

                # theadがない場合、最初の<tr>の<th>要素をヘッダーとして使用
                if not headers:
                    first_row = table.find('tr')
                    if first_row and first_row is not element:
                        headers = first_row.find_all('th')

                if headers and len(headers) == len(cells):
                    # ヘッダーとセルを対応付け
                    for header, cell in zip(headers, cells):
                        label = header.get_text(strip=True)
                        if not label:
                            continue

                        text = cell.get_text(' ', strip=True)

                        # ハイフンのみや空文字は情報なしとみなす
                        if text in {'-', 'ー', '―'}:
                            continue

                        href = ''
                        link = cell.find('a', href=True)
                        if link:
                            href = link.get('href', '').strip()

                        normalized_label = label.lower()

                        if label in {'イベント', 'ホール', 'エリア', 'ホール名'}:
                            if text:
                                label_map['hall'] = text
                        elif label in {'配置番号', 'スペース', 'スペース番号', '配置'}:
                            if text:
                                label_map['space'] = text
                        elif label in {'サークル', 'サークル名', 'サークル／企業名'}:
                            if text:
                                label_map['name'] = text
                        elif label in {'ペンネーム', '作者', '作家名'}:
                            if text:
                                label_map['penname'] = text
                        elif 'twitter' in normalized_label or 'x (' in normalized_label or normalized_label.startswith('x'):
                            twitter_url = href or text
                            if twitter_url:
                                label_map['twitter_url'] = twitter_url
                        elif 'web' in normalized_label or 'site' in normalized_label:
                            if href:
                                label_map['website_url'] = href

        return {k: v for k, v in label_map.items() if v}
    
    def _extract_by_rules(self, soup: BeautifulSoup, selectors: List[str], patterns: List[str]) -> Optional[str]:
        """セレクタとパターンを使って情報を抽出"""
        # セレクタで抽出
        for selector in selectors:
            try:
                elements = soup.select(selector)
                if elements:
                    text = elements[0].get_text(strip=True)
                    if text:
                        return text
            except Exception as e:
                logger.debug(f"セレクタ '{selector}' の処理でエラー: {e}")
        
        # パターンマッチで抽出
        page_text = soup.get_text()
        for pattern in patterns:
            try:
                match = re.search(pattern, page_text)
                if match:
                    return match.group(1) if match.groups() else match.group(0)
            except Exception as e:
                logger.debug(f"パターン '{pattern}' の処理でエラー: {e}")
        
        return None
    
    def _extract_from_element(self, element, selectors: List[str], patterns: List[str]) -> Optional[str]:
        """要素内から情報を抽出"""
        # 相対セレクタで抽出
        for selector in selectors:
            try:
                # セレクタが相対的な場合の処理
                if selector.startswith('.') or selector.startswith('['):
                    found = element.select_one(selector)
                else:
                    # 要素内での検索
                    found = element.select_one(selector)

                if found:
                    # リンクの場合は href 属性を優先
                    if found.name == 'a' and found.get('href'):
                        href = found.get('href', '').strip()
                        if href and href != '#':
                            return href

                    # それ以外の場合はテキストを返す
                    text = found.get_text(strip=True)
                    if text:
                        return text
            except Exception as e:
                logger.debug(f"要素内セレクタ '{selector}' の処理でエラー: {e}")

        # パターンマッチで抽出
        element_text = element.get_text()
        for pattern in patterns:
            try:
                match = re.search(pattern, element_text)
                if match:
                    return match.group(1) if match.groups() else match.group(0)
            except Exception as e:
                logger.debug(f"要素内パターン '{pattern}' の処理でエラー: {e}")

        return None
    
    def _parse_date(self, date_str: str) -> Optional[datetime]:
        """日付文字列をdatetimeオブジェクトに変換"""
        if not date_str:
            return None
        
        # 一般的な日付フォーマットを試す
        formats = [
            "%Y-%m-%d",
            "%Y/%m/%d",
            "%Y年%m月%d日",
            "%Y.%m.%d",
            "%d/%m/%Y",
            "%d-%m-%Y"
        ]
        
        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue
        
        # 正規表現で日付部分を抽出
        date_match = re.search(r'(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})', date_str)
        if date_match:
            year, month, day = map(int, date_match.groups())
            try:
                return datetime(year, month, day)
            except ValueError:
                pass
        
        logger.warning(f"日付のパースに失敗: {date_str}")
        return None
    
    def _normalize_twitter_url(self, url: str) -> Optional[str]:
        """Twitter URLを正規化"""
        if not url:
            return None
        
        # @で始まる場合
        if url.startswith('@'):
            return f"https://twitter.com/{url[1:]}"
        
        # twitter.com または x.com を含む場合
        if 'twitter.com' in url or 'x.com' in url:
            # URLからユーザー名を抽出
            match = re.search(r'(?:twitter\.com|x\.com)/([^/?]+)', url)
            if match:
                username = match.group(1)
                return f"https://twitter.com/{username}"
        
        return None
    
    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """サークル画像URLを抽出"""
        # サークル画像取得が無効化されている場合は空リストを返す
        if self.pattern.get('disable_circle_images', False):
            return []

        # Sockbase など固定アダプターがある場合は委譲
        if self.config.site_type == SiteType.SOCKBASE:
            from .sockbase_adapter import SockbaseAdapter  # 遅延インポート
            delegate = SockbaseAdapter(self.config)
            delegate.logger = self.logger
            return delegate.extract_circle_images(soup)
        
        # 基本的な画像抽出ロジック
        image_urls = []
        
        # img要素から画像を探す
        for i, img in enumerate(soup.find_all('img')):
            src = img.get('src', '')
            if src and not any(skip in src.lower() for skip in ['logo', 'banner', 'icon', 'button']):
                # 相対URLを絶対URLに変換
                full_url = urljoin(self.config.base_url, src)
                image_urls.append((i, full_url))
        
        return image_urls

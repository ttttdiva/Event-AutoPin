import re
from typing import List, Tuple, Optional, Dict, Any
from datetime import datetime
from bs4 import BeautifulSoup
import json

from ..core import BaseSiteAdapter
from ..models import Circle, Event, CircleImage
from ..utils.llm_client import LLMClient
from ..utils.pattern_manager import PatternManager
from ..utils.site_parsing_llm import parse_with_high_end_model


class GenericAdapter(BaseSiteAdapter):
    """LLMを使用した汎用アダプター"""

    def __init__(
        self,
        config,
        llm_client: Optional[LLMClient] = None,
        pattern_manager: Optional[PatternManager] = None,
    ):
        super().__init__(config)
        self.llm_client = llm_client or LLMClient(model=config.llm_model)
        self.pattern_manager = pattern_manager or PatternManager()
        self.extraction_rules = {}  # 抽出に使用したルールを記録
        self.extracted_event = None  # 抽出したイベント情報を記録
        self.extracted_circles_sample = []  # 抽出したサークルのサンプルを記録
        self.table_header_schemas: List[Dict[str, Any]] = []

    def can_handle(self, url: str) -> bool:
        """常にTrue（フォールバック用）"""
        return True

    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        """LLMを使用してイベント情報を抽出"""
        # catalog_additional_promptからイベント名を抽出
        event_name = None
        self.logger.debug(
            f"catalog_additional_prompt: '{self.config.catalog_additional_prompt}'"
        )
        if self.config.catalog_additional_prompt:
            match = re.search(
                r"イベント名は[「『](.+?)[」』]", self.config.catalog_additional_prompt
            )
            if match:
                event_name = match.group(1)
                self.logger.info(
                    f"catalog_additional_promptからイベント名を取得: {event_name}"
                )
            else:
                self.logger.warning(
                    f"catalog_additional_promptからイベント名を抽出できませんでした"
                )

        if self.config.event_name:
            date_obj = None
            if self.config.event_date:
                try:
                    date_text = self.config.event_date.replace("Z", "+00:00")
                    try:
                        date_obj = datetime.fromisoformat(date_text)
                    except ValueError:
                        date_obj = datetime.strptime(self.config.event_date, "%Y-%m-%d")
                except (ValueError, AttributeError):
                    self.logger.warning(
                        f"日付のパースに失敗: {self.config.event_date}"
                    )
            event = Event(
                name=self.config.event_name,
                url=self.config.base_url,
                date=date_obj,
            )
            event.maps = self.extract_event_maps(soup)
            self.extracted_event = {
                "name": event.name,
                "date": event.date.isoformat() if event.date else None,
                "venue": event.venue,
                "organizer": event.organizer,
            }
            return event

        if self.config.use_llm:
            event_info = self._extract_with_llm(soup, "event")

            # 抽出結果を記録（パターン学習用）
            self.extracted_event = event_info

            # dateフィールドを適切に処理
            date_str = event_info.get("date")
            date_obj = None
            if date_str:
                try:
                    # ISO形式の日付文字列をdatetimeオブジェクトに変換
                    date_obj = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    self.logger.warning(f"日付のパースに失敗: {date_str}")

            # イベント名はcatalog_additional_promptからの値を優先
            if not event_name:
                event_name = event_info.get("name", "イベント")

            event = Event(
                name=event_name,
                url=self.config.base_url,
                date=date_obj,
                venue=event_info.get("venue"),
                organizer=event_info.get("organizer"),
            )
        else:
            # LLMを使わない場合の簡易抽出
            if not event_name:
                event_name = self._extract_title(soup)

            event = Event(name=event_name, url=self.config.base_url)

        # マップ情報を追加
        event.maps = self.extract_event_maps(soup)
        return event

    def extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """初回サイトは列名をLLM判定し、既知の対応で機械抽出する。"""
        has_candidate_table = self.has_candidate_circle_table(soup)
        header_mappings = (
            self._infer_table_header_mappings(soup)
            if self.config.use_llm and has_candidate_table
            else {}
        )
        circles = self.try_direct_table_extraction(
            soup,
            header_mappings=header_mappings,
            require_exact_headers=True,
        )
        if circles:
            self.logger.info(
                f"LLM列名判定後のテーブルパースで {len(circles)} 件のサークルを抽出しました"
            )
            # パターン学習用にサンプルを記録
            for c in circles[:5]:
                self.extracted_circles_sample.append(
                    {
                        "name": c.name,
                        "space": c.space,
                        "hall": c.hall,
                        "twitter_url": c.twitter_url,
                    }
                )
            return circles

        if has_candidate_table:
            if self.config.use_llm:
                self.logger.error(
                    "テーブル列名を安全に対応付けできなかったため、行データをLLMへ送信せず抽出を中止します"
                )
                return []
            return self._extract_circles_without_llm(soup)

        # 直接パースに失敗した場合はLLMを使用
        if self.config.use_llm:
            return self._extract_circles_with_llm(soup)
        else:
            return self._extract_circles_without_llm(soup)

    def _infer_table_header_mappings(
        self,
        soup: BeautifulSoup,
        only_table_indices: Optional[List[int]] = None,
    ) -> Dict[int, Dict[int, str]]:
        """行データを送らず、列名だけをLLMへ渡して標準フィールドへ対応付ける。"""
        table_headers = []
        table_indices = []
        for table_index, table in enumerate(soup.find_all("table")):
            if only_table_indices is not None and table_index not in only_table_indices:
                continue
            rows = table.find_all("tr")
            if len(rows) < 2:
                continue
            headers = [
                cell.get_text(strip=True)
                for cell in rows[0].find_all(["th", "td"])
            ]
            if headers:
                table_indices.append(table_index)
                table_headers.append(headers)

        if not table_headers:
            return {}

        prompt = f"""以下はイベントのサークル一覧にあるテーブルの列名だけです。
各列を標準フィールドへ対応付けてください。行データは推測せず、列名の意味だけで判定してください。

列名一覧:
{json.dumps(table_headers, ensure_ascii=False)}

使用可能な標準フィールド:
space, name, penname, hall, twitter_url, website_url, pixiv_url, genre, description, ignore

次のJSON形式だけを返してください。table_indexとcolumn_indexは上の配列内の0始まり番号です。
{{"tables":[{{"table_index":0,"columns":{{"0":"space","1":"name"}}}}]}}
サークル名に相当するnameを特定できないテーブルはtablesに含めないでください。
"""
        try:
            response = self.llm_client.extract_data(prompt, temperature=0.0)
        except TypeError:
            response = self.llm_client.extract_data(prompt)
        except Exception as exc:
            self.logger.warning(f"テーブル列名のLLM判定に失敗: {exc}")
            return {}

        try:
            payload = json.loads(response)
        except (TypeError, json.JSONDecodeError) as exc:
            self.logger.warning(f"テーブル列名のLLM応答を解析できません: {exc}")
            return {}
        if not isinstance(payload, dict) or not isinstance(payload.get("tables"), list):
            self.logger.warning("テーブル列名のLLM応答が期待形式ではありません")
            return {}

        allowed_fields = {
            "space", "name", "penname", "hall", "twitter_url",
            "website_url", "pixiv_url", "genre", "description",
        }
        mappings: Dict[int, Dict[int, str]] = {}
        for table_result in payload.get("tables", []):
            if not isinstance(table_result, dict):
                continue
            try:
                relative_index = int(table_result.get("table_index"))
                actual_index = table_indices[relative_index]
            except (TypeError, ValueError, IndexError):
                continue
            headers = table_headers[relative_index]
            field_map: Dict[int, str] = {}
            columns = table_result.get("columns")
            if not isinstance(columns, dict):
                continue
            for raw_index, field in columns.items():
                try:
                    column_index = int(raw_index)
                except (TypeError, ValueError):
                    continue
                if 0 <= column_index < len(headers) and field in allowed_fields:
                    field_map[column_index] = field
            if "name" in field_map.values() and len(field_map) >= 2:
                mappings[actual_index] = field_map

        if mappings:
            self.table_header_schemas = [
                {
                    "headers": table_headers[table_indices.index(table_index)],
                    "field_map": {str(index): field for index, field in field_map.items()},
                }
                for table_index, field_map in mappings.items()
            ]
            self.logger.info(
                f"LLMでテーブル列名を判定しました: {len(mappings)}テーブル"
            )
        return mappings

    def extract_circle_images(self, soup: BeautifulSoup) -> List[Tuple[int, str]]:
        """画像URLを抽出"""
        # そうぞうパレッツの場合はサークルカット画像を取得しない
        if "souzou-palettes.net" in self.config.base_url:
            return []

        image_urls = []

        # 設定に基づいて画像を探す
        if self.config.extractor_config.image_selector:
            images = soup.select(self.config.extractor_config.image_selector)
        else:
            # すべての画像から判定
            images = soup.find_all("img")

        for i, img in enumerate(images):
            src = img.get("src", "")
            if self._is_circle_image(src, img):
                normalized_url = self._normalize_url(src)
                if normalized_url:
                    image_urls.append((i, normalized_url))

        return image_urls

    def _extract_with_llm(
        self, soup: BeautifulSoup, extract_type: str
    ) -> Dict[str, Any]:
        """LLMを使用してデータを抽出"""
        # HTMLの関連部分を抽出
        if extract_type == "event":
            context = self._get_event_context(soup)
            prompt = self._create_event_prompt(context)
        else:
            context = self._get_circle_context(soup)
            prompt = self._create_circle_prompt(context)

        # LLMに問い合わせ
        response = self.llm_client.extract_data(prompt)

        try:
            return json.loads(response)
        except json.JSONDecodeError:
            self.logger.error(f"LLMレスポンスのパースに失敗: {response}")
            return {}

    def _extract_circles_with_llm(self, soup: BeautifulSoup) -> List[Circle]:
        """LLMを使用してサークル情報を抽出"""
        # site_parsing_config がある場合は高性能モデルを使用
        if self.config.site_parsing_config:
            llm_data = self._extract_circles_with_high_end_llm(soup)
        else:
            llm_data = self._extract_with_llm(soup, "circles")

        circles = []

        for circle_data in llm_data.get("circles", []):
            circle = Circle(
                name=circle_data.get("name", ""),
                penname=circle_data.get("penname"),
                space=circle_data.get("space"),
                hall=circle_data.get("hall"),
                twitter_url=circle_data.get("twitter_url"),
                website_url=circle_data.get("website_url"),
                description=circle_data.get("description"),
                genres=circle_data.get("genres", []),
                raw_data=circle_data,
            )

            if circle.name:
                circles.append(circle)
                # サンプルとして最初の5件を記録
                if len(self.extracted_circles_sample) < 5:
                    self.extracted_circles_sample.append(circle_data)

        return circles

    def _extract_circles_with_high_end_llm(self, soup: BeautifulSoup) -> Dict[str, Any]:
        """高性能モデル（Codex CLI / GPT-5.4 API）でサークル情報を抽出"""
        context = self._get_circle_context(soup)
        prompt = self._create_circle_prompt(context)

        self.logger.info("高性能モデルでサークル抽出を試行中...")
        try:
            response = parse_with_high_end_model(
                prompt,
                self.config.site_parsing_config,
            )
            return json.loads(response)
        except Exception as e:
            self.logger.warning(
                f"高性能モデルでの抽出失敗、通常LLMにフォールバック: {e}"
            )
            return self._extract_with_llm(soup, "circles")

    def save_extraction_pattern(self):
        """LLMで抽出したパターンを保存"""
        if not self.pattern_manager or not self.extracted_event:
            return

        # セレクタは実際のテーブル構造に依存するため、
        # 汎用的なセレクタのみ保存する（位置依存のセレクタは使わない）
        extraction_rules = {
            "event_name_selectors": ["h1", "title", ".event-name"],
            "event_date_selectors": [".date", ".event-date"],
            "event_venue_selectors": [".venue", ".location"],
            "event_organizer_selectors": [".organizer", ".host"],
            "circle_container_selectors": ["tr", "li.circle", ".circle-item"],
            "circle_twitter_selectors": ['a[href*="twitter"]', 'a[href*="x.com"]'],
            "table_header_schemas": self.table_header_schemas,
        }

        self.pattern_manager.save_pattern(
            url=self.config.base_url,
            extraction_rules=extraction_rules,
            event_info=self.extracted_event,
            circles_sample=self.extracted_circles_sample,
        )

        self.logger.info(f"抽出パターンを保存しました: {self.config.base_url}")

    def _extract_circles_without_llm(self, soup: BeautifulSoup) -> List[Circle]:
        """LLMを使わずにサークル情報を抽出"""
        circles = []

        # カスタムセレクタがある場合
        if self.config.extractor_config.circle_selector:
            elements = soup.select(self.config.extractor_config.circle_selector)
            for elem in elements:
                circle = self._parse_circle_element(elem)
                if circle:
                    circles.append(circle)

        # テーブルベースの抽出
        else:
            tables = soup.find_all("table")
            for table in tables:
                circles.extend(self._extract_from_table(table))

        return circles

    def _parse_circle_element(self, elem) -> Optional[Circle]:
        """要素からサークル情報をパース"""
        circle = Circle(name="")

        # 名前の抽出
        if self.config.extractor_config.name_selector:
            name_elem = elem.select_one(self.config.extractor_config.name_selector)
            if name_elem:
                circle.name = name_elem.get_text(strip=True)
        else:
            # ヒューリスティックな抽出
            for tag in ["h1", "h2", "h3", "h4", "strong", "b"]:
                name_elem = elem.find(tag)
                if name_elem:
                    circle.name = name_elem.get_text(strip=True)
                    break

        # スペースの抽出
        text = elem.get_text()
        space_match = re.search(self.config.extractor_config.space_pattern, text)
        if space_match:
            circle.space = space_match.group()

        # URLの抽出
        for link in elem.find_all("a"):
            href = link.get("href", "")
            if re.match(self.config.extractor_config.twitter_pattern, href):
                circle.twitter_url = href
            elif href.startswith("http"):
                circle.website_url = href

        return circle if circle.name else None

    def _extract_from_table(self, table) -> List[Circle]:
        """テーブルからサークル情報を抽出"""
        circles = []
        headers = []

        # ヘッダー抽出
        header_row = table.find("tr")
        if header_row:
            headers = [
                th.get_text(strip=True) for th in header_row.find_all(["th", "td"])
            ]

        # データ行処理
        for row in table.find_all("tr")[1:]:
            cells = row.find_all(["td", "th"])
            if cells:
                circle_data = {}
                for i, cell in enumerate(cells):
                    if i < len(headers):
                        circle_data[headers[i]] = cell.get_text(strip=True)

                circle = self._create_circle_from_dict(circle_data)
                if circle:
                    circles.append(circle)

        return circles

    def _create_circle_from_dict(self, data: Dict[str, str]) -> Optional[Circle]:
        """辞書データからCircleオブジェクトを作成"""
        circle = Circle(name="")

        # キーワードベースのマッピング
        for key, value in data.items():
            key_lower = key.lower()

            if "サークル" in key or "circle" in key_lower or key == "団体名":
                circle.name = value
            elif "スペース" in key or "space" in key_lower or "配置" in key:
                circle.space = value
            elif "ホール" in key or "hall" in key_lower:
                circle.hall = value
            elif "ジャンル" in key or "genre" in key_lower:
                circle.genres = [value]
            elif "twitter" in key_lower or "x.com" in value:
                circle.twitter_url = value

        return circle if circle.name else None

    def _get_event_context(self, soup: BeautifulSoup) -> str:
        """イベント情報抽出用のコンテキストを取得"""
        # タイトル、ヘッダー、メタ情報を収集
        context_parts = []

        title = soup.find("title")
        if title:
            context_parts.append(f"<title>{title.get_text()}</title>")

        for h1 in soup.find_all("h1")[:3]:
            context_parts.append(f"<h1>{h1.get_text()}</h1>")

        meta_description = soup.find("meta", attrs={"name": "description"})
        if meta_description:
            context_parts.append(
                f"<meta description='{meta_description.get('content', '')}'/>"
            )

        return "\n".join(context_parts)

    def _get_circle_context(self, soup: BeautifulSoup) -> str:
        """サークル情報抽出用のコンテキストを取得"""
        # テーブルまたは主要コンテンツを取得
        tables = soup.find_all("table")
        if tables:
            # 最大のテーブル
            main_table = max(tables, key=lambda t: len(str(t)))
            return str(main_table)[:50000]

        # メインコンテンツエリアを探す
        main_content = soup.find("main") or soup.find(
            "div", class_=re.compile(r"content|main", re.I)
        )
        if main_content:
            return str(main_content)[:50000]

        return str(soup.body)[:50000] if soup.body else ""

    def _create_event_prompt(self, context: str) -> str:
        """イベント情報抽出用のプロンプトを作成"""
        if self.config.extractor_config.llm_prompt_template:
            return self.config.extractor_config.llm_prompt_template.format(
                context=context
            )

        return f"""
以下のHTMLからイベント情報を抽出してください。

HTML:
{context}

以下のJSON形式で返してください:
{{
    "name": "イベント名",
    "date": "開催日（ISO形式）",
    "venue": "会場",
    "organizer": "主催者"
}}

JSONのみを返してください。
"""

    def _create_circle_prompt(self, context: str) -> str:
        """サークル情報抽出用のプロンプトを作成"""
        return f"""
以下のHTMLからサークルリストの情報を抽出してください。

HTML:
{context}

以下のJSON形式で返してください:
{{
    "circles": [
        {{
            "name": "サークル名",
            "penname": "ペンネーム（作者名）",
            "space": "スペース番号",
            "hall": "ホール名",
            "twitter_url": "Twitter/X URL",
            "website_url": "WebサイトURL",
            "description": "説明",
            "genres": ["ジャンル1", "ジャンル2"]
        }}
    ]
}}

可能な限り多くのサークル情報を抽出してください。
JSONのみを返してください。
"""

    def _extract_title(self, soup: BeautifulSoup) -> str:
        """シンプルなタイトル抽出"""
        title = soup.find("title")
        if title:
            return title.get_text(strip=True)

        h1 = soup.find("h1")
        if h1:
            return h1.get_text(strip=True)

        return "イベント"

    def _is_circle_image(self, src: str, img_elem) -> bool:
        """サークル画像かどうか判定"""
        if not src:
            return False

        # ファイル拡張子チェック
        if not any(
            ext in src.lower() for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"]
        ):
            return False

        # サイズによる判定（小さすぎる画像を除外）
        width = img_elem.get("width")
        height = img_elem.get("height")
        if width and height:
            try:
                if int(width) < 50 or int(height) < 50:
                    return False
            except ValueError:
                pass

        # ファイル名による判定
        exclude_patterns = [
            "logo",
            "icon",
            "banner",
            "header",
            "footer",
            "button",
            "map",
        ]
        src_lower = src.lower()
        if any(pattern in src_lower for pattern in exclude_patterns):
            return False

        return True

    def _normalize_url(self, url: str) -> str:
        """URLを正規化"""
        if not url:
            return ""

        if url.startswith("http"):
            return url

        if url.startswith("//"):
            return "https:" + url

        if url.startswith("/"):
            base = "/".join(self.config.base_url.split("/")[:3])
            return base + url

        base = "/".join(self.config.base_url.split("/")[:-1])
        return base + "/" + url

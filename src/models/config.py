from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List
from enum import Enum

from ..utils.llm_attempts import (
    DEFAULT_IMAGE_FALLBACK_EFFORT,
    DEFAULT_IMAGE_FALLBACK_MODEL,
    DEFAULT_IMAGE_FALLBACK_PROVIDER,
    DEFAULT_IMAGE_PRIMARY_EFFORT,
    DEFAULT_IMAGE_PRIMARY_MODEL,
    DEFAULT_IMAGE_PRIMARY_PROVIDER,
    DEFAULT_TEXT_FALLBACK_EFFORT,
    DEFAULT_TEXT_FALLBACK_MODEL,
    DEFAULT_TEXT_FALLBACK_PROVIDER,
    DEFAULT_TEXT_PRIMARY_EFFORT,
    DEFAULT_TEXT_PRIMARY_MODEL,
    DEFAULT_TEXT_PRIMARY_PROVIDER,
)


class SiteType(Enum):
    """サイトタイプの列挙"""

    SOCKBASE = "sockbase"
    CIRCLE_MS = "circle_ms"
    COMITIA = "comitia"
    CUSTOM = "custom"


class OutputFormat(Enum):
    """出力フォーマットの列挙"""

    JSON = "json"


@dataclass
class ExtractorConfig:
    """データ抽出設定"""

    # CSS セレクタ
    circle_selector: Optional[str] = None
    name_selector: Optional[str] = None
    space_selector: Optional[str] = None

    # XPath
    circle_xpath: Optional[str] = None

    # 正規表現パターン
    space_pattern: Optional[str] = r"[あ-ん]-?\d+[ab]?|[A-Z]-?\d+[ab]?"
    twitter_pattern: Optional[str] = r"https?://(?:twitter\.com|x\.com)/\w+"

    # LLM プロンプトのカスタマイズ
    llm_prompt_template: Optional[str] = None

    # 画像抽出設定
    image_section_text: Optional[str] = None
    image_selector: Optional[str] = None

    # カスタム設定
    custom_config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class PaginationConfig:
    """ページネーション設定"""

    url_template: Optional[str] = None  # e.g. "https://example.com/circles?page={page}"
    start_page: int = 1
    max_pages: int = 50
    page_param: str = "page"


@dataclass
class SiteParsingConfig:
    """サイトパース専用の高性能モデル設定"""

    codex_model: str = DEFAULT_TEXT_FALLBACK_MODEL
    api_model: str = DEFAULT_TEXT_PRIMARY_MODEL
    reasoning_effort: str = DEFAULT_TEXT_PRIMARY_EFFORT  # none/minimal/low/medium/high/xhigh
    api_reasoning_effort: str = DEFAULT_TEXT_PRIMARY_EFFORT  # none/low/medium/high/xhigh
    prefer_cli: bool = True
    cli_timeout: int = 900


@dataclass
class SiteConfig:
    """サイト別設定"""

    site_type: SiteType
    base_url: str

    # ページ設定
    list_page_path: Optional[str] = None
    map_urls: List[str] = field(default_factory=list)

    # 抽出設定
    extractor_config: ExtractorConfig = field(default_factory=ExtractorConfig)

    # リクエスト設定
    headers: Dict[str, str] = field(
        default_factory=lambda: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
    )
    timeout: int = 30
    retry_count: int = 3

    # LLM設定
    use_llm: bool = True
    llm_model: str = DEFAULT_TEXT_PRIMARY_MODEL
    text_llm_provider: str = DEFAULT_TEXT_PRIMARY_PROVIDER
    text_llm_cli_models: Dict[str, str] = field(default_factory=dict)
    text_llm_cli_efforts: Dict[str, str] = field(default_factory=dict)
    text_llm_cli_timeout: int = 900
    api_reasoning_effort: str = DEFAULT_TEXT_PRIMARY_EFFORT
    api_reasoning_effort_map: Dict[str, str] = field(default_factory=dict)
    text_fallback_llm_provider: str = DEFAULT_TEXT_FALLBACK_PROVIDER
    text_fallback_llm_model: str = DEFAULT_TEXT_FALLBACK_MODEL
    text_fallback_llm_effort: str = DEFAULT_TEXT_FALLBACK_EFFORT
    image_llm_provider: str = DEFAULT_IMAGE_PRIMARY_PROVIDER
    image_llm_model: Optional[str] = DEFAULT_IMAGE_PRIMARY_MODEL
    image_llm_effort: str = DEFAULT_IMAGE_PRIMARY_EFFORT
    image_fallback_llm_provider: str = DEFAULT_IMAGE_FALLBACK_PROVIDER
    image_fallback_llm_model: str = DEFAULT_IMAGE_FALLBACK_MODEL
    image_fallback_llm_effort: str = DEFAULT_IMAGE_FALLBACK_EFFORT
    image_api_reasoning_effort_map: Dict[str, str] = field(default_factory=dict)

    @property
    def image_provider_kind(self) -> str:
        provider = self.image_llm_provider or DEFAULT_IMAGE_PRIMARY_PROVIDER
        return provider.split(":", 1)[0] if ":" in provider else "api"

    @property
    def image_llm_provider_name(self) -> str:
        provider = self.image_llm_provider or DEFAULT_IMAGE_PRIMARY_PROVIDER
        return provider.split(":", 1)[1] if ":" in provider else provider

    # サイトパース専用モデル設定（Codex CLI / GPT-5.6 API）
    site_parsing_config: Optional[SiteParsingConfig] = None

    # Cookie設定
    cookie_file: Optional[str] = None  # Netscape形式Cookieファイルパス

    # ページネーション設定
    pagination: Optional[PaginationConfig] = None

    # イベント情報設定
    catalog_additional_prompt: str = ""
    event_date: Optional[str] = None  # YYYY-MM-DD形式
    event_name: Optional[str] = None  # デスクトップアプリ側で入力されたイベント名

    def get_full_url(self, path: str = "") -> str:
        """完全なURLを生成"""
        if path.startswith("http"):
            return path
        if not path:
            return self.base_url
        return f"{self.base_url.rstrip('/')}/{path.lstrip('/')}"


@dataclass
class OutputConfig:
    """出力設定"""

    format: OutputFormat
    output_dir: str = ""

    # サークル画像スキップ（サイトにサークル画像がない場合）
    skip_circle_images: bool = False

    # ZIP設定
    create_zip: bool = True
    zip_compression: bool = True

    def get_output_path(self, filename: str) -> str:
        """出力ファイルパスを生成"""
        from pathlib import Path

        return str(Path(self.output_dir) / filename)

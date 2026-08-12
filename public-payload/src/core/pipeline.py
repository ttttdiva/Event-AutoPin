from typing import Optional, List, Dict, Any
from pathlib import Path
import logging
from datetime import datetime
from collections import Counter
from bs4 import BeautifulSoup

import requests as _requests

from ..models import Circle, CircleImage, Event, SiteConfig, OutputConfig
from ..utils import Downloader, setup_logger, ProgressLogger
from ..utils.circle_master import CircleMasterManager
from ..utils.catalog_image_analyzer import CatalogImageAnalyzer
from ..utils.cookie_loader import load_cookies_for_url
from ..utils.llm_attempts import api_models_from_attempts, build_image_llm_attempts
from .base_adapter import BaseSiteAdapter
from .base_formatter import BaseOutputFormatter

# アイテムタグ → サークルジャンル のマッピング（デスクトップアプリのCIRCLE_GENRESに合わせる）
_TAG_TO_GENRE = {
    "新刊(漫画)": "漫画",
    "新刊(イラスト)": "イラスト",
    "小説": "小説",
    "合同誌": "漫画",
    "雑誌": "雑誌",
    "音楽": "音楽",
    "グッズ": "グッズ",
    "その他": "その他",
}
_GENRE_PRIORITY = ["音楽", "漫画", "イラスト", "小説", "雑誌", "グッズ", "その他"]


def _infer_genre(items: List[Dict[str, Any]]) -> str:
    """アイテムリストからサークルジャンルを決定"""
    genres = [_TAG_TO_GENRE[i["type"]] for i in items if i.get("type") in _TAG_TO_GENRE]
    if not genres:
        return ""
    counts = Counter(genres)
    max_count = max(counts.values())
    top = [g for g, c in counts.items() if c == max_count]
    for g in _GENRE_PRIORITY:
        if g in top:
            return g
    return top[0]


class ExtractionPipeline:
    """データ抽出パイプライン"""

    def __init__(
        self,
        site_config: SiteConfig,
        output_config: OutputConfig,
        adapter: BaseSiteAdapter,
        formatter: BaseOutputFormatter,
        logger: Optional[logging.Logger] = None,
    ):
        self.site_config = site_config
        self.output_config = output_config
        self.adapter = adapter
        self.formatter = formatter
        self.logger = logger or setup_logger()

        # Cookie読み込み
        cookies = load_cookies_for_url(
            site_config.base_url,
            cookie_file=site_config.cookie_file,
        )
        if cookies:
            self.logger.info(f"Cookieを読み込みました ({len(cookies)} cookies)")
        else:
            self.logger.info(
                "Cookieなし（cookies/ディレクトリにファイルが見つかりません）"
            )

        # ユーティリティの初期化
        self.downloader = Downloader(
            headers=site_config.headers,
            timeout=site_config.timeout,
            retry_count=site_config.retry_count,
            cookies=cookies,
        )
        self.circle_master = CircleMasterManager()

        # APIアダプター（Picrea等）にセッションを渡す
        if hasattr(adapter, "session"):
            adapter.session = self.downloader.session

        # 出力ディレクトリの準備
        self.output_dir = Path(output_config.output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(self) -> Dict[str, Any]:
        """パイプラインを実行"""
        self.logger.info("=== サークルリスト生成開始 ===")
        start_time = datetime.now()

        try:
            # 1. HTML取得（ページネーション対応）
            html_pages = self._fetch_all_pages()

            # 2. HTMLパース（最初のページ）
            soup = BeautifulSoup(html_pages[0], "html.parser")

            # 3. イベント情報抽出
            event = self._extract_event_info(soup)

            # 3.5. デスクトップアプリ側で入力されたイベント名・日付で上書き
            if self.site_config.event_name:
                self.logger.info(
                    f"イベント名を設定値で上書き: {self.site_config.event_name}"
                )
                event.name = self.site_config.event_name
            if self.site_config.event_date:
                try:
                    event.date = datetime.strptime(
                        self.site_config.event_date, "%Y-%m-%d"
                    )
                    self.logger.info(
                        f"イベント日付を設定値で上書き: {self.site_config.event_date}"
                    )
                except ValueError:
                    self.logger.warning(
                        f"イベント日付のパースに失敗: {self.site_config.event_date}"
                    )

            # 4. サークル情報抽出（全ページ）
            circles = []
            for i, html in enumerate(html_pages):
                page_soup = soup if i == 0 else BeautifulSoup(html, "html.parser")
                page_circles = self._extract_circles(page_soup)
                circles.extend(page_circles)
                if len(html_pages) > 1:
                    self.logger.info(f"ページ {i+1}: {len(page_circles)}サークル抽出")

            # 5. 画像URL抽出・ダウンロード
            if not self.output_config.skip_circle_images:
                self._process_images(soup, circles)
            else:
                self.logger.info(
                    "サークル画像取得をスキップ（デフォルトカットのみ使用）"
                )
                self._apply_default_cuts(circles)

            # 5.5. サークルカット未設定 & おしながき画像ありのサークルをデフォルトカットに登録
            self._register_missing_cuts_as_default(circles)

            # 5.6. おしながき画像からサークルジャンルを判定・保存
            self._detect_and_save_genres(circles)

            # 6. マップ画像ダウンロード
            self._download_maps(event)

            # 7. データフォーマット・保存
            output_files = self._format_and_save(circles, event)

            # 完了
            duration = (datetime.now() - start_time).total_seconds()
            self.logger.info(f"=== 処理完了 (処理時間: {duration:.1f}秒) ===")

            return {
                "success": True,
                "event": event.to_dict(),
                "event_obj": event,  # Twitter処理用にオブジェクトも返す
                "circles": circles,  # Twitter処理用にサークルリストも返す
                "circle_count": len(circles),
                "output_files": output_files,
                "duration": duration,
            }

        except Exception as e:
            self.logger.error(f"パイプライン実行エラー: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "duration": (datetime.now() - start_time).total_seconds(),
            }

    def _fetch_html(self) -> str:
        """HTMLを取得（単一ページ）"""
        self.logger.info("HTMLを取得中...")

        url = self.site_config.get_full_url(self.site_config.list_page_path or "")
        html_content = self.downloader.fetch_content(url)

        if not html_content:
            raise ValueError(f"HTMLの取得に失敗しました: {url}")

        # 前処理
        html_content = self.adapter.preprocess_html(html_content)

        self.logger.info(f"HTML取得完了: {len(html_content)} 文字")
        return html_content

    def _fetch_all_pages(self) -> List[str]:
        """ページネーション設定に基づいて全ページのHTMLを取得"""
        pagination = self.site_config.pagination
        if not pagination or not pagination.url_template:
            return [self._fetch_html()]

        import time

        pages = []
        template = pagination.url_template
        self.logger.info(f"ページネーション取得開始: {template}")

        for page_num in range(
            pagination.start_page, pagination.start_page + pagination.max_pages
        ):
            url = template.format(page=page_num)
            self.logger.info(f"ページ {page_num} を取得中: {url}")

            html = self.downloader.fetch_content(url)
            if not html:
                self.logger.info(f"ページ {page_num}: レスポンスなし、取得終了")
                break

            html = self.adapter.preprocess_html(html)

            # 空ページの検出（サークルデータがない場合は終了）
            soup = BeautifulSoup(html, "html.parser")
            has_candidate_table = self.adapter.has_candidate_circle_table(soup)
            if page_num > pagination.start_page and not has_candidate_table:
                # 最初のページ以降でサークルが見つからなければ終了
                self.logger.info(f"ページ {page_num}: サークルデータなし、取得終了")
                break

            pages.append(html)
            time.sleep(0.5)  # レート制限対策

        self.logger.info(f"ページネーション完了: {len(pages)}ページ取得")
        return pages

    def _extract_event_info(self, soup: BeautifulSoup) -> Event:
        """イベント情報を抽出"""
        self.logger.info("イベント情報を抽出中...")

        event = self.adapter.extract_event_info(soup)

        self.logger.info(f"イベント名: {event.name}")
        return event

    def _extract_circles(self, soup: BeautifulSoup) -> List[Circle]:
        """サークル情報を抽出"""
        self.logger.info("サークル情報を抽出中...")

        circles = self.adapter.extract_circles(soup)

        # 検証
        errors = self.adapter.validate_extraction(circles)
        if errors:
            for error in errors:
                self.logger.warning(f"抽出検証: {error}")

        self.logger.info(f"抽出されたサークル数: {len(circles)}")
        return circles

    def _process_images(self, soup: BeautifulSoup, circles: List[Circle]):
        """画像を処理"""
        self.logger.info("サークル画像を処理中...")

        # 画像URLを抽出
        image_urls = self.adapter.extract_circle_images(soup)

        if not image_urls:
            self.logger.warning(
                "サークル画像が見つかりませんでした。デフォルトカットを確認します..."
            )

            # 画像URLが見つからない場合、すべてのサークルにデフォルトカットを適用
            for index, circle in enumerate(circles):
                default_cut_path = self.circle_master.copy_default_cut(
                    circle.name, self.output_dir, prefix=f"{index:04d}_default_"
                )
                if default_cut_path:
                    circle.circle_cut = type(
                        "CircleImage",
                        (),
                        {"url": "", "filename": default_cut_path.name},
                    )()
                    self.logger.info(f"標準カットを使用: {circle.name}")
            return

        # ダウンロードタスクを準備
        download_tasks = []
        index_to_filename = {}  # インデックスとファイル名の対応を記憶

        for index, url in image_urls:
            filename = f"{index:04d}.jpg"
            output_path = self.output_dir / filename
            download_tasks.append((url, output_path, f"サークル画像 {index}"))
            index_to_filename[index] = (url, filename)

        # 並行ダウンロード
        progress = ProgressLogger(self.logger, len(download_tasks), "画像ダウンロード ")
        results = self.downloader.download_multiple(download_tasks)

        # ダウンロード処理と標準カットのフォールバック
        for index, (url, filename) in index_to_filename.items():
            if index < len(circles):
                if results.get(url, False):
                    # ダウンロードが成功した場合
                    circles[index].circle_cut = (
                        circles[index].circle_cut
                        or type("CircleImage", (), {"url": url, "filename": filename})()
                    )
                else:
                    # ダウンロードに失敗した場合、標準カットを確認
                    circle = circles[index]
                    default_cut_path = self.circle_master.copy_default_cut(
                        circle.name, self.output_dir, prefix=f"{index:04d}_default_"
                    )
                    if default_cut_path:
                        circles[index].circle_cut = type(
                            "CircleImage",
                            (),
                            {"url": "", "filename": default_cut_path.name},
                        )()
                        self.logger.info(f"標準カットを使用: {circle.name}")

        # 画像URLがなかったサークルにもデフォルトカットを適用
        for index, circle in enumerate(circles):
            if circle.circle_cut is None and index not in index_to_filename:
                default_cut_path = self.circle_master.copy_default_cut(
                    circle.name, self.output_dir, prefix=f"{index:04d}_default_"
                )
                if default_cut_path:
                    circle.circle_cut = type(
                        "CircleImage",
                        (),
                        {"url": "", "filename": default_cut_path.name},
                    )()
                    self.logger.info(f"標準カットを使用（画像URLなし）: {circle.name}")

    def _apply_default_cuts(self, circles: List[Circle]):
        """全サークルにデフォルトカットを適用"""
        for index, circle in enumerate(circles):
            default_cut_path = self.circle_master.copy_default_cut(
                circle.name, self.output_dir, prefix=f"{index:04d}_default_"
            )
            if default_cut_path:
                circle.circle_cut = type(
                    "CircleImage", (), {"url": "", "filename": default_cut_path.name}
                )()

    def _detect_and_save_genres(self, circles: List[Circle]):
        """item_imagesを持つサークルのおしながき画像を解析してジャンルを設定する。
        すでにジャンルが設定済みのサークルはスキップする。"""
        targets = []
        for circle in circles:
            if not circle.item_images:
                continue
            if self.circle_master.get_genre(circle.name):
                continue
            # catalog_ プレフィックス画像を優先
            catalog_imgs = [img for img in circle.item_images if "catalog_" in img.path]
            best = catalog_imgs[0] if catalog_imgs else circle.item_images[0]
            img_path = self.output_dir / best.path
            if img_path.exists():
                targets.append((circle, img_path))

        if not targets:
            return

        self.logger.info(f"おしながき画像からジャンルを判定中... ({len(targets)}件)")

        image_attempts = build_image_llm_attempts(
            self.site_config.image_llm_provider,
            self.site_config.image_llm_model or self.site_config.llm_model,
            self.site_config.image_llm_effort,
            self.site_config.image_fallback_llm_provider,
            self.site_config.image_fallback_llm_model,
            self.site_config.image_fallback_llm_effort,
        )
        has_image_cli = any(attempt.get("kind") == "cli" for attempt in image_attempts)
        analyzer = CatalogImageAnalyzer(
            model=api_models_from_attempts(image_attempts),
            use_cli=has_image_cli,
            api_reasoning_effort=self.site_config.image_llm_effort,
            api_reasoning_effort_map=self.site_config.image_api_reasoning_effort_map,
            attempts=image_attempts,
        )

        detected = 0
        for circle, img_path in targets:
            items = analyzer.analyze_catalog_items(img_path)
            genre = _infer_genre(items)
            if genre:
                self.circle_master.set_genre(circle.name, genre)
                detected += 1
                self.logger.info(f"  ジャンル判定: {circle.name} → {genre}")

        if detected > 0:
            self.circle_master.save()
            self.logger.info(f"✅ {detected}サークルのジャンルを設定しました")

    def _register_missing_cuts_as_default(self, circles: List[Circle]):
        """サークルカット未設定でおしながき画像があるサークルをデフォルトカットに登録"""
        registered = 0
        for circle in circles:
            if circle.circle_cut:
                continue
            if not circle.item_images:
                continue
            item_path = self.output_dir / circle.item_images[0].path
            penname = circle.penname or ""
            if self.circle_master.register_default_cut(circle.name, penname, item_path):
                circle.circle_cut = CircleImage(
                    url="", filename=circle.item_images[0].path
                )
                registered += 1
        if registered > 0:
            self.logger.info(
                f"✅ {registered}サークルのおしながき画像をデフォルトカットに登録しました"
            )

    def _download_maps(self, event: Event):
        """マップ画像をダウンロード"""
        if not event.maps:
            return

        self.logger.info("マップ画像をダウンロード中...")

        download_tasks = []
        for map_info in event.maps:
            output_path = self.output_dir / map_info.filename
            download_tasks.append(
                (map_info.url, output_path, f"マップ {map_info.map_number}")
            )

        self.downloader.download_multiple(download_tasks)

    def _format_and_save(self, circles: List[Circle], event: Event) -> Dict[str, str]:
        """データをフォーマットして保存"""
        self.logger.info("データをフォーマット中...")

        # event.jsonスキーマに変換
        data = self.formatter.format_data(circles, event)

        # 検証
        errors = self.formatter.validate_output(data)
        if errors:
            for error in errors:
                self.logger.warning(f"出力検証: {error}")

        # event.jsonとして保存
        output_path = self.formatter.save(data, "event.json")

        self.logger.info(f"データ保存完了: {output_path}")

        return {
            "data": output_path,
        }

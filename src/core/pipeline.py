from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
import logging
from datetime import datetime
from collections import Counter
import hashlib
import os
import shutil
import tempfile
import warnings
from bs4 import BeautifulSoup
from PIL import Image, ImageOps

import requests as _requests

from ..models import Circle, CircleImage, Event, SiteConfig, OutputConfig
from ..utils import Downloader, setup_logger
from ..utils.circle_master import CircleMasterManager
from ..utils.catalog_image_analyzer import CatalogImageAnalyzer
from ..utils.cookie_loader import load_cookies_for_url
from ..utils.llm_attempts import api_models_from_attempts, build_image_llm_attempts
from ..utils.circle_cut_vision import (
    CIRCLE_CUT_DOWNLOAD_TIMEOUT_SECONDS,
    CIRCLE_CUT_VISION_TIMEOUT_SECONDS,
    MAX_CIRCLE_CUT_IMAGE_BYTES,
    CircleCutAsset,
    CircleCutVisionJudge,
    build_circle_cut_model_attempts,
    contains_credentialed_url,
    inspect_circle_cut_assets,
)
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
_MAX_CIRCLE_CUT_IMAGE_PIXELS = 25_000_000
_MAX_CIRCLE_CUT_IMAGE_EDGE = 2048


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


def _normalize_circle_cut_image(source_path: Path, output_path: Path) -> Optional[str]:
    """Decode and normalize an untrusted image before model upload/use."""

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source_path) as image:
                if image.format not in {"JPEG", "PNG", "WEBP", "GIF", "BMP"}:
                    raise ValueError("unsupported image format")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > _MAX_CIRCLE_CUT_IMAGE_PIXELS:
                    raise ValueError("image dimensions exceed limit")
                image.seek(0)
                image = ImageOps.exif_transpose(image.copy())
                image.thumbnail(
                    (_MAX_CIRCLE_CUT_IMAGE_EDGE, _MAX_CIRCLE_CUT_IMAGE_EDGE),
                    Image.Resampling.LANCZOS,
                )
                if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                    background.alpha_composite(rgba)
                    image = background.convert("RGB")
                else:
                    image = image.convert("RGB")
                image.save(output_path, format="JPEG", quality=88, optimize=True)
        if output_path.stat().st_size > MAX_CIRCLE_CUT_IMAGE_BYTES:
            raise ValueError("normalized image exceeds limit")
        return hashlib.sha256(output_path.read_bytes()).hexdigest()
    except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        try:
            output_path.unlink(missing_ok=True)
        except OSError:
            pass
        return None


def _has_site_image_credentials(site_config: SiteConfig, cookies: Any) -> bool:
    """Avoid sending images fetched with site credentials to an external model."""

    if cookies or contains_credentialed_url(site_config.base_url):
        return True
    headers = site_config.headers or {}
    sensitive_markers = (
        "authorization",
        "cookie",
        "token",
        "secret",
        "password",
        "api-key",
        "apikey",
    )
    return any(
        marker in str(name).casefold().replace("_", "-")
        for name in headers
        for marker in sensitive_markers
    )


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
        self._has_site_credentials = _has_site_image_credentials(site_config, cookies)
        self._circle_image_validation: Optional[Dict[str, Any]] = None

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
            circle_page_contexts: List[Tuple[BeautifulSoup, int, int]] = []
            for i, html in enumerate(html_pages):
                page_soup = soup if i == 0 else BeautifulSoup(html, "html.parser")
                page_start = len(circles)
                page_circles = self._extract_circles(page_soup)
                circles.extend(page_circles)
                circle_page_contexts.append(
                    (page_soup, page_start, len(page_circles))
                )
                if len(html_pages) > 1:
                    self.logger.info(f"ページ {i+1}: {len(page_circles)}サークル抽出")

            # 5. 画像URL抽出・ダウンロード
            if not self.output_config.skip_circle_images:
                self._process_images(circle_page_contexts, circles)
            else:
                self.logger.info(
                    "サークル画像取得をスキップ（デフォルトカットのみ使用）"
                )
                self._apply_default_cuts(circles)
                self._circle_image_validation = {
                    "status": "skipped_by_config",
                    "candidate_count": 0,
                    "downloaded_count": 0,
                    "sampled_count": 0,
                    "model_call_count": 0,
                    "first": {"status": "not_checked", "reason": "skip_circle_images"},
                    "second": {"status": "not_checked", "reason": "skip_circle_images"},
                    "last": {"status": "not_checked", "reason": "skip_circle_images"},
                }

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
                "circle_image_validation": self._circle_image_validation,
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

    def _process_images(self, page_contexts: Any, circles: List[Circle]):
        """Download adapter candidates, sample them visually, and preserve indices."""
        self.logger.info("サークル画像を処理中...")

        if isinstance(page_contexts, BeautifulSoup):
            page_contexts = [(page_contexts, 0, len(circles))]

        # Keep adapter order and map each page-local index to its original circle.
        image_urls: List[Tuple[int, int, int, str]] = []
        for page_index, (page_soup, page_offset, page_circle_count) in enumerate(
            page_contexts
        ):
            for local_index, url in self.adapter.extract_circle_images(page_soup) or []:
                if not isinstance(local_index, int) or not isinstance(url, str) or not url:
                    continue
                if local_index < 0 or local_index >= page_circle_count:
                    continue
                circle_index = page_offset + local_index
                if circle_index >= len(circles):
                    continue
                image_urls.append((circle_index, page_index, local_index, url))

        if not image_urls:
            self.logger.warning(
                "サークル画像が見つかりませんでした。デフォルトカットを確認します..."
            )
            self._circle_image_validation = self._empty_circle_cut_validation(
                candidate_count=0,
                reason="no_images",
            )
            self._apply_default_cuts(circles)
            return

        candidate_count = len(image_urls)
        selected_urls = [
            (order, circle_index, page_index, source_index, url)
            for order, (circle_index, page_index, source_index, url) in enumerate(
                image_urls, start=1
            )
        ]

        # Download each URL once, normalize it before model use, and retain all
        # original circle mappings for duplicate URL/hash aliases.
        assets: List[CircleCutAsset] = []
        downloaded_by_url: Dict[str, Tuple[Path, str, Optional[str]]] = {}
        download_failure_by_url: Dict[str, str] = {}
        download_failure_candidates: List[Dict[str, Any]] = []
        per_circle_candidate_number: Dict[int, int] = {}
        for order, circle_index, page_index, source_index, url in selected_urls:
            candidate_number = per_circle_candidate_number.get(circle_index, 0) + 1
            per_circle_candidate_number[circle_index] = candidate_number
            filename = (
                f"{circle_index:04d}.jpg"
                if candidate_number == 1
                else f"{circle_index:04d}_candidate_{candidate_number:02d}.jpg"
            )
            output_path = self.output_dir / filename
            if url in downloaded_by_url:
                source_path, image_hash, blocked_reason = downloaded_by_url[url]
                if not image_hash:
                    download_failure_candidates.append(
                        {
                            "candidate_order": order,
                            "circle_index": circle_index,
                            "source_page_index": page_index,
                            "source_index": source_index,
                            "reason": download_failure_by_url.get(
                                url, "download_failed"
                            ),
                        }
                    )
                    continue
                if source_path != output_path:
                    shutil.copyfile(source_path, output_path)
            else:
                temp_handle, temp_name = tempfile.mkstemp(
                    prefix=".circlecut-", suffix=".download", dir=self.output_dir
                )
                os.close(temp_handle)
                Path(temp_name).unlink(missing_ok=True)
                try:
                    ok, download_reason = self.downloader.download_file_limited(
                        url,
                        Path(temp_name),
                        max_bytes=MAX_CIRCLE_CUT_IMAGE_BYTES,
                        timeout_seconds=CIRCLE_CUT_DOWNLOAD_TIMEOUT_SECONDS,
                        max_total_seconds=CIRCLE_CUT_DOWNLOAD_TIMEOUT_SECONDS,
                    )
                    if not ok:
                        download_failure_by_url[url] = download_reason
                        download_failure_candidates.append(
                            {
                                "candidate_order": order,
                                "circle_index": circle_index,
                                "source_page_index": page_index,
                                "source_index": source_index,
                                "reason": download_reason,
                            }
                        )
                        downloaded_by_url[url] = (Path(), "", None)
                        continue
                    image_hash = _normalize_circle_cut_image(Path(temp_name), output_path)
                    if not image_hash:
                        download_failure_by_url[url] = "invalid_image"
                        download_failure_candidates.append(
                            {
                                "candidate_order": order,
                                "circle_index": circle_index,
                                "source_page_index": page_index,
                                "source_index": source_index,
                                "reason": "invalid_image",
                            }
                        )
                        downloaded_by_url[url] = (Path(), "", None)
                        continue
                    blocked_reason = (
                        "privacy_authenticated_source"
                        if self._has_site_credentials
                        else "credentialed_image_url"
                        if contains_credentialed_url(url)
                        else None
                    )
                    downloaded_by_url[url] = (output_path, image_hash, blocked_reason)
                finally:
                    try:
                        Path(temp_name).unlink(missing_ok=True)
                        Path(temp_name + ".part").unlink(missing_ok=True)
                    except OSError:
                        pass
                if not downloaded_by_url[url][1]:
                    continue

            _, image_hash, blocked_reason = downloaded_by_url[url]
            assets.append(
                CircleCutAsset(
                    order=order,
                    circle_index=circle_index,
                    url=url,
                    image_path=output_path,
                    image_hash=image_hash,
                    blocked_reason=blocked_reason,
                    source_page_index=page_index,
                    source_index=source_index,
                )
            )

        attempts = build_circle_cut_model_attempts(self.site_config)
        unique_image_count = len({asset.image_hash for asset in assets})
        model_call_budget = unique_image_count * len(attempts)
        judge = CircleCutVisionJudge(
            attempts,
            api_reasoning_effort_map=self.site_config.image_api_reasoning_effort_map,
            max_model_calls=model_call_budget,
            timeout_seconds=CIRCLE_CUT_VISION_TIMEOUT_SECONDS,
        )
        inspection = inspect_circle_cut_assets(assets, judge)
        rejected_hashes = {
            image_hash
            for image_hash, verdict in inspection.verdicts_by_hash.items()
            if verdict.decision is False
        }

        # A sampled negative excludes all URL aliases with identical image
        # content. Unsampled candidates keep legacy behavior but stay visible as
        # unverified in the run summary.
        asset_by_index: Dict[int, CircleCutAsset] = {}
        for asset in assets:
            if asset.image_hash in rejected_hashes:
                try:
                    asset.image_path.unlink(missing_ok=True)
                except OSError:
                    pass
                if circles[asset.circle_index].circle_cut:
                    circles[asset.circle_index].circle_cut = None
                continue
            asset_by_index.setdefault(asset.circle_index, asset)

        for circle_index, asset in asset_by_index.items():
            circle = circles[circle_index]
            circle.circle_cut = circle.circle_cut or CircleImage(
                url=asset.url,
                filename=asset.image_path.name,
            )

        # Preserve the existing default-cut fallback for missing, failed, or
        # visually rejected candidates.
        for index, circle in enumerate(circles):
            if circle.circle_cut is not None:
                continue
            default_cut_path = self.circle_master.copy_default_cut(
                circle.name, self.output_dir, prefix=f"{index:04d}_default_"
            )
            if default_cut_path:
                circle.circle_cut = CircleImage(url="", filename=default_cut_path.name)
                self.logger.info(f"標準カットを使用: {circle.name}")

        unique_hashes = {asset.image_hash for asset in assets}
        classified_hashes = {
            image_hash
            for image_hash, verdict in inspection.verdicts_by_hash.items()
            if verdict.decision is not None
        }
        if not assets and candidate_count:
            download_status = (
                download_failure_candidates[0]["reason"]
                if download_failure_candidates
                else "no_downloaded_images"
            )
            first_failure = (
                download_failure_candidates[0]
                if download_failure_candidates
                else {}
            )
            first_result = {
                "status": "download_failed",
                "candidate_order": first_failure.get("candidate_order"),
                "circle_index": first_failure.get("circle_index"),
                "source_page_index": first_failure.get("source_page_index"),
                "source_index": first_failure.get("source_index"),
                "reason": download_status,
            }
            second_result = {
                "status": "not_checked",
                "candidate_order": None,
                "reason": "no_first_cut",
            }
            last_result = dict(first_result)
        else:
            first_result = inspection.first
            second_result = inspection.second
            last_result = inspection.last

        failed_orders = [item["candidate_order"] for item in download_failure_candidates]
        first_order = first_result.get("candidate_order")
        if first_result.get("status") == "found" and first_order is not None:
            missed_before_first = [
                item
                for item in download_failure_candidates
                if item["candidate_order"] < first_order
            ]
            if missed_before_first:
                missed = min(missed_before_first, key=lambda item: item["candidate_order"])
                first_result = {
                    "status": "incomplete",
                    "candidate_order": missed["candidate_order"],
                    "circle_index": missed["circle_index"],
                    "source_page_index": missed["source_page_index"],
                    "source_index": missed["source_index"],
                    "reason": "download_failed_before_first_positive",
                    "positive_candidate_order": first_order,
                }
        elif failed_orders and first_result.get("status") in {"not_found", "no_candidates"}:
            missed = min(
                download_failure_candidates,
                key=lambda item: item["candidate_order"],
            )
            first_result = {
                "status": "incomplete",
                "candidate_order": missed["candidate_order"],
                "circle_index": missed["circle_index"],
                "source_page_index": missed["source_page_index"],
                "source_index": missed["source_index"],
                "reason": "download_failed_during_first_search",
            }

        if first_order is not None and second_result.get("status") in {
            "found",
            "not_found",
        }:
            second_order = second_result.get("candidate_order")
            missed_before_second = [
                item
                for item in download_failure_candidates
                if item["candidate_order"] > first_order
                and (second_order is None or item["candidate_order"] < second_order)
            ]
            if missed_before_second:
                missed = min(
                    missed_before_second,
                    key=lambda item: item["candidate_order"],
                )
                second_result = {
                    "status": "incomplete",
                    "candidate_order": missed["candidate_order"],
                    "circle_index": missed["circle_index"],
                    "source_page_index": missed["source_page_index"],
                    "source_index": missed["source_index"],
                    "reason": "download_failed_during_second_search",
                    "positive_candidate_order": second_order,
                }

        tail_failures = [
            item
            for item in download_failure_candidates
            if item["candidate_order"] == candidate_count
        ]
        if tail_failures:
            tail_failure = tail_failures[-1]
            last_result = {
                "status": "download_failed",
                "candidate_order": candidate_count,
                "circle_index": tail_failure["circle_index"],
                "source_page_index": tail_failure["source_page_index"],
                "source_index": tail_failure["source_index"],
                "reason": tail_failure["reason"],
                "last_downloaded_candidate_order": last_result.get("candidate_order"),
            }

        self._circle_image_validation = {
            "status": "sampled" if inspection.model_call_count else "unverified",
            "candidate_count": candidate_count,
            "downloaded_count": len(assets),
            "unique_downloaded_count": len(unique_hashes),
            "sampled_count": len(set(inspection.sampled_orders)),
            "unverified_downloaded_count": max(0, len(unique_hashes - classified_hashes)),
            "unfetched_count": max(0, candidate_count - len(assets)),
            "model_call_count": inspection.model_call_count,
            "model_call_limit": model_call_budget,
            "first": first_result,
            "second": second_result,
            "last": last_result,
            "download_failures": len(download_failure_candidates),
            "download_failure_reasons": sorted(
                {item["reason"] for item in download_failure_candidates}
            ),
            "download_failure_candidates": download_failure_candidates,
        }
        self.logger.info(
            "サークル画像の視覚確認: "
            f"候補 {candidate_count} 件、実画像 {len(assets)} 件、"
            f"モデル判定 {self._circle_image_validation['sampled_count']} 件 / "
            f"呼出 {inspection.model_call_count} 回、未検証 "
            f"{self._circle_image_validation['unverified_downloaded_count']} 件、"
            f"先頭={first_result['status']}({first_result['reason']}), "
            f"2枚目={second_result['status']}({second_result['reason']}), "
            f"末尾={last_result['status']}({last_result['reason']})"
        )

    @staticmethod
    def _empty_circle_cut_validation(candidate_count: int, reason: str) -> Dict[str, Any]:
        empty = {"status": "not_checked", "candidate_order": None, "reason": reason}
        return {
            "status": "unverified",
            "candidate_count": candidate_count,
            "downloaded_count": 0,
            "sampled_count": 0,
            "model_call_count": 0,
            "first": dict(empty),
            "second": dict(empty),
            "last": dict(empty),
        }

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

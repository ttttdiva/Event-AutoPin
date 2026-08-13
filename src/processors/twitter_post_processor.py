"""
Twitter Post Processor
パイプライン実行後にTwitter情報を追加処理する
"""

import asyncio
import re
from typing import List, Dict, Any, Optional
from datetime import datetime
from pathlib import Path
import json
from concurrent.futures import ThreadPoolExecutor
import time

from ..models import Circle, Event, ItemImage
from ..utils.twitter_extractor import TwitterExtractor
from ..utils.logger import setup_logger
from ..utils.progress_logger import ProgressLogger
from ..utils.catalog_image_analyzer import CatalogImageAnalyzer
from ..utils.url_validation import normalize_twitter_profile_url
from ..utils.llm_attempts import (
    api_models_from_attempts,
    build_image_llm_attempts,
    build_text_llm_attempts,
)

logger = setup_logger(__name__)


class TwitterConfig:
    """Twitter処理の設定"""
    def __init__(self, config_dict: Dict[str, Any]):
        self.enabled = config_dict.get('enabled', False)
        self.days_before_event = config_dict.get('days_before_event', 30)
        self.days_after_event = config_dict.get('days_after_event', 7)
        self.max_workers = 1
        self.rate_limit_seconds = config_dict.get('rate_limit_seconds', 2)
        raw_model = config_dict.get('model', 'gemini-pro')
        self.model = (
            [m.strip() for m in raw_model.split(',') if m.strip()]
            if isinstance(raw_model, str) and ',' in raw_model
            else raw_model
        )  # モデル名を直接指定
        self.output_dir = config_dict.get('output_dir', 'twitter_catalogs')
        self.debug_limit = config_dict.get('debug_limit', None)  # デバッグ用の処理数制限
        self.additional_prompt = config_dict.get('catalog_additional_prompt', '')  # 追加プロンプト
        self.event_date = config_dict.get('event_date')  # YYYY-MM-DD形式
        self.use_grok_search = config_dict.get('use_grok_search', False)
        self.image_llm_provider = config_dict.get('image_llm_provider') or 'api:gemini'
        if ':' in self.image_llm_provider:
            self.image_provider_kind, self.image_llm_provider_name = self.image_llm_provider.split(':', 1)
        else:
            self.image_provider_kind = 'api'
            self.image_llm_provider_name = self.image_llm_provider
        self.image_llm_model = config_dict.get('image_llm_model') or (
            self.model[0] if isinstance(self.model, list) else self.model
        )
        self.image_llm_effort = config_dict.get(
            'image_llm_effort',
            config_dict.get('api_reasoning_effort', 'medium'),
        )
        self.image_fallback_llm_provider = (
            config_dict.get('image_fallback_llm_provider') or 'openai'
        )
        if ':' in self.image_fallback_llm_provider:
            _, self.image_fallback_llm_provider_name = (
                self.image_fallback_llm_provider.split(':', 1)
            )
        else:
            self.image_fallback_llm_provider_name = self.image_fallback_llm_provider
        self.image_fallback_llm_model = (
            config_dict.get('image_fallback_llm_model') or 'gpt-5-mini'
        )
        self.image_fallback_llm_effort = (
            config_dict.get('image_fallback_llm_effort') or 'medium'
        )
        self.image_api_reasoning_effort_map = config_dict.get(
            'image_api_reasoning_effort_map',
            {},
        )
        text_provider = config_dict.get('text_llm_provider', 'api')
        self.text_llm_provider = text_provider
        self.text_llm_cli_models = config_dict.get('text_llm_cli_models', {})
        self.text_llm_cli_efforts = config_dict.get('text_llm_cli_efforts', {})
        self.text_fallback_llm_provider = (
            config_dict.get('text_fallback_llm_provider') or 'cli:codex'
        )
        self.text_fallback_llm_model = (
            config_dict.get('text_fallback_llm_model') or 'gpt-5.5'
        )
        self.text_fallback_llm_effort = (
            config_dict.get('text_fallback_llm_effort') or 'medium'
        )
        text_cli_providers = (
            [text_provider]
            if text_provider and text_provider != 'api'
            else []
        )
        self.tweet_llm_cli_providers = config_dict.get(
            'tweet_llm_cli_providers',
            text_cli_providers,
        )
        self.tweet_llm_cli_models = config_dict.get(
            'tweet_llm_cli_models',
            config_dict.get('text_llm_cli_models', {}),
        )
        self.tweet_llm_cli_efforts = config_dict.get(
            'tweet_llm_cli_efforts',
            config_dict.get('text_llm_cli_efforts', {}),
        )
        self.tweet_llm_cli_timeout = config_dict.get('tweet_llm_cli_timeout', 900)
        self.skip_catalog_image_analysis = bool(
            config_dict.get('skip_catalog_image_analysis', False)
        )
        self.api_reasoning_effort = config_dict.get('api_reasoning_effort', 'medium')
        self.api_reasoning_effort_map = config_dict.get(
            'api_reasoning_effort_map',
            {},
        )


class TwitterPostProcessor:
    """パイプライン実行後のTwitter処理"""

    def __init__(self, config: TwitterConfig):
        """
        初期化

        Args:
            config: Twitter処理設定
        """
        self.config = config
        # event_dateから日付文字列を自動生成し、additional_promptに付加
        from src.utils.date_utils import format_event_date_jp
        date_jp = format_event_date_jp(config.event_date) if config.event_date else None
        if date_jp and config.additional_prompt:
            self.effective_additional_prompt = f"{date_jp}\n{config.additional_prompt}"
        elif date_jp:
            self.effective_additional_prompt = date_jp
        else:
            self.effective_additional_prompt = config.additional_prompt
        text_primary_model = (
            config.model[0] if isinstance(config.model, list) and config.model else config.model
        )
        text_attempts = build_text_llm_attempts(
            config.text_llm_provider,
            text_primary_model,
            config.text_llm_cli_models,
            config.text_llm_cli_efforts,
            config.text_fallback_llm_provider,
            config.text_fallback_llm_model,
            config.text_fallback_llm_effort,
        )
        self.twitter_extractor = TwitterExtractor(
            model=api_models_from_attempts(text_attempts),
            additional_prompt=config.additional_prompt,
            event_date=config.event_date,
            cli_providers=config.tweet_llm_cli_providers,
            cli_model_map=config.tweet_llm_cli_models,
            cli_effort_map=config.tweet_llm_cli_efforts,
            cli_timeout=config.tweet_llm_cli_timeout,
            reasoning_effort=config.api_reasoning_effort,
            api_reasoning_effort_map=config.api_reasoning_effort_map,
            attempts=text_attempts,
        )
        self.progress = ProgressLogger()
        image_attempts = build_image_llm_attempts(
            config.image_llm_provider,
            config.image_llm_model,
            config.image_llm_effort,
            config.image_fallback_llm_provider,
            config.image_fallback_llm_model,
            config.image_fallback_llm_effort,
        )
        has_image_cli = any(attempt.get("kind") == "cli" for attempt in image_attempts)
        self.catalog_analyzer = CatalogImageAnalyzer(
            model=api_models_from_attempts(image_attempts),
            use_cli=has_image_cli,
            api_reasoning_effort=config.image_llm_effort,
            api_reasoning_effort_map=config.image_api_reasoning_effort_map,
            attempts=image_attempts,
        )
        self.output_path = Path(config.output_dir)
        self.output_path.mkdir(exist_ok=True)
        self._post_reprocess_cache: Dict[str, Dict[str, Any]] = {}
        self.last_run_summary: Dict[str, Any] = {
            "status": "not_started",
            "target_count": 0,
            "processed_count": 0,
            "failed_count": 0,
            "invalid_url_count": 0,
            "reason": None,
        }

        # Grok検索クライアントの初期化
        self.grok_client = None
        if config.use_grok_search:
            try:
                from ..utils.grok_search_client import GrokSearchClient
                self.grok_client = GrokSearchClient()
                logger.info("Grok search client initialized")
            except Exception as e:
                logger.warning(f"Grok検索の初期化に失敗（twscrapeにフォールバック）: {e}")

    @staticmethod
    def _extract_tweet_id_from_url(post_url: str) -> Optional[str]:
        match = re.search(r"(?:twitter\.com|x\.com)/[^/]+/status(?:es)?/(\d+)", str(post_url))
        return match.group(1) if match else None

    @staticmethod
    def _extract_username_from_url(twitter_url: str) -> Optional[str]:
        normalized = normalize_twitter_profile_url(twitter_url)
        return normalized.rsplit("/", 1)[-1] if normalized else None

    def _apply_catalog_detail(self, circle: Circle, detail: Dict[str, Any]) -> None:
        if detail.get('classification') == 'preview':
            circle.catalog_status = 'preview'
            logger.info(f"Circle {circle.name} classified as preview")
        else:
            circle.catalog_status = 'confirmed'

        if detail.get('is_existing_only', False) and detail.get('existing_only_confidence', 0) >= 0.7:
            circle.existing_only_status = '既刊のみ'
            logger.info(f"Circle {circle.name} marked as existing-only")

        detected_genre = detail.get('genre', '')
        if detected_genre:
            circle._detected_genre = detected_genre

        product_types = detail.get('product_types', []) or []
        circle._product_types = list(product_types) if isinstance(product_types, list) else []

    def _apply_direct_post_cache(
        self,
        circle: Circle,
        cached: Dict[str, Any],
        post_url: str,
    ) -> None:
        if cached.get("catalog_status"):
            circle.catalog_status = cached["catalog_status"]
        if cached.get("existing_only_status"):
            circle.existing_only_status = cached["existing_only_status"]
        if cached.get("detected_genre"):
            circle._detected_genre = cached["detected_genre"]
        product_types = cached.get("product_types", [])
        circle._product_types = list(product_types) if isinstance(product_types, list) else []
        if cached.get("items") and not circle.items:
            circle.items = self._default_items_to_skipped(cached["items"])
        if cached.get("item_images"):
            circle.item_images = [
                ItemImage(path=img["path"], source=img.get("source", "twitter"))
                for img in cached["item_images"]
                if img.get("path")
            ]
        if post_url and post_url not in (circle.memo or ""):
            memo_prefix = circle.memo + "\n" if circle.memo else ""
            circle.memo = memo_prefix + post_url

    def _cache_direct_post_result(self, tweet_id: str, circle: Circle) -> None:
        self._post_reprocess_cache[tweet_id] = {
            "catalog_status": circle.catalog_status,
            "existing_only_status": circle.existing_only_status,
            "detected_genre": getattr(circle, "_detected_genre", None),
            "product_types": list(getattr(circle, "_product_types", []) or []),
            "items": self._default_items_to_skipped(circle.items),
            "item_images": [
                {"path": img.path, "source": img.source}
                for img in circle.item_images
            ],
        }

    @staticmethod
    def _default_items_to_skipped(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for item in items:
            data = dict(item)
            if data.get("checked") is None:
                data["checked"] = 3
            normalized.append(data)
        return normalized

    @staticmethod
    def _catalog_item_key(item: Dict[str, Any]) -> tuple:
        name = re.sub(r"\s+", "", str(item.get("name", ""))).lower()
        item_type = re.sub(r"\s+", "", str(item.get("type", ""))).lower()
        if name:
            return ("name", name, item_type)
        try:
            price = int(item.get("price", 0) or 0)
        except (TypeError, ValueError):
            price = 0
        return ("fallback", item_type, price)

    def _merge_catalog_items(
        self,
        image_items: List[Dict[str, Any]],
        text_items: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        merged = self._default_items_to_skipped(image_items)
        index_by_key = {
            self._catalog_item_key(item): index
            for index, item in enumerate(merged)
        }

        for text_item in self._default_items_to_skipped(text_items):
            key = self._catalog_item_key(text_item)
            existing_index = index_by_key.get(key)
            if existing_index is None:
                index_by_key[key] = len(merged)
                merged.append(text_item)
                continue

            merged[existing_index] = {
                **merged[existing_index],
                **{k: v for k, v in text_item.items() if v not in (None, "")},
            }

        return merged

    async def _consolidate_catalog_items(
        self,
        items: List[Dict[str, Any]],
        event_name: str = "",
    ) -> List[Dict[str, Any]]:
        if len(items) < 2:
            return items

        llm_client = getattr(getattr(self, "twitter_extractor", None), "llm_client", None)
        consolidate = getattr(llm_client, "consolidate_catalog_items", None)
        if not callable(consolidate):
            return items

        loop = asyncio.get_event_loop()
        try:
            consolidated = await loop.run_in_executor(
                None,
                consolidate,
                items,
                event_name,
            )
        except Exception as e:
            logger.warning(f"Failed to consolidate catalog items for {event_name}: {e}")
            return items

        if not consolidated:
            return items
        return self._default_items_to_skipped(consolidated)

    async def _merge_text_items_into_circle(
        self,
        circle: Circle,
        text_items: List[Dict[str, Any]],
        event_name: str = "",
    ) -> bool:
        if not text_items:
            return False
        before = json.dumps(circle.items, ensure_ascii=False, sort_keys=True)
        merged = self._merge_catalog_items(circle.items, text_items)
        circle.items = await self._consolidate_catalog_items(merged, event_name)
        after = json.dumps(circle.items, ensure_ascii=False, sort_keys=True)
        logger.info(
            f"Merged {len(text_items)} text-derived items for {circle.name}; total={len(circle.items)}"
        )
        changed = before != after
        if self._apply_default_item_image(circle, overwrite=False):
            changed = True
        return changed

    @staticmethod
    def _first_item_image_path(circle: Circle) -> Optional[str]:
        for image in circle.item_images:
            if image.path:
                return image.path
        return None

    def _apply_default_item_image(
        self,
        circle: Circle,
        overwrite: bool = False,
        replace_paths: Optional[set] = None,
    ) -> bool:
        image_path = self._first_item_image_path(circle)
        if not image_path:
            return False

        changed = False
        for item in circle.items:
            if not isinstance(item, dict):
                continue
            current_image = item.get("image")
            if overwrite or not current_image or (replace_paths and current_image in replace_paths):
                if item.get("image") != image_path:
                    item["image"] = image_path
                    changed = True
        return changed

    async def process_circles(self, circles: List[Circle], event: Event, debug_limit: int = None) -> List[Circle]:
        """
        サークルリストにTwitter情報を追加

        Args:
            circles: サークルリスト
            event: イベント情報
            debug_limit: デバッグ用に処理するサークル数を制限

        Returns:
            更新されたサークルリスト
        """
        self.last_run_summary = {
            "status": "running",
            "target_count": 0,
            "processed_count": 0,
            "failed_count": 0,
            "invalid_url_count": 0,
            "reason": None,
        }
        if not self.config.enabled:
            logger.info("Twitter processing is disabled")
            self.last_run_summary["status"] = "disabled"
            return circles

        logger.info(f"Starting Twitter processing for {len(circles)} circles")
        if self.grok_client:
            logger.info("Mode: Grok x_search (with twscrape fallback)")
        else:
            logger.info("Mode: twscrape + LLM")

        # Twitter URLを持つサークルのみフィルター
        circles_with_twitter = []
        invalid_url_count = 0
        for circle in circles:
            if not circle.twitter_url:
                continue
            normalized = normalize_twitter_profile_url(circle.twitter_url)
            if not normalized:
                logger.warning(
                    f"Invalid Twitter profile URL for {circle.name}: {circle.twitter_url}"
                )
                circle.twitter_url = None
                invalid_url_count += 1
                continue
            circle.twitter_url = normalized
            circles_with_twitter.append(circle)
        logger.info(f"Found {len(circles_with_twitter)} circles with Twitter URLs")
        self.last_run_summary["invalid_url_count"] = invalid_url_count

        # デバッグモードの場合は処理数を制限
        if debug_limit or self.config.debug_limit:
            limit = debug_limit or self.config.debug_limit
            logger.info(f"Debug mode: limiting to {limit} circles")
            circles_with_twitter = circles_with_twitter[:limit]

        self.last_run_summary["target_count"] = len(circles_with_twitter)

        if not circles_with_twitter:
            logger.warning("No circles with Twitter URLs found")
            self.last_run_summary["status"] = "no_targets"
            return circles

        # プログレスバーの初期化
        self.progress.start_task("Twitter processing", len(circles_with_twitter))

        # イベント日時を取得（優先順位: config.event_date → event.date → additional_prompt）
        logger.info(f"Event info: name={event.name}, date={event.date}, venue={event.venue}")
        event_date = None
        if self.config.event_date:
            event_date = self._parse_event_date(self.config.event_date)
            if event_date:
                logger.info(f"config.event_dateからイベント日付を取得: {event_date}")
        if not event_date:
            event_date = self._parse_event_date(event.date)
        if not event_date:
            event_date = self._parse_event_date(self.config.additional_prompt)
            if event_date:
                logger.info(f"additional_promptからイベント日付を取得: {event_date}")
        if not event_date:
            logger.error("イベント日付を特定できません。config.yamlのcatalog_additional_promptに開催日を記載してください。")
            self.last_run_summary.update(
                status="failed",
                failed_count=len(circles_with_twitter),
                reason="イベント日付を特定できません",
            )
            return circles
        logger.info(f"Parsed event date: {event_date}")

        # X/Twitter scraping uses account rotation and checked-tweet bookkeeping.
        # Keep this sequential so per-circle state cannot be mixed.
        results = []
        for i, circle in enumerate(circles_with_twitter):
            processing_error = None
            try:
                results.append(
                    await self._process_single_circle(
                        circle,
                        event_date,
                        event.name,
                        i,
                    )
                )
            except Exception as e:
                results.append(e)
                processing_error = e

            if processing_error is not None:
                self.last_run_summary.update(
                    status="failed",
                    processed_count=i,
                    failed_count=len(circles_with_twitter) - i,
                    reason=f"{type(processing_error).__name__}: {processing_error}",
                )
                logger.error(
                    "X/Twitterクロールを中断しました: "
                    f"処理済み {i}/{len(circles_with_twitter)}件, "
                    f"未処理 {len(circles_with_twitter) - i}件, "
                    f"理由={type(processing_error).__name__}: {processing_error}"
                )
                break

            unavailable_reason = getattr(
                self.twitter_extractor, "_twscrape_unavailable_reason", None
            )
            if unavailable_reason:
                self.last_run_summary.update(
                    status="failed",
                    processed_count=i,
                    failed_count=len(circles_with_twitter) - i,
                    reason=f"twscrape: {unavailable_reason}",
                )
                logger.error(
                    "X/Twitterクロールを中断しました: "
                    f"処理済み {i}/{len(circles_with_twitter)}件, "
                    f"未処理 {len(circles_with_twitter) - i}件, "
                    f"理由={unavailable_reason}"
                )
                break

        # 結果を統合
        circle_map = {c.name: c for c in circles}

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"Error processing circle {circles_with_twitter[i].name}: {result}")
                continue
            elif isinstance(result, Circle):
                # 更新されたサークル情報を反映
                circle_map[result.name] = result

        # 元の順序を保持して返す
        updated_circles = [circle_map.get(c.name, c) for c in circles]

        self.progress.end_task()

        # 処理結果をサマリー
        self._print_summary(updated_circles)

        if self.last_run_summary["status"] == "running":
            self.last_run_summary.update(
                status="ok",
                processed_count=len(circles_with_twitter),
                failed_count=0,
            )

        return updated_circles

    async def _process_single_circle(
        self,
        circle: Circle,
        event_date: datetime,
        event_name: str,
        index: int
    ) -> Circle:
        """単一のサークルのTwitter情報を処理"""
        try:
            self.progress.update_progress(circle.name)

            # Twitter URLからユーザー名を抽出
            username = self._extract_username_from_url(circle.twitter_url)
            if not username:
                logger.warning(f"Invalid Twitter URL for {circle.name}: {circle.twitter_url}")
                return circle

            # レート制限対策
            await asyncio.sleep(self.config.rate_limit_seconds)

            # Grokモード or twscrapeモード
            if self.grok_client:
                try:
                    return await self._process_with_grok(circle, username, event_date, event_name)
                except Exception as e:
                    logger.warning(f"Grok検索に失敗（twscrapeにフォールバック）: {circle.name}: {e}")
                    return await self._process_with_twscrape(circle, username, event_date, event_name)
            else:
                return await self._process_with_twscrape(circle, username, event_date, event_name)

        except Exception as e:
            logger.error(f"Error processing circle {circle.name}: {e}")
            raise

    async def _process_with_grok(
        self,
        circle: Circle,
        username: str,
        event_date: datetime,
        event_name: str,
    ) -> Circle:
        """Grok x_search を使ったサークル処理"""
        result = await self.grok_client.search_catalog_tweet(
            username=username,
            event_name=event_name,
            event_date=event_date,
            days_before=self.config.days_before_event,
            days_after=self.config.days_after_event,
            additional_prompt=self.effective_additional_prompt,
        )

        if not result.get("found"):
            logger.info(f"Grok: お品書きツイートなし - {circle.name} (@{username})")
            return circle

        # 欠席判定
        if result.get("is_absence"):
            circle.absence_status = "欠席"
            logger.info(f"Grok: 欠席 - {circle.name} (reason: {result.get('reason', '')})")
            return circle

        # 既刊のみ判定
        if result.get("is_existing_only"):
            circle.existing_only_status = "既刊のみ"
            logger.info(f"Grok: 既刊のみ - {circle.name} (reason: {result.get('reason', '')})")

        # 予告判定
        if result.get("is_preview"):
            circle.catalog_status = "preview"
            logger.info(f"Grok: おしながき予告 - {circle.name} (reason: {result.get('reason', '')})")
        else:
            circle.catalog_status = "confirmed"

        tweet_url = result.get("tweet_url")
        tweet_id = result.get("tweet_id")

        # チェック済みツイートIDを記録
        if tweet_id:
            circle._checked_tweet_ids = [int(tweet_id)]

        # ジャンル判定結果を反映
        detected_genre = result.get("genre", "")
        if detected_genre:
            circle._detected_genre = detected_genre
        product_types = result.get("product_types", []) or []
        circle._product_types = list(product_types) if isinstance(product_types, list) else []

        # ツイートURLをメモに追加
        if tweet_url:
            memo_prefix = circle.memo + "\n" if circle.memo else ""
            circle.memo = memo_prefix + tweet_url
            logger.info(f"Grok: お品書き発見 - {circle.name} -> {tweet_url}")

        # 予告の場合は画像DLをスキップ（確定版でないため）
        if circle.catalog_status == "preview":
            return circle

        # ツイートから画像を取得してダウンロード
        if tweet_id:
            media_urls = await self._fetch_tweet_media(tweet_id)
            if media_urls:
                await self._download_and_process_images(circle, media_urls)
            else:
                logger.info(f"Grok: 画像なし - {circle.name}")

        return circle

    async def _process_with_twscrape(
        self,
        circle: Circle,
        username: str,
        event_date: datetime,
        event_name: str,
    ) -> Circle:
        """従来のtwscrape + LLMを使ったサークル処理"""
        # skip_tweet_ids を取得（再処理時に設定される）
        skip_tweet_ids = getattr(circle, '_skip_tweet_ids', None)

        # お品書きツイートを抽出
        catalog_tweets = await self.twitter_extractor.extract_catalog_tweets(
            username=username,
            event_date=event_date,
            days_before=self.config.days_before_event,
            days_after=self.config.days_after_event,
            event_name=event_name,
            skip_tweet_ids=skip_tweet_ids
        )

        # チェック済みツイートIDを記録（checked_tweets.json更新用）
        checked_ids = list(getattr(catalog_tweets, 'checked_tweet_ids', []))
        # 既存のskip_tweet_idsも合わせて保存（以前のチェック分も含める）
        existing_ids = skip_tweet_ids or []
        circle._checked_tweet_ids = list(set(existing_ids + checked_ids))

        # おしながきツイートと欠席ツイートを分離
        absence_tweets = [t for t in catalog_tweets if t.get('is_absence', False)]
        catalog_only_tweets = [t for t in catalog_tweets if not t.get('is_absence', False)]

        # おしながきツイートが一切見つからず、欠席ツイートのみの場合
        if not catalog_only_tweets and absence_tweets:
            # 欠席ツイートがイベント関連か判定（イベント名が含まれるか）
            event_related_absence = False
            for tweet in absence_tweets:
                if event_name and event_name.lower() in tweet['text'].lower():
                    event_related_absence = True
                    break

            if event_related_absence:
                circle.absence_status = '欠席'
                logger.info(f"Circle {circle.name} marked as absent (event-related)")
                return circle

        # おしながきツイートがない場合（欠席でもない）
        if not catalog_only_tweets:
            logger.info(f"No catalog tweets found for {circle.name}")
            return circle

        # ベストツイートを特定（バッチ判定で is_best フラグが付いている場合はそれを使用）
        best_tweets = [t for t in catalog_only_tweets if t.get('is_best')]
        if best_tweets:
            best_tweet = best_tweets[0]
            logger.info(f"Using batch-selected best tweet for {circle.name}")
        else:
            best_tweet = catalog_only_tweets[0]

        # 統合LLM判定: 分類（確定/予告）+ 既刊のみ + 頒布物種別を1回で判定
        loop = asyncio.get_event_loop()
        detail = await loop.run_in_executor(
            None,
            self.twitter_extractor.llm_client.analyze_catalog_tweet_detail,
            best_tweet['text'],
            event_name
        )

        self._apply_catalog_detail(circle, detail)

        # お品書きツイートのURLをメモに記載（欠席ツイートを除外）
        catalog_urls = [tweet['url'] for tweet in catalog_only_tweets]
        if catalog_urls:
            memo_prefix = circle.memo + "\n" if circle.memo else ""
            circle.memo = memo_prefix + "\n".join(catalog_urls)
            logger.info(f"Added catalog tweet URLs to memo for {circle.name}")

        # 予告の場合は画像DLをスキップ
        if circle.catalog_status == 'preview':
            return circle

        # お品書き画像をダウンロード（best_tweetを優先、なければ他の候補から）
        image_downloaded = False
        if best_tweet.get('media'):
            image_downloaded = await self._download_and_process_images(
                circle,
                best_tweet['media'],
                failure_context="best tweet",
            )

        if not image_downloaded:
            for tweet in catalog_only_tweets:
                if tweet is best_tweet:
                    continue  # best_tweetは既に試した
                if tweet['media']:
                    if await self._download_and_process_images(
                        circle,
                        tweet['media'],
                        failure_context="catalog tweet",
                    ):
                        break

        text_items = await loop.run_in_executor(
            None,
            self.twitter_extractor.llm_client.extract_catalog_items_from_text,
            best_tweet['text'],
            event_name,
        )
        if await self._merge_text_items_into_circle(circle, text_items, event_name):
            if not circle.catalog_status or circle.catalog_status == "preview":
                circle.catalog_status = "confirmed"

        return circle

    async def process_circle_from_post_url(
        self,
        circle: Circle,
        post_url: str,
        event_name: str = "",
        use_text_detail: bool = False,
    ) -> bool:
        """memoなどに残っているX投稿URLを直接再処理する"""
        tweet_id = self._extract_tweet_id_from_url(post_url)
        if not tweet_id:
            logger.warning(f"Invalid post URL for direct reprocess: {post_url}")
            return False

        cached = self._post_reprocess_cache.get(tweet_id)
        if cached:
            self._apply_direct_post_cache(circle, cached, post_url)
            return True

        tweet_detail = await self._fetch_tweet_detail(tweet_id)
        updated = False

        if post_url and post_url not in (circle.memo or ""):
            memo_prefix = circle.memo + "\n" if circle.memo else ""
            circle.memo = memo_prefix + post_url

        media_urls = list(tweet_detail.get("media_urls", []))
        previous_item_images = list(circle.item_images)
        previous_item_image_paths = {
            img.path for img in previous_item_images if img.path
        }
        image_processed_any = False
        if media_urls:
            circle.item_images = []

        for img_url in media_urls:
            image_processed = await self._download_and_process_image(circle, img_url)
            if image_processed:
                image_processed_any = True
                updated = True
            if image_processed and circle.items:
                if not circle.catalog_status:
                    circle.catalog_status = "confirmed"
            if image_processed and not circle.items:
                logger.warning(f"No items detected from image for {circle.name}: {img_url}")
            elif not image_processed:
                logger.warning(f"Failed to download image for {circle.name}: {img_url}")
        if media_urls and not image_processed_any:
            circle.item_images = previous_item_images
        elif image_processed_any:
            if self._apply_default_item_image(
                circle,
                overwrite=False,
                replace_paths=previous_item_image_paths,
            ):
                updated = True

        tweet_text = tweet_detail.get("text", "")
        detail_error = False
        if use_text_detail and tweet_text:
            loop = asyncio.get_event_loop()
            detail = await loop.run_in_executor(
                None,
                self.twitter_extractor.llm_client.analyze_catalog_tweet_detail,
                tweet_text,
                event_name,
            )
            detail_error = bool(detail.get("error"))
            if not detail_error:
                previous_status = circle.catalog_status
                previous_existing_only = circle.existing_only_status
                previous_product_types = list(getattr(circle, "_product_types", []) or [])
                self._apply_catalog_detail(circle, detail)
                if (
                    circle.catalog_status != previous_status
                    or circle.existing_only_status != previous_existing_only
                    or list(getattr(circle, "_product_types", []) or []) != previous_product_types
                ):
                    updated = True

                if circle.catalog_status == "preview":
                    if not circle.items:
                        self._cache_direct_post_result(tweet_id, circle)
                        return True

            text_items = await loop.run_in_executor(
                None,
                self.twitter_extractor.llm_client.extract_catalog_items_from_text,
                tweet_text,
                event_name,
            )
            if await self._merge_text_items_into_circle(circle, text_items, event_name):
                if not circle.catalog_status or circle.catalog_status == "preview":
                    circle.catalog_status = "confirmed"
                updated = True
            if image_processed_any and self._apply_default_item_image(
                circle,
                overwrite=False,
                replace_paths=previous_item_image_paths,
            ):
                updated = True

        if circle.items and (circle.item_images or updated):
            if circle.catalog_status == "preview":
                circle.catalog_status = "confirmed"
            self._cache_direct_post_result(tweet_id, circle)
            return True
        if use_text_detail and tweet_text and circle.catalog_status == "confirmed" and not detail_error:
            circle.catalog_status = "no_extractable_items"
            self._cache_direct_post_result(tweet_id, circle)
            return True
        return updated or bool(circle.items)

    async def _fetch_tweet_detail(self, tweet_id: str) -> Dict[str, Any]:
        """twscrapeでツイート1件を取得し、本文とメディアURLを返す"""
        try:
            await self.twitter_extractor.initialize()
            api = self.twitter_extractor._get_next_api_instance()
            tweet = await api.tweet_details(int(tweet_id))
            if not tweet:
                return {}

            media_urls: List[str] = []
            media = getattr(tweet, "media", None)
            photos = getattr(media, "photos", None) if media else None
            if photos:
                media_urls = [
                    photo.url
                    for photo in photos
                    if getattr(photo, "url", None)
                ]

            return {
                "text": (
                    getattr(tweet, "rawContent", None)
                    or getattr(tweet, "text", None)
                    or getattr(tweet, "content", None)
                    or ""
                ),
                "url": getattr(tweet, "url", None) or "",
                "media_urls": media_urls,
            }
        except Exception as e:
            logger.warning(f"ツイート {tweet_id} の取得に失敗: {e}")
        return {}

    async def _fetch_tweet_media(self, tweet_id: str) -> List[str]:
        """twscrape でツイート1件を取得し、メディアURLリストを返す"""
        tweet_detail = await self._fetch_tweet_detail(tweet_id)
        if tweet_detail:
            return list(tweet_detail.get("media_urls", []))
        return []

    async def _download_and_process_images(
        self,
        circle: Circle,
        img_urls: List[str],
        failure_context: str = "tweet",
    ) -> bool:
        image_downloaded = False
        for img_url in img_urls:
            if await self._download_and_process_image(circle, img_url):
                image_downloaded = True
            else:
                logger.warning(
                    f"Failed to download image from {failure_context} for {circle.name}: {img_url}"
                )
        return image_downloaded

    async def _download_and_process_image(self, circle: Circle, img_url: str) -> bool:
        """お品書き画像をダウンロード・分析・リサイズしてサークル情報を更新"""
        original_filename = img_url.split('/')[-1]
        filename = f"catalog_{original_filename}"

        image_path = await self.twitter_extractor.download_catalog_image(
            img_url, self.output_path, filename
        )

        if not image_path or not Path(image_path).exists():
            return False

        image_name = Path(image_path).name
        loop = asyncio.get_event_loop()

        # お品書き画像からアイテム情報を抽出（リサイズ前）
        detected_items = []
        if self.config.skip_catalog_image_analysis:
            logger.info(
                f"Skipped catalog image analysis for {circle.name}: {Path(image_path).name}"
            )
        else:
            detected_items = await loop.run_in_executor(
                None,
                self.catalog_analyzer.analyze_catalog_items,
                Path(image_path)
            )

        # itemsリストに設定（name, type, price を含む）
        if detected_items:
            for item in detected_items:
                if isinstance(item, dict) and not item.get("image"):
                    item["image"] = image_name
            circle.items = self._merge_catalog_items(circle.items, detected_items)
            names = [i.get('name') or i.get('type', '?') for i in detected_items]
            logger.info(f"Detected {len(detected_items)} items for {circle.name}: {', '.join(names)}")

            # 画像解析結果からジャンルを推定（テキスト分析より信頼度が高い）
            image_genre = self._infer_genre_from_items(detected_items)
            if image_genre:
                circle._detected_genre = image_genre
                logger.info(f"画像解析からジャンル推定: {circle.name} -> {image_genre}")

        # アイテム画像として設定
        image_key = (image_name, 'twitter')
        existing_images = {
            (img.path, img.source)
            for img in circle.item_images
        }
        if image_key not in existing_images:
            circle.item_images.append(ItemImage(path=image_name, source='twitter'))
        logger.info(f"Downloaded and processed catalog image for {circle.name}: {Path(image_path).name}")
        return True

    @staticmethod
    def _infer_genre_from_items(items: List[Dict[str, Any]]) -> Optional[str]:
        """
        画像解析で得たアイテム情報からサークルのジャンルを推定する。
        優先順: 漫画 > イラスト > 小説 > 雑誌(合同誌含む) > 音楽 > グッズ > その他
        「新刊(漫画)+グッズ」のような複合の場合、本業を優先。
        """
        types = {item.get('type', '') for item in items if item.get('type')}
        if not types:
            return None

        if '新刊(漫画)' in types:
            return '漫画'

        if '新刊(イラスト)' in types:
            return 'イラスト'

        if '小説' in types:
            return '小説'

        # 合同誌・雑誌はどちらも「雑誌」として扱う
        if '合同誌' in types or '雑誌' in types:
            return '雑誌'

        if '音楽' in types:
            return '音楽'

        if 'グッズ' in types:
            return 'グッズ'

        if 'その他' in types:
            return 'その他'

        return None

    def _parse_event_date(self, date_input) -> Optional[datetime]:
        """
        イベント日付文字列またはdatetimeオブジェクトを処理

        Args:
            date_input: 日付文字列またはdatetimeオブジェクト

        Returns:
            datetime オブジェクト
        """
        # date_inputがNoneの場合
        if not date_input:
            logger.warning("Event date is None or empty, using current date")
            return datetime.now()

        # すでにdatetimeオブジェクトの場合はそのまま返す
        if isinstance(date_input, datetime):
            return date_input

        # 文字列に変換
        date_str = str(date_input)

        # 複数の日付フォーマットを試す
        formats = [
            "%Y-%m-%d",
            "%Y/%m/%d",
            "%Y年%m月%d日",
            "%Y.%m.%d"
        ]

        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt)
            except (ValueError, TypeError):
                continue

        # 日付部分のみ抽出を試みる
        date_match = re.search(r'(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})', date_str)
        if date_match:
            year, month, day = map(int, date_match.groups())
            return datetime(year, month, day)

        return None

    def _sanitize_filename(self, name: str) -> str:
        """ファイル名に使用できない文字を置換"""
        # Windowsで使用できない文字を置換
        name = re.sub(r'[<>:"|?*\\]', '_', name)
        # スラッシュをアンダースコアに置換
        name = name.replace('/', '_')
        # 連続するスペースを一つに
        name = re.sub(r'\s+', ' ', name)
        # 先頭と末尾のスペースを削除
        return name.strip()

    def _print_summary(self, circles: List[Circle]):
        """処理結果のサマリーを表示"""
        total = len(circles)
        with_items = len([c for c in circles if c.items])
        with_images = len([c for c in circles if c.item_images])
        absent = len([c for c in circles if c.memo and '欠席' in c.memo])

        logger.info("\n=== Twitter Processing Summary ===")
        logger.info(f"Total circles: {total}")
        logger.info(f"Circles with items: {with_items}")
        logger.info(f"Circles with catalog images: {with_images}")
        logger.info(f"Absent/Consignment: {absent}")
        logger.info(f"Output directory: {self.config.output_dir}")
        logger.info("=================================\n")

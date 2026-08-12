#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
サークルリスト生成ツール - メインエントリポイント
様々なイベントサイトからサークル情報を抽出し、指定フォーマットで出力する
"""

import sys
import os
from pathlib import Path
import yaml
import argparse
import json
from typing import Dict, Any, Union, List, Optional
from dotenv import load_dotenv

from src.models import SiteConfig, OutputConfig, OutputFormat, ExtractorConfig
from src.models.config import SiteParsingConfig, PaginationConfig
from src.adapters import AdapterFactory
from src.formatters import FormatterFactory
from src.core import ExtractionPipeline
from src.utils import setup_logger, LLMClient, ProgressLogger
from src.utils.api_cost_tracker import get_cost_tracker
from src.utils.llm_attempts import (
    api_models_from_attempts,
    build_text_llm_attempts,
)
from src.processors import TwitterPostProcessor, TwitterConfig
from src.utils.pattern_manager import PatternManager
from src.utils.json_reprocessor import JSONReprocessor
from src.utils.output_cleanup import protected_output_entry_names


class CircleListGenerator:
    """サークルリスト生成ツールのメインクラス"""

    def __init__(self, config_path: str = "config.yaml"):
        """初期化"""
        # 環境変数を読み込み
        load_dotenv(override=True)

        # 設定ファイルを読み込み
        self.config = self._load_config(config_path)

        # ロガーをセットアップ（ファイルログ有効）
        output_dir = self.config["output_dir"]
        log_dir = str(Path(output_dir) / "logs")
        self.logger = setup_logger(
            log_level=os.environ.get("LOG_LEVEL", "INFO"), log_dir=log_dir
        )

        self.logger.info("サークルリスト生成ツール初期化完了")
        # GUI/CLIへ返す座標生成の機械可読な診断。既存の event.json 契約には
        # 影響させず、bridge が必要に応じて結果を返せるようにする。
        self.coordinate_generation_summary: Dict[str, Any] = {
            "status": "not_requested",
            "attempted": 0,
            "succeeded": 0,
            "failed": 0,
            "total_updated": 0,
            "maps": [],
        }

    def _get_model_config(self) -> Union[str, List[str]]:
        """モデル設定を取得（単一または複数モデル対応）"""
        # 新形式: models リスト
        if "models" in self.config and isinstance(self.config["models"], list):
            models = self.config["models"][:3]  # 最大3つまで
            if models:
                self.logger.info(f"複数モデル設定を使用: {models}")
                return models

        # 従来形式: model 文字列
        model = self.config.get("model", "gpt-5.6-sol")
        self.logger.info(f"単一モデル設定を使用: {model}")
        return model

    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """設定ファイルを読み込み"""
        config_file = Path(config_path)
        if not config_file.exists():
            raise FileNotFoundError(f"設定ファイルが見つかりません: {config_path}")

        with open(config_file, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)

    def _create_site_config(self) -> SiteConfig:
        """サイト設定を作成"""
        # URLからサイトタイプを自動検出
        url = self.config.get("url", "")
        site_type = AdapterFactory.detect_site_type(url)
        self.logger.info(f"サイトタイプを自動検出: {site_type.value}")

        # map_url / map_urls をmap_urlsリストに変換
        map_urls = []
        raw_map_urls = self.config.get("map_urls")
        if isinstance(raw_map_urls, list):
            map_urls.extend(str(url).strip() for url in raw_map_urls if str(url).strip())
        if self.config.get("map_url"):
            map_url = str(self.config["map_url"]).strip()
            if map_url and map_url not in map_urls:
                map_urls.append(map_url)

        # エクストラクタ設定（デフォルト）
        extractor_config = ExtractorConfig()

        # モデル設定を取得（単一または複数）
        models = self._get_model_config()

        # サイトパース専用モデル設定
        site_parsing_config = None
        sp_raw = self.config.get("site_parsing")
        if sp_raw and isinstance(sp_raw, dict):
            site_reasoning_effort = sp_raw.get(
                "reasoning_effort",
                sp_raw.get("api_reasoning_effort", "medium"),
            )
            site_parsing_config = SiteParsingConfig(
                codex_model=sp_raw.get("codex_model", "gpt-5.4"),
                api_model=sp_raw.get("api_model", "gpt-5.6-sol"),
                reasoning_effort=site_reasoning_effort,
                api_reasoning_effort=site_reasoning_effort,
                prefer_cli=sp_raw.get("prefer_cli", True),
            )
            self.logger.info(
                f"サイトパース専用モデル: CLI={site_parsing_config.codex_model}, API={site_parsing_config.api_model}"
            )

        # ページネーション設定
        pagination_config = None
        pg_raw = self.config.get("pagination")
        if pg_raw and isinstance(pg_raw, dict):
            pagination_config = PaginationConfig(
                url_template=pg_raw.get("url_template"),
                start_page=pg_raw.get("start_page", 1),
                max_pages=pg_raw.get("max_pages", 50),
                page_param=pg_raw.get("page_param", "page"),
            )

        llm_model = models if isinstance(models, str) else models[0]
        image_provider = self.config.get("image_llm_provider") or "api:gemini"
        image_model = self.config.get("image_llm_model") or llm_model
        image_effort = self.config.get(
            "image_llm_effort", self.config.get("api_reasoning_effort", "medium")
        )

        return SiteConfig(
            site_type=site_type,
            base_url=url,
            map_urls=map_urls,
            extractor_config=extractor_config,
            timeout=30,
            retry_count=3,
            use_llm=True,
            llm_model=llm_model,
            text_llm_provider=self.config.get("text_llm_provider", "api"),
            text_llm_cli_models=self.config.get("text_llm_cli_models", {}),
            text_llm_cli_efforts=self.config.get("text_llm_cli_efforts", {}),
            text_llm_cli_timeout=self.config.get("text_llm_cli_timeout", 900),
            api_reasoning_effort=self.config.get("api_reasoning_effort", "medium"),
            api_reasoning_effort_map=self.config.get("api_reasoning_effort_map", {}),
            text_fallback_llm_provider=self.config.get(
                "text_fallback_llm_provider", "cli:codex"
            ),
            text_fallback_llm_model=self.config.get(
                "text_fallback_llm_model", "gpt-5.5"
            ),
            text_fallback_llm_effort=self.config.get(
                "text_fallback_llm_effort", "medium"
            ),
            image_llm_provider=image_provider,
            image_llm_model=image_model,
            image_llm_effort=image_effort,
            image_fallback_llm_provider=self.config.get(
                "image_fallback_llm_provider", "openai"
            ),
            image_fallback_llm_model=self.config.get(
                "image_fallback_llm_model", "gpt-5-mini"
            ),
            image_fallback_llm_effort=self.config.get(
                "image_fallback_llm_effort", "medium"
            ),
            image_api_reasoning_effort_map=self.config.get(
                "image_api_reasoning_effort_map", {}
            ),
            catalog_additional_prompt=self.config.get("catalog_additional_prompt", ""),
            event_date=self.config.get("event_date"),
            event_name=self.config.get("event_name") or None,
            site_parsing_config=site_parsing_config,
            cookie_file=self.config.get("cookie_file"),
            pagination=pagination_config,
        )

    def _create_output_config(self) -> OutputConfig:
        """出力設定を作成"""
        output_format = OutputFormat.JSON

        config = OutputConfig(
            format=output_format,
            output_dir=self.config["output_dir"],
            skip_circle_images=self.config.get("skip_circle_images", False),
            create_zip=False,
        )

        return config

    def run(
        self, reprocess_mode: bool = False, regenerate_coordinates: bool = False
    ) -> bool:
        """メイン処理を実行

        Args:
            reprocess_mode: 再処理モード（既存event.jsonからおしながき未記載を再処理）
            regenerate_coordinates: 座標再生成フラグ
        """
        try:
            # 再処理モードの場合
            if reprocess_mode:
                return self._run_reprocess_mode(
                    regenerate_coordinates=regenerate_coordinates
                )

            coordinate_requested = bool(
                regenerate_coordinates and self._should_generate_coordinates()
            )
            coordinate_ok = True

            # output_dirの既存ファイルをクリア（フルパイプラインは最初からやり直す）
            output_dir = Path(self.config["output_dir"])
            if output_dir.exists():
                import shutil

                protected_names = protected_output_entry_names(output_dir)
                for item in output_dir.iterdir():
                    if item.name in protected_names:
                        # logsはロガー使用中、event.jsonとイベント画像はユーザー設定を保持
                        continue
                    try:
                        if item.is_dir():
                            shutil.rmtree(item)
                        else:
                            item.unlink()
                    except PermissionError:
                        self.logger.warning(
                            f"ファイル使用中のためスキップ: {item.name}"
                        )
                self.logger.info(f"output_dirをクリアしました: {output_dir}")
            output_dir.mkdir(parents=True, exist_ok=True)

            # 全体進捗の初期化
            twitter_enabled = self.config.get("enable_twitter_catalog", True)
            has_map = regenerate_coordinates and self._should_generate_coordinates()
            total_steps = 3  # 基本: 初期化 + パイプライン + 後処理
            if twitter_enabled:
                total_steps += 1  # Twitter処理
            if has_map:
                total_steps += 1  # 座標生成
            pipeline_progress = ProgressLogger(
                self.logger, total_steps, "パイプライン "
            )

            # 設定を作成
            site_config = self._create_site_config()
            output_config = self._create_output_config()

            # LLMクライアントを準備
            llm_client = None
            if site_config.use_llm:
                models = self._get_model_config()
                try:
                    # 複数モデル対応のLLMクライアントを作成
                    text_attempts = build_text_llm_attempts(
                        getattr(site_config, "text_llm_provider", "api"),
                        site_config.llm_model,
                        site_config.text_llm_cli_models,
                        site_config.text_llm_cli_efforts,
                        site_config.text_fallback_llm_provider,
                        site_config.text_fallback_llm_model,
                        site_config.text_fallback_llm_effort,
                    )
                    self.logger.info(f"Text LLM attempts: {text_attempts}")
                    llm_client = LLMClient(
                        model=api_models_from_attempts(text_attempts),
                        attempts=text_attempts,
                        cli_model_map=site_config.text_llm_cli_models,
                        cli_effort_map=site_config.text_llm_cli_efforts,
                        cli_timeout=site_config.text_llm_cli_timeout,
                        cli_cwd=str(Path(__file__).resolve().parent),
                        reasoning_effort=site_config.api_reasoning_effort,
                        api_reasoning_effort_map=site_config.api_reasoning_effort_map,
                    )
                    self.logger.info(f"LLMクライアントを初期化しました: {models}")
                except Exception as e:
                    self.logger.warning(f"LLMクライアントの初期化に失敗: {e}")

            # パターンマネージャーを初期化
            pattern_manager = PatternManager()

            # パターン再学習フラグ: 既存パターンを削除してLLMに再解析させる
            if self.config.get("force_relearn_pattern"):
                site_key = pattern_manager.get_site_key(self.config["url"])
                if site_key in pattern_manager.patterns:
                    del pattern_manager.patterns[site_key]
                    pattern_manager._save_patterns()
                    self.logger.info(f"既存パターンを削除しました: {site_key}")

            # アダプターとフォーマッターを作成
            adapter = AdapterFactory.create_adapter(
                site_config, llm_client, pattern_manager
            )
            formatter = FormatterFactory.create_formatter(output_config)

            # パイプラインを作成して実行
            pipeline = ExtractionPipeline(
                site_config=site_config,
                output_config=output_config,
                adapter=adapter,
                formatter=formatter,
                logger=self.logger,
            )
            pipeline_progress.update(1, "初期化完了")

            result = pipeline.run()

            pipeline_progress.update(1, "パイプライン完了")

            if not result["success"]:
                self.logger.error(f"❌ エラーが発生しました: {result.get('error')}")
                return False

            # GenericAdapterを使用した場合はパターンを保存
            from src.adapters.generic_adapter import GenericAdapter

            if isinstance(adapter, GenericAdapter):
                try:
                    adapter.save_extraction_pattern()
                    self.logger.info("✅ 抽出パターンを学習・保存しました")
                except Exception as e:
                    self.logger.warning(f"パターンの保存に失敗: {e}")

            # event.jsonは直接出力されるのでコピー不要

            # 過去イベントからURL補完
            circles_for_enrich = result.get("circles", [])
            if circles_for_enrich:
                try:
                    from src.utils.past_event_enricher import PastEventEnricher

                    enricher = PastEventEnricher(
                        events_dir=str(Path(self.config["output_dir"]).parent)
                    )
                    circle_dicts = [
                        c.__dict__ if hasattr(c, "__dict__") else c
                        for c in circles_for_enrich
                    ]
                    enriched = enricher.enrich_circles(circle_dicts)
                    if enriched > 0:
                        self.logger.info(
                            f"過去イベントから{enriched}サークルのURLを補完しました"
                        )
                        # Circleオブジェクトに書き戻し
                        for c_obj, c_dict in zip(circles_for_enrich, circle_dicts):
                            if hasattr(c_obj, "twitter_url"):
                                for key in ["twitter_url", "website_url", "pixiv_url"]:
                                    if c_dict.get(key):
                                        setattr(c_obj, key, c_dict[key])
                except Exception as e:
                    self.logger.warning(f"過去イベントURL補完でエラー: {e}")

            # Twitter処理（オプション）
            if twitter_enabled:
                self.logger.info("\n=== Twitter処理を開始します ===")

                # event.jsonからサークル情報を読み込み
                import asyncio

                # デフォルトのTwitter設定を作成
                twitter_config = TwitterConfig(
                    {
                        "enabled": True,
                        "days_before_event": self.config.get("days_before", 30),
                        "days_after_event": self.config.get("days_after", 7),
                        "max_workers": 1,
                        "rate_limit_seconds": 2,
                        "model": self._get_model_config(),  # 同じモデル設定を使用
                        "text_llm_provider": self.config.get(
                            "text_llm_provider", "api"
                        ),
                        "text_llm_cli_models": self.config.get(
                            "text_llm_cli_models", {}
                        ),
                        "text_llm_cli_efforts": self.config.get(
                            "text_llm_cli_efforts", {}
                        ),
                        "text_fallback_llm_provider": self.config.get(
                            "text_fallback_llm_provider"
                        ),
                        "text_fallback_llm_model": self.config.get(
                            "text_fallback_llm_model"
                        ),
                        "text_fallback_llm_effort": self.config.get(
                            "text_fallback_llm_effort"
                        ),
                        "output_dir": self.config["output_dir"],
                        "debug_limit": self.config.get(
                            "debug_limit", None
                        ),  # デバッグ用の処理数制限
                        "catalog_additional_prompt": self.config.get(
                            "catalog_additional_prompt", ""
                        ),  # 追加プロンプト
                        "event_date": self.config.get("event_date"),
                        "use_grok_search": self.config.get("use_grok_search", False),
                        "tweet_llm_cli_providers": self.config.get(
                            "tweet_llm_cli_providers",
                            (
                                [self.config.get("text_llm_provider")]
                                if self.config.get("text_llm_provider", "api") != "api"
                                else []
                            ),
                        ),
                        "tweet_llm_cli_models": self.config.get(
                            "tweet_llm_cli_models",
                            self.config.get("text_llm_cli_models", {}),
                        ),
                        "tweet_llm_cli_efforts": self.config.get(
                            "tweet_llm_cli_efforts",
                            self.config.get("text_llm_cli_efforts", {}),
                        ),
                        "tweet_llm_cli_timeout": self.config.get(
                            "tweet_llm_cli_timeout", 900
                        ),
                        "skip_catalog_image_analysis": self.config.get(
                            "skip_catalog_image_analysis", False
                        ),
                        "api_reasoning_effort": self.config.get(
                            "api_reasoning_effort", "medium"
                        ),
                        "api_reasoning_effort_map": self.config.get(
                            "api_reasoning_effort_map", {}
                        ),
                        "image_llm_provider": self.config.get("image_llm_provider"),
                        "image_llm_model": self.config.get("image_llm_model"),
                        "image_llm_effort": self.config.get(
                            "image_llm_effort",
                            self.config.get("api_reasoning_effort", "medium"),
                        ),
                        "image_fallback_llm_provider": self.config.get(
                            "image_fallback_llm_provider"
                        ),
                        "image_fallback_llm_model": self.config.get(
                            "image_fallback_llm_model"
                        ),
                        "image_fallback_llm_effort": self.config.get(
                            "image_fallback_llm_effort"
                        ),
                        "image_api_reasoning_effort_map": self.config.get(
                            "image_api_reasoning_effort_map", {}
                        ),
                    }
                )
                twitter_processor = TwitterPostProcessor(twitter_config)

                # パイプラインからサークルとイベント情報を取得
                # (正確な方法は後で調整が必要)
                circles = result.get("circles", [])
                event = result.get("event_obj")

                # デバッグログ: Circleオブジェクトのtwitter_url属性を確認
                self.logger.debug(f"取得したサークル数: {len(circles)}")
                if circles:
                    circles_with_twitter = [c for c in circles if c.twitter_url]
                    self.logger.debug(
                        f"Twitter URLを持つサークル数: {len(circles_with_twitter)}"
                    )
                    if circles_with_twitter:
                        for i, c in enumerate(
                            circles_with_twitter[:3]
                        ):  # 最初の3件だけ表示
                            self.logger.debug(
                                f"  サークル[{i}]: {c.name} -> {c.twitter_url}"
                            )

                if circles and event:
                    # Twitter情報を追加
                    updated_circles = asyncio.run(
                        twitter_processor.process_circles(
                            circles, event, debug_limit=self.config.get("debug_limit")
                        )
                    )
                    twitter_summary = dict(twitter_processor.last_run_summary)
                    result["twitter_processing"] = twitter_summary

                    if twitter_summary.get("status") == "failed":
                        self.logger.error(
                            "❌ X/Twitter処理に失敗しました: "
                            f"対象={twitter_summary.get('target_count', 0)}件, "
                            f"処理済み={twitter_summary.get('processed_count', 0)}件, "
                            f"未処理/失敗={twitter_summary.get('failed_count', 0)}件, "
                            f"理由={twitter_summary.get('reason') or '不明'}"
                        )
                    else:
                        self.logger.info(
                            "X/Twitter処理結果: "
                            f"状態={twitter_summary.get('status')}, "
                            f"対象={twitter_summary.get('target_count', 0)}件, "
                            f"処理済み={twitter_summary.get('processed_count', 0)}件"
                        )

                    print(
                        "TWITTER_PROCESSING_RESULT="
                        + json.dumps(twitter_summary, ensure_ascii=False),
                        file=sys.stderr,
                        flush=True,
                    )

                    # checked_tweets.json を保存（チェック済みツイートID記録）
                    self._save_checked_tweets(updated_circles, output_dir)

                    # ジャンル判定結果をcircle_masterに書き込み（未設定の場合のみ）
                    self._save_detected_genres(updated_circles)

                    # 更新されたデータでevent.jsonを再生成
                    self.logger.info("Twitter情報を反映したevent.jsonを再生成中...")
                    data = formatter.format_data(updated_circles, event)
                    data.setdefault("metadata", {})["twitter_processing"] = twitter_summary
                    output_path = formatter.save(data, "event.json")
                    result["output_files"]["data"] = output_path

                    if twitter_summary.get("status") == "failed":
                        self.logger.warning("⚠️ Twitter処理は失敗を含んで終了しました")
                    else:
                        self.logger.info("✅ Twitter処理が完了しました！")
                else:
                    self.logger.warning("Twitter処理に必要なデータが不足しています")
                pipeline_progress.update(1, "Twitter処理完了")

            # 座標自動生成（オプショナル）
            if coordinate_requested:
                self.logger.info("\n=== 座標自動生成を開始 ===")
                coordinate_ok = self._generate_coordinates()
                if coordinate_ok:
                    self.logger.info("✅ 座標生成完了")
                else:
                    self.logger.error(
                        "❌ 座標生成に失敗しました: "
                        f"{self.coordinate_generation_summary.get('error') or self.coordinate_generation_summary.get('status')}"
                    )
                pipeline_progress.update(1, "座標生成完了")

            # 古いファイルのクリーンアップは不要（event.jsonは上書き）

            pipeline_progress.update(1, "後処理完了")
            if result.get("twitter_processing", {}).get("status") == "failed":
                self.logger.warning(
                    "⚠️ サークルリスト生成は完了しましたが、X/Twitter処理は失敗しました"
                )
            else:
                self.logger.info("✅ サークルリスト生成が正常に完了しました！")
            result["coordinate_generation"] = self.coordinate_generation_summary
            self._print_summary(result)

            # API料金サマリー
            get_cost_tracker().log_summary()

            return not coordinate_requested or coordinate_ok

        except Exception as e:
            self.logger.error(f"❌ 予期しないエラー: {e}", exc_info=True)
            return False

    def _run_reprocess_mode(self, regenerate_coordinates: bool = False) -> bool:
        """再処理モード: 既存event.jsonからおしながき未記載・予告のみのサークルを再処理"""
        try:
            self.logger.info("\n=== 再処理モードで実行 ===")

            total_steps = 3
            if regenerate_coordinates and self._should_generate_coordinates():
                total_steps += 1
            reprocess_progress = ProgressLogger(self.logger, total_steps, "再処理 ")

            output_dir = self.config["output_dir"]
            event_json_path = Path(output_dir) / "event.json"
            reprocessor = JSONReprocessor(event_json_path, self.logger, output_dir)

            event_data = reprocessor.load_existing_json()
            if event_data is None:
                self.logger.error("既存のevent.jsonが見つかりません")
                return False

            from datetime import datetime

            config_event_date = self.config.get("event_date")
            if config_event_date:
                try:
                    event_date_obj = datetime.strptime(config_event_date, "%Y-%m-%d")
                except ValueError as exc:
                    raise ValueError(
                        f"event_dateが不正です（YYYY-MM-DD形式の実在日が必要）: {config_event_date}"
                    ) from exc
            else:
                event_date_obj = datetime.now()

            circles_without_catalog = reprocessor.extract_circles_without_catalog(
                event_data
            )

            reprocess_progress.update(1, "event.json読み込み完了")

            if not circles_without_catalog:
                self.logger.info(
                    "✅ すべてのサークルにおしながきリンクが記載されています"
                )

                coordinate_requested = bool(
                    regenerate_coordinates and self._should_generate_coordinates()
                )
                coordinate_ok = True
                if coordinate_requested:
                    self.logger.info("\n=== 座標再生成のみ実行します ===")
                    coordinate_ok = self._generate_coordinates()
                    if coordinate_ok:
                        self.logger.info("✅ 座標再生成完了")
                    else:
                        self.logger.warning("⚠️ 座標再生成に失敗しました")

                return not coordinate_requested or coordinate_ok

            self.logger.info(
                f"\n{len(circles_without_catalog)}件のサークルを再処理します"
            )

            event_info = event_data.get("event", {})
            event_name = event_info.get("name", "")

            checked_tweets = self._load_checked_tweets(output_dir)

            self.logger.info(
                "再処理モード: twscrape + LLM（Gemini）で処理します（Grok無効）"
            )
            twitter_config = TwitterConfig(
                {
                    "enabled": True,
                    "days_before_event": self.config.get("days_before", 30),
                    "days_after_event": self.config.get("days_after", 7),
                    "max_workers": 1,
                    "rate_limit_seconds": 2,
                    "model": self._get_model_config(),
                    "text_llm_provider": self.config.get(
                        "text_llm_provider", "api"
                    ),
                    "text_llm_cli_models": self.config.get(
                        "text_llm_cli_models", {}
                    ),
                    "text_llm_cli_efforts": self.config.get(
                        "text_llm_cli_efforts", {}
                    ),
                    "text_fallback_llm_provider": self.config.get(
                        "text_fallback_llm_provider"
                    ),
                    "text_fallback_llm_model": self.config.get(
                        "text_fallback_llm_model"
                    ),
                    "text_fallback_llm_effort": self.config.get(
                        "text_fallback_llm_effort"
                    ),
                    "output_dir": output_dir,
                    "debug_limit": self.config.get("debug_limit", None),
                    "catalog_additional_prompt": self.config.get(
                        "catalog_additional_prompt", ""
                    ),
                    "event_date": self.config.get("event_date"),
                    "use_grok_search": False,
                    "tweet_llm_cli_providers": self.config.get(
                        "tweet_llm_cli_providers",
                        (
                            [self.config.get("text_llm_provider")]
                            if self.config.get("text_llm_provider", "api") != "api"
                            else []
                        ),
                    ),
                    "tweet_llm_cli_models": self.config.get(
                        "tweet_llm_cli_models",
                        self.config.get("text_llm_cli_models", {}),
                    ),
                    "tweet_llm_cli_efforts": self.config.get(
                        "tweet_llm_cli_efforts",
                        self.config.get("text_llm_cli_efforts", {}),
                    ),
                    "tweet_llm_cli_timeout": self.config.get(
                        "tweet_llm_cli_timeout", 900
                    ),
                    "skip_catalog_image_analysis": self.config.get(
                        "skip_catalog_image_analysis", False
                    ),
                    "api_reasoning_effort": self.config.get(
                        "api_reasoning_effort", "medium"
                    ),
                    "api_reasoning_effort_map": self.config.get(
                        "api_reasoning_effort_map", {}
                    ),
                    "image_llm_provider": self.config.get("image_llm_provider"),
                    "image_llm_model": self.config.get("image_llm_model"),
                    "image_llm_effort": self.config.get(
                        "image_llm_effort",
                        self.config.get("api_reasoning_effort", "medium"),
                    ),
                    "image_fallback_llm_provider": self.config.get(
                        "image_fallback_llm_provider"
                    ),
                    "image_fallback_llm_model": self.config.get(
                        "image_fallback_llm_model"
                    ),
                    "image_fallback_llm_effort": self.config.get(
                        "image_fallback_llm_effort"
                    ),
                    "image_api_reasoning_effort_map": self.config.get(
                        "image_api_reasoning_effort_map", {}
                    ),
                }
            )
            twitter_processor = TwitterPostProcessor(twitter_config)

            from src.models import Event, Circle

            event = Event(
                name=event_name,
                date=event_date_obj,
                url=event_info.get("url", ""),
                venue=event_info.get("venue", ""),
            )

            circles_to_process = []
            for c in circles_without_catalog:
                circle = Circle(
                    name=c["name"],
                    space=c.get("space", ""),
                    twitter_url=c.get("twitter_url", ""),
                )
                circle._circle_index = c["circle_index"]
                memo_catalog_urls = c.get("catalog_urls", [])
                if memo_catalog_urls:
                    circle._memo_catalog_urls = memo_catalog_urls
                circle_checked = checked_tweets.get(c["name"], {})
                skip_ids = circle_checked.get("checked_tweet_ids", [])
                if skip_ids and not memo_catalog_urls:
                    circle._skip_tweet_ids = skip_ids
                circles_to_process.append(circle)

            import asyncio

            async def _run_reprocess_targets():
                search_targets = []
                for circle in circles_to_process:
                    direct_urls = getattr(circle, "_memo_catalog_urls", [])
                    for post_url in direct_urls:
                        await twitter_processor.process_circle_from_post_url(
                            circle,
                            post_url,
                            event.name,
                            use_text_detail=True,
                        )
                        if circle.items:
                            break
                    if not direct_urls:
                        search_targets.append(circle)

                if search_targets:
                    await twitter_processor.process_circles(
                        search_targets,
                        event,
                        debug_limit=len(search_targets),
                    )
                return circles_to_process

            updated_circles = asyncio.run(_run_reprocess_targets())
            twitter_summary = dict(twitter_processor.last_run_summary)
            if twitter_summary.get("status") == "failed":
                self.logger.error(
                    "❌ X/Twitter再処理に失敗しました: "
                    f"対象={twitter_summary.get('target_count', 0)}件, "
                    f"処理済み={twitter_summary.get('processed_count', 0)}件, "
                    f"未処理/失敗={twitter_summary.get('failed_count', 0)}件, "
                    f"理由={twitter_summary.get('reason') or '不明'}"
                )
            print(
                "TWITTER_PROCESSING_RESULT="
                + json.dumps(twitter_summary, ensure_ascii=False),
                file=sys.stderr,
                flush=True,
            )

            reprocess_progress.update(1, "Twitter処理完了")

            self._save_checked_tweets(updated_circles, output_dir)

            # ジャンル判定結果をcircle_masterに書き込み（未設定の場合のみ）
            self._save_detected_genres(updated_circles)

            import re

            update_data = []
            for circle in updated_circles:
                if hasattr(circle, "_circle_index"):
                    catalog_url = None
                    if circle.memo:
                        status_urls = re.findall(
                            r"https?://(?:twitter\.com|x\.com)/[^\s]+/status(?:es)?/\d+",
                            circle.memo,
                        )
                        catalog_urls = re.findall(r"https?://[^\s]+", circle.memo)
                        if status_urls:
                            catalog_url = status_urls[0]
                        elif catalog_urls:
                            catalog_url = catalog_urls[0]

                    catalog_image = None
                    if circle.item_images and len(circle.item_images) > 0:
                        catalog_image = circle.item_images[0].path

                    catalog_type = None
                    catalog_status = getattr(circle, "catalog_status", None)

                    if catalog_status == "preview":
                        catalog_type = "おしながき予告"
                    elif circle.items:
                        # 画像解析結果（高精度）を最優先
                        item_types = list(
                            dict.fromkeys(
                                item.get("type", "")
                                for item in circle.items
                                if item.get("type")
                            )
                        )
                        if item_types:
                            catalog_type = "、".join(item_types)
                    if not catalog_type and (catalog_url or catalog_image):
                        catalog_type = "おしながき"

                    has_update = bool(
                        catalog_url
                        or catalog_image
                        or circle.items
                        or catalog_status
                        or circle.existing_only_status
                    )
                    if has_update:
                        update_data.append(
                            {
                                "circle_index": circle._circle_index,
                                "catalog_url": catalog_url,
                                "catalog_image": catalog_image,
                                "catalog_type": catalog_type,
                                "items": list(circle.items),
                                "catalog_status": catalog_status,
                                "existing_only_status": circle.existing_only_status,
                            }
                        )

            event_data = reprocessor.update_catalog_links(event_data, update_data)
            event_data = reprocessor.apply_default_cuts_for_missing(event_data)
            event_data.setdefault("metadata", {})["twitter_processing"] = twitter_summary
            reprocessor.save_updated_json(event_data)

            reprocess_progress.update(1, "event.json保存完了")
            self.logger.info(f"✅ {len(update_data)}件のおしながきリンクを追加しました")

            coordinate_requested = bool(
                regenerate_coordinates and self._should_generate_coordinates()
            )
            coordinate_ok = True
            if coordinate_requested:
                self.logger.info("\n=== 座標再生成を開始 ===")
                coordinate_ok = self._generate_coordinates()
                if coordinate_ok:
                    self.logger.info("✅ 座標再生成完了")
                else:
                    self.logger.warning(
                        "⚠️ 座標再生成に失敗しましたが、処理は継続します"
                    )

            get_cost_tracker().log_summary()
            return not coordinate_requested or coordinate_ok

        except Exception as e:
            self.logger.error(f"再処理中にエラー: {e}", exc_info=True)
            return False

    def _load_checked_tweets(self, output_dir: str) -> dict:
        """checked_tweets.json を読み込む

        Returns:
            {サークル名: {twitter_url, checked_tweet_ids, last_checked}} の辞書
        """
        import json

        checked_path = Path(output_dir) / "checked_tweets.json"
        if checked_path.exists():
            try:
                with open(checked_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.logger.info(
                    f"checked_tweets.json を読み込みました（{len(data)}サークル分）"
                )
                return data
            except Exception as e:
                self.logger.warning(f"checked_tweets.json の読み込みに失敗: {e}")
        return {}

    def _save_checked_tweets(self, circles, output_dir: str):
        """処理済みサークルのチェック済みツイートIDを checked_tweets.json に保存"""
        import json
        from datetime import datetime

        checked_path = Path(output_dir) / "checked_tweets.json"

        # 既存データを読み込み
        existing = {}
        if checked_path.exists():
            try:
                with open(checked_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                pass

        # 更新
        updated_count = 0
        for circle in circles:
            checked_ids = getattr(circle, "_checked_tweet_ids", [])
            if not checked_ids:
                continue

            # 既存のIDとマージ
            circle_data = existing.get(circle.name, {})
            old_ids = set(circle_data.get("checked_tweet_ids", []))
            new_ids = old_ids | set(checked_ids)

            existing[circle.name] = {
                "twitter_url": circle.twitter_url or circle_data.get("twitter_url", ""),
                "checked_tweet_ids": sorted(new_ids),
                "last_checked": datetime.now().isoformat(),
            }
            updated_count += 1

        # 保存
        try:
            with open(checked_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
            if updated_count > 0:
                self.logger.info(
                    f"checked_tweets.json を更新しました（{updated_count}サークル分）"
                )
        except Exception as e:
            self.logger.warning(f"checked_tweets.json の保存に失敗: {e}")

    def _save_detected_genres(self, circles):
        """Twitter処理で検出されたジャンルをcircle_masterに保存（未設定の場合のみ）"""
        from src.utils.circle_master import CircleMasterManager

        circle_master = CircleMasterManager()
        saved_count = 0
        for circle in circles:
            detected_genre = getattr(circle, "_detected_genre", None)
            if not detected_genre:
                continue
            existing_genre = circle_master.get_genre(circle.name)
            if not existing_genre:
                circle_master.set_genre(circle.name, detected_genre)
                saved_count += 1
                self.logger.debug(
                    f"ジャンル自動設定: {circle.name} -> {detected_genre}"
                )
        if saved_count > 0:
            circle_master.save()
            self.logger.info(
                f"✅ {saved_count}サークルのジャンルをcircle_masterに保存しました"
            )

    def _should_generate_coordinates(self) -> bool:
        """座標生成が必要かを判定"""
        return bool(self.config.get("map_url") or self.config.get("map_urls"))

    def _find_local_map_file(self, output_dir: str, map_number: int) -> Optional[Path]:
        base = Path(output_dir)
        suffixes = ["jpg", "jpeg", "png", "webp"]
        for folder in [base / "maps", base]:
            for suffix in suffixes:
                candidate = folder / f"map_{map_number:02d}.{suffix}"
                if candidate.exists():
                    return candidate
        return None

    def _save_coordinate_generation_summary(self) -> None:
        """座標生成診断をoutput_dirへ保存（GUI bridgeが回収する）。"""
        try:
            path = Path(self.config["output_dir"]) / "coordinate_generation_summary.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(self.coordinate_generation_summary, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except (KeyError, OSError, TypeError, ValueError):
            self.logger.debug("座標生成サマリーの保存に失敗しました", exc_info=True)

    def _generate_coordinates(self) -> bool:
        """座標を自動生成してevent.jsonを更新"""
        from src.space_locator import generate_coordinates_from_map
        from src.space_locator.json_updater import JSONUpdater

        raw_map_urls = self.config.get("map_urls")
        map_urls = []
        if isinstance(raw_map_urls, list):
            map_urls.extend(str(url).strip() for url in raw_map_urls if str(url).strip())
        if self.config.get("map_url"):
            map_url = str(self.config["map_url"]).strip()
            if map_url and map_url not in map_urls:
                map_urls.append(map_url)
        if not map_urls:
            self.logger.error("map_urlが設定されていません")
            self.coordinate_generation_summary = {
                "status": "failed",
                "attempted": 0,
                "succeeded": 0,
                "failed": 0,
                "total_updated": 0,
                "maps": [],
                "error": "map_urlが設定されていません",
            }
            self._save_coordinate_generation_summary()
            return False

        models = self._get_model_config()
        model = self.config.get("image_llm_model") or (
            models[0] if isinstance(models, list) else models
        )

        output_dir = self.config["output_dir"]
        event_json_path = Path(output_dir) / "event.json"

        if not event_json_path.exists():
            self.logger.error(f"event.jsonが見つかりません: {event_json_path}")
            self.coordinate_generation_summary = {
                "status": "failed",
                "attempted": 0,
                "succeeded": 0,
                "failed": 0,
                "total_updated": 0,
                "maps": [],
                "error": f"event.jsonが見つかりません: {event_json_path}",
            }
            self._save_coordinate_generation_summary()
            return False

        try:
            total_updated = 0
            attempted = 0
            succeeded = 0
            failed = 0
            map_diagnostics: list[Dict[str, Any]] = []
            ocr_config = self.config.get("ocr_config")
            if not isinstance(ocr_config, dict):
                # config.yaml を直接実行する旧利用者も環境変数設定を利用可能。
                ocr_config = None

            for i, map_url in enumerate(map_urls):
                self.logger.info(f"\nマップ{i+1}/{len(map_urls)}: {map_url}")

                map_number = i + 1
                local_map_path = self._find_local_map_file(output_dir, map_number)
                if local_map_path is None:
                    self.logger.error(
                        f"マップファイルが見つかりません: map_{map_number:02d}.jpg/png/webp"
                    )
                    failed += 1
                    attempted += 1
                    map_diagnostics.append(
                        {
                            "map_number": map_number,
                            "status": "failed",
                            "error": "マップファイルが見つかりません",
                        }
                    )
                    continue

                attempted += 1
                output_json = Path(output_dir) / f"coordinates_map_{map_number}.json"
                generation_kwargs = {
                    "image_path": str(local_map_path),
                    "event_json_path": str(event_json_path),
                    "output_json_path": str(output_json),
                    "model": model,
                    "map_number": map_number,
                }
                if ocr_config:
                    generation_kwargs["ocr_config"] = ocr_config
                coord_map = generate_coordinates_from_map(**generation_kwargs)

                if coord_map is None:
                    self.logger.error(f"座標生成失敗: {local_map_path}")
                    failed += 1
                    diagnostic: Dict[str, Any] = {
                        "map_number": map_number,
                        "status": "failed",
                        "image_path": str(local_map_path),
                        "output_json": str(output_json),
                        "error": "座標生成関数が結果を返しませんでした",
                    }
                    try:
                        if output_json.exists():
                            saved = json.loads(output_json.read_text(encoding="utf-8-sig"))
                            if isinstance(saved, dict):
                                diagnostic["error"] = saved.get("error") or diagnostic["error"]
                                diagnostic["ocr_diagnostics"] = saved.get("ocr_diagnostics", {})
                    except (OSError, ValueError, TypeError):
                        pass
                    map_diagnostics.append(diagnostic)
                    continue

                # event.jsonを更新
                updater = JSONUpdater()
                update_result = updater.update_event_json(
                    event_json_path=str(event_json_path),
                    coordinate_map=(
                        coord_map
                        if isinstance(coord_map, list)
                        else coord_map.get("complete_grid", [])
                    ),
                    map_number=map_number,
                )

                if update_result:
                    updated = update_result["updated_count"]
                    skipped = update_result["skipped_count"]
                    total_updated += updated
                    self.logger.info(f"更新: {updated}件 / スキップ: {skipped}件")
                    succeeded += 1
                    map_diagnostics.append(
                        {
                            "map_number": map_number,
                            "status": "success",
                            "image_path": str(local_map_path),
                            "output_json": str(output_json),
                            "updated_count": updated,
                            "skipped_count": skipped,
                        }
                    )
                else:
                    failed += 1
                    map_diagnostics.append(
                        {
                            "map_number": map_number,
                            "status": "failed",
                            "image_path": str(local_map_path),
                            "output_json": str(output_json),
                            "error": "event.jsonの座標更新に失敗しました",
                        }
                    )

            self.logger.info(f"\n合計 {total_updated} 件の座標を更新しました")
            status = "success" if succeeded == attempted and attempted else (
                "partial" if succeeded else "failed"
            )
            self.coordinate_generation_summary = {
                "status": status,
                "attempted": attempted,
                "succeeded": succeeded,
                "failed": failed,
                "total_updated": total_updated,
                "maps": map_diagnostics,
            }
            self._save_coordinate_generation_summary()
            # 一部成功は既存仕様どおり継続可能だが、全マップ失敗はGUI/CLIの
            # 成功表示を許可しない。
            return succeeded > 0

        except Exception as e:
            self.logger.error(f"座標生成中にエラー: {e}", exc_info=True)
            self.coordinate_generation_summary = {
                "status": "failed",
                "attempted": locals().get("attempted", 0),
                "succeeded": locals().get("succeeded", 0),
                "failed": locals().get("failed", 0) + 1,
                "total_updated": locals().get("total_updated", 0),
                "maps": locals().get("map_diagnostics", []),
                "error": str(e),
            }
            self._save_coordinate_generation_summary()
            return False

    def _print_summary(self, result: Dict[str, Any]):
        """実行結果のサマリーを表示"""
        print("\n" + "=" * 50)
        print("実行結果サマリー")
        print("=" * 50)
        print(f"イベント名: {result['event']['name']}")
        print(f"抽出サークル数: {result['circle_count']}")
        print(f"処理時間: {result['duration']:.1f}秒")

        twitter_summary = result.get("twitter_processing")
        if twitter_summary:
            print("\nX/Twitter処理:")
            print(f"  状態: {twitter_summary.get('status')}")
            print(f"  対象: {twitter_summary.get('target_count', 0)}件")
            print(f"  処理済み: {twitter_summary.get('processed_count', 0)}件")
            print(f"  未処理/失敗: {twitter_summary.get('failed_count', 0)}件")
            print(f"  不正URL除外: {twitter_summary.get('invalid_url_count', 0)}件")
            if twitter_summary.get("reason"):
                print(f"  理由: {twitter_summary['reason']}")

        coordinate_summary = result.get("coordinate_generation")
        if coordinate_summary and coordinate_summary.get("status") != "not_requested":
            print("\n座標生成:")
            print(f"  状態: {coordinate_summary.get('status')}")
            print(
                "  マップ: "
                f"{coordinate_summary.get('succeeded', 0)}/"
                f"{coordinate_summary.get('attempted', 0)} 成功"
            )
            print(f"  更新: {coordinate_summary.get('total_updated', 0)}件")
            if coordinate_summary.get("error"):
                print(f"  診断: {coordinate_summary['error']}")

        print("\n出力ファイル:")
        for file_type, file_path in result["output_files"].items():
            print(f"  {file_type}: {file_path}")

        print("=" * 50)


def main():
    """メインエントリポイント"""
    parser = argparse.ArgumentParser(
        description="サークルリスト生成ツール - 様々なイベントサイトからサークル情報を抽出"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="詳細なログを出力")
    parser.add_argument(
        "-r",
        "--reprocess",
        action="store_true",
        help="再処理モード: 既存のevent.jsonからおしながき未記載のサークルを再処理",
    )
    parser.add_argument(
        "--regenerate-coordinates",
        action="store_true",
        help="座標を再生成: 既存のマップファイルから座標を再生成",
    )

    args = parser.parse_args()

    # Verboseモードの設定
    if args.verbose:
        os.environ["LOG_LEVEL"] = "DEBUG"

    try:
        generator = CircleListGenerator("config.yaml")
        success = generator.run(
            reprocess_mode=args.reprocess,
            regenerate_coordinates=args.regenerate_coordinates,
        )

        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n\n処理が中断されました。")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ エラーが発生しました: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

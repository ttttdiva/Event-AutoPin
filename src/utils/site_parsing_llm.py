"""
サイトパース専用の高性能LLMユーティリティ

GPT-5.6 Sol API → Codex CLI のフォールバックチェーンで
イベントサイトのHTML解析を行う。
"""

import json
import logging
from typing import Optional

from ..models.config import SiteParsingConfig
from .cli_llm import execute_cli_prompt
from .llm_client import LLMClient
from .llm_attempts import api_models_from_attempts, build_text_llm_attempts

logger = logging.getLogger(__name__)


def parse_with_high_end_model(
    prompt: str,
    site_parsing_config: SiteParsingConfig,
    timeout: Optional[int] = None,
) -> str:
    """
    高性能モデルでプロンプトを実行し結果を返す。

    フォールバック順:
    1. OpenAI Responses API (api_model, reasoning_effort 付き)
    2. prefer_cli=True の場合、Codex CLI (--model codex_model)

    Returns:
        LLMレスポンス文字列（JSON形式を期待）
    """
    effective_timeout = timeout or site_parsing_config.cli_timeout

    # 新形式は選択された構造解析roleだけを呼ぶ。旧 codex_model/api_model
    # 設定には触れず、保存済みconfigの従来順序を維持する。
    if site_parsing_config.provider and site_parsing_config.model:
        attempts = build_text_llm_attempts(
            site_parsing_config.provider,
            site_parsing_config.model,
            site_parsing_config.cli_model_map,
            site_parsing_config.cli_effort_map,
            site_parsing_config.fallback_provider,
            site_parsing_config.fallback_model,
            site_parsing_config.fallback_effort,
            primary_effort=site_parsing_config.effort,
        )
        if not attempts:
            raise RuntimeError("サイト構造解析roleに有効なprovider/modelがありません")
        logger.info(
            "サイト構造解析roleを使用: provider=%s, model=%s",
            site_parsing_config.provider,
            site_parsing_config.model,
        )
        client = LLMClient(
            model=api_models_from_attempts(attempts),
            attempts=attempts,
            cli_model_map=site_parsing_config.cli_model_map,
            cli_effort_map=site_parsing_config.cli_effort_map,
            cli_timeout=effective_timeout,
            reasoning_effort=site_parsing_config.effort,
            max_api_retries=0,
        )
        result = client.extract_data(
            prompt,
            temperature=0.0,
            reasoning_effort=site_parsing_config.effort,
            timeout=effective_timeout,
        )
        if not result or not result.strip():
            raise RuntimeError("サイト構造解析roleが空の結果を返しました")
        return _extract_json_content(result)

    # 1. OpenAI Responses API を試行
    logger.info(
        f"API ({site_parsing_config.api_model}, reasoning={site_parsing_config.reasoning_effort}) で試行中..."
    )
    try:
        client = LLMClient(model=site_parsing_config.api_model)
        result = client.extract_data(
            prompt,
            reasoning_effort=site_parsing_config.reasoning_effort
            or site_parsing_config.api_reasoning_effort,
        )
        if result and result.strip():
            logger.info("API で正常に処理完了")
            return result
    except Exception as e:
        logger.error(f"API ({site_parsing_config.api_model}) 例外: {e}")

    # 2. Codex CLI を試行（既存のCLI経路をフォールバックとして維持）
    if site_parsing_config.prefer_cli:
        logger.info(f"Codex CLI (model={site_parsing_config.codex_model}) で試行中...")
        try:
            success, output = execute_cli_prompt(
                prompt,
                provider="codex",
                model=site_parsing_config.codex_model,
                timeout=effective_timeout,
                effort=site_parsing_config.reasoning_effort
                or site_parsing_config.api_reasoning_effort,
            )
            if success and output.strip():
                logger.info("Codex CLI で正常に処理完了")
                return _extract_json_content(output)
            logger.warning(f"Codex CLI 失敗: {output[:200]}")
        except Exception as e:
            logger.warning(f"Codex CLI 例外: {e}")

    raise RuntimeError("すべてのサイトパースモデルで処理に失敗しました")


def _extract_json_content(text: str) -> str:
    """CLI出力からJSON部分を抽出"""
    text = text.strip()
    if "```json" in text:
        start = text.find("```json") + 7
        end = text.find("```", start)
        if end > start:
            text = text[start:end].strip()
    elif text.startswith("```"):
        text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    # JSON妥当性チェック
    try:
        json.loads(text)
    except json.JSONDecodeError:
        logger.warning("CLI出力がJSON形式ではありません")
    return text

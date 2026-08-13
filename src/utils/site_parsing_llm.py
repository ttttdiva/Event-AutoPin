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

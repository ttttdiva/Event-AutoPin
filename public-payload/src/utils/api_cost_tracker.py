"""
API料金追跡モジュール
各LLM APIのトークン使用量と料金を追跡・集計する
"""

import logging
import threading
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# API料金テーブル（USD / 1Mトークン）- 2026年3月時点
PRICING = {
    # xAI Grok
    "grok-4": {"input": 3.00, "output": 15.00},
    "grok-4-fast": {"input": 0.20, "output": 0.50},
    "grok-4-1-fast": {"input": 0.20, "output": 0.50},
    "grok-4-1-fast-non-reasoning": {"input": 0.20, "output": 0.50},
    "grok-3": {"input": 3.00, "output": 15.00},
    "grok-3-mini": {"input": 0.30, "output": 0.50},
    # Google Gemini
    "gemini-3.1-pro": {"input": 2.00, "output": 12.00},
    "gemini-2.5-pro": {"input": 1.25, "output": 10.00},
    "gemini-2.5-pro-preview-05-06": {"input": 1.25, "output": 10.00},
    "gemini-3-flash": {"input": 0.50, "output": 3.00},
    "gemini-3-flash-preview": {"input": 0.50, "output": 3.00},
    "gemini-2.5-flash": {"input": 0.30, "output": 2.50},
    "gemini-2.5-flash-preview-04-17": {"input": 0.30, "output": 2.50},
    "gemini-2.0-flash": {"input": 0.10, "output": 0.70},
    "gemini-2.0-flash-lite": {"input": 0.075, "output": 0.30},
    "gemini-3.1-flash-lite": {"input": 0.25, "output": 1.50},
    "gemini-2.5-flash-lite": {"input": 0.10, "output": 0.40},
    # OpenAI
    "gpt-5.4": {"input": 10.00, "output": 30.00},
    "gpt-5.4-mini": {"input": 1.10, "output": 4.40},
    "gpt-5.3-codex": {"input": 5.00, "output": 15.00},
    "gpt-5-mini": {"input": 0.40, "output": 1.60},
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    # Grok x_search ツール呼び出し（$5/1000回 = 1回あたり$0.005）
    "_x_search_call": {"per_call": 0.005},
}

# 為替レート（USD→JPY概算）
USD_TO_JPY = 150.0


class ApiCostTracker:
    """API料金追跡のシングルトン"""

    _instance: Optional["ApiCostTracker"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "ApiCostTracker":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
            return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._usage: Dict[str, Dict[str, float]] = {}
        self._tool_calls: Dict[str, int] = {}
        self._data_lock = threading.Lock()

    def reset(self):
        """集計をリセット"""
        with self._data_lock:
            self._usage.clear()
            self._tool_calls.clear()

    def add_tokens(self, model: str, input_tokens: int, output_tokens: int):
        """トークン使用量を記録"""
        with self._data_lock:
            if model not in self._usage:
                self._usage[model] = {"input_tokens": 0, "output_tokens": 0}
            self._usage[model]["input_tokens"] += input_tokens
            self._usage[model]["output_tokens"] += output_tokens

    def add_tool_call(self, tool_name: str, count: int = 1):
        """ツール呼び出し回数を記録"""
        with self._data_lock:
            self._tool_calls[tool_name] = self._tool_calls.get(tool_name, 0) + count

    def _get_pricing(self, model: str) -> Optional[Dict[str, float]]:
        """モデル名から料金テーブルを検索（部分一致対応）"""
        # 完全一致
        if model in PRICING:
            return PRICING[model]
        # 部分一致（gemini-2.5-flash-preview-XXX → gemini-2.5-flash 等）
        model_lower = model.lower()
        for key in PRICING:
            if model_lower.startswith(key):
                return PRICING[key]
        return None

    def get_summary(self) -> Dict[str, any]:
        """集計結果を返す"""
        with self._data_lock:
            details = []
            total_usd = 0.0

            for model, usage in self._usage.items():
                pricing = self._get_pricing(model)
                input_tokens = usage["input_tokens"]
                output_tokens = usage["output_tokens"]

                if pricing and "input" in pricing:
                    input_cost = input_tokens / 1_000_000 * pricing["input"]
                    output_cost = output_tokens / 1_000_000 * pricing["output"]
                    model_cost = input_cost + output_cost
                else:
                    input_cost = 0
                    output_cost = 0
                    model_cost = 0

                total_usd += model_cost
                details.append(
                    {
                        "model": model,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "cost_usd": model_cost,
                        "pricing_found": pricing is not None,
                    }
                )

            # ツール呼び出し料金
            for tool, count in self._tool_calls.items():
                tool_key = f"_{tool}"
                pricing = PRICING.get(tool_key)
                if pricing and "per_call" in pricing:
                    tool_cost = count * pricing["per_call"]
                    total_usd += tool_cost
                    details.append(
                        {
                            "tool": tool,
                            "calls": count,
                            "cost_usd": tool_cost,
                        }
                    )

            return {
                "details": details,
                "total_usd": total_usd,
                "total_jpy": total_usd * USD_TO_JPY,
            }

    def log_summary(self):
        """集計結果をログに出力"""
        summary = self.get_summary()

        if not summary["details"]:
            return

        logger.info("=== API料金サマリー ===")

        for detail in summary["details"]:
            if "model" in detail:
                status = "" if detail["pricing_found"] else " (料金不明)"
                logger.info(
                    f"  {detail['model']}: "
                    f"入力{detail['input_tokens']:,}トークン / "
                    f"出力{detail['output_tokens']:,}トークン "
                    f"= ${detail['cost_usd']:.4f}{status}"
                )
            elif "tool" in detail:
                logger.info(
                    f"  {detail['tool']}: {detail['calls']}回 = ${detail['cost_usd']:.4f}"
                )

        logger.info(
            f"  合計: ${summary['total_usd']:.4f} " f"(約{summary['total_jpy']:.1f}円)"
        )
        logger.info("======================")


# グローバルインスタンス取得用
def get_cost_tracker() -> ApiCostTracker:
    return ApiCostTracker()

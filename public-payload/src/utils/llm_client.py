import os
from typing import Optional, Dict, Any, Union, List, Tuple
import logging
from openai import OpenAI
import json
import base64
import google.generativeai as genai
import requests
import time
import re
import ast

from .api_cost_tracker import get_cost_tracker


_GENERIC_EVENT_KEYWORDS = {
    "イベント",
    "開催",
    "略称",
    "正式名称",
    "ハッシュタグ",
    "お品書き",
    "おしながき",
    "新刊",
    "参加",
}


def extract_event_keywords_from_text(event_info: str) -> List[str]:
    """LLMに頼らず、追加入力から明示キーワードを抽出する。"""
    if not event_info:
        return []

    candidates: List[str] = []

    quoted_patterns = [
        r"[「『](.+?)[」』]",
        r"[\"'](.+?)[\"']",
    ]
    for pattern in quoted_patterns:
        candidates.extend(re.findall(pattern, event_info))

    candidates.extend(re.findall(r"#[\w\u3040-\u30ff\u3400-\u9fffー]+", event_info))

    keywords: List[str] = []
    seen = set()
    for raw in candidates:
        keyword = str(raw).strip()
        keyword = re.sub(r"\s+", " ", keyword)
        keyword = keyword.strip("。、，,.;:：()（）[]【】")
        if not keyword:
            continue
        if len(keyword) < 2:
            continue
        if keyword in _GENERIC_EVENT_KEYWORDS:
            continue
        if keyword not in seen:
            seen.add(keyword)
            keywords.append(keyword)

    return keywords


class LLMClient:
    """LLM APIクライアント（複数モデルのフォールバック対応）"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Union[str, List[str]] = "gpt-5.6-sol",
        cli_providers: Optional[List[str]] = None,
        cli_model_map: Optional[Dict[str, str]] = None,
        cli_effort_map: Optional[Dict[str, str]] = None,
        cli_timeout: int = 900,
        cli_cwd: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
        api_reasoning_effort_map: Optional[Dict[str, str]] = None,
        attempts: Optional[List[Dict[str, Any]]] = None,
    ):
        """初期化

        Args:
            api_key: APIキー（非推奨、環境変数から読み込むべき）
            model: 使用するモデル名（文字列またはリスト）。リストの場合はフォールバック順
        """
        self.logger = logging.getLogger(__name__)
        self.cli_providers = cli_providers or []
        self.cli_model_map = cli_model_map or {}
        self.cli_effort_map = cli_effort_map or {}
        self.cli_timeout = cli_timeout
        self.cli_cwd = cli_cwd
        self.reasoning_effort = reasoning_effort
        self.api_reasoning_effort_map = api_reasoning_effort_map or {}
        self.attempts = attempts or []

        # モデルをリスト形式に統一
        if isinstance(model, str):
            self.models = [model]
        else:
            self.models = model

        if not self.models and not self.attempts:
            raise ValueError("少なくとも1つのモデルを指定してください")

        # 各モデルのクライアントを初期化
        self.clients = []
        api_model_names = list(self.models)
        for attempt in self.attempts:
            if attempt.get("kind") == "api" and attempt.get("model"):
                api_model_names.append(attempt["model"])
        seen_api_models = set()
        for model_name in api_model_names:
            if not model_name or model_name in seen_api_models:
                continue
            seen_api_models.add(model_name)
            try:
                client_info = self._init_client(model_name, api_key)
                self.clients.append(client_info)
                self.logger.info(f"モデル {model_name} を初期化しました")
            except Exception as e:
                self.logger.warning(f"モデル {model_name} の初期化に失敗: {e}")

        has_cli_attempt = any(attempt.get("kind") == "cli" for attempt in self.attempts)
        if not self.clients and not self.cli_providers and not has_cli_attempt:
            raise ValueError("利用可能なモデルがありません。APIキーを確認してください")

        # プライマリモデルの情報を保持（互換性のため）
        self.model = self.models[0] if self.models else (
            self.attempts[0].get("model") if self.attempts else "cli"
        )
        self.api_type = self.clients[0]["api_type"] if self.clients else "cli"
        self.client = self.clients[0]["client"] if self.clients else None

    def _init_client(
        self, model_name: str, api_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """個別のクライアントを初期化"""
        if model_name.startswith("gemini"):
            # Gemini API
            actual_api_key = api_key or os.getenv("GEMINI_API_KEY")
            if not actual_api_key:
                raise ValueError(
                    f"Gemini APIキーが設定されていません（モデル: {model_name}）"
                )

            # 新しい設定インスタンスを作成
            genai.configure(api_key=actual_api_key)
            client = genai.GenerativeModel(model_name)

            return {
                "model": model_name,
                "api_type": "gemini",
                "client": client,
                "api_key": actual_api_key,
            }
        else:
            # OpenAI API (gpt-3.5-turbo, gpt-5-mini など)
            actual_api_key = api_key or os.getenv("OPENAI_API_KEY")
            if not actual_api_key:
                raise ValueError(
                    f"OpenAI APIキーが設定されていません（モデル: {model_name}）"
                )

            client = OpenAI(api_key=actual_api_key)

            return {
                "model": model_name,
                "api_type": "openai",
                "client": client,
                "api_key": actual_api_key,
            }

    def _normalize_response_text(self, content: str) -> str:
        content = content.strip()
        if content.startswith("```json"):
            content = content[7:]
        elif content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

        parsed = self._parse_lenient_json(content)
        if parsed is not None:
            return json.dumps(parsed, ensure_ascii=False)

        return content

    def _parse_lenient_json(self, content: str) -> Optional[Any]:
        candidates = [content]
        object_match = re.search(r"\{[\s\S]*\}", content)
        if object_match:
            candidates.append(object_match.group())
        array_match = re.search(r"\[[\s\S]*\]", content)
        if array_match:
            candidates.append(array_match.group())

        for candidate in candidates:
            parsed = self._loads_json_like(candidate)
            if parsed is not None:
                return parsed
        return None

    def _loads_json_like(self, content: str) -> Optional[Any]:
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        json_like = re.sub(
            r"(?<=[\{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:",
            r'"\1":',
            content,
        )
        json_like = re.sub(r",\s*([}\]])", r"\1", json_like)
        try:
            return json.loads(json_like)
        except json.JSONDecodeError:
            pass

        python_like = re.sub(r"\btrue\b", "True", json_like, flags=re.IGNORECASE)
        python_like = re.sub(r"\bfalse\b", "False", python_like, flags=re.IGNORECASE)
        python_like = re.sub(r"\bnull\b", "None", python_like, flags=re.IGNORECASE)
        try:
            return ast.literal_eval(python_like)
        except (ValueError, SyntaxError):
            return None

    def _api_reasoning_effort_for(
        self, model_name: str, override: Optional[str] = None
    ) -> Optional[str]:
        effort = (
            override
            or self.api_reasoning_effort_map.get(model_name)
            or self.reasoning_effort
        )
        return None if effort == "none" else effort

    def _openai_temperature_for(
        self, model_name: str, temperature: Optional[float]
    ) -> Optional[float]:
        if temperature is None:
            return None
        normalized = model_name.lower()
        if normalized.startswith(("gpt-5", "o1", "o3", "o4")):
            return None
        return temperature

    @staticmethod
    def _uses_responses_api(model_name: str) -> bool:
        return model_name == "gpt-5.6-sol"

    @staticmethod
    def _response_field(value: Any, name: str, default: Any = None) -> Any:
        if isinstance(value, dict):
            return value.get(name, default)
        return getattr(value, name, default)

    @classmethod
    def _responses_output_text(cls, response: Any) -> str:
        direct = cls._response_field(response, "output_text", "")
        if direct:
            return str(direct).strip()

        output = cls._response_field(response, "output", []) or []
        texts: List[str] = []
        for item in output:
            content = cls._response_field(item, "content", []) or []
            for part in content:
                if cls._response_field(part, "type") != "output_text":
                    continue
                text = cls._response_field(part, "text", "")
                if text:
                    texts.append(str(text))
        return "".join(texts).strip()

    def _gemini_thinking_config(
        self, model_name: str, effort: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        effort = effort if effort is not None else self.reasoning_effort
        if not effort:
            return None

        if model_name.startswith("gemini-3"):
            if effort in {"minimal", "low", "medium", "high"}:
                return {"thinkingLevel": effort}
            if effort == "none":
                return {"thinkingLevel": "minimal"}
            return None

        if model_name.startswith("gemini-2.5"):
            if effort == "dynamic":
                return {"thinkingBudget": -1}
            if effort == "none":
                return {"thinkingBudget": 0}
            if effort.isdigit():
                return {"thinkingBudget": int(effort)}
            budget_by_effort = {
                "minimal": 512,
                "low": 1024,
                "medium": 8192,
                "high": 32768 if model_name.startswith("gemini-2.5-pro") else 24576,
            }
            if effort in budget_by_effort:
                return {"thinkingBudget": budget_by_effort[effort]}

        return None

    def _gemini_generation_config(
        self,
        model_name: str,
        temperature: Optional[float] = None,
        reasoning_effort: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        config: Dict[str, Any] = {}
        if temperature is not None:
            config["temperature"] = temperature
        thinking_config = self._gemini_thinking_config(model_name, reasoning_effort)
        if thinking_config:
            config["thinkingConfig"] = thinking_config
        return config or None

    def _generate_gemini_content(
        self,
        model_name: str,
        api_key: str,
        contents: List[Dict[str, Any]],
        temperature: Optional[float] = None,
        reasoning_effort: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_name}:generateContent"
        )
        body: Dict[str, Any] = {"contents": contents}
        generation_config = self._gemini_generation_config(
            model_name,
            temperature,
            reasoning_effort,
        )
        if generation_config:
            body["generationConfig"] = generation_config

        response = requests.post(
            url,
            params={"key": api_key},
            headers={"Content-Type": "application/json"},
            json=body,
            timeout=180,
        )
        response.raise_for_status()
        data = response.json()
        parts = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [])
        )
        text = "".join(
            part.get("text", "")
            for part in parts
            if part.get("text") and not part.get("thought")
        ).strip()
        return text, data.get("usageMetadata") or {}

    def _extract_with_cli_provider(
        self,
        prompt: str,
        provider: str,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> Optional[str]:
        from .cli_llm import execute_cli_prompt

        model = model if model is not None else self.cli_model_map.get(provider)
        label = f"{provider} CLI"
        if model:
            label += f" ({model})"
        self.logger.info(f"{label} でLLM判定を試行中...")

        cli_kwargs: Dict[str, Any] = {
            "provider": provider,
            "cwd": self.cli_cwd,
            "timeout": self.cli_timeout,
            "model": model,
        }
        effort = effort if effort is not None else self.cli_effort_map.get(provider)
        if effort is not None:
            cli_kwargs["effort"] = effort
        success, output = execute_cli_prompt(prompt, **cli_kwargs)
        if not success:
            self.logger.warning(f"{label} が失敗しました: {output}")
            return None

        content = self._normalize_response_text(output)
        try:
            json.loads(content)
        except json.JSONDecodeError as e:
            self.logger.warning(f"{label} のJSONパースに失敗しました: {e}")
            return None

        self.logger.info(f"{label} でLLM判定に成功しました")
        return content

    def _extract_with_cli(self, prompt: str) -> Optional[str]:
        if not self.cli_providers:
            return None

        from .cli_llm import execute_cli_prompt

        for provider in self.cli_providers:
            model = self.cli_model_map.get(provider)
            label = f"{provider} CLI"
            if model:
                label += f" ({model})"
            self.logger.info(f"{label} でLLM判定を試行中...")

            cli_kwargs: Dict[str, Any] = {
                "provider": provider,
                "cwd": self.cli_cwd,
                "timeout": self.cli_timeout,
                "model": model,
            }
            effort = self.cli_effort_map.get(provider)
            if effort is not None:
                cli_kwargs["effort"] = effort
            success, output = execute_cli_prompt(prompt, **cli_kwargs)
            if not success:
                self.logger.warning(f"{label} が失敗しました: {output}")
                continue

            content = self._normalize_response_text(output)
            try:
                json.loads(content)
            except json.JSONDecodeError as e:
                self.logger.warning(f"{label} のJSONパースに失敗しました: {e}")
                continue

            self.logger.info(f"{label} でLLM判定に成功しました")
            return content

        return None

    def _extract_data_with_attempts(
        self,
        prompt: str,
        temperature: float = 0.1,
        reasoning_effort: Optional[str] = None,
    ) -> str:
        last_error = None
        for index, attempt in enumerate(self.attempts):
            try:
                if attempt.get("kind") == "cli":
                    content = self._extract_with_cli_provider(
                        prompt,
                        attempt.get("provider", ""),
                        attempt.get("model"),
                        attempt.get("effort"),
                    )
                    if content is None:
                        raise RuntimeError("CLI LLM処理に失敗しました")
                    return content

                model_name = attempt.get("model")
                if not model_name:
                    raise RuntimeError("APIモデルが空です")
                api_client = LLMClient(
                    model=model_name,
                    reasoning_effort=attempt.get("effort") or reasoning_effort or self.reasoning_effort,
                    api_reasoning_effort_map=self.api_reasoning_effort_map,
                )
                return api_client.extract_data(prompt, temperature=temperature)
            except Exception as e:
                last_error = e
                self.logger.error(f"LLM試行 {index + 1} が失敗しました: {e}")
                if index < len(self.attempts) - 1:
                    time.sleep(1)
                    continue

        if last_error is None:
            raise RuntimeError("CLI/API LLM処理に失敗しました")
        raise last_error

    def extract_data(
        self,
        prompt: str,
        temperature: float = 0.1,
        reasoning_effort: Optional[str] = None,
    ) -> str:
        """データ抽出のためのLLM呼び出し（フォールバック対応）"""
        if self.attempts:
            return self._extract_data_with_attempts(
                prompt,
                temperature,
                reasoning_effort,
            )

        last_error = None

        cli_content = self._extract_with_cli(prompt)
        if cli_content is not None:
            return cli_content
        if self.cli_providers:
            self.logger.warning("すべてのCLI LLMが失敗しました。APIモデルにフォールバックします。")

        for i, client_info in enumerate(self.clients):
            try:
                self.logger.info(f"モデル {client_info['model']} で処理を試行中...")
                effective_reasoning_effort = self._api_reasoning_effort_for(
                    client_info["model"],
                    reasoning_effort,
                )

                cost_tracker = get_cost_tracker()

                if client_info["api_type"] == "gemini":
                    # Gemini API
                    full_prompt = (
                        "あなたはHTMLを解析してデータを抽出する専門家です。常にJSON形式で回答してください。\n\n"
                        + prompt
                    )
                    content, usage_metadata = self._generate_gemini_content(
                        client_info["model"],
                        client_info["api_key"],
                        [{"parts": [{"text": full_prompt}]}],
                        temperature=temperature,
                        reasoning_effort=effective_reasoning_effort,
                    )
                    # トークン追跡
                    if usage_metadata:
                        cost_tracker.add_tokens(
                            client_info["model"],
                            usage_metadata.get("promptTokenCount", 0),
                            usage_metadata.get("candidatesTokenCount", 0),
                        )
                elif self._uses_responses_api(client_info["model"]):
                    response = client_info["client"].responses.create(
                        model=client_info["model"],
                        instructions=(
                            "あなたはHTMLを解析してデータを抽出する専門家です。"
                            "常にJSON形式で回答してください。"
                        ),
                        input=prompt,
                        reasoning={
                            "effort": effective_reasoning_effort or "medium"
                        },
                    )
                    content = self._responses_output_text(response)
                    usage = self._response_field(response, "usage")
                    if usage:
                        cost_tracker.add_tokens(
                            client_info["model"],
                            self._response_field(usage, "input_tokens", 0),
                            self._response_field(usage, "output_tokens", 0),
                        )
                else:
                    # OpenAI API
                    # GPT-5-miniはtemperature=1のみサポート
                    api_kwargs: Dict[str, Any] = {
                        "model": client_info["model"],
                        "messages": [
                            {
                                "role": "system",
                                "content": "あなたはHTMLを解析してデータを抽出する専門家です。常にJSON形式で回答してください。",
                            },
                            {"role": "user", "content": prompt},
                        ],
                    }
                    actual_temperature = self._openai_temperature_for(
                        client_info["model"], temperature
                    )
                    if actual_temperature is not None:
                        api_kwargs["temperature"] = actual_temperature
                    if effective_reasoning_effort and client_info["api_type"] == "openai":
                        api_kwargs["reasoning_effort"] = effective_reasoning_effort

                    response = client_info["client"].chat.completions.create(
                        **api_kwargs
                    )
                    content = response.choices[0].message.content.strip()
                    # トークン追跡
                    if response.usage:
                        cost_tracker.add_tokens(
                            client_info["model"],
                            response.usage.prompt_tokens,
                            response.usage.completion_tokens,
                        )

                # JSON部分を抽出
                if content.startswith("```json"):
                    content = content[7:]
                if content.endswith("```"):
                    content = content[:-3]

                # JSONの妥当性を確認
                try:
                    json.loads(content)
                except json.JSONDecodeError as e:
                    self.logger.warning(f"LLMレスポンスがJSON形式ではありません: {e}")

                self.logger.info(f"モデル {client_info['model']} で正常に処理完了")
                return content

            except Exception as e:
                last_error = e
                self.logger.error(f"モデル {client_info['model']} でエラー: {e}")

                # 最後のモデルでなければ次を試行
                if i < len(self.clients) - 1:
                    self.logger.info(f"次のモデルにフォールバック...")
                    time.sleep(1)  # レート制限対策
                    continue

        # すべてのモデルで失敗
        self.logger.error(f"すべてのモデルで処理に失敗しました")
        if last_error is None:
            raise RuntimeError("CLI/API LLM処理に失敗しました")
        raise last_error

    def analyze_structure(
        self, html_content: str, max_length: int = 5000
    ) -> Dict[str, Any]:
        """HTML構造を分析"""
        # HTMLを制限
        truncated_html = html_content[:max_length]

        prompt = f"""
以下のHTMLコンテンツの構造を分析してください。

HTML:
{truncated_html}

以下の形式でJSONを返してください:
{{
    "structure_type": "table|div|list|mixed",
    "has_table": true/false,
    "table_count": 数値,
    "main_content_selector": "CSSセレクタ",
    "circle_container_type": "要素タイプ",
    "data_attributes": ["使用されているdata属性"],
    "class_patterns": ["クラス名パターン"],
    "extraction_hints": "データ抽出のヒント"
}}
"""

        response = self.extract_data(prompt)

        try:
            return json.loads(response)
        except json.JSONDecodeError:
            return {
                "structure_type": "unknown",
                "extraction_hints": "構造分析に失敗しました",
            }

    def analyze_image(
        self, image_path: str, prompt: str, model: Optional[str] = None
    ) -> str:
        """画像を解析してテキスト情報を抽出（フォールバック対応）"""
        last_error = None

        for i, client_info in enumerate(self.clients):
            try:
                self.logger.info(f"モデル {client_info['model']} で画像解析を試行中...")
                effective_reasoning_effort = self._api_reasoning_effort_for(
                    client_info["model"],
                )

                cost_tracker = get_cost_tracker()

                if client_info["api_type"] == "gemini":
                    # Gemini API
                    image_suffix = os.path.splitext(image_path)[1].lower()
                    mime_type = "image/png" if image_suffix == ".png" else "image/jpeg"
                    with open(image_path, "rb") as image_file:
                        base64_image = base64.b64encode(image_file.read()).decode(
                            "utf-8"
                        )
                    content, usage_metadata = self._generate_gemini_content(
                        client_info["model"],
                        client_info["api_key"],
                        [
                            {
                                "parts": [
                                    {"text": prompt},
                                    {
                                        "inline_data": {
                                            "mime_type": mime_type,
                                            "data": base64_image,
                                        }
                                    },
                                ]
                            }
                        ],
                        reasoning_effort=effective_reasoning_effort,
                    )
                    # トークン追跡
                    if usage_metadata:
                        cost_tracker.add_tokens(
                            client_info["model"],
                            usage_metadata.get("promptTokenCount", 0),
                            usage_metadata.get("candidatesTokenCount", 0),
                        )
                else:
                    # OpenAI API
                    # 画像をbase64エンコード
                    with open(image_path, "rb") as image_file:
                        base64_image = base64.b64encode(image_file.read()).decode(
                            "utf-8"
                        )

                    # GPT-5-miniはtemperature=1のみサポート
                    model_name = model or client_info["model"]

                    if self._uses_responses_api(model_name):
                        image_suffix = os.path.splitext(image_path)[1].lower()
                        mime_type = "image/png" if image_suffix == ".png" else "image/jpeg"
                        response = client_info["client"].responses.create(
                            model=model_name,
                            instructions="画像を解析して、指定されたJSON形式で回答してください。",
                            input=[
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "input_text", "text": prompt},
                                        {
                                            "type": "input_image",
                                            "image_url": (
                                                f"data:{mime_type};base64,{base64_image}"
                                            ),
                                        },
                                    ],
                                }
                            ],
                            reasoning={
                                "effort": effective_reasoning_effort or "medium"
                            },
                        )
                        content = self._responses_output_text(response)
                        usage = self._response_field(response, "usage")
                        if usage:
                            cost_tracker.add_tokens(
                                model_name,
                                self._response_field(usage, "input_tokens", 0),
                                self._response_field(usage, "output_tokens", 0),
                            )
                    else:
                        api_kwargs: Dict[str, Any] = {
                            "model": model_name,
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "text", "text": prompt},
                                        {
                                            "type": "image_url",
                                            "image_url": {
                                                "url": f"data:image/jpeg;base64,{base64_image}"
                                            },
                                        },
                                    ],
                                }
                            ],
                        }
                        actual_temperature = self._openai_temperature_for(model_name, 0.1)
                        if actual_temperature is not None:
                            api_kwargs["temperature"] = actual_temperature
                        if effective_reasoning_effort:
                            api_kwargs["reasoning_effort"] = effective_reasoning_effort

                        response = client_info["client"].chat.completions.create(
                            **api_kwargs
                        )

                        content = response.choices[0].message.content.strip()
                        # トークン追跡
                        if response.usage:
                            cost_tracker.add_tokens(
                                model_name,
                                response.usage.prompt_tokens,
                                response.usage.completion_tokens,
                            )

                # JSON部分を抽出
                if content.startswith("```json"):
                    content = content[7:]
                if content.endswith("```"):
                    content = content[:-3]

                self.logger.info(f"モデル {client_info['model']} で画像解析完了")
                return content

            except Exception as e:
                last_error = e
                self.logger.error(
                    f"モデル {client_info['model']} で画像解析エラー: {e}"
                )

                # 最後のモデルでなければ次を試行
                if i < len(self.clients) - 1:
                    self.logger.info(f"次のモデルにフォールバック...")
                    time.sleep(1)  # レート制限対策
                    continue

        # すべてのモデルで失敗
        self.logger.error(f"すべてのモデルで画像解析に失敗しました")
        raise last_error

    def extract_event_keywords(self, event_info: str) -> List[str]:
        """
        イベント情報からお品書きツイート検索用のキーワードを抽出

        Args:
            event_info: イベント情報（イベント名、略称、開催日などを含むテキスト）

        Returns:
            抽出されたキーワードのリスト
        """
        deterministic_keywords = extract_event_keywords_from_text(event_info)
        if deterministic_keywords:
            self.logger.info(
                f"Extracted {len(deterministic_keywords)} explicit keywords from event info: {deterministic_keywords}"
            )
            return deterministic_keywords

        prompt = f"""
以下のイベント情報から、Twitterでお品書きツイートを検索する際に有効なキーワードを抽出してください。

イベント情報:
{event_info}

抽出基準:
1. イベントの正式名称（複数あれば全て）
2. イベントの略称（複数あれば全て）
3. よく使われる愛称やハッシュタグ
4. イベント名の一部で特徴的なワード

注意:
- 単に「イベント」「開催」などの一般的すぎる単語は不要
- 日付や年月日などの時間情報も不要
- 具体的にツイート本文に含まれそうなワードのみ

以下のJSON形式で回答してください：
```json
{{
  "keywords": ["キーワード1", "キーワード2", ...]
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)

            try:
                result = json.loads(result_text)
                keywords = result.get("keywords", [])
                self.logger.info(
                    f"Extracted {len(keywords)} keywords from event info: {keywords}"
                )
                return keywords
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse LLM response as JSON: {result_text}"
                )
                return []

        except Exception as e:
            self.logger.error(f"Error extracting keywords: {e}")
            return []

    def is_event_related_tweet(
        self,
        tweet_text: str,
        event_name: str,
        event_date: str = "",
        additional_prompt: str = "",
    ) -> Dict[str, Any]:
        """
        ツイートが特定のイベントに関連しているか判定

        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名
            event_date: イベント日付（オプション）
            additional_prompt: 追加プロンプト（オプション）

        Returns:
            判定結果の辞書
        """
        prompt = f"""
以下のツイートが、指定された同人イベントのお品書き（サークル参加情報、新刊情報、頒布物情報）に関連しているか判定してください。

イベント名: {event_name}

ツイート:
{tweet_text}

判定基準:
1. イベント名の略称や一部が含まれている場合は関連あり
2. 「お品書き」「新刊」「サークル参加」「スペース」などのキーワードがある場合は関連性が高い
3. ただし、別のイベント名が明記されている場合は関連なし
4. 通販や店舗委託のみの告知は、明確にそのイベントに関連していない限り関連なし
{f'{chr(10)}追加指示: {additional_prompt}' if additional_prompt else ''}

以下のJSON形式で回答してください：
```json
{{
  "is_related": true/false,
  "confidence": 0.0～1.0,
  "reason": "判定理由",
  "detected_event_name": "ツイート内で検出したイベント名（あれば）"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)

            try:
                result = json.loads(result_text)
                self.logger.info(
                    f"Event relation check - Related: {result.get('is_related')}, Confidence: {result.get('confidence')}"
                )
                return result
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse LLM response as JSON: {result_text}"
                )
                return {
                    "is_related": True,  # エラー時は安全のためTrueを返す
                    "confidence": 0.5,
                    "reason": "LLMレスポンスのパースに失敗",
                    "error": True,
                }

        except Exception as e:
            self.logger.error(f"Error checking event relation: {e}")
            return {
                "is_related": True,  # エラー時は安全のためTrueを返す
                "confidence": 0.5,
                "reason": f"LLM判定エラー: {str(e)}",
                "error": True,
            }

    def is_existing_only_catalog(
        self, tweet_text: str, event_name: str = ""
    ) -> Dict[str, Any]:
        """
        お品書きツイートが「既刊のみ」かどうかを判定

        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名（オプション）

        Returns:
            判定結果の辞書
        """
        prompt = f"""
以下のお品書きツイートが「既刊のみ」の頒布内容かどうかを判定してください。

ツイート:
{tweet_text}
{f'{chr(10)}イベント名: {event_name}' if event_name else ''}

判定基準:
1. 「既刊のみ」「既刊だけ」などの明示的な記載がある → 既刊のみ
2. 「新刊なし」「新刊ありません」などの記載がある → 既刊のみ
3. 既刊の情報のみで新刊の情報が全くない、かつ「既刊」という言葉が含まれる → 既刊のみ
4. 新刊の情報が含まれている場合 → 既刊のみではない
5. 既刊という言葉が全く含まれていない場合 → 判定不能（既刊のみではない）
6. 通販のみの告知 → 既刊のみではない

重要な注意事項:
- 「線画のみ」「コピー本だけ」「ペーパーのみ」など、否定的なニュアンスでも新刊の情報があれば既刊のみではない
- 「～のみ」「～だけ」という表現があっても、それが新刊の形態や内容を指している場合は新刊として扱う
- 断定できない場合はis_existing_only=falseを返す
- 新刊情報が少しでもあれば既刊のみではない

以下のJSON形式で回答してください：
```json
{{
  "is_existing_only": true/false,
  "confidence": 0.0～1.0,
  "reason": "判定理由"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)

            try:
                result = json.loads(result_text)
                self.logger.info(
                    f"Existing-only check - Result: {result.get('is_existing_only')}, Confidence: {result.get('confidence')}"
                )
                return result
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse LLM response as JSON: {result_text}"
                )
                return {
                    "is_existing_only": False,  # エラー時は安全のためFalseを返す
                    "confidence": 0.0,
                    "reason": "LLMレスポンスのパースに失敗",
                    "error": True,
                }

        except Exception as e:
            self.logger.error(f"Error checking existing-only: {e}")
            return {
                "is_existing_only": False,  # エラー時は安全のためFalseを返す
                "confidence": 0.0,
                "reason": f"LLM判定エラー: {str(e)}",
                "error": True,
            }

    def classify_catalog_tweet(
        self, tweet_text: str, event_name: str = ""
    ) -> Dict[str, Any]:
        """
        お品書きツイートが「確定版」か「予告」かを判定

        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名（オプション）

        Returns:
            判定結果の辞書 {"classification": "confirmed"/"preview", "confidence": float, "reason": str}
        """
        prompt = f"""以下のツイートが「確定版おしながき」か「おしながき予告」かを判定してください。

ツイート:
{tweet_text}
{f'{chr(10)}イベント名: {event_name}' if event_name else ''}

判定基準:
1. 確定版おしながき (confirmed):
   - 具体的な頒布物の情報がある（タイトル、価格、ページ数、サイズなど）
   - 完成したお品書き画像への言及がある（「お品書きです」「頒布物一覧」等）
   - 頒布物のリストが記載されている
   - スペース番号と共に頒布内容が記載されている

2. おしながき予告 (preview):
   - 「お品書き準備中」「お品書き作成中」「後日公開」「お品書きは後ほど」
   - 「参加します」「スペースいただきました」だけで頒布物の具体的情報がない
   - 「新刊出します」だけで詳細がない
   - 「お品書きは明日」「近日中にお品書き出します」

3. 迷った場合は confirmed を選択（予告を見逃すより確定を見逃す方が問題）

以下のJSON形式で回答してください：
```json
{{
  "classification": "confirmed" または "preview",
  "confidence": 0.0～1.0,
  "reason": "判定理由"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)

            try:
                result = json.loads(result_text)
                self.logger.info(
                    f"Catalog classification - Result: {result.get('classification')}, Confidence: {result.get('confidence')}"
                )
                return result
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse LLM response as JSON: {result_text}"
                )
                return {
                    "classification": "confirmed",  # エラー時は安全のためconfirmedを返す
                    "confidence": 0.0,
                    "reason": "LLMレスポンスのパースに失敗",
                    "error": True,
                }

        except Exception as e:
            self.logger.error(f"Error classifying catalog tweet: {e}")
            return {
                "classification": "confirmed",  # エラー時は安全のためconfirmedを返す
                "confidence": 0.0,
                "reason": f"LLM判定エラー: {str(e)}",
                "error": True,
            }

    def detect_product_type(self, tweet_text: str, event_name: str = "") -> List[str]:
        """
        お品書きツイートのテキストから頒布物の種類を判定

        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名（オプション）

        Returns:
            検出されたタグのリスト（例: ["CD"]）
        """
        prompt = f"""以下のツイートは同人イベントのお品書き（頒布物告知）です。
頒布物の種類を判定してください。

ツイート:
{tweet_text}

【判定するタグ（該当するものを全て選択）】
- 本: 同人誌、本、漫画、小説、イラスト集、画集、アートブック、合同誌、アンソロジー、コピー本、文庫本、ペーパーなど紙の印刷物
- CD: CD、音楽CD、楽曲、アルバム、シングル、コンピレーション、ボーカル、インスト、ダウンロードコード（音楽配信含む）
- グッズ: アクリルスタンド、缶バッジ、ステッカー、タオル、Tシャツ、キーホルダー、ポストカード、クリアファイル、抱き枕カバーなど物品
- デジタル: ゲーム、ソフトウェア、デジタルデータ（音楽以外）

【ルール】
- 複数該当する場合は全て列挙
- 判定できない場合は空配列を返す
- 「ダウンロードコード販売」でも音楽なら「CD」に分類

以下のJSON形式で回答してください：
```json
{{
  "tags": ["CD"],
  "reason": "判定理由"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)

            try:
                result = json.loads(result_text)
                tags = result.get("tags", [])
                if tags:
                    self.logger.info(f"Product type detected: {', '.join(tags)}")
                return tags
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse product type response: {result_text}"
                )
                return []

        except Exception as e:
            self.logger.error(f"Error detecting product type: {e}")
            return []

    def select_best_catalog_tweet(
        self, tweets: List[Dict[str, Any]], event_name: str = ""
    ) -> int:
        """
        複数のおしながきツイート候補から最も完成度の高いものを選出

        Args:
            tweets: おしながきツイートのリスト（各要素は {'text': str, 'date': str, 'has_media': bool} を含む）
            event_name: イベント名（オプション）

        Returns:
            最適なツイートのインデックス（0始まり）
        """
        if len(tweets) <= 1:
            return 0

        # ツイート情報を整形
        tweets_text = ""
        for i, tweet in enumerate(tweets):
            has_media = "あり" if tweet.get("has_media", False) else "なし"
            tweets_text += f"\n--- ツイート {i+1} (日付: {tweet.get('date', '不明')}, 画像: {has_media}) ---\n{tweet['text']}\n"

        prompt = f"""以下は同一サークルの同一イベントに関するおしながき（頒布物告知）ツイートの候補一覧です。
この中から「最も完成度が高く、お品書きとして最適なツイート」を1つ選んでください。

{f'イベント名: {event_name}' if event_name else ''}

{tweets_text}

【選出基準（優先度順）】
1. 具体的な頒布物情報の充実度（タイトル、価格、ページ数、サイズ等）
2. 「確定版」であること（「予告」「準備中」「後日」ではない）
3. 画像が添付されている（お品書き画像がある方が良い）
4. より新しい日付（同等の完成度なら新しい方を優先）

以下のJSON形式で回答してください：
```json
{{
  "best_index": 選んだツイートの番号(1始まり),
  "reason": "選出理由"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)
            try:
                result = json.loads(result_text)
                best_index = result.get("best_index", 1) - 1  # 1始まり→0始まりに変換
                # 範囲チェック
                if best_index < 0 or best_index >= len(tweets):
                    self.logger.warning(
                        f"LLMが返したインデックスが範囲外: {best_index + 1}, デフォルト(最新)を使用"
                    )
                    return 0
                self.logger.info(
                    f"Best catalog tweet selected: #{best_index + 1} - {result.get('reason', '')}"
                )
                return best_index
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse best tweet selection response: {result_text}"
                )
                return 0

        except Exception as e:
            self.logger.error(f"Error selecting best catalog tweet: {e}")
            return 0

    def batch_filter_catalog_tweets(
        self,
        tweets_data: List[Dict[str, Any]],
        event_name: str,
        event_date: str = "",
        additional_prompt: str = "",
    ) -> Dict[str, Any]:
        """
        複数ツイートをまとめて1回のLLM呼び出しで判定。
        おしながき関連ツイートの特定＋最も詳細なものの選出を同時に行う。

        Args:
            tweets_data: ツイートリスト [{"index": int, "text": str, "date": str, "has_media": bool}, ...]
            event_name: イベント名
            event_date: イベント日付
            additional_prompt: 追加プロンプト

        Returns:
            {"catalog_indices": [int], "best_index": int|null, "absence_indices": [int]}
        """
        if not tweets_data:
            return {"catalog_indices": [], "best_index": None, "absence_indices": []}

        # ツイート一覧を整形
        tweets_text = ""
        for t in tweets_data:
            has_media = "あり" if t.get("has_media", False) else "なし"
            tweets_text += f"\n--- ツイート {t['index']} (日付: {t.get('date', '不明')}, 画像: {has_media}) ---\n{t['text']}\n"

        prompt = f"""以下はあるサークルのツイート一覧です。この中からイベント「{event_name}」に関連するおしながき（お品書き＝頒布物告知）ツイートを特定してください。
{f'イベント開催日: {event_date}' if event_date else ''}
{f'追加情報: {additional_prompt}' if additional_prompt else ''}

{tweets_text}

【作業】
1. 各ツイートが「{event_name}」のおしながき（頒布物告知・サークル参加情報）かどうか判定
2. 欠席・不参加を示すツイートがあれば特定
3. おしながきツイートが複数ある場合、最も完成度が高い（詳細な頒布物情報がある）ものを選出

【判定基準】
- イベント名の略称や一部が含まれ、かつ頒布物情報がある → おしながき
- 「お品書き」「新刊」「頒布」「サークル参加」「スペース」等のキーワード＋イベントへの言及 → おしながき
- 別のイベント名が明記されている場合 → 関連なし
- 通販のみの告知 → 関連なし
- 「不参加」「欠席」「見送り」 → 欠席

【ベスト選出基準（優先度順）】
1. 具体的な頒布物情報の充実度（タイトル、価格、ページ数等）
2. 「確定版」であること（「予告」「準備中」ではない）
3. 画像が添付されている
4. より新しい日付

以下のJSON形式で回答してください：
```json
{{
  "catalog_indices": [おしながきツイートのindex番号の配列],
  "best_index": 最も詳細なおしながきツイートのindex番号（なければnull）,
  "absence_indices": [欠席ツイートのindex番号の配列],
  "reason": "判定理由の要約"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)
            try:
                result = json.loads(result_text)
                self.logger.info(
                    f"Batch filter: catalogs={result.get('catalog_indices', [])}, "
                    f"best={result.get('best_index')}, "
                    f"absences={result.get('absence_indices', [])}"
                )
                return result
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse batch filter response: {result_text}"
                )
                return {
                    "catalog_indices": [],
                    "best_index": None,
                    "absence_indices": [],
                }
        except Exception as e:
            self.logger.error(f"Error in batch_filter_catalog_tweets: {e}")
            return {"catalog_indices": [], "best_index": None, "absence_indices": []}

    def analyze_catalog_tweet_detail(
        self,
        tweet_text: str,
        event_name: str = "",
    ) -> Dict[str, Any]:
        """
        おしながきツイート1件に対して、分類・既刊判定・頒布物種別を1回のLLM呼び出しで統合判定。

        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名

        Returns:
            {
                "classification": "confirmed"/"preview",
                "is_existing_only": bool,
                "product_types": ["CD", "本", ...],
                "confidence": float,
                "reason": str
            }
        """
        prompt = f"""以下のツイートは同人イベントのおしながき（頒布物告知）です。4つの観点で同時に判定してください。
{f'イベント名: {event_name}' if event_name else ''}

ツイート:
{tweet_text}

【判定1: 確定版 vs 予告】
- confirmed: 具体的な頒布物情報がある（タイトル、価格、ページ数等）、完成したお品書き画像への言及、頒布物リスト記載
- preview: 「準備中」「後日公開」「参加します」だけで詳細なし、「新刊出します」だけで詳細なし
- 迷ったらconfirmed

【判定2: 既刊のみかどうか】
- 「既刊のみ」「新刊なし」等の明示的記載 → 既刊のみ
- 新刊情報が少しでもあれば既刊のみではない
- 断定できなければfalse

【判定3: 頒布物の種類（該当する全てを選択）】
- 本: 同人誌、漫画、小説、イラスト集、コピー本、ペーパー等の紙の印刷物
- CD: CD、音楽CD、楽曲、アルバム、ダウンロードコード（音楽配信含む）
- グッズ: アクスタ、缶バッジ、ステッカー、タオル、Tシャツ、キーホルダー等
- デジタル: ゲーム、ソフトウェア、デジタルデータ（音楽以外）

【判定4: サークルのジャンル】
以下から最も適切なものを1つ選んでください（新刊・既刊の区別は不要）：
- 漫画: 同人誌、マンガ、コミック
- イラスト: イラスト集、画集、CG集
- 音楽: CD、音楽作品、楽曲
- 小説: 小説、文芸、SS
- 雑誌: 雑誌、情報誌、フリーペーパー、合同誌、アンソロジー、絵本など漫画・イラスト・小説に分類しにくい本
- グッズ: グッズのみの頒布（アクキー、缶バッジ等）
- その他: 上記に当てはまらない
- 判定できない場合は空文字列""

以下のJSON形式で回答してください：
```json
{{
  "classification": "confirmed" または "preview",
  "is_existing_only": true/false,
  "existing_only_confidence": 0.0～1.0,
  "product_types": ["CD", "本"],
  "genre": "音楽",
  "reason": "判定理由"
}}
```
"""

        try:
            result_text = self.extract_data(prompt, temperature=0.1)
            try:
                result = json.loads(result_text)
                self.logger.info(
                    f"Catalog detail: classification={result.get('classification')}, "
                    f"existing_only={result.get('is_existing_only')}, "
                    f"products={result.get('product_types', [])}"
                )
                return result
            except json.JSONDecodeError:
                self.logger.warning(
                    f"Failed to parse catalog detail response: {result_text}"
                )
                return {
                    "classification": "confirmed",
                    "is_existing_only": False,
                    "existing_only_confidence": 0.0,
                    "product_types": [],
                    "reason": "LLMレスポンスのパースに失敗",
                    "error": True,
                }
        except Exception as e:
            self.logger.error(f"Error in analyze_catalog_tweet_detail: {e}")
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": [],
                "reason": f"LLM判定エラー: {str(e)}",
                "error": True,
            }

    def extract_catalog_items_from_text(
        self,
        tweet_text: str,
        event_name: str = "",
    ) -> List[Dict[str, Any]]:
        """
        X投稿本文だけで頒布物の品名・価格が具体的に分かる場合だけitemsを抽出する。
        予告、概要、種別だけの場合は空配列を返す。
        """
        from .catalog_image_analyzer import CatalogImageAnalyzer

        tags_list = "、".join(CatalogImageAnalyzer.ITEM_TAGS)
        prompt = f"""以下は同人イベントのX投稿本文です。
本文だけから、買い物リストに入れられる具体的な頒布物を抽出してください。
{f'イベント名: {event_name}' if event_name else ''}

投稿本文:
{tweet_text}

抽出ルール:
- 品名、価格、頒布物内容が本文中に具体的に書かれている場合だけitemsにする
- 「お品書き公開しました」「画像をご覧ください」「後日追加」「準備中」だけなら [] を返す
- 「本/CD/グッズ」程度の種別しか分からない場合も [] を返す
- 価格が不明なら price は 0
- type は必ず次のどれか: {tags_list}
- 推測で品名を作らない

JSON配列だけで返してください:
[
  {{"name": "品名", "type": "種別タグ", "price": 500, "description": "本文由来なら短い補足"}}
]
"""
        try:
            result_text = self.extract_data(prompt, temperature=0.1)
            json_match = re.search(r'\[[\s\S]*\]', result_text or "")
            if not json_match:
                return []
            raw_items = json.loads(json_match.group())
            if not isinstance(raw_items, list):
                return []

            valid_tags = set(CatalogImageAnalyzer.ITEM_TAGS)
            items: List[Dict[str, Any]] = []
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                name = str(raw.get("name", "")).strip()
                item_type = str(raw.get("type", "")).strip()
                if not name or item_type not in valid_tags:
                    continue
                try:
                    price = int(raw.get("price", 0) or 0)
                except (TypeError, ValueError):
                    price = 0
                items.append({
                    "name": name,
                    "type": item_type,
                    "price": max(price, 0),
                    "description": str(raw.get("description", "")).strip(),
                    "checked": 3,
                })
            return items
        except Exception as e:
            self.logger.warning(f"Failed to extract catalog items from text: {e}")
            return []

    def consolidate_catalog_items(
        self,
        items: List[Dict[str, Any]],
        event_name: str = "",
    ) -> List[Dict[str, Any]]:
        """
        画像由来と本文由来のitemsを同一頒布物単位に統合する。
        """
        if len(items) < 2:
            return items

        from .catalog_image_analyzer import CatalogImageAnalyzer

        tags_list = "、".join(CatalogImageAnalyzer.ITEM_TAGS)
        items_json = json.dumps(items, ensure_ascii=False, indent=2)
        prompt = f"""以下は同人イベントのお品書き処理で抽出された頒布物候補です。
画像解析由来と投稿本文由来が混在しており、同じ頒布物が表記ゆれで重複している可能性があります。
{f'イベント名: {event_name}' if event_name else ''}

候補items:
```json
{items_json}
```

統合ルール:
- 同じ頒布物を指す候補は1件にまとめる
- 表記ゆれ、接頭辞、略称、価格0と価格ありの差だけなら同一候補として扱う
- 別巻、別グッズ、セットと単品など、買い物リスト上で別に選ぶべきものは分ける
- name/type/price/description/image/checked は既存情報から選び、画像ファイル名がある場合は可能な限り残す
- price はより具体的な数値を優先する。両方不明なら0
- type は必ず次のどれか: {tags_list}
- 漫画本文、サンプルページ内の台詞、料理名や小物名は頒布物にしない
- 推測で新しい頒布物を追加しない

JSON配列だけで返してください:
[
  {{"name": "品名", "type": "種別タグ", "price": 500, "description": "短い補足", "image": "catalog_x.jpg", "checked": 3}}
]
"""
        try:
            result_text = self.extract_data(prompt, temperature=0.1)
            json_match = re.search(r'\[[\s\S]*\]', result_text or "")
            if not json_match:
                return []
            raw_items = json.loads(json_match.group())
            if not isinstance(raw_items, list):
                return []

            valid_tags = set(CatalogImageAnalyzer.ITEM_TAGS)
            normalized: List[Dict[str, Any]] = []
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                name = str(raw.get("name", "")).strip()
                item_type = str(raw.get("type", "")).strip()
                if not name or item_type not in valid_tags:
                    continue
                try:
                    price = int(raw.get("price", 0) or 0)
                except (TypeError, ValueError):
                    price = 0
                try:
                    checked = int(raw.get("checked", 3) or 3)
                except (TypeError, ValueError):
                    checked = 3
                item = {
                    "name": name,
                    "type": item_type,
                    "price": max(price, 0),
                    "description": str(raw.get("description", "")).strip(),
                    "checked": checked,
                }
                image = str(raw.get("image", "")).strip()
                if image:
                    item["image"] = image
                normalized.append(item)
            return normalized
        except Exception as e:
            self.logger.warning(f"Failed to consolidate catalog items: {e}")
            return []

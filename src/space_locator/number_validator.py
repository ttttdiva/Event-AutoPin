#!/usr/bin/env python3
"""
数字検証モジュール - LLMによるフォント一貫性チェック

検出された数字の切り抜き画像をLLMに見せて、
スペース番号として妥当かを判定する。
"""

import sys
import json
import re
import cv2
import base64
import numpy as np
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Dict, Any, Optional, Union, Mapping
import logging

# プロジェクトのルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.llm_client import LLMClient
from src.utils.llm_attempts import api_models_from_attempts


_DIAGNOSTIC_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*\S+"
)
_DIAGNOSTIC_URL_QUERY_KEY_RE = re.compile(
    r"(?i)([?&](?:key|api_key|access_token)=)[^&\s\"']+"
)
_DIAGNOSTIC_BEARER_RE = re.compile(r"(?i)Bearer\s+\S+")
_DIAGNOSTIC_WINDOWS_PATH_RE = re.compile(
    r"(?:[A-Za-z]:\\|\\\\)[^\s\"'`;,)\]]+"
)


class NumberValidatorImageReadError(ValueError):
    """NumberValidator がマップ画像そのものを読み込めない場合の専用例外。"""


class NumberValidatorLLMError(RuntimeError):
    """NumberValidator の画像 LLM 呼び出しまたはレスポンス解析が失敗した場合。"""

    def __init__(
        self,
        message: str,
        *,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        effort: Optional[str] = None,
        sanitized_message: Optional[str] = None,
        exception_type: Optional[str] = None,
    ):
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.effort = effort
        self.sanitized_message = sanitized_message or message
        self.exception_type = exception_type or type(self).__name__


@dataclass
class NumberValidationResult:
    status: str
    numbers: List[Dict[str, Any]]
    diagnostics: Dict[str, Any] = field(default_factory=dict)


def _sanitize_llm_error_message(value: Any, *, max_chars: int = 500) -> str:
    text = str(value or "")

    def redact_secret(match: re.Match[str]) -> str:
        raw = match.group(0)
        separator = max(raw.find("="), raw.find(":"))
        return f"{raw[: separator + 1] if separator >= 0 else 'secret:'}<redacted>"

    text = _DIAGNOSTIC_SECRET_RE.sub(redact_secret, text)
    text = _DIAGNOSTIC_URL_QUERY_KEY_RE.sub(r"\1<redacted>", text)
    text = _DIAGNOSTIC_BEARER_RE.sub("Bearer <redacted>", text)
    text = _DIAGNOSTIC_WINDOWS_PATH_RE.sub("<path>", text)
    text = text.strip()
    if len(text) > max_chars:
        return "…" + text[-(max_chars - 1) :]
    return text


def _normalize_api_provider(provider: Optional[str]) -> str:
    value = str(provider or "openai").strip().lower()
    if value in {"api", "openai"}:
        return "openai"
    if value == "gemini":
        return "gemini"
    return value


def _expected_api_type(provider: Optional[str]) -> str:
    return _normalize_api_provider(provider)


def _assert_provider_model_binding(provider: Optional[str], model: str) -> None:
    expected = _expected_api_type(provider)
    if expected == "gemini" and not str(model).startswith("gemini"):
        raise RuntimeError(f"Gemini API provider に非Geminiモデル: {model}")
    if expected == "openai" and str(model).startswith("gemini"):
        raise RuntimeError(f"OpenAI API provider にGeminiモデル: {model}")


class NumberValidator:
    """LLMを使った数字検証器"""

    def __init__(
        self,
        model: Union[str, List[str]] = "gpt-5-mini",
        *,
        attempts: Optional[List[Dict[str, Any]]] = None,
        api_reasoning_effort_map: Optional[Dict[str, str]] = None,
    ):
        """
        Args:
            model: 使用するLLMモデル名（API フォールバック用）
            attempts: 通常画像処理と同じ LLM routing 設定
            api_reasoning_effort_map: API モデルごとの reasoning effort
        """
        self.logger = logging.getLogger(__name__)
        self.attempts = list(attempts or [])
        self.api_reasoning_effort_map = dict(api_reasoning_effort_map or {})
        self._api_clients: Dict[tuple[str, str], LLMClient] = {}
        api_models = api_models_from_attempts(self.attempts)
        if self.attempts:
            self.llm_client = LLMClient(
                model=api_models,
                api_reasoning_effort_map=self.api_reasoning_effort_map,
                attempts=self.attempts,
            )
        else:
            self.llm_client = LLMClient(
                model=model,
                api_reasoning_effort_map=self.api_reasoning_effort_map,
            )

    @staticmethod
    def _load_image(image_path: str) -> Optional[np.ndarray]:
        """Unicode パスでも読めるよう cv2.imread 失敗時に imdecode へ fallback する。"""

        try:
            image = cv2.imread(str(image_path))
        except Exception:
            image = None
        if image is not None:
            return image
        try:
            encoded = np.fromfile(str(image_path), dtype=np.uint8)
            if encoded.size == 0:
                return None
            return cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        except (OSError, ValueError, TypeError):
            return None

    def _attempt_diagnostics(self, attempt: Mapping[str, Any]) -> Dict[str, Any]:
        return {
            "provider": attempt.get("provider"),
            "model": attempt.get("model"),
            "effort": attempt.get("effort"),
        }

    def _build_llm_error(
        self,
        message: str,
        *,
        attempt: Optional[Mapping[str, Any]] = None,
        sanitized_message: Optional[str] = None,
        exception_type: Optional[str] = None,
        cause: Optional[BaseException] = None,
    ) -> NumberValidatorLLMError:
        attempt = attempt or {}
        error = NumberValidatorLLMError(
            message,
            provider=attempt.get("provider"),
            model=attempt.get("model"),
            effort=attempt.get("effort"),
            sanitized_message=sanitized_message or _sanitize_llm_error_message(message),
            exception_type=exception_type or (type(cause).__name__ if cause else "RuntimeError"),
        )
        if cause is not None:
            raise error from cause
        return error

    def validate_numbers(
        self,
        image_path: str,
        detected_numbers: List[Dict[str, Any]],
    ) -> NumberValidationResult:
        raw_count = len(detected_numbers)
        if raw_count == 0:
            return NumberValidationResult(
                status="validated",
                numbers=[],
                diagnostics={
                    "status": "validated",
                    "raw_count": 0,
                    "validated_count": 0,
                },
            )

        image = self._load_image(image_path)
        if image is None:
            raise NumberValidatorImageReadError(
                f"マップ画像を読み込めません: {image_path}"
            )

        cropped_images = []
        for i, num_info in enumerate(detected_numbers):
            x = num_info["x"]
            y = num_info["y"]
            w = num_info.get("width", 30)
            h = num_info.get("height", 30)

            padding = 5
            x1 = max(0, x - padding)
            y1 = max(0, y - padding)
            x2 = min(image.shape[1], x + w + padding)
            y2 = min(image.shape[0], y + h + padding)

            cropped = image[y1:y2, x1:x2]
            _, buffer = cv2.imencode(".png", cropped)
            img_base64 = base64.b64encode(buffer).decode("utf-8")

            cropped_images.append(
                {
                    "index": i,
                    "number": num_info["number"],
                    "image_base64": img_base64,
                    "position": (x, y),
                }
            )

        self.logger.info(f"LLMで{len(cropped_images)}個の数字を検証中...")
        try:
            validation_result = self._validate_with_llm(cropped_images)
        except NumberValidatorLLMError as exc:
            diagnostics = {
                "status": "skipped_error",
                "provider": exc.provider,
                "model": exc.model,
                "effort": exc.effort,
                "reason": exc.sanitized_message,
                "raw_count": raw_count,
                "validated_count": None,
                "exception_type": exc.exception_type,
            }
            self.logger.warning(
                "NumberValidator 画像LLMをスキップします (provider=%s model=%s reason=%s)",
                exc.provider,
                exc.model,
                exc.sanitized_message,
            )
            return NumberValidationResult(
                status="skipped_error",
                numbers=list(detected_numbers),
                diagnostics=diagnostics,
            )

        valid_numbers = []
        for i, is_valid in enumerate(validation_result.get("valid_indices", [])):
            if is_valid:
                valid_numbers.append(detected_numbers[i])

        self.logger.info(
            f"検証完了: {len(valid_numbers)}/{len(detected_numbers)}個が妥当"
        )

        if not valid_numbers:
            return NumberValidationResult(
                status="rejected_all",
                numbers=[],
                diagnostics={
                    "status": "rejected_all",
                    "raw_count": raw_count,
                    "validated_count": 0,
                },
            )

        return NumberValidationResult(
            status="validated",
            numbers=valid_numbers,
            diagnostics={
                "status": "validated",
                "raw_count": raw_count,
                "validated_count": len(valid_numbers),
            },
        )

    def _api_client_for_attempt(self, attempt: Mapping[str, Any]) -> LLMClient:
        provider = _normalize_api_provider(str(attempt.get("provider") or "openai"))
        model = str(attempt.get("model") or "")
        key = (provider, model)
        if key not in self._api_clients:
            _assert_provider_model_binding(provider, model)
            self._api_clients[key] = LLMClient(
                model=model,
                api_reasoning_effort_map=self.api_reasoning_effort_map,
            )
            bound_clients = [
                client
                for client in self._api_clients[key].clients
                if client.get("api_type") == provider and client.get("model") == model
            ]
            if not bound_clients:
                raise RuntimeError(
                    f"API provider/model binding failed: {provider}/{model}"
                )
        return self._api_clients[key]

    def _analyze_api_image(
        self,
        attempt: Mapping[str, Any],
        image_path: str,
        prompt: str,
    ) -> str:
        provider = _normalize_api_provider(str(attempt.get("provider") or "openai"))
        model = str(attempt.get("model") or "")
        if not model:
            raise RuntimeError("API画像解析モデルが空です")
        client = self._api_client_for_attempt(attempt)
        matching = [
            client_info
            for client_info in client.clients
            if client_info.get("api_type") == provider
            and client_info.get("model") == model
        ]
        if not matching:
            raise RuntimeError(
                f"API provider/model client unavailable: {provider}/{model}"
            )
        return client.analyze_image(image_path, prompt, model=model)

    def _analyze_image_with_attempts(
        self,
        image_path: str,
        prompt: str,
    ) -> str:
        from src.utils.cli_llm import analyze_image_cli

        last_error: Optional[Exception] = None
        last_attempt: Dict[str, Any] = {}

        for index, attempt in enumerate(self.attempts):
            provider = str(attempt.get("provider") or "")
            model = attempt.get("model")
            effort = attempt.get("effort")
            last_attempt = attempt
            try:
                if attempt.get("kind") == "cli":
                    cli_model_map = {provider: model} if model else {}
                    cli_effort_map = {provider: effort} if effort is not None else {}
                    response_text = analyze_image_cli(
                        image_path=image_path,
                        prompt=prompt,
                        providers=[provider],
                        cli_model_map=cli_model_map,
                        cli_effort_map=cli_effort_map,
                    )
                    if not str(response_text or "").strip():
                        raise RuntimeError("CLI画像解析が空でした")
                    return response_text

                return self._analyze_api_image(attempt, image_path, prompt)
            except NumberValidatorLLMError:
                raise
            except Exception as exc:
                last_error = exc
                self.logger.warning(
                    "NumberValidator 画像LLM試行 %d が失敗しました: %s",
                    index + 1,
                    _sanitize_llm_error_message(exc),
                )
                continue

        if last_error is None:
            raise self._build_llm_error(
                "画像LLM解析に失敗しました",
                attempt=last_attempt,
                sanitized_message="画像LLM解析に失敗しました",
                exception_type="RuntimeError",
            )

        raise self._build_llm_error(
            str(last_error),
            attempt=last_attempt,
            sanitized_message=_sanitize_llm_error_message(last_error),
            exception_type=type(last_error).__name__,
            cause=last_error,
        )

    def _parse_validation_response(
        self,
        response_text: str,
        cropped_count: int,
    ) -> Dict[str, Any]:
        if "```json" in response_text:
            json_start = response_text.find("```json") + 7
            json_end = response_text.find("```", json_start)
            json_str = response_text[json_start:json_end].strip()
        else:
            json_str = response_text.strip()

        try:
            result = json.loads(json_str)
        except json.JSONDecodeError as exc:
            raise self._build_llm_error(
                "LLM JSON parse failure",
                sanitized_message=_sanitize_llm_error_message(exc),
                exception_type=type(exc).__name__,
                cause=exc,
            )

        if not isinstance(result, dict):
            raise self._build_llm_error(
                "LLM response schema invalid",
                sanitized_message="LLM response schema invalid",
                exception_type="ValueError",
            )

        raw_indices = result.get("valid_indices")
        if not isinstance(raw_indices, list):
            raise self._build_llm_error(
                "LLM response missing valid_indices",
                sanitized_message="LLM response missing valid_indices",
                exception_type="ValueError",
            )

        valid_list = [False] * cropped_count
        for idx in raw_indices:
            if isinstance(idx, int) and 0 <= idx < cropped_count:
                valid_list[idx] = True

        result["valid_indices"] = valid_list
        return result

    def _validate_with_llm(
        self,
        cropped_images: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        composite_image_path = self._create_composite_image(cropped_images)

        prompt = f"""あなたはイベント会場のスペース配置図の検証システムです。

## タスク
画像には{len(cropped_images)}個の数字が横に並んでいます。
各数字の上に番号（0, 1, 2...）が表示されています。

どの数字がスペース番号として妥当かを判定してください。

## 判定基準
1. **フォントの一貫性**
   - スペース番号は通常、同じフォント・サイズで統一されている
   - 明らかに異なるフォント（装飾的、小さすぎる、大きすぎる）は除外

2. **除外すべきもの**
   - ページ番号（例：P.12、12ページ）
   - 日付の一部（例：2025/01/12の一部）
   - タイトルや見出しの数字
   - QRコードやバーコード内の数字
   - 装飾的な数字

3. **妥当性の判断**
   - 配置図内のグリッド上にある数字
   - 他の数字と同じフォント・サイズ
   - スペース区画を示す位置にある

## 検出された数字情報
{self._format_numbers_list(cropped_images)}

## 出力形式
以下のJSON形式で返してください：
```json
{{
  "valid_indices": [0, 2, 3, 5, ...],
  "invalid_indices": [1, 4, ...],
  "reasons": {{
    "1": "フォントが装飾的で他と異なる",
    "4": "ページ番号と思われる"
  }}
}}
```

**重要**:
- 迷った場合は妥当と判定してください（false negativeよりfalse positiveの方が安全）
- 画像を見てフォントの一貫性を重視してください
"""

        try:
            if self.attempts:
                response_text = self._analyze_image_with_attempts(
                    composite_image_path,
                    prompt,
                )
            else:
                response_text = self.llm_client.analyze_image(
                    composite_image_path,
                    prompt,
                )
        except NumberValidatorLLMError:
            raise
        except Exception as exc:
            raise self._build_llm_error(
                str(exc),
                sanitized_message=_sanitize_llm_error_message(exc),
                exception_type=type(exc).__name__,
                cause=exc,
            )

        if not str(response_text or "").strip():
            raise self._build_llm_error(
                "LLM response empty",
                sanitized_message="LLM response empty",
                exception_type="RuntimeError",
            )

        return self._parse_validation_response(response_text, len(cropped_images))

    def _create_composite_image(
        self,
        cropped_images: List[Dict[str, Any]],
    ) -> str:
        import tempfile

        images = []
        max_height = 0

        for img_info in cropped_images:
            img_bytes = base64.b64decode(img_info["image_base64"])
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            images.append(img)
            max_height = max(max_height, img.shape[0])

        resized_images = []
        for img in images:
            h, w = img.shape[:2]
            if h < max_height:
                pad = max_height - h
                img = cv2.copyMakeBorder(
                    img,
                    0,
                    pad,
                    0,
                    0,
                    cv2.BORDER_CONSTANT,
                    value=[255, 255, 255],
                )
            resized_images.append(img)

        composite = np.hstack(resized_images)

        x_offset = 0
        for i, img in enumerate(resized_images):
            cv2.putText(
                composite,
                str(i),
                (x_offset + 5, 15),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 0, 255),
                2,
            )
            x_offset += img.shape[1]

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp_file:
            cv2.imwrite(tmp_file.name, composite)
            return tmp_file.name

    def _format_numbers_list(
        self,
        cropped_images: List[Dict[str, Any]],
    ) -> str:
        lines = []
        for i, img_info in enumerate(cropped_images):
            lines.append(
                f"  [{i}] 番号「{img_info['number']}」at "
                f"({img_info['position'][0]}, {img_info['position'][1]})"
            )
        return "\n".join(lines)


def main():
    """テスト実行"""
    import argparse

    parser = argparse.ArgumentParser(
        description="検出された数字の妥当性を検証"
    )
    parser.add_argument("image_path", help="マップ画像のパス")
    parser.add_argument("ocr_json", help="OCR結果JSONのパス")
    parser.add_argument(
        "--model",
        default="gpt-5-mini",
        help="使用するLLMモデル",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    with open(args.ocr_json, "r", encoding="utf-8") as f:
        ocr_data = json.load(f)

    detected_numbers = []
    for item in ocr_data.get("space_ids", []):
        if item.get("number_only"):
            detected_numbers.append(
                {
                    "number": item["text"],
                    "x": item["x"],
                    "y": item["y"],
                    "width": item.get("width", 30),
                    "height": item.get("height", 30),
                }
            )

    print(f"OCR検出: {len(detected_numbers)}個")

    validator = NumberValidator(model=args.model)
    result = validator.validate_numbers(args.image_path, detected_numbers)

    print(
        f"\n検証結果: status={result.status} "
        f"{len(result.numbers)}/{len(detected_numbers)}個"
    )
    print("\n妥当な数字:")
    for num in result.numbers[:10]:
        print(f"  {num['number']} at ({num['x']}, {num['y']})")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
LLMによる配置パターン判定機能

マップ画像とOCR結果から、スペース配置パターンを自動判定します。
- 列/行ラベルの方向判定（A→E or E→A、あ→え or え→あ）
- 番号の増減方向判定
- 配置タイプの判定（縦配置型 or 横配置型）
"""

import json
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional, Mapping
import logging

# プロジェクトのルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.llm_client import LLMClient


def _normalize_api_provider(provider: Optional[str]) -> str:
    value = str(provider or "openai").strip().lower()
    if value in {"api", "openai"}:
        return "openai"
    if value == "gemini":
        return "gemini"
    return value


def _assert_provider_model_binding(provider: Optional[str], model: str) -> None:
    expected = _normalize_api_provider(provider)
    if expected == "gemini" and not str(model).startswith("gemini"):
        raise RuntimeError(f"Gemini API provider に非Geminiモデル: {model}")
    if expected == "openai" and str(model).startswith("gemini"):
        raise RuntimeError(f"OpenAI API provider にGeminiモデル: {model}")


class PatternAnalyzer:
    """LLMを使った配置パターン判定器"""

    def __init__(
        self,
        model: str = "gpt-5-mini",
        *,
        attempt: Optional[Mapping[str, Any]] = None,
        api_reasoning_effort_map: Optional[Mapping[str, str]] = None,
    ):
        """
        Args:
            model: スタンドアロン実行用の legacy API model
            attempt: explicit {kind, provider, model, effort} routing
            api_reasoning_effort_map: API モデルごとの reasoning effort
        """
        self.logger = logging.getLogger(__name__)
        self.attempt = dict(attempt) if attempt else None
        self.api_reasoning_effort_map = dict(api_reasoning_effort_map or {})
        self._legacy_model = model
        self._api_clients: Dict[tuple[str, str], LLMClient] = {}

    def analyze_pattern(
        self,
        image_path: str,
        ocr_results: List[Dict[str, Any]],
        catalog_info: Optional[Dict[str, Any]] = None,
        calibration_points: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        マップ画像とOCR結果から配置パターンを判定

        Args:
            image_path: マップ画像のパス
            ocr_results: OCRで検出された番号と座標のリスト
                        [{"number": "12", "x": 468, "y": 304}, ...]

        Returns:
            判定結果の辞書:
            {
                "layout_type": "縦配置型" or "横配置型",
                "columns": {
                    "labels": ["E", "D", "C", "B", "A"],
                    "direction": "右から左",  # or "左から右"
                    "count": 5
                },
                "rows": {
                    "numbering": "上から下",
                    "range": [12, 1],
                    "count": 12
                },
                "floor": "1F" or "3F",
                "confidence": 0.95
            }
        """
        prompt = self._build_prompt(ocr_results, catalog_info, calibration_points)

        self.logger.info(f"配置パターン判定を開始: {image_path}")
        response_text = self._analyze_image(image_path, prompt)

        if "```json" in response_text:
            json_start = response_text.find("```json") + 7
            json_end = response_text.find("```", json_start)
            json_str = response_text[json_start:json_end].strip()
        else:
            json_str = response_text.strip()

        result = json.loads(json_str)
        self.logger.info(f"判定完了: {result.get('layout_type', 'unknown')}")
        return result

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

    def _analyze_image(self, image_path: str, prompt: str) -> str:
        if self.attempt:
            if self.attempt.get("kind") == "cli":
                from src.utils.cli_llm import analyze_image_cli

                provider = str(self.attempt.get("provider") or "")
                model = self.attempt.get("model")
                effort = self.attempt.get("effort")
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
            return self._analyze_api_image(self.attempt, image_path, prompt)

        client = LLMClient(
            model=self._legacy_model,
            api_reasoning_effort_map=self.api_reasoning_effort_map,
        )
        return client.analyze_image(image_path, prompt)

    def _build_prompt(
        self,
        ocr_results: List[Dict[str, Any]],
        catalog_info: Optional[Dict[str, Any]] = None,
        calibration_points: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """LLMに送るプロンプトを構築"""

        ocr_summary = self._format_ocr_results(ocr_results)
        catalog_summary = self._format_catalog_info(catalog_info)
        calibration_summary = self._format_calibration_points(calibration_points)

        prompt = f"""あなたはイベント会場のマップ画像から配置パターンを解析するシステムです。

## 現状
OCRで番号（01, 02, 03...）と座標を取得しました：
{ocr_summary}

## event.json のスペース一覧
{catalog_summary}

## ユーザー校正点
{calibration_summary}

## あなたのタスク
マップ画像を見て、以下を判定してください：

### 1. 配置タイプの判定
- **縦配置型**: 列ラベル（A, B, C...）が主体で、番号が縦に並ぶ
- **横配置型**: 行ラベル（あ, い, う...）が主体で、番号が横に並ぶ

### 2. 列ラベルの判定（縦配置型の場合）
- 列ラベル（A, B, C, D, E など）がどの順序で並んでいるか？
  - 例: "左から右に A→B→C→D→E" または "右から左に E→D→C→B→A"
- 各列のX座標位置（OCR結果のX座標をグループ化）

### 3. 行ラベルの判定（横配置型の場合）
- 行ラベル（あ, い, う, え など）がどの順序で並んでいるか？
  - 例: "上から下に あ→い→う→え" または "下から上に え→う→い→あ"
- 各行のY座標位置（OCR結果のY座標をグループ化）

### 4. 番号の増減方向
- 番号（01, 02, 03...）がどの方向に増加するか？
  - 例: "上から下に 01→02→03" または "下から上に 12→11→10"

### 5. フロア情報
- マップ画像に表示されているフロア番号（1F, 3F など）

## 重要な制約
- **座標は出力しないでください**。OCR結果の座標をそのまま使います。
- **推測を避けてください**。画像から明確に判断できることのみを出力してください。

## 出力形式（必ずJSON形式で返してください）

### 縦配置型の場合:
```json
{{
  "layout_type": "縦配置型",
  "columns": {{
    "labels": ["E", "D", "C", "B", "A"],
    "direction": "右から左",
    "count": 5
  }},
  "rows": {{
    "numbering": "上から下",
    "range": [12, 1],
    "count": 12
  }},
  "floor": "1F",
  "confidence": 0.95
}}
```

### 横配置型の場合:
```json
{{
  "layout_type": "横配置型",
  "rows": {{
    "labels": ["え", "う", "い", "あ"],
    "direction": "上から下",
    "count": 4
  }},
  "columns": {{
    "numbering": "右から左",
    "range": [18, 1],
    "count": 18
  }},
  "floor": "3F",
  "confidence": 0.90
}}
```

必ず上記のJSON形式で回答してください。"""

        return prompt

    def _format_catalog_info(self, catalog_info: Optional[Dict[str, Any]]) -> str:
        if not catalog_info:
            return "スペース一覧は未指定。画像とOCRだけから配置規則を判定してください。"

        labels = catalog_info.get("horizontal_labels") or catalog_info.get("order") or []
        counts = catalog_info.get("counts") or {}
        number_map = catalog_info.get("number_map") or {}
        lines = [
            f"対象スペース数: {len(catalog_info.get('spaces') or [])}",
            f"行/列ラベル候補: {', '.join(map(str, labels[:30]))}",
        ]
        for label in labels[:30]:
            numbers = number_map.get(label) or []
            if numbers:
                lines.append(
                    f"- {label}: {counts.get(label, len(numbers))}件 / 番号 {min(numbers):02d}-{max(numbers):02d}"
                )
            else:
                lines.append(f"- {label}: {counts.get(label, 0)}件")
        return "\n".join(lines)

    def _format_calibration_points(
        self,
        calibration_points: Optional[List[Dict[str, Any]]],
    ) -> str:
        if not calibration_points:
            return "なし。"
        lines = []
        for point in calibration_points[:20]:
            lines.append(
                f"- {point.get('space') or point.get('space_id')}: "
                f"x={float(point.get('pin_x', point.get('x', 0))):.4f}, "
                f"y={float(point.get('pin_y', point.get('y', 0))):.4f}"
            )
        return "\n".join(lines)

    def _format_ocr_results(self, ocr_results: List[Dict[str, Any]]) -> str:
        """OCR結果を読みやすく整形"""
        sorted_by_x = sorted(ocr_results, key=lambda r: r['x'])
        sorted_by_y = sorted(ocr_results, key=lambda r: r['y'])

        summary = f"検出番号数: {len(ocr_results)}個\n\n"
        summary += "【X座標順（左→右）の最初の10個】:\n"
        for item in sorted_by_x[:10]:
            summary += f"  番号 {item['number']:>2s} at (x={item['x']:4d}, y={item['y']:4d})\n"

        summary += "\n【Y座標順（上→下）の最初の10個】:\n"
        for item in sorted_by_y[:10]:
            summary += f"  番号 {item['number']:>2s} at (x={item['x']:4d}, y={item['y']:4d})\n"

        return summary


def main():
    """テスト実行"""
    import sys

    if len(sys.argv) < 3:
        print("Usage: python pattern_analyzer.py <image_path> <ocr_json_path>")
        sys.exit(1)

    image_path = sys.argv[1]
    ocr_json_path = sys.argv[2]

    with open(ocr_json_path, 'r') as f:
        ocr_data = json.load(f)

    ocr_results = []
    for item in ocr_data.get('space_ids', []):
        if item.get('number_only'):
            ocr_results.append({
                'number': item['text'],
                'x': item['x'],
                'y': item['y']
            })

    print(f"OCR結果: {len(ocr_results)}個の番号を検出")

    analyzer = PatternAnalyzer()
    result = analyzer.analyze_pattern(image_path, ocr_results)

    print("\n=== 判定結果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))

    output_path = image_path.replace('.png', '_pattern.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n結果を保存しました: {output_path}")


if __name__ == "__main__":
    main()

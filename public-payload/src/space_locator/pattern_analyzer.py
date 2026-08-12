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
from typing import Dict, List, Any, Optional
import logging

# プロジェクトのルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.llm_client import LLMClient


class PatternAnalyzer:
    """LLMを使った配置パターン判定器"""

    def __init__(self, model: str = "gpt-5-mini"):
        """
        Args:
            model: 使用するLLMモデル名（デフォルト: gpt-5-mini）
        """
        self.logger = logging.getLogger(__name__)
        self.llm_client = LLMClient(model=model)

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
        # プロンプトを構築
        prompt = self._build_prompt(ocr_results, catalog_info, calibration_points)

        # LLMに画像解析をリクエスト
        self.logger.info(f"配置パターン判定を開始: {image_path}")
        response_text = self.llm_client.analyze_image(image_path, prompt)

        # JSONブロックを抽出
        if "```json" in response_text:
            json_start = response_text.find("```json") + 7
            json_end = response_text.find("```", json_start)
            json_str = response_text[json_start:json_end].strip()
        else:
            json_str = response_text.strip()

        result = json.loads(json_str)
        self.logger.info(f"判定完了: {result.get('layout_type', 'unknown')}")
        return result

    def _build_prompt(
        self,
        ocr_results: List[Dict[str, Any]],
        catalog_info: Optional[Dict[str, Any]] = None,
        calibration_points: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """LLMに送るプロンプトを構築"""

        # OCR結果を整形
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
        # X座標でソートしてグループ化
        sorted_by_x = sorted(ocr_results, key=lambda r: r['x'])

        # Y座標でもグループ化
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

    # OCR結果を読み込み
    with open(ocr_json_path, 'r') as f:
        ocr_data = json.load(f)

    # space_idsからnumber_onlyのものを抽出
    ocr_results = []
    for item in ocr_data.get('space_ids', []):
        if item.get('number_only'):
            ocr_results.append({
                'number': item['text'],
                'x': item['x'],
                'y': item['y']
            })

    print(f"OCR結果: {len(ocr_results)}個の番号を検出")

    # パターン判定を実行
    analyzer = PatternAnalyzer()
    result = analyzer.analyze_pattern(image_path, ocr_results)

    print("\n=== 判定結果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))

    # 結果を保存
    output_path = image_path.replace('.png', '_pattern.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n結果を保存しました: {output_path}")


if __name__ == "__main__":
    main()

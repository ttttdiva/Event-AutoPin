#!/usr/bin/env python3
"""
数字検証モジュール - LLMによるフォント一貫性チェック

検出された数字の切り抜き画像をLLMに見せて、
スペース番号として妥当かを判定する。
"""

import sys
import json
import cv2
import base64
from pathlib import Path
from typing import List, Dict, Any
import logging

# プロジェクトのルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.llm_client import LLMClient


class NumberValidator:
    """LLMを使った数字検証器"""

    def __init__(self, model: str = "gpt-5-mini"):
        """
        Args:
            model: 使用するLLMモデル名
        """
        self.logger = logging.getLogger(__name__)
        self.llm_client = LLMClient(model=model)

    def validate_numbers(
        self,
        image_path: str,
        detected_numbers: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        検出された数字の妥当性を検証

        Args:
            image_path: 元のマップ画像パス
            detected_numbers: OCR検出結果
                [
                    {"number": "12", "x": 526, "y": 304,
                     "width": 20, "height": 18},
                    ...
                ]

        Returns:
            妥当と判定された数字のリスト
        """
        if len(detected_numbers) == 0:
            return []

        # 画像を読み込み
        image = cv2.imread(image_path)

        # 各数字を切り抜き
        cropped_images = []
        for i, num_info in enumerate(detected_numbers):
            x = num_info['x']
            y = num_info['y']
            w = num_info.get('width', 30)  # デフォルト値
            h = num_info.get('height', 30)

            # 少し余白を持たせて切り抜き
            padding = 5
            x1 = max(0, x - padding)
            y1 = max(0, y - padding)
            x2 = min(image.shape[1], x + w + padding)
            y2 = min(image.shape[0], y + h + padding)

            cropped = image[y1:y2, x1:x2]

            # Base64エンコード
            _, buffer = cv2.imencode('.png', cropped)
            img_base64 = base64.b64encode(buffer).decode('utf-8')

            cropped_images.append({
                'index': i,
                'number': num_info['number'],
                'image_base64': img_base64,
                'position': (x, y)
            })

        # LLMで一括判定
        self.logger.info(f"LLMで{len(cropped_images)}個の数字を検証中...")
        validation_result = self._validate_with_llm(cropped_images)

        # 妥当と判定されたものだけ返す
        valid_numbers = []
        for i, is_valid in enumerate(validation_result.get('valid_indices', [])):
            if is_valid:
                valid_numbers.append(detected_numbers[i])

        self.logger.info(
            f"検証完了: {len(valid_numbers)}/{len(detected_numbers)}個が妥当"
        )

        return valid_numbers

    def _validate_with_llm(
        self,
        cropped_images: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        LLMで切り抜き画像を一括検証

        戦略：
        1. 複数の切り抜き画像を並べた1枚の画像にする
        2. フォントの一貫性をチェックさせる
        3. 明らかに異なるフォント（ページ番号など）を除外
        """
        # 切り抜き画像を並べた合成画像を作成
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
  "valid_indices": [0, 2, 3, 5, ...],  // 妥当と判定した番号のインデックス
  "invalid_indices": [1, 4, ...],      // 除外すべき番号のインデックス
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

        # LLMに合成画像を見せて判定
        response_text = self.llm_client.analyze_image(composite_image_path, prompt)

        # JSONを抽出
        if "```json" in response_text:
            json_start = response_text.find("```json") + 7
            json_end = response_text.find("```", json_start)
            json_str = response_text[json_start:json_end].strip()
        else:
            json_str = response_text.strip()

        result = json.loads(json_str)

        # valid_indicesをbooleanリストに変換
        valid_list = [False] * len(cropped_images)
        for idx in result.get('valid_indices', []):
            if 0 <= idx < len(cropped_images):
                valid_list[idx] = True

        result['valid_indices'] = valid_list
        return result

    def _create_composite_image(
        self,
        cropped_images: List[Dict[str, Any]]
    ) -> str:
        """
        切り抜き画像を横に並べた合成画像を作成

        Returns:
            合成画像のパス
        """
        import cv2
        import numpy as np
        import tempfile

        # Base64から画像をデコード
        images = []
        max_height = 0

        for img_info in cropped_images:
            img_bytes = base64.b64decode(img_info['image_base64'])
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            images.append(img)
            max_height = max(max_height, img.shape[0])

        # 各画像を同じ高さに調整
        resized_images = []
        for img in images:
            h, w = img.shape[:2]
            if h < max_height:
                # 余白を追加
                pad = max_height - h
                img = cv2.copyMakeBorder(
                    img, 0, pad, 0, 0,
                    cv2.BORDER_CONSTANT,
                    value=[255, 255, 255]
                )
            resized_images.append(img)

        # 横に連結
        composite = np.hstack(resized_images)

        # インデックス番号を画像上部に描画
        x_offset = 0
        for i, img in enumerate(resized_images):
            cv2.putText(
                composite,
                str(i),
                (x_offset + 5, 15),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 0, 255),
                2
            )
            x_offset += img.shape[1]

        # 一時ファイルに保存
        with tempfile.NamedTemporaryFile(
            suffix='.png',
            delete=False
        ) as tmp_file:
            cv2.imwrite(tmp_file.name, composite)
            return tmp_file.name

    def _format_numbers_list(
        self,
        cropped_images: List[Dict[str, Any]]
    ) -> str:
        """数字リストをフォーマット"""
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
        description='検出された数字の妥当性を検証'
    )
    parser.add_argument('image_path', help='マップ画像のパス')
    parser.add_argument('ocr_json', help='OCR結果JSONのパス')
    parser.add_argument(
        '--model',
        default='gpt-5-mini',
        help='使用するLLMモデル'
    )

    args = parser.parse_args()

    # ロギング設定
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # OCR結果を読み込み
    with open(args.ocr_json, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    detected_numbers = []
    for item in ocr_data.get('space_ids', []):
        if item.get('number_only'):
            detected_numbers.append({
                'number': item['text'],
                'x': item['x'],
                'y': item['y'],
                'width': item.get('width', 30),
                'height': item.get('height', 30)
            })

    print(f"OCR検出: {len(detected_numbers)}個")

    # 検証実行
    validator = NumberValidator(model=args.model)
    valid_numbers = validator.validate_numbers(args.image_path, detected_numbers)

    print(f"\n検証結果: {len(valid_numbers)}/{len(detected_numbers)}個が妥当")
    print("\n妥当な数字:")
    for num in valid_numbers[:10]:
        print(f"  {num['number']} at ({num['x']}, {num['y']})")


if __name__ == "__main__":
    main()
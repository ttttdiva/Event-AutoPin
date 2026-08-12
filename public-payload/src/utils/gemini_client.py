"""
Gemini API クライアント
画像からテキスト情報を抽出する
"""

import os
import json
import base64
from pathlib import Path
from typing import Dict, Any, Optional
import google.generativeai as genai
from PIL import Image

from .logger import setup_logger

logger = setup_logger(__name__)


class GeminiClient:
    """Gemini API クライアント"""
    
    def __init__(self, api_key: Optional[str] = None, model: str = "gemini-2.0-flash-exp"):
        """
        初期化
        
        Args:
            api_key: Gemini API キー（指定しない場合は環境変数から取得）
            model: 使用するモデル名
        """
        self.api_key = api_key or os.getenv('GEMINI_API_KEY')
        if not self.api_key:
            raise ValueError("Gemini API key not found. Set GEMINI_API_KEY environment variable.")
        
        # Gemini APIを設定
        genai.configure(api_key=self.api_key)
        self.model = genai.GenerativeModel(model)
        logger.info(f"Gemini client initialized with model: {model}")
    
    def analyze_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """
        画像を解析してテキスト情報を抽出
        
        Args:
            image_path: 画像ファイルのパス
            prompt: 解析用プロンプト
            
        Returns:
            解析結果の辞書
        """
        try:
            # 画像を読み込み
            image = Image.open(image_path)
            
            # プロンプトと画像を送信
            response = self.model.generate_content([prompt, image])
            
            # レスポンステキストを取得
            result_text = response.text
            
            # JSON形式で返されることを期待
            # JSON部分を抽出（```json ... ``` の形式に対応）
            if "```json" in result_text:
                json_start = result_text.find("```json") + 7
                json_end = result_text.find("```", json_start)
                json_text = result_text[json_start:json_end].strip()
            else:
                # JSON形式でない場合はそのまま使用
                json_text = result_text.strip()
            
            # JSONをパース
            try:
                result = json.loads(json_text)
                logger.info(f"Successfully analyzed image: {image_path}")
                return result
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse JSON response: {e}")
                # パースできない場合は生のテキストを返す
                return {
                    "raw_response": result_text,
                    "error": "Failed to parse as JSON"
                }
                
        except Exception as e:
            logger.error(f"Error analyzing image {image_path}: {e}")
            return {
                "error": str(e),
                "image_path": image_path
            }
    
    def is_event_related_tweet(self, tweet_text: str, event_name: str, event_date: str = "", additional_prompt: str = "") -> Dict[str, Any]:
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
以下のツイートが、指定された同人イベントに関連しているか判定してください。

イベント名: {event_name}

ツイート:
{tweet_text}

判定基準:
1. イベント名の略称や一部が含まれている場合は関連あり
2. 同じ会場名が言及されている場合は関連あり
3. 別のイベント名が明記されている場合は関連なし
{f'{chr(10)}{additional_prompt}' if additional_prompt else ''}

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
            # Geminiでテキスト解析
            response = self.model.generate_content(prompt)
            result_text = response.text
            
            # JSON部分を抽出
            if "```json" in result_text:
                json_start = result_text.find("```json") + 7
                json_end = result_text.find("```", json_start)
                json_text = result_text[json_start:json_end].strip()
            else:
                json_text = result_text.strip()
            
            result = json.loads(json_text)
            logger.info(f"Event relation check - Related: {result.get('is_related')}, Confidence: {result.get('confidence')}")
            return result
            
        except Exception as e:
            logger.error(f"Error checking event relation: {e}")
            return {
                "is_related": True,  # エラー時は安全のためTrueを返す
                "confidence": 0.5,
                "reason": f"LLM判定エラー: {str(e)}",
                "error": True
            }
    
    def detect_absence_tweet(self, tweet_text: str, event_name: str = "") -> Dict[str, Any]:
        """
        ツイートテキストから欠席情報を検出
        
        Args:
            tweet_text: ツイートのテキスト
            event_name: イベント名（コンテキスト用）
            
        Returns:
            欠席情報の辞書
        """
        prompt = f"""
以下のツイートが同人イベントへの欠席や委託参加を示しているか判定してください。
{f'イベント名: {event_name}' if event_name else ''}

ツイート:
{tweet_text}

以下のJSON形式で回答してください：
```json
{{
  "is_absent": true/false,
  "reason": "欠席理由（欠席の場合）",
  "type": "欠席/委託/合同参加",
  "details": "詳細情報"
}}
```
"""
        
        # Geminiは画像なしでもテキストのみの解析が可能
        response = self.model.generate_content(prompt)
        result_text = response.text
        
        # JSON部分を抽出
        if "```json" in result_text:
            json_start = result_text.find("```json") + 7
            json_end = result_text.find("```", json_start)
            json_text = result_text[json_start:json_end].strip()
        else:
            json_text = result_text.strip()
        
        try:
            return json.loads(json_text)
        except json.JSONDecodeError:
            return {
                "is_absent": False,
                "error": "Failed to parse response"
            }
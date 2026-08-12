"""
Grok x_search API クライアント
xAI の Grok API を使用して X(旧Twitter) のお品書きツイートを検索する
"""

import os
import re
import json
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta

import httpx

from .api_cost_tracker import get_cost_tracker

logger = logging.getLogger(__name__)


class GrokSearchClient:
    """xAI Grok API x_search クライアント"""

    DEFAULT_MODEL = "grok-4-1-fast-non-reasoning"
    API_BASE = "https://api.x.ai/v1"

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_key = api_key or os.getenv("XAI_API_KEY", "")
        self.model = model or os.getenv("XAI_GROK_MODEL", self.DEFAULT_MODEL)
        if not self.api_key:
            raise ValueError("XAI_API_KEY が設定されていません")

    async def search_catalog_tweet(
        self,
        username: str,
        event_name: str,
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7,
        additional_prompt: str = "",
        max_results: int = 10,
        timeout_seconds: int = 60,
    ) -> Dict[str, Any]:
        """
        Grok x_search でユーザーのお品書きツイートを検索

        Returns:
            {
                "found": bool,
                "tweet_url": Optional[str],
                "tweet_id": Optional[str],
                "is_absence": bool,
                "is_existing_only": bool,
                "summary": str,
            }
        """
        from_date = (event_date - timedelta(days=days_before)).strftime("%Y-%m-%d")
        to_date = (event_date + timedelta(days=days_after)).strftime("%Y-%m-%d")

        system_prompt = self._build_system_prompt(event_name, additional_prompt)
        query = self._build_query(username)

        payload = {
            "model": self.model,
            "input": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
            "tools": [
                {
                    "type": "x_search",
                    "x_search": {
                        "max_results": max_results,
                        "search_mode": "latest",
                        "freshness": "auto",
                        "language": "ja",
                        "allowed_x_handles": [username],
                        "from_date": from_date,
                        "to_date": to_date,
                    },
                }
            ],
            "temperature": 0.1,
            "max_output_tokens": 500,
        }

        url = f"{self.API_BASE}/responses"

        try:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except Exception as e:
            logger.error(f"Grok APIへの接続に失敗: {e}")
            return self._default_result(error=str(e))

        if response.status_code >= 300:
            logger.error(f"Grok APIエラー ({response.status_code}): {response.text}")
            return self._default_result(error=response.text)

        try:
            response_data = response.json()
        except Exception:
            logger.error(f"Grok APIの応答を解析できません: {response.text}")
            return self._default_result(error="JSON parse failed")

        # トークン追跡
        cost_tracker = get_cost_tracker()
        usage = response_data.get("usage", {})
        if usage:
            cost_tracker.add_tokens(
                self.model,
                usage.get("input_tokens", 0),
                usage.get("output_tokens", 0),
            )
        # x_searchツール呼び出し記録
        cost_tracker.add_tool_call("x_search_call")

        output_text = self._extract_text(response_data)
        logger.debug(f"Grok raw response for @{username}: {output_text}")

        result = self._parse_response(output_text)
        result["summary"] = output_text
        return result

    def _build_system_prompt(self, event_name: str, additional_prompt: str) -> str:
        prompt = f"""あなたは同人イベントの情報収集アシスタントです。
指定されたユーザーのX投稿を検索し、イベント「{event_name}」に関連するお品書き（頒布物リスト）ツイートを特定してください。

【検索対象】
- お品書き、おしながき、新刊情報、頒布物一覧のツイート
- サークル参加に関する告知ツイート
- 欠席・不参加・委託参加の告知ツイート

【判定基準】
1. イベント名「{event_name}」に関連するツイートを優先（略称も考慮）
2. 別イベントのお品書きは除外
3. 画像付きのツイートを優先（お品書き画像の可能性が高い）
4. 「既刊のみ」「既刊だけ」「新刊なし」のように新刊がないことを明言している場合は existing_only
5. 「不参加」「欠席」「委託のみ」のように参加しないことを明言している場合は absence

【出力形式】
必ず以下のJSON形式のみで回答してください。余計な説明は不要です。
```json
{{
  "status": "found",
  "tweet_url": "https://x.com/username/status/1234567890",
  "reason": "判定理由",
  "has_image": true,
  "product_types": ["CD"],
  "genre": "音楽"
}}
```

product_typesの値（該当するものを全て列挙、該当なしなら空配列）:
- "本": 同人誌、漫画、小説、イラスト集、合同誌、コピー本など紙の印刷物
- "CD": CD、音楽、楽曲、アルバム、ダウンロードコード（音楽配信含む）
- "グッズ": アクリルスタンド、缶バッジ、ステッカー、ポストカードなど物品
- "デジタル": ゲーム、ソフトウェア、デジタルデータ（音楽以外）

genreの値（最も適切なものを1つ選択、判定できなければ空文字列""）:
- "漫画": 同人誌、マンガ、コミック
- "イラスト": イラスト集、画集、CG集
- "音楽": CD、音楽作品、楽曲
- "小説": 小説、文芸、SS
- "グッズ": グッズのみの頒布
- "その他": 上記に当てはまらない

statusの値:
- "found": 確定版お品書き（具体的な頒布物リスト、価格、お品書き画像など）が見つかった
- "preview": お品書き予告（「準備中」「後日公開」「作成中」「お品書きは後ほど」など、確定版でないもの）が見つかった
- "absence": 欠席・不参加・委託のみのツイートが見つかった
- "existing_only": 既刊のみの頒布ツイートが見つかった
- "not_found": 該当するツイートが見つからなかった

判定のポイント:
- 具体的な頒布物の情報（タイトル、価格、ページ数など）や完成したお品書き画像があれば "found"
- 「お品書き作ってます」「後日お品書き出します」「準備中」のような予告は "preview"
- 迷ったら "found" を選択（予告を見逃すより確定を見逃す方が問題）"""

        if additional_prompt:
            prompt += f"\n\n追加指示: {additional_prompt}"

        return prompt

    def _build_query(self, username: str) -> str:
        return f"@{username} お品書き OR 新刊 OR 頒布 OR サークル参加 OR 欠席 OR 不参加"

    def _parse_response(self, response_text: str) -> Dict[str, Any]:
        default = self._default_result()

        # 優先度1: ```json``` ブロックから抽出
        json_match = re.search(r"```json\s*(.*?)\s*```", response_text, re.DOTALL)
        if json_match:
            json_str = json_match.group(1)
        else:
            # 優先度2: ベアJSONオブジェクト
            json_match = re.search(
                r'\{\s*"status"\s*:.*?\}', response_text, re.DOTALL
            )
            if json_match:
                json_str = json_match.group(0)
            else:
                # 優先度3: ツイートURLを直接抽出
                urls = self.extract_tweet_urls(response_text)
                if urls:
                    tweet_id = self.extract_tweet_id_from_url(urls[0])
                    return {
                        **default,
                        "found": True,
                        "tweet_url": urls[0],
                        "tweet_id": tweet_id,
                    }
                return default

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            # JSONパース失敗時もURL抽出を試みる
            urls = self.extract_tweet_urls(response_text)
            if urls:
                tweet_id = self.extract_tweet_id_from_url(urls[0])
                return {
                    **default,
                    "found": True,
                    "tweet_url": urls[0],
                    "tweet_id": tweet_id,
                }
            return default

        status = data.get("status", "not_found")
        tweet_url = data.get("tweet_url", "")
        tweet_id = self.extract_tweet_id_from_url(tweet_url) if tweet_url else None

        return {
            "found": status in ("found", "preview", "absence", "existing_only"),
            "tweet_url": tweet_url or None,
            "tweet_id": tweet_id,
            "is_absence": status == "absence",
            "is_existing_only": status == "existing_only",
            "is_preview": status == "preview",
            "has_image": data.get("has_image", False),
            "reason": data.get("reason", ""),
            "product_types": data.get("product_types", []),
            "genre": data.get("genre", ""),
        }

    def _extract_text(self, payload: dict) -> str:
        """Grok API レスポンスからテキストを抽出"""
        # 優先度1: トップレベル output_text
        output_text = payload.get("output_text")
        if output_text:
            if isinstance(output_text, list):
                return "\n".join(str(x) for x in output_text).strip()
            return str(output_text).strip()

        # 優先度2: output 配列からメッセージを抽出
        outputs = payload.get("output", [])
        if not isinstance(outputs, list):
            outputs = []

        texts: List[str] = []
        for item in outputs:
            if isinstance(item, str):
                texts.append(item)
                continue
            if not isinstance(item, dict):
                continue
            if item.get("type") != "message":
                continue

            content = item.get("content")
            if isinstance(content, str):
                if content:
                    texts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, str):
                        if block:
                            texts.append(block)
                    elif isinstance(block, dict):
                        t = block.get("text") or block.get("output_text")
                        if t:
                            texts.append(str(t))

        if texts:
            return "\n".join(texts).strip()

        # フォールバック: JSON全体
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def _default_result(error: str = "") -> Dict[str, Any]:
        result = {
            "found": False,
            "tweet_url": None,
            "tweet_id": None,
            "is_absence": False,
            "is_existing_only": False,
            "is_preview": False,
            "has_image": False,
            "reason": "",
            "summary": "",
        }
        if error:
            result["error"] = error
        return result

    @staticmethod
    def extract_tweet_urls(text: str) -> List[str]:
        """テキストからツイートURLを抽出"""
        pattern = r"https?://(?:twitter\.com|x\.com)/[A-Za-z0-9_]+/status/\d+"
        return re.findall(pattern, text)

    @staticmethod
    def extract_tweet_id_from_url(url: str) -> Optional[str]:
        """ツイートURLからIDを抽出"""
        match = re.search(r"/status/(\d+)", url)
        return match.group(1) if match else None

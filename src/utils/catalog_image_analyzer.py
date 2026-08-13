"""
お品書き画像からアイテム情報（名前・価格・種別）を抽出する機能
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from ..utils.logger import setup_logger

logger = setup_logger(__name__)


class CatalogImageAnalyzer:
    """お品書き画像からアイテム情報を抽出"""

    # 検出対象のアイテムタグ
    ITEM_TAGS = [
        "新刊(漫画)",
        "新刊(イラスト)",
        "小説",
        "合同誌",
        "雑誌",
        "音楽",
        "グッズ",
        "その他"
    ]
    ITEM_SOURCE_IMAGE_TYPES = {"catalog_menu", "product_list", "price_list", "cover", "product_image"}

    def __init__(
        self,
        model: Union[str, List[str]] = "gpt-5-mini",
        use_cli: bool = False,
        cli_providers: Optional[List[str]] = None,
        cli_model_map: Optional[Dict[str, str]] = None,
        cli_effort_map: Optional[Dict[str, str]] = None,
        api_reasoning_effort: Optional[str] = None,
        api_reasoning_effort_map: Optional[Dict[str, str]] = None,
        attempts: Optional[List[Dict[str, str]]] = None,
    ):
        """
        初期化

        Args:
            model: 使用するLLMモデル名（API モード時）
            use_cli: True の場合、API ではなく CLI LLM（antigravity/claude -p）で分析
            cli_providers: CLI プロバイダの優先順（例: ["antigravity", "claude"]）
        """
        self.use_cli = use_cli
        self.cli_providers = cli_providers or ["antigravity", "claude"]
        self.cli_model_map = cli_model_map or {}
        self.cli_effort_map = cli_effort_map or {}
        self.api_reasoning_effort = api_reasoning_effort
        self.api_reasoning_effort_map = api_reasoning_effort_map or {}
        self.attempts = attempts or []
        self.api_clients = {}
        self.llm_client = None
        try:
            from ..utils.llm_client import LLMClient
            self.llm_client = LLMClient(
                model=model,
                reasoning_effort=api_reasoning_effort,
                api_reasoning_effort_map=self.api_reasoning_effort_map,
            )
            for attempt in self.attempts:
                if attempt.get("kind") == "api" and attempt.get("model"):
                    try:
                        self.api_clients[attempt["model"]] = LLMClient(
                            model=attempt["model"],
                            reasoning_effort=attempt.get("effort") or api_reasoning_effort,
                            api_reasoning_effort_map=self.api_reasoning_effort_map,
                        )
                    except Exception as attempt_error:
                        logger.warning(
                            f"API画像解析の試行を利用できません ({attempt.get('model')}): {attempt_error}"
                        )
        except Exception as e:
            if not use_cli:
                raise
            logger.warning(f"API fallback for image analysis is unavailable: {e}")

        if use_cli:
            logger.info(f"CatalogImageAnalyzer initialized with CLI LLM (providers: {self.cli_providers})")
        else:
            logger.info(f"CatalogImageAnalyzer initialized with API model: {model}")

    def analyze_catalog_image(self, image_path: Path) -> List[str]:
        """
        お品書き画像からアイテムタグを抽出（後方互換API）

        Args:
            image_path: お品書き画像のパス

        Returns:
            検出されたアイテムタグのリスト（例: ["新刊", "イラスト本"]）
        """
        items = self.analyze_catalog_items(image_path)
        return list({item.get('type', '') for item in items if item.get('type')})

    def analyze_catalog_items(self, image_path: Path) -> List[Dict[str, Any]]:
        """
        お品書き画像からアイテム情報を抽出

        Args:
            image_path: お品書き画像のパス

        Returns:
            アイテム情報のリスト。各要素は:
            {
                "name": "アイテム名",
                "type": "新刊" | "既刊" | ... ,
                "price": 500,          # 不明なら0
                "description": ""
            }
        """
        if not image_path.exists():
            logger.warning(f"Image file not found: {image_path}")
            return []

        try:
            prompt = self._build_analysis_prompt()

            if self.attempts:
                response = self._analyze_with_attempts(image_path, prompt)
            elif self.use_cli:
                response = self._analyze_with_cli(image_path, prompt)
            else:
                response = self._analyze_with_api(image_path, prompt)

            items = self._parse_response(response)

            if items:
                names = [i.get('name', '?') for i in items]
                logger.info(f"Detected {len(items)} items in {image_path.name}: {', '.join(names)}")
            else:
                logger.debug(f"No items detected in {image_path.name}")

            return items

        except Exception as e:
            logger.error(f"Error analyzing catalog image {image_path}: {e}", exc_info=True)
            return []

    def _analyze_with_api(self, image_path: Path, prompt: str) -> str:
        """API LLM で画像分析"""
        if self.llm_client is None:
            raise RuntimeError("API画像解析fallbackを利用できません")
        logger.debug(f"Analyzing catalog image (API): {image_path.name}")
        return self.llm_client.analyze_image(
            image_path=str(image_path),
            prompt=prompt
        )

    def _analyze_with_api_model(self, image_path: Path, prompt: str, model: str) -> str:
        client = self.api_clients.get(model)
        if client is None:
            raise RuntimeError(f"API画像解析fallbackを利用できません: {model}")
        logger.debug(f"Analyzing catalog image (API {model}): {image_path.name}")
        return client.analyze_image(
            image_path=str(image_path),
            prompt=prompt,
        )

    def _analyze_with_attempts(self, image_path: Path, prompt: str) -> str:
        from .cli_llm import analyze_image_cli

        last_error: Optional[Exception] = None
        for index, attempt in enumerate(self.attempts):
            try:
                if attempt.get("kind") == "cli":
                    provider = attempt.get("provider", "")
                    model = attempt.get("model")
                    effort = attempt.get("effort")
                    cli_model_map = {provider: model} if model else {}
                    cli_effort_map = {provider: effort} if effort is not None else {}
                    return analyze_image_cli(
                        image_path=str(image_path),
                        prompt=prompt,
                        providers=[provider],
                        cli_model_map=cli_model_map,
                        cli_effort_map=cli_effort_map,
                    )

                model = attempt.get("model")
                if not model:
                    raise RuntimeError("API画像解析モデルが空です")
                return self._analyze_with_api_model(image_path, prompt, model)
            except Exception as e:
                last_error = e
                logger.warning(f"画像LLM試行 {index + 1} が失敗しました: {e}")
                continue

        if last_error is None:
            raise RuntimeError("画像LLM解析に失敗しました")
        raise last_error

    def _analyze_with_cli(self, image_path: Path, prompt: str) -> str:
        """CLI LLM で画像分析"""
        from .cli_llm import analyze_image_cli

        logger.debug(f"Analyzing catalog image (CLI): {image_path.name}")
        try:
            return analyze_image_cli(
                image_path=str(image_path),
                prompt=prompt,
                providers=self.cli_providers,
                cli_model_map=self.cli_model_map,
                cli_effort_map=self.cli_effort_map,
            )
        except Exception as e:
            logger.warning(f"CLI画像解析が失敗しました。APIへフォールバックします: {e}")
            return self._analyze_with_api(image_path, prompt)

    def _build_analysis_prompt(self) -> str:
        """画像認識用のプロンプトを構築"""
        tags_list = "、".join(self.ITEM_TAGS)

        prompt = f"""この画像が同人イベントのお品書き（頒布物リスト）かどうかを先に判定してください。
画像がお品書き、頒布物一覧、価格表の場合だけでなく、単独の表紙・ジャケット・頒布物写真でタイトルが明確に読める場合も頒布物として読み取ってください。
漫画サンプルページ、本文ページ、告知画像、会話文や料理名だけの画像からは頒布物を抽出しないでください。
漫画サンプル内の台詞や料理名（例: かつ丼、オムライス）は頒布物名ではありません。

【出力フォーマット】
```json
{{
  "image_type": "catalog_menu | product_list | price_list | cover | product_image | sample_page | announcement | other",
  "is_catalog_image": true/false,
  "items": [
    {{"name": "アイテム名", "type": "種別タグ", "price": 価格(数値)}}
  ]
}}
```

【種別タグ（type）の判定ルール】
使用できるタグ: {tags_list}
- 「新刊(漫画)」: 新刊・新作で、漫画・コミック・同人誌（イラスト集以外の本）の場合
- 「新刊(イラスト)」: 新刊・新作で、イラスト集・画集・CG集・アートブックの場合
- 「小説」: 小説、文芸、SS、テキスト主体の本の場合
- 「合同誌」: 合同誌、アンソロジーなどの表記がある場合
- 「雑誌」: 雑誌、情報誌、フリーペーパーなどの表記がある場合
- 「音楽」: CD、音楽、楽曲、ボーカル、インスト、ダウンロードコードなどの表記がある場合
- 「グッズ」: アクリルスタンド、缶バッジ、ステッカー、タオル、Tシャツ、キーホルダーなどの表記がある場合
- 「その他」: 上記に該当しない場合
- 既刊（既存作品の再頒布）も内容に応じて上記タグを付ける（新刊かどうかは問わない）

【注意事項】
- アイテム名(name)は画像に書かれている通りに読み取る。読み取れない場合は種別タグをnameにする。
- 価格(price)は数値のみ（円マーク等は不要）。読み取れない場合は0にする。
- 「無料配布」「Free」は price: 0 にする。
- 必ずJSONオブジェクトのみを出力し、それ以外のテキストは含めないこと。
- image_type が cover / product_image の場合は、表紙・ジャケット・頒布物写真としてタイトルが明確に読める場合だけ is_catalog_image=true にして1件のitemにする。価格が読めなければ price=0。
- image_type が sample_page / announcement / other の場合は is_catalog_image=false、items=[] にする。
- アイテムが1つも読み取れない場合は items=[] にする。

【出力例】
```json
{{
  "image_type": "catalog_menu",
  "is_catalog_image": true,
  "items": [
    {{"name": "星空のワルツ", "type": "新刊(漫画)", "price": 500}},
    {{"name": "夏の記憶", "type": "新刊(イラスト)", "price": 300}},
    {{"name": "アクリルキーホルダー", "type": "グッズ", "price": 800}}
  ]
}}
```
        """
        return prompt

    def _parse_item_list(self, raw_items: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_items, list):
            return []

        items = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            item: Dict[str, Any] = {
                'name': str(raw.get('name', '')).strip(),
                'type': '',
                'price': 0,
                'description': '',
                'checked': 3,
            }
            # type のバリデーション
            raw_type = str(raw.get('type', '')).strip()
            if raw_type in self.ITEM_TAGS:
                item['type'] = raw_type
            # price のバリデーション
            try:
                price = int(raw.get('price', 0))
                item['price'] = max(price, 0)
            except (ValueError, TypeError):
                item['price'] = 0

            items.append(item)

        return items

    def _parse_response(self, response: str) -> List[Dict[str, Any]]:
        """
        LLMのレスポンスからアイテム情報リストを抽出

        Args:
            response: LLMの応答テキスト

        Returns:
            アイテム情報のリスト
        """
        if not response:
            return []

        response = response.strip()

        # 新形式: 画像種別とitemsを同時に返す。漫画サンプル等はここで落とす。
        response_head = response.lstrip()
        object_response = response_head.startswith("{") or bool(
            re.search(r'```\s*(?:json)?\s*\{', response_head)
        )
        object_match = re.search(r'\{[\s\S]*\}', response) if object_response else None
        if object_match:
            try:
                raw_result = json.loads(object_match.group())
            except json.JSONDecodeError:
                raw_result = None
            if isinstance(raw_result, dict):
                image_type = str(raw_result.get('image_type', '')).strip().lower()
                is_catalog_image = bool(raw_result.get('is_catalog_image'))
                if raw_result.get('is_catalog_image') is False:
                    logger.info(
                        f"Skipped non-catalog image type={image_type}: {raw_result.get('reason', '')}"
                    )
                    return []
                if image_type and image_type not in self.ITEM_SOURCE_IMAGE_TYPES:
                    logger.info(
                        f"Skipped non-catalog image type={image_type}: {raw_result.get('reason', '')}"
                    )
                    return []
                if image_type and not is_catalog_image:
                    logger.info(
                        f"Skipped non-catalog image type={image_type}: {raw_result.get('reason', '')}"
                    )
                    return []
                return self._parse_item_list(raw_result.get('items', []))

        # JSON配列を抽出（```json ... ``` やテキスト混在に対応）
        json_match = re.search(r'\[[\s\S]*\]', response)
        if not json_match:
            # 旧形式（カンマ区切りタグ）へのフォールバック
            return self._parse_legacy_response(response)

        try:
            raw_items = json.loads(json_match.group())
        except json.JSONDecodeError:
            logger.warning(f"JSONパースに失敗しました。旧形式パースを試します: {response[:200]}")
            return self._parse_legacy_response(response)

        return self._parse_item_list(raw_items)

    def _parse_legacy_response(self, response: str) -> List[Dict[str, Any]]:
        """旧形式（カンマ区切りタグ）のレスポンスをパース"""
        if "なし" in response:
            return []

        parts = response.replace("、", ",").split(",")
        items = []
        for part in parts:
            tag = part.strip()
            if tag in self.ITEM_TAGS:
                items.append({
                    'name': '',
                    'type': tag,
                    'price': 0,
                    'description': '',
                    'checked': 3,
                })
        return items

"""event.json 統一フォーマッター — 全コンポーネント共通スキーマで出力"""

from typing import List, Dict, Any
import json
from pathlib import Path
import logging

from ..core import BaseOutputFormatter
from ..models import Circle, Event


class JSONFormatter(BaseOutputFormatter):
    """event.json 統一フォーマッター"""

    def get_required_columns(self) -> List[str]:
        return []

    def format_data(self, circles: List[Circle], event: Event) -> Dict[str, Any]:
        """データをevent.jsonスキーマに変換して返す"""
        from datetime import datetime

        data = {
            'event': event.to_dict(),
            'circles': [circle.to_dict() for circle in circles],
            'metadata': {
                'generated_at': datetime.now().isoformat(),
                'format_version': '3.0',
                'total_circles': len(circles),
                'source': 'pipeline',
            },
        }

        return data

    def save(self, data: Any, filename: str) -> str:
        """event.jsonとして保存（既存メタデータを保持）"""
        output_path = self.config.get_output_path('event.json')

        if not isinstance(data, dict):
            raise TypeError(f"JSONFormatter.save() expects dict, got {type(data)}")

        # 既存のevent.jsonからユーザー手動入力メタデータを保持
        existing_path = Path(output_path)
        if existing_path.exists():
            try:
                with open(existing_path, 'r', encoding='utf-8') as f:
                    existing = json.load(f)
                existing_event = existing.get('event', {})
                new_event = data.get('event', {})
                def is_empty(value):
                    return value is None or value == ''

                # スクレイピングで取得できないフィールドは既存値を保持
                for key in (
                    'date',
                    'venue',
                    'organizer',
                    'memo',
                    'map_url',
                    'additional_prompt',
                    'event_image',
                    'completed',
                    'shopping_started_at',
                    'shopping_ended_at',
                ):
                    existing_value = existing_event.get(key)
                    if (
                        (key not in new_event or is_empty(new_event.get(key)))
                        and key in existing_event
                        and not is_empty(existing_value)
                    ):
                        new_event[key] = existing_value
                if not new_event.get('event_url') and existing_event.get('event_url'):
                    new_event['event_url'] = existing_event['event_url']
                if not new_event.get('url') and existing_event.get('url'):
                    new_event['url'] = existing_event['url']
                data['event'] = new_event
            except (json.JSONDecodeError, OSError):
                pass

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        self.logger.info(f"event.json を保存: {output_path}")
        return output_path

    def validate_output(self, data: Any) -> List[str]:
        """出力データの検証"""
        errors = []
        if not isinstance(data, dict):
            errors.append("出力データがdict型ではありません")
            return errors
        if 'event' not in data:
            errors.append("必須キー不足: event")
        if 'circles' not in data:
            errors.append("必須キー不足: circles")
        if not data.get('circles'):
            errors.append("サークルデータが空です")
        return errors

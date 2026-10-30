"""event.json 統一フォーマッター — 全コンポーネント共通スキーマで出力"""

from typing import List, Dict, Any
import json
from pathlib import Path
import logging

from ..core import BaseOutputFormatter
from ..models import Circle, Event
from ..utils.atomic_json import atomic_write_json


NL = chr(10)


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

        # パイプラインが追跡用に設定した付帯情報（サークルカット判定の概要など）
        extras = getattr(self, 'metadata_extras', None)
        if extras:
            data['metadata'].update(extras)

        return data

    def save(self, data: Any, filename: str) -> str:
        """event.jsonとして保存（既存メタデータを保持）"""
        output_path = self.config.get_output_path('event.json')

        if not isinstance(data, dict):
            raise TypeError(f"JSONFormatter.save() expects dict, got {type(data)}")

        # 既存のevent.jsonからユーザー手動入力メタデータを保持
        # 1回の実行で複数回saveされるため、最初に読んだ保存済みデータを基準にし続ける
        # （1回目のsaveで上書きされた後のファイルを基準にすると手動状態が失われる）。
        existing_path = Path(output_path)
        if not hasattr(self, '_baseline_existing'):
            self._baseline_existing = None
            if existing_path.exists():
                try:
                    with open(existing_path, 'r', encoding='utf-8') as f:
                        self._baseline_existing = json.load(f)
                except (json.JSONDecodeError, OSError):
                    self._baseline_existing = None
        if self._baseline_existing is not None:
            try:
                existing = self._baseline_existing
                self._carry_circle_manual_state(existing.get('circles'), data.get('circles'))
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

        # Grok再探索などで記録したXアカウント状態は、お品書き未取得のサークル分を次回へ引き継ぐ。
        if self._baseline_existing is not None:
            previous = (self._baseline_existing.get('metadata') or {}).get('x_account_status')
            if previous:
                from ..utils.x_account_status import merge_x_account_status
                merged = merge_x_account_status(
                    previous, (data.get('metadata') or {}).get('x_account_status'),
                    data.get('circles'),
                )
                if merged:
                    data.setdefault('metadata', {})['x_account_status'] = merged

        atomic_write_json(output_path, data)

        self.logger.info(f"event.json を保存: {output_path}")
        return output_path

    @staticmethod
    def _circle_key(circle: Dict[str, Any]) -> tuple:
        def norm(value: Any) -> str:
            return str(value or '').strip()
        return (norm(circle.get('space')), norm(circle.get('name')))

    @classmethod
    def _carry_circle_manual_state(cls, existing_circles: Any, new_circles: Any) -> int:
        """再取得で作り直したサークルへ、手動の購入状態・優先度・メモ・ピンなどを引き継ぐ。"""
        if not isinstance(existing_circles, list) or not isinstance(new_circles, list):
            return 0
        by_key = {
            cls._circle_key(c): c for c in existing_circles if isinstance(c, dict)
        }
        by_name = {}
        for c in existing_circles:
            if isinstance(c, dict) and c.get('name'):
                by_name.setdefault(str(c['name']).strip(), []).append(c)
        carried = 0
        for circle in new_circles:
            if not isinstance(circle, dict):
                continue
            old = by_key.get(cls._circle_key(circle))
            if old is None:
                same_name = by_name.get(str(circle.get('name') or '').strip(), [])
                old = same_name[0] if len(same_name) == 1 else None
            if old is None:
                continue
            changed = False
            if old.get('checked') and not circle.get('checked'):
                circle['checked'] = old['checked']
                changed = True
            if old.get('priority_color') not in (None, 5) and circle.get('priority_color') in (None, 5):
                circle['priority_color'] = old['priority_color']
                changed = True
            for key in ('absence_status', 'existing_only_status', 'pin_x', 'pin_y', 'map_number'):
                if old.get(key) is not None and circle.get(key) is None:
                    circle[key] = old[key]
                    changed = True
            old_memo = str(old.get('memo') or '')
            if old_memo:
                new_memo = str(circle.get('memo') or '')
                lines = [ln for ln in new_memo.split(NL) if ln]
                merged = [ln for ln in old_memo.split(NL) if ln]
                merged += [ln for ln in lines if ln not in merged]
                circle['memo'] = NL.join(merged)
                changed = changed or circle['memo'] != new_memo
            old_items = {
                str(it.get('name') or ''): it
                for it in old.get('items') or []
                if isinstance(it, dict) and it.get('checked')
            }
            for item in circle.get('items') or []:
                if isinstance(item, dict) and not item.get('checked'):
                    prev = old_items.get(str(item.get('name') or ''))
                    if prev:
                        item['checked'] = prev['checked']
                        changed = True
            old_origin = old.get('circle_cut_origin')
            if isinstance(old_origin, dict) and old_origin.get('kind') == 'manual':
                circle['circle_cut_filename'] = old.get('circle_cut_filename')
                circle['circle_cut_url'] = old.get('circle_cut_url')
                circle['circle_cut_origin'] = old_origin
                changed = True
            carried += 1 if changed else 0
        return carried

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

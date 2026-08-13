#!/usr/bin/env python3
"""
event.json座標更新機能

座標マップを使ってevent.json内のサークルpin_x/pin_yを更新
"""

import json
import re
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path
import logging

from src.space_locator.auto_coordinate_generator import expand_space_ids


class JSONUpdater:
    """event.json座標更新処理"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)

    def update_event_json(
        self,
        event_json_path: str,
        coordinate_map: List[Dict[str, Any]],
        map_number: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        event.jsonのサークル座標を更新

        Args:
            event_json_path: event.jsonのパス
            coordinate_map: 座標マップ [{"space_id": "E12", "x": 468, "y": 304, ...}, ...]

        Returns:
            更新結果 {"updated_count", "skipped_count", ...}
        """
        path = Path(event_json_path)
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        coord_dict = self._build_coordinate_dict(coordinate_map)
        self.logger.info(f"座標マップ: {len(coord_dict)}件")

        circles = data.get('circles', [])
        event = data.get('event', {})
        maps = event.get('maps', []) if isinstance(event, dict) else []
        multi_map = isinstance(maps, list) and len(maps) > 1
        updated_count = 0
        skipped_count = 0
        updated_space_ids = []

        for circle in circles:
            space_id = (circle.get('space') or '').strip()
            if not space_id:
                skipped_count += 1
                continue
            if map_number is not None:
                existing_map_number = circle.get('map_number')
                if existing_map_number is None and multi_map:
                    skipped_count += 1
                    continue
                if existing_map_number is not None:
                    try:
                        if int(existing_map_number) != int(map_number):
                            skipped_count += 1
                            continue
                    except (TypeError, ValueError):
                        skipped_count += 1
                        continue

            resolved_id, coord = self._find_coordinate(space_id, coord_dict)

            if coord:
                if coord['normalized_x'] is not None and coord['normalized_y'] is not None:
                    circle['pin_x'] = coord['normalized_x']
                    circle['pin_y'] = coord['normalized_y']
                else:
                    circle['pin_x'] = coord['x']
                    circle['pin_y'] = coord['y']
                if map_number is not None:
                    circle['map_number'] = int(map_number)
                updated_count += 1
                updated_space_ids.append(resolved_id)
            else:
                skipped_count += 1

        # 書き戻し
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        result = {
            'total_circles': len(circles),
            'updated_count': updated_count,
            'skipped_count': skipped_count,
            'updated_space_ids': updated_space_ids,
        }
        self.logger.info(f"更新完了: {updated_count}件更新、{skipped_count}件スキップ")
        return result

    def _build_coordinate_dict(self, coordinate_map: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        coord_dict = {}
        for item in coordinate_map:
            space_id = item['space_id']
            coord_data = {
                'x': item['x'],
                'y': item['y'],
                'normalized_x': item.get('normalized_x'),
                'normalized_y': item.get('normalized_y'),
            }
            coord_dict[space_id] = coord_data
            coord_dict[self._normalize_space_id(space_id, '-')] = coord_data
            coord_dict[self._normalize_space_id(space_id, ' ')] = coord_data
        return coord_dict

    def _normalize_space_id(self, space_id: str, separator: str = '-') -> str:
        if separator in space_id:
            return space_id
        if separator == '-' and ' ' in space_id:
            return space_id.replace(' ', '-')
        elif separator == ' ' and '-' in space_id:
            return space_id.replace('-', ' ')
        match = re.match(r'^([ぁ-んァ-ヶA-Za-z]+)(\d+)$', space_id)
        if match:
            return f"{match.group(1)}{separator}{match.group(2).zfill(2)}"
        return space_id

    def _find_coordinate(
        self, space_id: str, coord_dict: Dict[str, Dict[str, Any]]
    ) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
        expanded_ids = self._expand_multi_space_ids(space_id)
        if len(expanded_ids) > 1:
            collected = []
            collected_ids = []
            for expanded in expanded_ids:
                for candidate in self._generate_candidate_ids(expanded):
                    if candidate in coord_dict:
                        collected.append(coord_dict[candidate])
                        collected_ids.append(candidate)
                        break
            # A grouped circle has one shared booth centre.  Never update it
            # from only a subset of its members: that silently moves the pin to
            # one side when OCR/catalog geometry is incomplete.
            if len(collected) == len(expanded_ids):
                avg_coord = self._average_coordinates(collected)
                return ','.join(collected_ids), avg_coord
            return None, None

        for candidate in self._generate_candidate_ids(space_id):
            if candidate in coord_dict:
                return candidate, coord_dict[candidate]
        return None, None

    def _average_coordinates(self, coords: List[Dict[str, Any]]) -> Dict[str, Any]:
        count = len(coords)
        if count == 0:
            return {}
        norm_x = [c.get('normalized_x') for c in coords if c.get('normalized_x') is not None]
        norm_y = [c.get('normalized_y') for c in coords if c.get('normalized_y') is not None]
        if len(norm_x) == count and len(norm_y) == count:
            return {
                'x': sum(c['x'] for c in coords) / count,
                'y': sum(c['y'] for c in coords) / count,
                'normalized_x': sum(norm_x) / count,
                'normalized_y': sum(norm_y) / count,
            }
        return {
            'x': sum(c['x'] for c in coords) / count,
            'y': sum(c['y'] for c in coords) / count,
            'normalized_x': None,
            'normalized_y': None,
        }

    def _generate_candidate_ids(self, space_id: str) -> List[str]:
        candidates = []
        seen = set()

        def add(v):
            if v and v not in seen:
                candidates.append(v)
                seen.add(v)

        add(space_id)
        add(self._normalize_space_id(space_id, '-'))
        add(self._normalize_space_id(space_id, ' '))
        for expanded in self._expand_multi_space_ids(space_id):
            add(expanded)
            add(self._normalize_space_id(expanded, '-'))
            add(self._normalize_space_id(expanded, ' '))
        return candidates

    def _expand_multi_space_ids(self, space_id: str) -> List[str]:
        return [item["space_id"] for item in expand_space_ids(space_id)]

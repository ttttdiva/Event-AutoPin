#!/usr/bin/env python3
"""
event.json座標更新機能

座標マップを使ってevent.json内のサークルpin_x/pin_yを更新
"""

import json
import re
from copy import deepcopy
from typing import Dict, List, Any, Optional, Tuple
from pathlib import Path
import logging

from src.space_locator.auto_coordinate_generator import expand_circle_space_ids, expand_space_ids
from src.utils.atomic_json import atomic_write_json


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

        patches = self.build_coordinate_patches(data, coordinate_map, map_number)
        self.logger.info(f"座標マップ: {len(self._build_coordinate_dict(coordinate_map))}件")

        circles = data.get('circles', [])
        if isinstance(circles, list):
            for patch in patches.get("circle_patches", []):
                try:
                    index = int(patch["circle_index"])
                    changes = patch.get("changes") or {}
                    if 0 <= index < len(circles) and isinstance(circles[index], dict):
                        circles[index].update(changes)
                except (KeyError, TypeError, ValueError):
                    # build_coordinate_patches emits validated indices; keep the
                    # writer defensive if a caller supplies a custom payload.
                    continue

        # 書き戻し
        atomic_write_json(path, data, indent=2)

        result = {
            key: value
            for key, value in patches.items()
            if key != "circle_patches"
        }
        self.logger.info(
            f"更新完了: {patches.get('updated_count', 0)}件更新、"
            f"{patches.get('skipped_count', 0)}件スキップ"
        )
        return result

    def build_coordinate_patches(
        self,
        event_data: Dict[str, Any],
        coordinate_map: List[Dict[str, Any]],
        map_number: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Build pure, auditable event pin patches without mutating ``event_data``.

        The returned ``circle_patches`` contains the original circle snapshot and
        only the pin changes needed for each matched circle.  This lets callers
        review/atomically apply updates while retaining the legacy aggregate
        counters used by the desktop and CLI flows.
        """
        coord_dict = self._build_coordinate_dict(coordinate_map)
        circles = event_data.get("circles", []) if isinstance(event_data, dict) else []
        if not isinstance(circles, list):
            circles = []
        event = event_data.get("event", {}) if isinstance(event_data, dict) else {}
        maps = event.get("maps", []) if isinstance(event, dict) else []
        multi_map = isinstance(maps, list) and len(maps) > 1
        updated_count = 0
        skipped_count = 0
        updated_space_ids: List[Optional[str]] = []
        circle_patches: List[Dict[str, Any]] = []

        for circle_index, circle in enumerate(circles):
            if not isinstance(circle, dict):
                skipped_count += 1
                continue
            space_id = (circle.get("space") or "").strip()
            hall = circle.get("hall")
            if not space_id:
                skipped_count += 1
                continue
            if map_number is not None:
                existing_map_number = circle.get("map_number")
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

            resolved_id, coord = self._find_coordinate(space_id, coord_dict, hall=hall)
            if not coord:
                skipped_count += 1
                continue

            if coord.get("normalized_x") is not None and coord.get("normalized_y") is not None:
                pin_x = coord["normalized_x"]
                pin_y = coord["normalized_y"]
            else:
                pin_x = coord.get("x")
                pin_y = coord.get("y")
            if pin_x is None or pin_y is None:
                skipped_count += 1
                continue

            updated_count += 1
            updated_space_ids.append(resolved_id)
            circle_patches.append(
                {
                    "circle_index": circle_index,
                    "circle_identity": {
                        key: str(circle.get(key) or "")
                        for key in ("name", "penname", "space", "hall")
                    },
                    "base_circle": deepcopy(circle),
                    "changes": {"pin_x": pin_x, "pin_y": pin_y},
                }
            )

        return {
            "total_circles": len(circles),
            "updated_count": updated_count,
            "skipped_count": skipped_count,
            "updated_space_ids": updated_space_ids,
            "circle_patches": circle_patches,
        }

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
        self,
        space_id: str,
        coord_dict: Dict[str, Dict[str, Any]],
        hall: Optional[str] = None,
    ) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
        expanded_ids = self._expand_multi_space_ids(space_id, hall=hall)
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

        for candidate in self._generate_candidate_ids(space_id, hall=hall):
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

    def _generate_candidate_ids(
        self,
        space_id: str,
        hall: Optional[str] = None,
    ) -> List[str]:
        candidates = []
        seen = set()

        def add(v):
            if v and v not in seen:
                candidates.append(v)
                seen.add(v)

        add(space_id)
        add(self._normalize_space_id(space_id, '-'))
        add(self._normalize_space_id(space_id, ' '))
        for expanded in self._expand_multi_space_ids(space_id, hall=hall):
            add(expanded)
            add(self._normalize_space_id(expanded, '-'))
            add(self._normalize_space_id(expanded, ' '))
        return candidates

    def _expand_multi_space_ids(
        self,
        space_id: str,
        hall: Optional[str] = None,
    ) -> List[str]:
        return [item["space_id"] for item in expand_circle_space_ids(space_id, hall)]

#!/usr/bin/env python3
"""
event.json再処理ユーティリティ
既存のevent.jsonを読み込み、おしながきリンクが未記載のサークルを抽出して再処理
"""

import json
import re
from pathlib import Path
from typing import List, Dict, Optional, Any
import logging

from .circle_master import CircleMasterManager
from .atomic_json import atomic_write_json
from .reprocess_helpers import (
    REASON_NO_CATALOG,
    REASON_PREVIEW_ONLY,
    append_unique_line,
    reason_counts,
    text_value,
    valid_index,
)

TERMINAL_NO_ITEM_CATALOG_STATUSES = {"no_extractable_items"}


class JSONReprocessor:
    """event.json再処理クラス"""

    def __init__(self, json_path: str = "", logger: Optional[logging.Logger] = None, output_dir: str = ""):
        self.json_path = Path(json_path)
        self.logger = logger or logging.getLogger(__name__)
        self.output_dir = Path(output_dir)
        self.circle_master = CircleMasterManager()

    def load_existing_json(self) -> Optional[Dict[str, Any]]:
        """既存のevent.jsonを読み込む"""
        if not self.json_path.exists():
            self.logger.warning(f"event.jsonが見つかりません: {self.json_path}")
            return None
        try:
            with open(self.json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            circles = data.get('circles', [])
            self.logger.info(f"既存のevent.jsonを読み込みました: {len(circles)}サークル")
            return data
        except Exception as e:
            self.logger.error(f"event.json読み込みエラー: {e}")
            return None

    def extract_circles_without_catalog(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """おしながきリンクが未記載、またはおしながき予告のみのサークルを抽出"""
        circles = data.get('circles', [])
        result = []

        for idx, circle in enumerate(circles):
            name = circle.get('name', '')
            if not name:
                continue

            # memo URLだけでは完了扱いにしない。アイテム本体が必要。
            items = circle.get('items', [])
            has_item_details = any(
                text_value(item.get('type', ''))
                or text_value(item.get('name', ''))
                for item in items
            ) if items else False

            memo = circle.get('memo', '')
            memo_catalog_urls = re.findall(
                r"https?://(?:twitter\.com|x\.com)/[^\s]+/status(?:es)?/\d+",
                memo,
            )

            has_catalog = has_item_details
            catalog_status = circle.get('catalog_status')
            is_needs_recheck = catalog_status == 'needs_recheck'
            is_terminal_no_item = catalog_status in TERMINAL_NO_ITEM_CATALOG_STATUSES

            is_preview = catalog_status == 'preview' or any(
                'おしながき予告' in text_value(tag)
                for tag in circle.get('tags', [])
            )

            needs_reprocess = False
            reason = ''
            if is_needs_recheck:
                needs_reprocess = True
                reason = REASON_NO_CATALOG
            elif is_preview:
                needs_reprocess = True
                reason = REASON_PREVIEW_ONLY
            elif not has_catalog and not is_terminal_no_item:
                needs_reprocess = True
                reason = REASON_NO_CATALOG

            if needs_reprocess:
                twitter_url = circle.get('twitter_url', '')
                if twitter_url or memo_catalog_urls:
                    result.append({
                        'name': name,
                        'space': circle.get('space', ''),
                        'twitter_url': twitter_url,
                        'circle_index': idx,
                        'reason': reason,
                        'catalog_urls': memo_catalog_urls,
                    })

        counts = reason_counts(result)
        no_catalog = counts[REASON_NO_CATALOG]
        preview_only = counts[REASON_PREVIEW_ONLY]
        self.logger.info(
            f"再処理対象サークル: {len(result)}件 "
            f"(未取得: {no_catalog}, 予告のみ: {preview_only})"
        )
        return result

    def update_catalog_links(self, data: Dict[str, Any], update_data: List[Dict]) -> Dict[str, Any]:
        """おしながきリンクを更新"""
        circles = data.get('circles', [])

        for update in update_data:
            idx = update.get('circle_index')
            if valid_index(idx, len(circles)):
                circle = circles[idx]

                if update.get('catalog_url'):
                    # memoにお品書きURL追加
                    circle['memo'] = append_unique_line(
                        circle.get('memo', ''),
                        update['catalog_url'],
                    )

                if update.get('catalog_image'):
                    img_entry = {'path': update['catalog_image'], 'source': 'twitter'}
                    if 'item_images' not in circle:
                        circle['item_images'] = []
                    circle['item_images'].append(img_entry)

                if update.get('items'):
                    circle['items'] = update['items']

                if update.get('catalog_status'):
                    circle['catalog_status'] = update['catalog_status']

                if update.get('existing_only_status'):
                    circle['existing_only_status'] = update['existing_only_status']

                if update.get('catalog_type'):
                    # tagsに追加
                    if 'tags' not in circle:
                        circle['tags'] = []
                    if update['catalog_type'] not in circle['tags']:
                        circle['tags'].append(update['catalog_type'])

        return data

    def apply_default_cuts_for_missing(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """サークルカットがないサークルにデフォルトカットを適用"""
        circles = data.get('circles', [])
        updated_count = 0
        fallback_count = 0

        for idx, circle in enumerate(circles):
            name = circle.get('name', '')
            if not name:
                continue

            cut_filename = text_value(circle.get('circle_cut_filename', ''))
            if cut_filename:
                continue

            default_cut_path = self.circle_master.copy_default_cut(
                name, self.output_dir, prefix=f"{idx:04d}_default_"
            )
            if default_cut_path:
                circle['circle_cut_filename'] = default_cut_path.name
                updated_count += 1
            else:
                # お品書き画像で代用 + デフォルトカットとして登録
                item_images = circle.get('item_images', [])
                if item_images:
                    item_path = text_value(item_images[0].get('path', ''))
                    if not item_path:
                        continue
                    circle['circle_cut_filename'] = item_path
                    fallback_count += 1
                    # デフォルトカットに登録（次回以降も使えるように）
                    if item_path:
                        full_path = self.output_dir / item_path
                        penname = circle.get('penname', '')
                        self.circle_master.register_default_cut(name, penname, full_path)

        if updated_count > 0:
            self.logger.info(f"✅ {updated_count}サークルにデフォルトカットを適用しました")
        if fallback_count > 0:
            self.logger.info(f"✅ {fallback_count}サークルにおしながき画像をサークルカットとして設定しました")

        return data

    def save_updated_json(self, data: Dict[str, Any], output_path: Optional[str] = None):
        """更新されたevent.jsonを保存"""
        save_path = Path(output_path) if output_path else self.json_path
        try:
            atomic_write_json(save_path, data)
            self.logger.info(f"✅ event.jsonを更新しました: {save_path}")
        except Exception as e:
            self.logger.error(f"event.json保存エラー: {e}")
            raise

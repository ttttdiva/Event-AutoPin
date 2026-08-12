"""
サイトパターン学習・管理システム
LLMで処理したサイトのパターンを保存し、次回以降はLLMを使わずに処理できるようにする
"""

import json
import hashlib
from pathlib import Path
from typing import Dict, Any, Optional, List
from datetime import datetime
from urllib.parse import urlparse
import logging

logger = logging.getLogger(__name__)


class PatternManager:
    """サイトパターンの学習・管理クラス"""
    
    def __init__(self, patterns_dir: str = "learned_patterns"):
        """
        Args:
            patterns_dir: パターンファイルを保存するディレクトリ
        """
        self.patterns_dir = Path(patterns_dir)
        self.patterns_dir.mkdir(exist_ok=True)
        self.patterns_file = self.patterns_dir / "site_patterns.json"
        self.stats_file = self.patterns_dir / "site_patterns_stats.json"
        self.patterns = self._load_patterns()
        self.stats = self._load_stats()
    
    def _load_patterns(self) -> Dict[str, Any]:
        """保存済みパターンを読み込み"""
        if self.patterns_file.exists():
            try:
                with open(self.patterns_file, 'r', encoding='utf-8') as f:
                    patterns = json.load(f)
                    logger.info(f"学習済みパターンを読み込みました: {len(patterns)} サイト")
                    return patterns
            except Exception as e:
                logger.error(f"パターンファイルの読み込みに失敗: {e}")
                return {}
        return {}

    def _load_stats(self) -> Dict[str, Any]:
        """統計情報を読み込み"""
        if self.stats_file.exists():
            try:
                with open(self.stats_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"統計ファイルの読み込みに失敗: {e}")
                return {}
        return {}

    def _save_patterns(self):
        """パターンをファイルに保存（統計情報を除く）"""
        try:
            # 統計フィールドを除外してパターンを保存
            patterns_without_stats = {}
            for url_hash, pattern in self.patterns.items():
                pattern_copy = pattern.copy()
                # 統計フィールドを削除
                pattern_copy.pop('use_count', None)
                pattern_copy.pop('last_used', None)
                pattern_copy.pop('created_at', None)
                patterns_without_stats[url_hash] = pattern_copy

            with open(self.patterns_file, 'w', encoding='utf-8') as f:
                json.dump(patterns_without_stats, f, ensure_ascii=False, indent=2)
            logger.info(f"パターンを保存しました: {self.patterns_file}")
        except Exception as e:
            logger.error(f"パターンの保存に失敗: {e}")

    def _save_stats(self):
        """統計情報を保存"""
        try:
            with open(self.stats_file, 'w', encoding='utf-8') as f:
                json.dump(self.stats, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"統計の保存に失敗: {e}")
    
    def get_site_key(self, url: str) -> str:
        """URLからサイト識別キーを生成"""
        parsed = urlparse(url)
        
        # 特定のドメインは固定キーを使用
        domain = parsed.netloc.lower()
        if 'kowa-uta.com' in domain:
            return 'kowa-uta.com'
        elif 'sockbase.net' in domain:
            return 'sockbase.net'
        
        # その他のサイトは動的にキーを生成
        path_parts = [p for p in parsed.path.split('/') if p]
        if path_parts:
            # イベント固有の部分を除外（数字や年を含む部分）
            base_parts = []
            for part in path_parts:
                # 数字のみ、年っぽい数字は除外
                if not (part.isdigit() or (len(part) == 4 and part.startswith('20'))):
                    base_parts.append(part)
            
            if base_parts:
                return f"{parsed.netloc}/{'/'.join(base_parts[:2])}"
        
        return parsed.netloc
    
    def has_pattern(self, url: str) -> bool:
        """指定URLのパターンが学習済みか確認"""
        site_key = self.get_site_key(url)
        return site_key in self.patterns
    
    def get_pattern(self, url: str) -> Optional[Dict[str, Any]]:
        """学習済みパターンを取得"""
        site_key = self.get_site_key(url)
        pattern = self.patterns.get(site_key)
        
        if pattern:
            logger.info(f"学習済みパターンを使用: {site_key}")
            # 使用統計を更新
            if site_key not in self.stats:
                self.stats[site_key] = {}
            self.stats[site_key]['use_count'] = self.stats[site_key].get('use_count', 0) + 1
            self.stats[site_key]['last_used'] = datetime.now().isoformat()
            self._save_stats()

        return pattern
    
    def save_pattern(self, url: str, extraction_rules: Dict[str, Any], 
                    event_info: Dict[str, Any], circles_sample: List[Dict[str, Any]]):
        """LLMで抽出したパターンを保存
        
        Args:
            url: 処理したURL
            extraction_rules: 抽出に使用したCSSセレクタやパターン
            event_info: 抽出されたイベント情報
            circles_sample: 抽出されたサークル情報のサンプル（最大5件）
        """
        site_key = self.get_site_key(url)
        
        pattern = {
            'site_key': site_key,
            'domain': urlparse(url).netloc,
            'sample_url': url,
            'extraction_rules': extraction_rules,
            'event_structure': self._analyze_structure(event_info),
            'circle_structure': self._analyze_circles_structure(circles_sample[:5]),
            'version': '1.0'
        }

        self.patterns[site_key] = pattern
        self._save_patterns()

        # 統計情報を初期化
        self.stats[site_key] = {
            'created_at': datetime.now().isoformat(),
            'last_used': datetime.now().isoformat(),
            'use_count': 1
        }
        self._save_stats()
        
        logger.info(f"新しいパターンを学習しました: {site_key}")
    
    def _analyze_structure(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """データ構造を分析"""
        structure = {}
        for key, value in data.items():
            if value is not None:
                structure[key] = {
                    'type': type(value).__name__,
                    'example': str(value)[:100] if not isinstance(value, (dict, list)) else None,
                    'present': True
                }
        return structure
    
    def _analyze_circles_structure(self, circles: List[Dict[str, Any]]) -> Dict[str, Any]:
        """サークルデータの構造を分析"""
        if not circles:
            return {}
        
        # 全サークルで共通のフィールドを特定
        common_fields = {}
        for circle in circles:
            for key, value in circle.items():
                if value is not None and value != '':
                    if key not in common_fields:
                        common_fields[key] = {
                            'type': type(value).__name__,
                            'frequency': 0,
                            'examples': []
                        }
                    common_fields[key]['frequency'] += 1
                    if len(common_fields[key]['examples']) < 3:
                        common_fields[key]['examples'].append(str(value)[:50])
        
        # 頻度を正規化
        total = len(circles)
        for field in common_fields.values():
            field['frequency'] = field['frequency'] / total
        
        return common_fields
    
    def export_pattern(self, site_key: str, output_path: str):
        """特定サイトのパターンをエクスポート"""
        if site_key in self.patterns:
            pattern = self.patterns[site_key]
            output_file = Path(output_path)
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(pattern, f, ensure_ascii=False, indent=2)
            logger.info(f"パターンをエクスポート: {output_file}")
            return True
        return False
    
    def import_pattern(self, pattern_file: str):
        """外部パターンファイルをインポート"""
        try:
            with open(pattern_file, 'r', encoding='utf-8') as f:
                pattern = json.load(f)
            
            site_key = pattern.get('site_key')
            if site_key:
                self.patterns[site_key] = pattern
                self._save_patterns()
                logger.info(f"パターンをインポート: {site_key}")
                return True
        except Exception as e:
            logger.error(f"パターンのインポートに失敗: {e}")
        return False
    
    def list_patterns(self) -> List[Dict[str, Any]]:
        """学習済みパターンの一覧を取得"""
        patterns_list = []
        for site_key, pattern in self.patterns.items():
            stats = self.stats.get(site_key, {})
            patterns_list.append({
                'site_key': site_key,
                'domain': pattern.get('domain'),
                'created_at': stats.get('created_at'),
                'last_used': stats.get('last_used'),
                'use_count': stats.get('use_count', 0)
            })
        return sorted(patterns_list, key=lambda x: x.get('use_count', 0), reverse=True)
#!/usr/bin/env python
"""
固定アダプターをlearned_patternsに移行するスクリプト
KowaUtaAdapterとSockbaseAdapterの処理ロジックをパターンとして保存
"""

import json
from pathlib import Path
from datetime import datetime

def create_kowauta_pattern():
    """声音の宴用のパターンを作成"""
    return {
        'site_key': 'kowa-uta.com',
        'domain': 'kowa-uta.com',
        'sample_url': 'https://kowa-uta.com/5th/circleList/',
        'extraction_rules': {
            # イベント情報の抽出ルール
            'event_name_selectors': ['title', 'h1'],
            'event_name_patterns': [r'第(\d+)回\s*(.+?)(?:\s*サークルリスト)?$'],
            'event_date_patterns': [r'(\d{4})[年․s]*(\d{1,2})[月․s]*(\d{1,2})[日]?'],
            'event_venue_patterns': ['会場', 'ビッグサイト', '東京'],
            
            # サークル情報の抽出ルール
            'circle_container_selectors': ['table tr', 'div.circle'],
            'circle_name_selectors': ['td:nth-child(2)', '.circle-name'],
            'circle_space_selectors': ['td:first-child', '.space'],
            'circle_penname_selectors': ['td:nth-child(3)', '.penname'],
            'circle_twitter_selectors': ['a[href*="twitter"]', 'a[href*="x.com"]'],
            'circle_website_selectors': ['a[href*="http"]'],
            
            # テーブル形式の特別処理
            'table_processing': True,
            'header_keywords': ['サークル', 'スペース', 'ペンネーム'],
            
            # カスタム処理フラグ
            'custom_processing': {
                'extract_from_table': True,
                'extract_from_divs': True,
                'normalize_space': True,
                'parse_event_from_url': True
            }
        },
        'event_structure': {
            'name': {'type': 'str', 'present': True},
            'date': {'type': 'str', 'present': True},
            'venue': {'type': 'str', 'present': False},
            'organizer': {'type': 'str', 'present': False}
        },
        'circle_structure': {
            'name': {'type': 'str', 'frequency': 1.0},
            'space': {'type': 'str', 'frequency': 1.0},
            'penname': {'type': 'str', 'frequency': 0.8},
            'twitter_url': {'type': 'str', 'frequency': 0.5},
            'website_url': {'type': 'str', 'frequency': 0.3}
        },
        'created_at': datetime.now().isoformat(),
        'last_used': datetime.now().isoformat(),
        'use_count': 100,  # 高い優先度を示すため
        'version': '2.0',
        'adapter_type': 'fixed_migration'  # 固定アダプターからの移行を示す
    }

def create_sockbase_pattern():
    """Sockbase用のパターンを作成"""
    return {
        'site_key': 'sockbase.net',
        'domain': 'sockbase.net',
        'sample_url': 'https://sockbase.net/event/souzou2024',
        'extraction_rules': {
            # イベント情報の抽出ルール
            'event_name_selectors': ['h1', '.event-title', 'title'],
            'event_name_patterns': [],
            
            # サークル情報の抽出ルール
            'circle_container_selectors': ['table tr', '.circle-item'],
            'circle_name_selectors': ['td:nth-child(2)', '.circle-name'],
            'circle_space_selectors': ['td:first-child', '.space-number'],
            'circle_penname_selectors': ['td:nth-child(3)', '.author'],
            'circle_twitter_selectors': ['a[href*="twitter"]', 'a[href*="x.com"]'],
            'circle_website_selectors': ['a[href*="http"]'],
            'circle_description_selectors': ['.description', 'td:nth-child(4)'],
            
            # テーブル形式の処理
            'table_processing': True,
            'header_keywords': ['スペース', 'サークル名', '作者'],
            
            # カスタム処理フラグ
            'custom_processing': {
                'extract_from_table': True,
                'extract_from_list': True,
                'normalize_links': True
            }
        },
        'event_structure': {
            'name': {'type': 'str', 'present': True},
            'date': {'type': 'str', 'present': False},
            'venue': {'type': 'str', 'present': False}
        },
        'circle_structure': {
            'name': {'type': 'str', 'frequency': 1.0},
            'space': {'type': 'str', 'frequency': 1.0},
            'penname': {'type': 'str', 'frequency': 0.9},
            'twitter_url': {'type': 'str', 'frequency': 0.6},
            'website_url': {'type': 'str', 'frequency': 0.4},
            'description': {'type': 'str', 'frequency': 0.7}
        },
        'created_at': datetime.now().isoformat(),
        'last_used': datetime.now().isoformat(),
        'use_count': 100,  # 高い優先度を示すため
        'version': '2.0',
        'adapter_type': 'fixed_migration'
    }

def migrate_fixed_adapters():
    """固定アダプターをパターンとして保存"""
    
    # learned_patternsディレクトリを作成
    patterns_dir = Path("learned_patterns")
    patterns_dir.mkdir(exist_ok=True)
    
    # 既存のパターンを読み込み
    patterns_file = patterns_dir / "site_patterns.json"
    if patterns_file.exists():
        with open(patterns_file, 'r', encoding='utf-8') as f:
            patterns = json.load(f)
    else:
        patterns = {}
    
    # 固定アダプターのパターンを追加
    patterns['kowa-uta.com'] = create_kowauta_pattern()
    patterns['sockbase.net'] = create_sockbase_pattern()
    
    # 保存
    with open(patterns_file, 'w', encoding='utf-8') as f:
        json.dump(patterns, f, ensure_ascii=False, indent=2)
    
    print("✅ 固定アダプターをlearned_patternsに移行しました:")
    print("  - kowa-uta.com (声音の宴)")
    print("  - sockbase.net (Sockbase)")
    print(f"\n保存先: {patterns_file.absolute()}")
    
    return patterns

if __name__ == "__main__":
    migrate_fixed_adapters()
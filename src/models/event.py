from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime
from copy import deepcopy


@dataclass
class EventMap:
    """イベントマップ情報"""
    url: str
    filename: str = "map_01.jpg"
    map_number: int = 1


@dataclass
class Event:
    """イベント情報"""
    name: str
    url: str
    date: Optional[datetime] = None
    venue: Optional[str] = None
    organizer: Optional[str] = None
    
    # マップ情報
    maps: List[EventMap] = field(default_factory=list)
    
    # メモ
    memo: str = ""

    # 買い物時刻（モバイル購入結果用）
    shopping_started_at: Optional[str] = None
    shopping_ended_at: Optional[str] = None
    created_at: Optional[str] = None

    # メタデータ
    raw_data: Dict[str, Any] = field(default_factory=dict)
    extracted_at: datetime = field(default_factory=datetime.now)

    # クロール入力の構造化メタデータ。旧event.jsonには存在しないため
    # 任意値として保持し、未指定時は従来の出力を変えない。既存の
    # positional constructor引数を壊さないよう、末尾へ追加している。
    event_urls: List[str] = field(default_factory=list)
    crawl_data_source_urls: List[str] = field(default_factory=list)
    event_sources: List[Dict[str, Any]] = field(default_factory=list)
    crawl_settings: Dict[str, Any] = field(default_factory=dict)
    map_config: Any = None
    source_urls: List[str] = field(default_factory=list)
    source_events: List[Dict[str, Any]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """辞書形式に変換"""
        # dateフィールドの型をチェック
        date_value = None
        if self.date:
            if isinstance(self.date, datetime):
                date_value = self.date.date().isoformat()
            elif isinstance(self.date, str):
                date_value = self.date
            else:
                date_value = str(self.date)
        
        data = {
            'name': self.name,
            'url': self.url,
            'date': date_value,
            'venue': self.venue,
            'organizer': self.organizer,
            'maps': [{'filename': m.filename, 'map_number': m.map_number} for m in self.maps],
            'memo': self.memo,
            'shopping_started_at': self.shopping_started_at,
            'shopping_ended_at': self.shopping_ended_at,
            'created_at': self.created_at or datetime.now().isoformat(),
        }

        # Prefer explicit fields but also accept adapter/raw-data supplied
        # extensions.  This lets a multi-source crawl round-trip metadata even
        # when an adapter constructs Event with the legacy constructor.
        optional_fields = (
            'event_urls', 'crawl_data_source_urls', 'event_sources', 'crawl_settings', 'map_config',
            'source_urls', 'source_events', 'event_url', 'additional_prompt',
            'event_image',
        )
        for key in optional_fields:
            value = getattr(self, key, None)
            if value in (None, [], {}):
                value = self.raw_data.get(key) if isinstance(self.raw_data, dict) else None
            if value not in (None, [], {}):
                data[key] = deepcopy(value)
        return data

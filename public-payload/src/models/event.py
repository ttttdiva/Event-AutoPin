from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime


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
        
        return {
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

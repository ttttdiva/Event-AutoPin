from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime


@dataclass
class CircleImage:
    """サークルカット画像の情報"""
    url: str
    filename: Optional[str] = None
    width: int = 182
    height: int = 256
    
    def __post_init__(self):
        if not self.filename:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.filename = f"circle_{timestamp}.jpg"


@dataclass
class ItemImage:
    """アイテム画像の情報"""
    path: str
    source: str = "unknown"  # "twitter", "web", etc.


@dataclass
class Circle:
    """サークル情報の標準データモデル"""
    # 基本情報
    name: str
    penname: Optional[str] = None
    space: Optional[str] = None
    hall: Optional[str] = None
    
    # 連絡先・リンク
    twitter_url: Optional[str] = None
    website_url: Optional[str] = None
    pixiv_url: Optional[str] = None
    
    # 説明・タグ
    description: Optional[str] = None
    genres: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    
    # 頒布物情報
    items: List[Dict[str, Any]] = field(default_factory=list)
    
    # 画像
    circle_cut: Optional[CircleImage] = None
    item_images: List['ItemImage'] = field(default_factory=list)
    
    # メタデータ
    raw_data: Dict[str, Any] = field(default_factory=dict)
    extracted_at: datetime = field(default_factory=datetime.now)
    
    # 買い物リスト用
    priority_color: int = 5  # 5:低, 11:中, 10:高, 15:最優先
    memo: str = ""
    absence_status: Optional[str] = None  # "欠席" if the circle is absent
    existing_only_status: Optional[str] = None  # "既刊のみ" if the circle only sells existing items
    catalog_status: Optional[str] = None  # "confirmed", "preview", or "no_extractable_items"

    # マップ座標（スマホアプリのピン表示用、0.0〜1.0の正規化座標）
    pin_x: Optional[float] = None
    pin_y: Optional[float] = None
    map_number: Optional[int] = None

    # 購入状態（0=未購入, 1=買えた, 2=買えなかった, 3=見送り）
    checked: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        """辞書形式に変換"""
        return {
            'name': self.name,
            'penname': self.penname,
            'space': self.space,
            'hall': self.hall,
            'twitter_url': self.twitter_url,
            'website_url': self.website_url,
            'pixiv_url': self.pixiv_url,
            'description': self.description,
            'genres': self.genres,
            'tags': self.tags,
            'items': self.items,
            'circle_cut_url': self.circle_cut.url if self.circle_cut else None,
            'circle_cut_filename': self.circle_cut.filename if self.circle_cut else None,
            'item_images': [{'path': img.path, 'source': img.source} for img in self.item_images],
            'priority_color': self.priority_color,
            'memo': self.memo,
            'absence_status': self.absence_status,
            'existing_only_status': self.existing_only_status,
            'catalog_status': self.catalog_status,
            'pin_x': self.pin_x,
            'pin_y': self.pin_y,
            'map_number': self.map_number,
            'checked': self.checked,
        }
    
    def validate(self) -> List[str]:
        """データの検証を行い、エラーのリストを返す"""
        errors = []
        
        if not self.name or not self.name.strip():
            errors.append("サークル名が空です")
        
        if self.space and not self._is_valid_space(self.space):
            errors.append(f"無効なスペース番号形式: {self.space}")
        
        if self.priority_color not in [5, 11, 10, 15]:
            errors.append(f"無効な優先度カラー: {self.priority_color}")
        
        return errors
    
    def _is_valid_space(self, space: str) -> bool:
        """スペース番号の形式を検証"""
        import re
        # 日本式 (あ-01) または 西洋式 (A-01, A01) の両方に対応
        # 範囲形式 (09_10, 09-10, 09,10) もサポート
        patterns = [
            r'^[あ-ん]-?\d+[ab]?$',                    # 日本式
            r'^[A-Z]\d+[ab]?$',                         # 西洋式（ハイフンなし）
            r'^[A-Z]-\d+[ab]?$',                        # 西洋式（ハイフンあり）
            r'^\d+$',                                    # 数字のみ
            r'^\d+[_,\-]\d+$',                           # 範囲形式（09_10, 09-10, 09,10）
            r'^[あ-ん]-?\d+[_,\-]\d+$',                  # 日本式範囲
            r'^[A-Z]-?\d+[_,\-]\d+$',                    # 西洋式範囲
            r'^企業\d+$',                                # 企業スペース
        ]
        return any(re.match(pattern, space, re.IGNORECASE) for pattern in patterns)

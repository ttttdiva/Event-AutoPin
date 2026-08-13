"""
スペース位置座標生成モジュール
マップ画像からスペース番号の座標を自動抽出
"""

from .auto_coordinate_generator import (
    generate_coordinates_from_map,
)
from .json_updater import JSONUpdater
from .ocr_config import UnlimitedOCRConfig

__all__ = [
    'generate_coordinates_from_map',
    'JSONUpdater',
    'UnlimitedOCRConfig',
]

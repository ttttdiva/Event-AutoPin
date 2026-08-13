from pathlib import Path
from typing import Optional, Tuple
import logging
from PIL import Image


class ImageProcessor:
    """画像処理クラス"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)

    def validate_image(self, image_path: Path) -> Optional[Tuple[int, int]]:
        """画像の妥当性を確認し、サイズを返す"""
        try:
            with Image.open(image_path) as img:
                return img.size
        except Exception as e:
            self.logger.error(f"画像検証エラー ({image_path}): {e}")
            return None

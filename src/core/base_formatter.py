from abc import ABC, abstractmethod
from typing import List, Any, Dict
from pathlib import Path
import logging

from ..models import Circle, Event, OutputConfig


class BaseOutputFormatter(ABC):
    """出力フォーマッターの基底クラス"""

    def __init__(self, config: OutputConfig):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)

        # 出力ディレクトリを作成
        Path(config.output_dir).mkdir(parents=True, exist_ok=True)

    @abstractmethod
    def format_data(self, circles: List[Circle], event: Event) -> Any:
        """サークルデータを指定フォーマットに変換"""
        pass

    @abstractmethod
    def save(self, data: Any, filename: str) -> str:
        """データを保存して保存先パスを返す"""
        pass

    def validate_output(self, data: Any) -> List[str]:
        """出力データの検証"""
        return []

    @abstractmethod
    def get_required_columns(self) -> List[str]:
        """必須カラムのリストを返す"""
        pass

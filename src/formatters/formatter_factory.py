import logging

from ..core import BaseOutputFormatter
from ..models import OutputConfig, OutputFormat
from .json_formatter import JSONFormatter


class FormatterFactory:
    """出力フォーマッターのファクトリクラス"""

    @staticmethod
    def create_formatter(output_config: OutputConfig) -> BaseOutputFormatter:
        """設定に基づいてフォーマッターを作成（JSON統一）"""
        logger = logging.getLogger(__name__)
        logger.info("JSONフォーマッターを使用")
        return JSONFormatter(output_config)

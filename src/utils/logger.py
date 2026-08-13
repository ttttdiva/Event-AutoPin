import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional


def setup_logger(
    name: str = "circle_list_generator",
    log_level: str = "INFO",
    log_dir: Optional[str] = None,
    console_output: bool = True
) -> logging.Logger:
    """ロガーをセットアップ"""
    
    logger = logging.getLogger(name)
    
    # 既にハンドラが設定されている場合は、そのまま返す
    # これにより重複したハンドラの追加を防ぐ
    if logger.handlers:
        return logger
    
    logger.setLevel(getattr(logging, log_level.upper()))
    
    # ログの伝播を防ぐ（親ロガーへの伝播を止める）
    # これにより重複したログ出力を防ぐ
    logger.propagate = False
    
    # フォーマッタ
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # コンソールハンドラ
    if console_output:
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)
    
    # ファイルハンドラ
    if log_dir:
        log_path = Path(log_dir)
        log_path.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        file_handler = logging.FileHandler(
            log_path / f"{name}_{timestamp}.log",
            encoding='utf-8'
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    
    return logger


class ProgressLogger:
    """進捗ログ用のヘルパークラス"""
    
    def __init__(self, logger: logging.Logger, total: int, prefix: str = ""):
        self.logger = logger
        self.total = total
        self.current = 0
        self.prefix = prefix
    
    def update(self, increment: int = 1, message: str = ""):
        """進捗を更新"""
        self.current += increment
        percentage = (self.current / self.total * 100) if self.total > 0 else 0

        # PROGRESS: プレフィックスでGUIがパース可能な形式で出力
        item_info = f" - {message}" if message else ""
        self.logger.info(f"PROGRESS: {self.current}/{self.total} ({percentage:.0f}%){item_info}")
    
    def complete(self, message: str = "完了"):
        """完了をログ"""
        self.logger.info(f"{self.prefix}{message}: {self.current}/{self.total} 件")
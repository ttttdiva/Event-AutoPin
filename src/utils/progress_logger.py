"""
プログレス表示ユーティリティ
"""

import sys
from datetime import datetime
from typing import Optional

from .logger import setup_logger

logger = setup_logger(__name__)


class ProgressLogger:
    """進捗状況を表示するユーティリティ"""
    
    def __init__(self):
        self.current_task = None
        self.total_items = 0
        self.processed_items = 0
        self.start_time = None
        self.last_update_time = None
    
    def start_task(self, task_name: str, total_items: int):
        """
        タスクを開始
        
        Args:
            task_name: タスク名
            total_items: 処理するアイテムの総数
        """
        self.current_task = task_name
        self.total_items = total_items
        self.processed_items = 0
        self.start_time = datetime.now()
        self.last_update_time = datetime.now()
        
        logger.info(f"Starting {task_name} - Total items: {total_items}")
        self._print_progress()
    
    def update_progress(self, item_name: Optional[str] = None):
        """
        進捗を更新
        
        Args:
            item_name: 現在処理中のアイテム名
        """
        self.processed_items += 1
        current_time = datetime.now()
        
        # 1秒ごとまたは最後のアイテムの場合に表示を更新
        if (current_time - self.last_update_time).total_seconds() >= 1 or self.processed_items == self.total_items:
            self._print_progress(item_name)
            self.last_update_time = current_time
    
    def end_task(self):
        """タスクを終了"""
        if self.start_time:
            duration = (datetime.now() - self.start_time).total_seconds()
            logger.info(f"Completed {self.current_task} - Duration: {duration:.1f}s")
        
        # 改行を出力して進捗表示をクリア
        print()
        
        self.current_task = None
        self.total_items = 0
        self.processed_items = 0
        self.start_time = None
    
    def _print_progress(self, current_item: Optional[str] = None):
        """進捗を表示"""
        if self.total_items == 0:
            return

        percentage = (self.processed_items / self.total_items) * 100

        # 経過時間と推定残り時間
        if self.start_time and self.processed_items > 0:
            elapsed = (datetime.now() - self.start_time).total_seconds()
            avg_time = elapsed / self.processed_items
            remaining = avg_time * (self.total_items - self.processed_items)
            time_info = f" 経過{elapsed:.0f}秒 残り約{remaining:.0f}秒"
        else:
            time_info = ""

        # 現在のアイテム情報
        item_info = f" - {current_item}" if current_item else ""

        # PROGRESS: プレフィックスでGUIがパース可能な形式で出力
        logger.info(f"PROGRESS: {self.processed_items}/{self.total_items} ({percentage:.0f}%){time_info}{item_info}")
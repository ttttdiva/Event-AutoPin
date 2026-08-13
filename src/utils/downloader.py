import requests
from pathlib import Path
from typing import Optional, Dict, List, Tuple
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import time


class Downloader:
    """ファイルダウンロードクラス（Session対応）"""

    def __init__(
        self,
        headers: Optional[Dict[str, str]] = None,
        timeout: int = 30,
        retry_count: int = 3,
        max_workers: int = 5,
        cookies: Optional["requests.cookies.RequestsCookieJar"] = None,
    ):
        self.headers = headers or {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        self.timeout = timeout
        self.retry_count = retry_count
        self.max_workers = max_workers
        self.logger = logging.getLogger(__name__)

        # Session管理（Cookie永続化）
        self.session = requests.Session()
        self.session.headers.update(self.headers)
        if cookies:
            self.session.cookies = cookies

    def download_file(self, url: str, output_path: Path, description: str = "") -> bool:
        """単一ファイルをダウンロード"""
        for attempt in range(self.retry_count):
            try:
                response = self.session.get(
                    url, headers=self.headers, timeout=self.timeout, stream=True
                )
                response.raise_for_status()

                # ファイルを保存
                with open(output_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)

                self.logger.info(f"ダウンロード完了: {description or output_path.name}")
                return True

            except requests.exceptions.RequestException as e:
                self.logger.warning(
                    f"ダウンロードエラー (試行 {attempt + 1}/{self.retry_count}): "
                    f"{description or url} - {e}"
                )

                if attempt < self.retry_count - 1:
                    time.sleep(2**attempt)  # 指数バックオフ

        return False

    def download_multiple(
        self, download_tasks: List[Tuple[str, Path, str]]
    ) -> Dict[str, bool]:
        """複数ファイルを並行ダウンロード

        Args:
            download_tasks: (url, output_path, description) のリスト

        Returns:
            {url: success} の辞書
        """
        results = {}

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # タスクを投入
            future_to_url = {
                executor.submit(self.download_file, url, output_path, description): url
                for url, output_path, description in download_tasks
            }

            # 結果を収集
            for future in as_completed(future_to_url):
                url = future_to_url[future]
                try:
                    success = future.result()
                    results[url] = success
                except Exception as e:
                    self.logger.error(f"ダウンロード処理エラー ({url}): {e}")
                    results[url] = False

        # サマリーログ
        success_count = sum(1 for success in results.values() if success)
        self.logger.info(
            f"ダウンロード完了: {success_count}/{len(results)} ファイル成功"
        )

        return results

    def fetch_content(self, url: str) -> Optional[str]:
        """テキストコンテンツを取得"""
        for attempt in range(self.retry_count):
            try:
                response = self.session.get(
                    url, headers=self.headers, timeout=self.timeout
                )
                response.raise_for_status()
                response.encoding = response.apparent_encoding

                return response.text

            except requests.exceptions.RequestException as e:
                self.logger.warning(
                    f"コンテンツ取得エラー (試行 {attempt + 1}/{self.retry_count}): "
                    f"{url} - {e}"
                )

                if attempt < self.retry_count - 1:
                    time.sleep(2**attempt)

        return None

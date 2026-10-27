import requests
from pathlib import Path
from typing import Optional, Dict, List, Tuple
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import os


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

    def download_file_limited(
        self,
        url: str,
        output_path: Path,
        *,
        max_bytes: int,
        timeout_seconds: float,
        max_total_seconds: Optional[float] = None,
    ) -> tuple[bool, str]:
        """Download one untrusted image with byte and elapsed-time bounds.

        This method intentionally does not include the URL or exception text
        in its result/logs because image URLs can contain signed credentials.
        """

        if max_bytes <= 0 or timeout_seconds <= 0:
            return False, "invalid_limits"

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = output_path.with_name(output_path.name + ".part")
        response = None
        started = time.monotonic()
        total_timeout = max_total_seconds or timeout_seconds
        connect_read_timeout = min(5.0, float(timeout_seconds))
        try:
            response = self.session.get(
                url,
                headers=self.headers,
                timeout=(connect_read_timeout, connect_read_timeout),
                stream=True,
            )
            response.raise_for_status()
            declared_size = response.headers.get("Content-Length")
            try:
                if declared_size is not None and int(declared_size) > max_bytes:
                    return False, "image_size_limit"
            except (TypeError, ValueError):
                pass

            downloaded = 0
            with open(partial_path, "wb") as stream:
                for chunk in response.iter_content(chunk_size=8192):
                    if time.monotonic() - started > total_timeout:
                        return False, "download_timeout"
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        return False, "image_size_limit"
                    stream.write(chunk)

            if time.monotonic() - started > total_timeout:
                return False, "download_timeout"
            if downloaded == 0:
                return False, "empty_image"
            os.replace(partial_path, output_path)
            return True, "downloaded"
        except requests.exceptions.Timeout:
            return False, "download_timeout"
        except requests.exceptions.RequestException:
            return False, "download_failed"
        except OSError:
            return False, "local_write_failed"
        except Exception:
            return False, "download_failed"
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            try:
                if partial_path.exists():
                    partial_path.unlink()
            except OSError:
                pass

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

"""
Netscape HTTP Cookie Format のCookieファイルを読み込み、
requests.Session に設定する。

cookies/{domain}_cookies.txt を自動検出するか、
明示的なファイルパスを指定できる。
"""

import http.cookiejar
import logging
import tempfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

# プロジェクトルートの cookies/ ディレクトリ
_COOKIES_DIR = Path(__file__).parent.parent.parent / "cookies"


def _find_cookie_file(url: str) -> Optional[Path]:
    """URLのドメインからCookieファイルを自動検出"""
    domain = urlparse(url).hostname
    if not domain:
        return None

    candidates = [
        _COOKIES_DIR / f"{domain}_cookies.txt",
        _COOKIES_DIR / f"{domain}.txt",
    ]
    # サブドメインを除去して探す (www.example.com → example.com)
    parts = domain.split(".")
    if len(parts) > 2:
        base_domain = ".".join(parts[-2:])
        candidates.append(_COOKIES_DIR / f"{base_domain}_cookies.txt")
        candidates.append(_COOKIES_DIR / f"{base_domain}.txt")

    for path in candidates:
        if path.exists() and path.stat().st_size > 0:
            logger.info(f"Cookieファイルを検出: {path}")
            return path

    return None


def load_cookies_for_url(
    url: str,
    cookie_file: Optional[str] = None,
    project_root: Optional[Path] = None,
) -> Optional[requests.cookies.RequestsCookieJar]:
    """
    URLに対応するCookieを読み込む。

    Args:
        url: 対象URL（ドメイン自動検出用）
        cookie_file: 明示的なCookieファイルパス（優先）
        project_root: プロジェクトルート（相対パス解決用）

    Returns:
        RequestsCookieJar（Cookieなしの場合はNone）
    """
    cookie_path = None

    # 明示的指定を優先
    if cookie_file:
        p = Path(cookie_file)
        if not p.is_absolute() and project_root:
            p = project_root / p
        if p.exists():
            cookie_path = p
        else:
            logger.warning(f"指定されたCookieファイルが見つかりません: {p}")

    # 自動検出
    if cookie_path is None:
        cookie_path = _find_cookie_file(url)

    if cookie_path is None:
        return None

    return _load_netscape_cookies(cookie_path)


def _load_netscape_cookies(path: Path) -> Optional[requests.cookies.RequestsCookieJar]:
    """Netscape形式のCookieファイルを読み込む"""
    try:
        content = path.read_text(encoding="utf-8", errors="replace")

        # マジックラインがなければ補完
        if not content.startswith("# Netscape HTTP Cookie File"):
            content = "# Netscape HTTP Cookie File\n" + content

        # 空行のみ（Cookieデータなし）のチェック
        data_lines = [
            l for l in content.strip().splitlines() if l and not l.startswith("#")
        ]
        if not data_lines:
            logger.warning(f"Cookieファイルにデータがありません: {path}")
            return None

        # MozillaCookieJar はファイルから読む必要があるので一時ファイルを使う
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        jar = http.cookiejar.MozillaCookieJar(tmp_path)
        jar.load(ignore_discard=True, ignore_expires=True)

        # 一時ファイル削除
        Path(tmp_path).unlink(missing_ok=True)

        # requests互換のCookieJarに変換
        req_jar = requests.cookies.RequestsCookieJar()
        for cookie in jar:
            req_jar.set_cookie(cookie)

        logger.info(f"Cookieを読み込みました: {path.name} ({len(req_jar)} cookies)")
        return req_jar

    except Exception as e:
        logger.error(f"Cookie読み込みエラー: {path} - {e}")
        return None

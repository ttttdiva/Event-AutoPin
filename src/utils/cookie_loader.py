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
COOKIE_MAX_BYTES = 2 * 1024 * 1024

_COOKIE_ERROR_MESSAGES = {
    "missing": "Cookieファイルが見つかりません。",
    "directory": "Cookieファイルにフォルダは指定できません。",
    "unsupported": "CookieファイルはNetscape形式の.txtのみ対応しています。",
    "empty_or_invalid": "CookieファイルはNetscape形式で1件以上のCookieが必要です。",
    "too_large": "Cookieファイルは最大2MBまでです。",
    "unreadable": "Cookieファイルを読み取れません。",
}


class CookieFileValidationError(ValueError):
    """明示されたCookieファイルを安全に利用できない場合のエラー。"""

    def __init__(self, code: str = "empty_or_invalid"):
        self.code = code
        super().__init__(
            _COOKIE_ERROR_MESSAGES.get(code, _COOKIE_ERROR_MESSAGES["empty_or_invalid"])
        )


def _safe_cookie_basename(path: Path) -> str:
    """ログへ出すCookie名をbasenameかつ制御文字なしに制限する。"""
    name = path.name
    safe = "".join(ch for ch in name if ord(ch) >= 0x20 and ord(ch) != 0x7F)
    return safe[:128] or "選択済みCookieファイル"


def validate_cookie_file_path(
    cookie_file: str,
    project_root: Optional[Path] = None,
) -> Path:
    """明示Cookieパスを検証し、実行時に使う絶対パスを返す。

    ファイル種別・存在・サイズ・読み取り可能性に加えて、Netscape形式を実parseする。
    エラーにはCookie本文・pathを含めない。
    """
    if not isinstance(cookie_file, str) or not cookie_file.strip():
        raise CookieFileValidationError("empty_or_invalid")

    try:
        path = Path(cookie_file.strip()).expanduser()
        if not path.is_absolute() and project_root is not None:
            path = Path(project_root) / path
        resolved = path.resolve(strict=False)
        try:
            stat_result = resolved.stat()
        except FileNotFoundError as exc:
            raise CookieFileValidationError("missing") from exc
        except PermissionError as exc:
            raise CookieFileValidationError("unreadable") from exc
        if resolved.is_dir():
            raise CookieFileValidationError("directory")
        if not resolved.is_file():
            raise CookieFileValidationError("unreadable")
        if resolved.suffix.lower() != ".txt":
            raise CookieFileValidationError("unsupported")
        if stat_result.st_size <= 0:
            raise CookieFileValidationError("empty_or_invalid")
        if stat_result.st_size > COOKIE_MAX_BYTES:
            raise CookieFileValidationError("too_large")
        try:
            with resolved.open("rb") as handle:
                content = handle.read(COOKIE_MAX_BYTES + 1)
        except (OSError, ValueError) as exc:
            raise CookieFileValidationError("unreadable") from exc
        if len(content) > COOKIE_MAX_BYTES:
            raise CookieFileValidationError("too_large")
        try:
            jar = _parse_netscape_cookie_content(content)
        except CookieFileValidationError:
            raise
        except Exception as exc:
            raise CookieFileValidationError("empty_or_invalid") from exc
        if jar is None or len(jar) == 0:
            raise CookieFileValidationError("empty_or_invalid")
    except CookieFileValidationError:
        raise
    except (OSError, ValueError, RuntimeError) as exc:
        raise CookieFileValidationError("unreadable") from exc

    return resolved


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
        try:
            if path.is_file() and path.stat().st_size > 0:
                logger.info("Cookieファイルを自動検出しました")
                return path
        except OSError:
            continue

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
        # 明示pathが無効な場合は自動検出へfallbackしない。選択された
        # Cookieと別の認証情報を意図せず使わないため、呼び出し元へ返す。
        cookie_path = validate_cookie_file_path(cookie_file, project_root)

    # 自動検出
    if cookie_path is None:
        cookie_path = _find_cookie_file(url)

    if cookie_path is None:
        return None

    loaded = _load_netscape_cookies(cookie_path)
    # 明示されたpathは、初回検証後のrace（置換・切断・権限変更など）でも
    # 無認証のまま処理を続けたり、自動検出へ切り替えたりしない。
    if cookie_file and (loaded is None or len(loaded) == 0):
        raise CookieFileValidationError("empty_or_invalid")
    return loaded


def _load_netscape_cookies(path: Path) -> Optional[requests.cookies.RequestsCookieJar]:
    """Netscape形式のCookieファイルを読み込む"""
    try:
        with path.open("rb") as handle:
            raw_content = handle.read(COOKIE_MAX_BYTES + 1)
        req_jar = _parse_netscape_cookie_content(raw_content)
        if req_jar is None or len(req_jar) == 0:
            logger.warning("Cookieファイルにデータがありません")
            return None
        logger.info(
            f"Cookieを読み込みました: {_safe_cookie_basename(path)} ({len(req_jar)} cookies)"
        )
        return req_jar
    except Exception:
        logger.error("Cookie読み込みエラー")
        return None


def _parse_netscape_cookie_content(
    raw_content: bytes,
) -> Optional[requests.cookies.RequestsCookieJar]:
    """Netscape構造を確認してMozillaCookieJarで実parseする。"""
    if not raw_content or len(raw_content) > COOKIE_MAX_BYTES:
        raise CookieFileValidationError(
            "too_large" if len(raw_content) > COOKIE_MAX_BYTES else "empty_or_invalid"
        )
    try:
        content = raw_content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CookieFileValidationError("empty_or_invalid") from exc

    if not content.startswith("# Netscape HTTP Cookie File"):
        content = "# Netscape HTTP Cookie File\n" + content

    cookie_rows = 0
    for raw_line in content.splitlines():
        line = raw_line.rstrip("\r")
        if not line.strip():
            continue
        trimmed_start = line.lstrip()
        if line.startswith("#HttpOnly_"):
            candidate = line[len("#HttpOnly_") :]
        elif trimmed_start.startswith("#") or trimmed_start.startswith("$"):
            continue
        else:
            candidate = line
        fields = candidate.split("\t")
        if len(fields) != 7:
            raise CookieFileValidationError("empty_or_invalid")
        domain = fields[0].strip()
        if not domain or domain != fields[0] or any(ch.isspace() for ch in domain):
            raise CookieFileValidationError("empty_or_invalid")
        if fields[1] not in {"TRUE", "FALSE"}:
            raise CookieFileValidationError("empty_or_invalid")
        if (fields[1] == "TRUE") != domain.startswith("."):
            raise CookieFileValidationError("empty_or_invalid")
        if not fields[2].startswith("/"):
            raise CookieFileValidationError("empty_or_invalid")
        if fields[3] not in {"TRUE", "FALSE"}:
            raise CookieFileValidationError("empty_or_invalid")
        # MozillaCookieJar uses an empty expiry for a session cookie and
        # accepts an empty cookie name. Preserve that established loader
        # compatibility while still rejecting non-numeric non-empty expiry.
        if fields[4]:
            try:
                int(fields[4])
            except ValueError as exc:
                raise CookieFileValidationError("empty_or_invalid") from exc
        cookie_rows += 1
    if cookie_rows == 0:
        raise CookieFileValidationError("empty_or_invalid")

    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            prefix="event-autopin-cookie-",
            delete=False,
            encoding="utf-8",
        ) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)

        jar = http.cookiejar.MozillaCookieJar(str(tmp_path))
        jar.load(ignore_discard=True, ignore_expires=True)
        req_jar = requests.cookies.RequestsCookieJar()
        for cookie in jar:
            req_jar.set_cookie(cookie)
        if len(req_jar) == 0:
            raise CookieFileValidationError("empty_or_invalid")
        return req_jar
    except CookieFileValidationError:
        raise
    except Exception as exc:
        raise CookieFileValidationError("empty_or_invalid") from exc
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass

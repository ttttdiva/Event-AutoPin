"""iframeで埋め込まれたサークル一覧の取り込み。

イベント公式サイトの多くは、一覧そのものを別ホストのiframeで埋め込む
（例: Sockbaseの `/embed` ウィジェット）。静的HTMLを読むだけではiframeの
中身が見えず、周囲の数行だけを全件と誤認するため、一覧らしいiframeを取得し
元のHTMLへ展開してからアダプターに渡す。
"""

from __future__ import annotations

import logging
import re
from typing import Callable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

logger = logging.getLogger("circle_list_generator")

# 一覧ではない埋め込み（動画・SNSウィジェット・地図・フォーム等）のホスト
_NON_LIST_HOST_SUFFIXES = (
    "youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
    "vimeo.com",
    "nicovideo.jp",
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "twitch.tv",
    "spotify.com",
    "soundcloud.com",
    "bandcamp.com",
    "line.me",
    "disqus.com",
    "recaptcha.net",
    "forms.gle",
    "forms.office.com",
    "typeform.com",
    "googletagmanager.com",
    "doubleclick.net",
    "openstreetmap.org",
)

_SOCKBASE_EMBED_RE = re.compile(
    r"^(https?://list\.sockbase\.net/circle-lists/[^/?#]+)/embed/?(?:[?#].*)?$",
    re.I,
)

MAX_FRAMES = 6


def _canonical_frame_url(url: str) -> str:
    """埋め込み用URLを、画像URLなど情報が多い通常ページのURLへ読み替える。

    Sockbaseの `/embed` はサークルカットURLを含まないが、通常の一覧ページには含まれる。
    """

    match = _SOCKBASE_EMBED_RE.match(url)
    if match:
        return match.group(1) + "/"
    return url


def _is_list_candidate(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    for suffix in _NON_LIST_HOST_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            return False
    if host in {"google.com", "www.google.com", "maps.google.com"} and "/maps" in parsed.path:
        return False
    if host == "docs.google.com" and "/forms" in parsed.path:
        return False
    return True


def find_list_frames(html: str, base_url: str) -> List[str]:
    """HTML内の一覧らしいiframeの絶対URLを出現順・重複なしで返す。"""

    if not html or "<iframe" not in html.lower():
        return []
    urls: List[str] = []
    soup = BeautifulSoup(html, "html.parser")
    for frame in soup.find_all("iframe"):
        src = (frame.get("src") or frame.get("data-src") or "").strip()
        if not src or src.startswith(("about:", "javascript:", "data:")):
            continue
        absolute = urljoin(base_url, src)
        if not _is_list_candidate(absolute):
            continue
        canonical = _canonical_frame_url(absolute)
        if canonical not in urls:
            urls.append(canonical)
        if len(urls) >= MAX_FRAMES:
            break
    return urls


def _body_markup(frame_html: str) -> str:
    match = re.search(r"<body[^>]*>(.*)</body>", frame_html, re.S | re.I)
    return match.group(1) if match else frame_html


def inline_frames(
    html: str,
    base_url: str,
    fetch: Callable[[str], Optional[str]],
    frame_urls: Optional[List[str]] = None,
) -> Tuple[str, List[str]]:
    """一覧らしいiframeを取得し、元のHTML末尾へ展開して返す。

    戻り値は (展開後HTML, 展開できたフレームURL一覧)。取得できないフレームは
    読み飛ばし、元のHTMLはそのまま保つ。iframeタグ自体は残す。
    """

    urls = frame_urls if frame_urls is not None else find_list_frames(html, base_url)
    if not urls:
        return html, []
    inlined: List[str] = []
    parts: List[str] = []
    for url in urls:
        try:
            frame_html = fetch(url)
        except Exception as exc:  # 取得失敗は致命ではない
            logger.warning(f"iframeの取得に失敗: {url} - {exc}")
            continue
        if not frame_html:
            logger.warning(f"iframeの中身が空です: {url}")
            continue
        parts.append(
            f'<div data-inlined-frame="{url}">{_body_markup(frame_html)}</div>'
        )
        inlined.append(url)
    if not parts:
        return html, []
    logger.info(f"iframeを {len(inlined)} 件展開: {inlined}")
    merged = html
    if re.search(r"</body\s*>", merged, re.I):
        merged = re.sub(
            r"</body\s*>",
            lambda m: "".join(parts) + m.group(0),
            merged,
            count=1,
            flags=re.I,
        )
    else:
        merged = merged + "".join(parts)
    return merged, inlined

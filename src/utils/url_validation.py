"""外部プロフィールURLの検証・正規化。"""

import re
from typing import Optional
from urllib.parse import urlparse


_TWITTER_PROFILE_RE = re.compile(r"^/?@?([A-Za-z0-9_]{1,15})/?$")
_RESERVED_TWITTER_PATHS = {
    "home",
    "explore",
    "i",
    "intent",
    "messages",
    "notifications",
    "search",
    "settings",
    "share",
}


def normalize_twitter_profile_url(value: object) -> Optional[str]:
    """X/TwitterのユーザープロフィールURLだけを正規化して返す。"""
    if not isinstance(value, str):
        return None

    raw = value.strip()
    if not raw:
        return None

    try:
        parsed = urlparse(raw)
    except ValueError:
        return None

    if parsed.scheme.lower() not in {"http", "https"}:
        return None
    if parsed.netloc.lower().split(":", 1)[0] not in {
        "x.com",
        "www.x.com",
        "twitter.com",
        "www.twitter.com",
    }:
        return None
    match = _TWITTER_PROFILE_RE.fullmatch(parsed.path)
    if not match:
        return None

    username = match.group(1)
    if username.lower() in _RESERVED_TWITTER_PATHS:
        return None
    return f"https://x.com/{username}"

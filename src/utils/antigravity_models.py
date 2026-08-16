"""Antigravity CLI model catalog helpers."""

from __future__ import annotations

import logging
import re
import subprocess
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

from .cli_llm import _resolve_antigravity_bin

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


def parse_agy_models_text(text: str) -> List[Tuple[str, str]]:
    models: List[Tuple[str, str]] = []
    seen = set()
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("Fetching"):
            continue
        if "\t" in line:
            slug, label = line.split("\t", 1)
        elif "  " in line:
            parts = re.split(r"\s{2,}", line, maxsplit=1)
            if len(parts) != 2:
                continue
            slug, label = parts
        else:
            continue
        slug = slug.strip()
        label = label.strip()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        models.append((slug, label or slug))
    return models


def fetch_antigravity_models(timeout: int = 60) -> Tuple[List[Tuple[str, str]], str]:
    bin_path = _resolve_antigravity_bin()
    try:
        result = subprocess.run(
            [bin_path, "models"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("agy models の取得に失敗: %s", exc)
        return [], "fetch-failed"

    if result.returncode != 0:
        logger.warning(
            "agy models が非ゼロ終了: rc=%s stderr=%s",
            result.returncode,
            (result.stderr or "").strip()[:200],
        )
        return [], "fetch-failed"

    parsed = parse_agy_models_text(result.stdout)
    if not parsed:
        return [], "fetch-failed"
    return parsed, "cli-live"


@lru_cache(maxsize=1)
def antigravity_model_maps() -> Dict[str, Dict[str, str]]:
    models, _source = fetch_antigravity_models()
    slug_to_label = {slug: label for slug, label in models}
    label_to_slug = {label: slug for slug, label in models}
    return {
        "slug_to_label": slug_to_label,
        "label_to_slug": label_to_slug,
    }


def resolve_antigravity_model(model: Optional[str]) -> Optional[str]:
    value = str(model or "").strip()
    if not value or value.lower() == "default":
        return value or None
    if _SLUG_RE.match(value):
        return value
    maps = antigravity_model_maps()
    resolved = maps["label_to_slug"].get(value)
    if resolved:
        return resolved
    normalized = re.sub(r"\s+", " ", value.strip().lower())
    for label, slug in maps["label_to_slug"].items():
        if re.sub(r"\s+", " ", label.strip().lower()) == normalized:
            return slug
    return value

"""投稿単位の同時解析を通常クロール・URL指定再処理に共用する。"""

import asyncio
import copy
import hashlib
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from ..models import ItemImage
from ..utils.reprocess_deadline import ReprocessDeadlineExceeded
from ..utils.reprocess_trace import trace_stage

logger = logging.getLogger(__name__)
_FIELDS = ("items", "item_images", "catalog_status", "existing_only_status", "_detected_genre", "_product_types")


def enabled(processor: Any) -> bool:
    return (getattr(processor, "catalog_post_analyzer", None) is not None
            and not getattr(processor.config, "skip_catalog_image_analysis", False))


def _check(deadline: Any) -> None:
    if deadline is not None:
        deadline.require_time(stage="catalog.joint")


def _snapshot(circle: Any) -> Dict[str, Any]:
    return {key: copy.deepcopy(getattr(circle, key, None)) for key in _FIELDS}


def _apply(processor: Any, circle: Any, state: Dict[str, Any], post_url: str) -> None:
    # 最新の購買状態は解析結果や他サークルのキャッシュで上書きしない。
    checked = {processor._catalog_item_key(item): item.get("checked") for item in circle.items}
    for key, value in copy.deepcopy(state).items():
        if key == "items":
            for item in value:
                previous = checked.get(processor._catalog_item_key(item))
                item["checked"] = previous if previous is not None else 3
        setattr(circle, key, value)
    if post_url and post_url not in (circle.memo or ""):
        circle.memo = (circle.memo + "\n" if circle.memo else "") + post_url


async def process_post(processor: Any, circle: Any, post_text: str, media_urls: List[str],
                       event_name: str, event_date: str = "", post_url: str = "",
                       deadline: Any = None, run_id: Optional[str] = None,
                       trace: Any = None) -> Optional[str]:
    """全画像の取得・検証が成功するまでCircleを書き換えない。

    戻り値はconfirmed/preview。明示的な対象外はNone、取得・解析失敗は例外。
    途中の1枚だけで成功にしない。解析executorはCircleや永続ファイルに触れない。
    """
    from .twitter_post_processor import (
        _await_with_optional_deadline, _run_in_executor_with_optional_deadline,
    )

    _check(deadline)
    urls = list(dict.fromkeys(media_urls))
    if any(not isinstance(url, str) or not url for url in urls):
        raise ValueError("投稿のメディアURLが不正です")
    with tempfile.TemporaryDirectory(prefix=".catalog_joint_", dir=processor.output_path) as directory:
        paths = []
        names = []
        for url in urls:
            _check(deadline)
            suffix = Path(urlsplit(url).path).suffix.lower()
            if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
                suffix = ".jpg"
            name = "catalog_" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24] + suffix
            with trace_stage(run_id, "media.download", trace):
                downloaded = await _await_with_optional_deadline(
                    processor.twitter_extractor.download_catalog_image(url, Path(directory), name),
                    deadline, stage="media.download",
                )
            _check(deadline)
            if not downloaded or not Path(downloaded).is_file():
                raise RuntimeError("投稿の全画像を取得できないため、同時解析を中止します")
            # downloaderの戻り値を信用して既存画像を移動・削除しない。
            path = Path(downloaded).resolve()
            if path.parent != Path(directory).resolve():
                raise RuntimeError("画像の取得先が一時ディレクトリ外です")
            paths.append(path)
            # 同じURLの画像が後日更新されても、既存画像を上書きしない。
            names.append("catalog_" + hashlib.sha256(path.read_bytes()).hexdigest()[:24] + suffix)

        with trace_stage(run_id, "catalog.joint", trace):
            analysis = await _run_in_executor_with_optional_deadline(
                asyncio.get_running_loop(), processor.catalog_post_analyzer.analyze,
                paths, post_text, event_name=event_name,
                event_date=str(event_date or getattr(processor.config, "event_date", "") or ""),
                additional_prompt=getattr(processor, "effective_additional_prompt", ""),
                deadline=deadline, budget=deadline, stage="catalog.joint",
            )
        _check(deadline)
        status = analysis["classification"]
        if status == "not_catalog":
            return None
        if status == "preview":
            # 予告は既存の確定商品を消さない。通常クロールでは他候補の確定版を先に探す。
            circle.catalog_status = "preview"
            if post_url and post_url not in (circle.memo or ""):
                circle.memo = (circle.memo + "\n" if circle.memo else "") + post_url
            return status

        items = copy.deepcopy(analysis["items"])
        for item in items:
            evidence = item["catalog_evidence"]
            refs = evidence["image_indices"]
            evidence.update(source_url=post_url, model=analysis["model"],
                            image_paths=[names[i - 1] for i in refs])
            if refs:
                item["image"] = names[refs[0] - 1]
        indices = analysis["catalog_image_indices"]
        state = {"items": items,
                 "item_images": [ItemImage(path=name, source="twitter") for name in dict.fromkeys(names[i - 1] for i in indices)],
                 "catalog_status": "confirmed" if items else "no_extractable_items",
                 "existing_only_status": "既刊のみ" if analysis["is_existing_only"] else None,
                 "_detected_genre": processor._infer_genre_from_items(items),
                 "_product_types": list(dict.fromkeys(item["type"] for item in items if item["type"]))}
        # 全応答を検証した後で画像を公開する。非採用画像と一時ファイルは自動破棄される。
        for i in indices:
            _check(deadline)
            os.replace(paths[i - 1], processor.output_path / names[i - 1])
        _check(deadline)
        _apply(processor, circle, state, post_url)
        logger.info("本文と%d枚の画像から%d件の商品を同時解析しました (%s)", len(paths), len(items), analysis["model"])
        return status


async def process_candidates(processor: Any, circle: Any, candidates: List[Dict[str, Any]],
                             best: Dict[str, Any], event_name: str, event_date: Any) -> Any:
    """投稿の本文と画像の対応を崩さず、予告より確定版を優先する。"""
    fallback = None
    last_error = None
    for tweet in [best] + [tweet for tweet in candidates if tweet is not best]:
        staged = copy.copy(circle)
        try:
            status = await process_post(processor, staged, tweet.get("text", ""), tweet.get("media", []) or [],
                                        event_name, str(event_date or ""), tweet.get("url", ""))
        except ReprocessDeadlineExceeded:
            raise
        except Exception as exc:
            last_error = exc
            logger.warning("候補投稿の同時解析に失敗しました。別候補を確認します: %s", type(exc).__name__)
            continue
        if status == "confirmed" and staged.items:
            _apply(processor, circle, _snapshot(staged), tweet.get("url", ""))
            return circle
        if status and (fallback is None or status == "confirmed"):
            fallback = (status, _snapshot(staged), tweet.get("url", ""))
    # 取得・解析エラーを「商品なし」や「予告」の成功で隠さない。
    if last_error is not None:
        raise last_error
    if fallback:
        status, state, url = fallback
        if status == "preview":
            state = {"catalog_status": "preview"}
        _apply(processor, circle, state, url)
    return circle


async def process_direct_post(processor: Any, circle: Any, tweet_id: str, post_url: str,
                              event_name: str, deadline: Any = None,
                              run_id: Optional[str] = None, trace: Any = None) -> bool:
    from .twitter_post_processor import _call_with_optional_deadline

    _check(deadline)
    key = (tweet_id, event_name, str(getattr(processor.config, "event_date", "")),
           getattr(processor, "effective_additional_prompt", ""))
    cache = getattr(processor, "_joint_post_cache", None)
    if cache is None:
        cache = processor._joint_post_cache = {}
    if key in cache:
        _check(deadline)
        _apply(processor, circle, cache[key], post_url)
        return True
    tweet = await _call_with_optional_deadline(processor._fetch_tweet_detail, tweet_id,
                                               deadline=deadline, run_id=run_id, trace=trace)
    _check(deadline)
    if not tweet or not (tweet.get("text") or tweet.get("media_urls")):
        return False
    staged = copy.copy(circle)
    status = await process_post(processor, staged, tweet.get("text", ""), tweet.get("media_urls", []) or [],
                                event_name, post_url=post_url, deadline=deadline, run_id=run_id, trace=trace)
    _check(deadline)
    if status is None:
        return False
    state = _snapshot(staged) if status == "confirmed" else {"catalog_status": "preview"}
    _check(deadline)
    cache[key] = copy.deepcopy(state)
    _apply(processor, circle, state, post_url)
    return True

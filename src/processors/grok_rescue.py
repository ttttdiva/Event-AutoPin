"""twscrape後もお品書きが空のサークルを、Grok Build(web検索)で再探索する段。

流れ:
 1. 空のサークル(twitter_urlあり)のハンドルを12件ずつGrokへ問い合わせる(逐次)。
 2. 回答のお品書きURLは、投稿の本文と全画像を設定の画像モデルで解析し直して反映する。
    Grokは画像を見ていないため、not_catalog(別イベント/お品書きでない)は反映しない。
 3. 凍結・存在なし・未発見などは自動で x_account_status に記録する(情報の補完はしない)。
Grok Build(grok.exe)が使えない時は、理由を記録して何もせず続行する。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from ..utils.grok_build import GrokBuildError
from ..utils.logger import setup_logger
from ..utils.grok_build_x_search import GrokBuildXSearch, GrokFinding

logger = setup_logger(__name__)

STATUS_LABELS = {
    "account_suspended": "アカウント凍結",
    "account_not_found": "アカウントが存在しない",
    "account_unknown": "アカウントの存在を確認できない",
    "catalog_not_published": "Xでお品書き未公開/未発見",
    "post_not_catalog": "見つかった投稿はこのイベントのお品書きではない",
    "post_fetch_failed": "お品書き投稿の取得・解析に失敗",
}
# 状態が確定し、twscrapeの未解決扱いを外してよいもの(アカウント自体の状態)。
_RESOLVING = {"account_suspended", "account_not_found"}


def _circle_key(circle: Any, taken: Dict[str, Any]) -> str:
    name = str(getattr(circle, "name", "") or "").strip() or "(unnamed)"
    if name in taken and taken[name].get("space") != getattr(circle, "space", ""):
        return f"{name} ({getattr(circle, 'space', '')})"
    return name


def _needs_rediscovery(circle: Any) -> bool:
    return not getattr(circle, "catalog_status", None) and not getattr(circle, "absence_status", None)


def _analysis_model(processor: Any, circle: Any) -> str:
    for item in getattr(circle, "items", None) or []:
        evidence = item.get("catalog_evidence") if isinstance(item, dict) else None
        if isinstance(evidence, dict) and evidence.get("model"):
            return str(evidence["model"])
    config = processor.config
    return f"{config.image_llm_provider}:{config.image_llm_model}"


def _record(processor: Any, circle: Any, status: str, handle: str, finding: Optional[GrokFinding],
            discovery_model: str, now: str, post_url: Optional[str] = None) -> None:
    store: Dict[str, Dict[str, Any]] = processor.x_account_status
    entry: Dict[str, Any] = {
        "status": status,
        "label": STATUS_LABELS.get(status, status),
        "handle": handle,
        "space": getattr(circle, "space", "") or "",
        "checked_at": now,
        "source": "grok-build",
        "discovery_model": discovery_model,
    }
    if finding is not None and finding.note:
        entry["note"] = finding.note
    if post_url:
        entry["post_url"] = post_url
    store[_circle_key(circle, store)] = entry


async def run_grok_rescue(
    processor: Any,
    circles_with_twitter: List[Any],
    results: List[Any],
    event: Any,
    event_date: datetime,
    target_outcomes: List[Dict[str, Any]],
    on_circle_complete: Optional[Callable[[Any], Any]] = None,
    searcher: Optional[GrokBuildXSearch] = None,
) -> Dict[str, Any]:
    """救済段を実行し、summary用のdictを返す。例外は呼び出し元へ出さない。"""
    config = processor.config
    summary: Dict[str, Any] = {
        "status": "skipped",
        "reason": None,
        "discovery_model": None,
        "candidate_count": 0,
        "batches": 0,
        "processed": [],
    }
    if not getattr(config, "use_grok_rescue", True):
        summary["reason"] = "disabled by config (use_grok_rescue=false)"
        return summary

    try:
        while len(results) < len(circles_with_twitter):
            results.append(circles_with_twitter[len(results)])
        candidates: List[int] = []
        for index, circle in enumerate(circles_with_twitter):
            current = results[index] if index < len(results) and hasattr(results[index], "name") else circle
            if _needs_rediscovery(current) and processor._extract_username_from_url(current.twitter_url):
                candidates.append(index)
        summary["candidate_count"] = len(candidates)
        if not candidates:
            summary["status"] = "no_candidates"
            return summary

        searcher = searcher or getattr(processor, "grok_rescue_searcher", None) or GrokBuildXSearch(
            batch_size=getattr(config, "grok_rescue_batch_size", 12),
            timeout=getattr(config, "grok_rescue_timeout", 900.0),
            model=getattr(config, "grok_rescue_model", None),
        )
        available, reason = await asyncio.to_thread(searcher.availability)
        if not available:
            summary["reason"] = f"skipped: {reason}"
            logger.warning("Grok再探索をスキップします: %s", reason)
            return summary

        by_handle: Dict[str, List[int]] = {}
        for index in candidates:
            handle = processor._extract_username_from_url(circles_with_twitter[index].twitter_url)
            by_handle.setdefault(handle, []).append(index)
        handles = list(by_handle)
        summary["status"] = "ran"
        logger.info("Grok再探索: %d件(%dハンドル)を%d件ずつ問い合わせます",
                    len(candidates), len(handles), searcher.batch_size)

        consecutive_failures = 0
        for batch in searcher.batches(handles):
            summary["batches"] += 1
            try:
                reply = await asyncio.to_thread(searcher.ask_batch, batch, event.name, event_date)
                consecutive_failures = 0
            except GrokBuildError as exc:
                # unknown_deliveryは再送しない。以降のバッチも続けるが、連続失敗で打ち切る。
                logger.warning("Grok再探索のバッチが失敗しました(%s)。再送しません", exc.code)
                summary.setdefault("failed_batches", []).append({"handles": list(batch), "code": exc.code})
                consecutive_failures += 1
                if exc.code in {"not_installed", "not_authenticated"} or consecutive_failures >= 2:
                    summary["reason"] = f"stopped: {exc.code}"
                    break
                continue
            except Exception as exc:  # noqa: BLE001 - 救済段は本処理を止めない
                logger.warning("Grok再探索のバッチで想定外のエラー: %s", type(exc).__name__)
                summary.setdefault("failed_batches", []).append(
                    {"handles": list(batch), "code": type(exc).__name__})
                consecutive_failures += 1
                if consecutive_failures >= 2:
                    summary["reason"] = f"stopped: {type(exc).__name__}"
                    break
                continue

            summary["discovery_model"] = reply.model or summary["discovery_model"]
            logger.info("Grok回答(%s, %d/%d件を解釈): %s", reply.model, len(reply.findings),
                        len(batch), reply.text[:3000].replace("\n", " / "))
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            for handle in batch:
                finding = reply.findings.get(handle.lower())
                for index in by_handle[handle]:
                    await _apply_finding(
                        processor, circles_with_twitter, results, index, handle, finding,
                        reply.model, now, event, target_outcomes, summary, on_circle_complete,
                    )
        return summary
    except Exception as exc:  # noqa: BLE001
        logger.warning("Grok再探索で想定外のエラー(続行します): %s", type(exc).__name__)
        summary["status"] = "error"
        summary["reason"] = type(exc).__name__
        return summary


async def _apply_finding(processor, circles_with_twitter, results, index, handle, finding,
                         discovery_model, now, event, target_outcomes, summary, on_circle_complete):
    circle = results[index] if index < len(results) and hasattr(results[index], "name") else circles_with_twitter[index]
    results[index] = circle
    entry: Dict[str, Any] = {"circle": str(circle.name)[:200], "handle": handle,
                             "discovery_model": discovery_model, "analysis_model": None,
                             "outcome": None}
    summary["processed"].append(entry)

    if finding is None:
        entry["outcome"] = "no_answer"
        return
    if finding.suspended:
        status = "account_suspended"
    elif finding.exists == "なし":
        status = "account_not_found"
    elif finding.post_url:
        status = None
    elif finding.exists == "不明":
        status = "account_unknown"
    else:
        status = "catalog_not_published"

    if status is not None:
        _record(processor, circle, status, handle, finding, discovery_model, now)
        entry["outcome"] = status
        if status in _RESOLVING:
            _resolve_unresolved(processor, circle, circles_with_twitter, target_outcomes, index)
        return

    # お品書きURLあり: 投稿の本文と全画像を画像モデルで解析する(Grokの判断は信用しない)。
    before = (circle.catalog_status, len(getattr(circle, "items", None) or []))
    try:
        processed = await processor.process_circle_from_post_url(
            circle, finding.post_url, event.name,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Grokが見つけた投稿の解析に失敗: %s (%s)", circle.name, type(exc).__name__)
        _record(processor, circle, "post_fetch_failed", handle, finding, discovery_model, now,
                finding.post_url)
        entry["outcome"] = "post_fetch_failed"
        entry["post_url"] = finding.post_url
        return
    entry["post_url"] = finding.post_url
    outcome = getattr(processor, "_last_direct_post_outcome", None)
    if processed and circle.catalog_status:
        entry["outcome"] = "adopted"
        entry["analysis_model"] = _analysis_model(processor, circle)
        if finding.post_id:
            ids = set(getattr(circle, "_checked_tweet_ids", None) or [])
            ids.add(int(finding.post_id))
            circle._checked_tweet_ids = sorted(ids)
        processor.x_account_status.pop(_circle_key(circle, {}), None)
        _mark_rescued(processor, circle, circles_with_twitter, target_outcomes, index)
        if on_circle_complete is not None:
            callback_result = on_circle_complete(circle)
            if asyncio.iscoroutine(callback_result):
                await callback_result
        return
    # 反映されなかった: circleは変更しない(not_catalogを尊重)。
    status = "post_fetch_failed" if outcome == "fetch_failed" else "post_not_catalog"
    _record(processor, circle, status, handle, finding, discovery_model, now, finding.post_url)
    entry["outcome"] = status
    if (circle.catalog_status, len(getattr(circle, "items", None) or [])) != before:
        logger.warning("Grok再探索で想定外のサークル更新: %s", circle.name)


def _target_outcome(circles_with_twitter, target_outcomes, index):
    return target_outcomes[index] if index < len(target_outcomes) else None


def _resolve_unresolved(processor, circle, circles_with_twitter, target_outcomes, index) -> None:
    """凍結等でアカウント自体の状態が確定したサークルを、取得失敗(未解決)から外す。"""
    summary = processor.last_run_summary
    name = str(getattr(circle, "name", ""))[:200]
    summary["unresolved_targets"] = [
        item for item in summary.get("unresolved_targets", [])
        if not (isinstance(item, dict) and item.get("circle") == name)
    ]
    circle._twitter_processing_succeeded = True
    circles_with_twitter[index]._twitter_processing_succeeded = True
    outcome = _target_outcome(circles_with_twitter, target_outcomes, index)
    if outcome is not None:
        outcome.update(processing_status="processed", fetch_outcome="no_catalog_found")


def _mark_rescued(processor, circle, circles_with_twitter, target_outcomes, index) -> None:
    summary = processor.last_run_summary
    name = str(getattr(circle, "name", ""))[:200]
    summary["unresolved_targets"] = [
        item for item in summary.get("unresolved_targets", [])
        if not (isinstance(item, dict) and item.get("circle") == name)
    ]
    summary["catalog_found_count"] = summary.get("catalog_found_count", 0) + 1
    circle._twitter_processing_succeeded = True
    circles_with_twitter[index]._twitter_processing_succeeded = True
    outcome = _target_outcome(circles_with_twitter, target_outcomes, index)
    if outcome is not None:
        status = str(getattr(circle, "catalog_status", "") or "none")
        outcome.update(
            processing_status="processed", fetch_outcome="catalog_found",
            catalog_status=status if status in {"confirmed", "preview", "no_extractable_items"} else "none",
            item_count=len(getattr(circle, "items", None) or []),
            item_image_count=len(getattr(circle, "item_images", None) or []),
        )

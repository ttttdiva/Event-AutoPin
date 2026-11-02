"""AoiTalk Grok Bot Chat方式のX検索adapter。

Grok BotはxAI APIモデルではなく、AoiTalkのChat専用Gatewayです。
このアダプタはAoiTalkの ``GrokBotChatService.send_turn`` を別Pythonプロセス
から呼び、owner/chat/turnとoperation_idをそのまま同サービスの冪等台帳へ
委譲します。タイムアウト後に同じturnを再実行してもAoiTalk側がreconcile
のみ行い、二重送信しません。

なお、本モジュールのテスト・availability probeはBotへ送信しません。
実運用でmode=botが選択された時だけ、AoiTalkコードを実行します。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from .grok_search_client import GrokSearchClient

logger = logging.getLogger(__name__)

DEFAULT_BOT_CHAT_ID = "event-autopin-twitter"
DEFAULT_BOT_TIMEOUT_SECONDS = 900.0
DEFAULT_AOITALK_ROOT_NAME = "41_AoiTalk"


class GrokBotSearchError(RuntimeError):
    """Bot送信前/送信後の安全な分類だけを保持する例外。"""

    def __init__(self, code: str, message: str = "") -> None:
        self.code = str(code or "bot_error")[:80]
        # AoiTalk側の例外/応答本文をそのままログへ出さない。
        super().__init__(f"Grok Bot {self.code}: {str(message or '')[:240]}" if message else f"Grok Bot {self.code}")


BotRunner = Callable[..., Tuple[str, str, Mapping[str, Any]]]


def _value(config: Any, key: str, default: Any = None) -> Any:
    if isinstance(config, Mapping):
        return config.get(key, default)
    getter = getattr(config, "get", None)
    if callable(getter):
        try:
            return getter(key, default)
        except TypeError:
            return default
    return getattr(config, key, default)


def _bot_section(config: Any) -> dict[str, Any]:
    section = _value(config, "grok_bot_chat", None)
    return dict(section) if isinstance(section, Mapping) else {}


def _resolve_root(config: Any, explicit: Optional[str | Path] = None) -> Path:
    configured = explicit or _value(config, "grok_bot_root", None) or os.getenv("AOITALK_ROOT", "")
    if configured:
        return Path(str(configured)).expanduser()
    return Path(__file__).resolve().parents[2].parent / DEFAULT_AOITALK_ROOT_NAME


def _safe_identifier(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    if not text or any(char in text for char in "\r\n\x00"):
        return fallback
    return text[:200]


def _turn_key(
    run_id: str,
    username: str,
    event_name: str,
    event_date: datetime,
    days_before: int,
    days_after: int,
    additional_prompt: str = "",
) -> str:
    # Bot側の台帳キーにユーザー入力を直接含めない。同一run/queryの再実行は
    # 同じoperationへreconcileし、新しいrunは別operationになる。
    raw = "\x1f".join(
        (
            str(run_id or "").strip(),
            str(username or "").strip().lower(),
            str(event_name or "").strip(),
            event_date.strftime("%Y-%m-%d"),
            str(int(days_before)),
            str(int(days_after)),
            str(additional_prompt or "").strip(),
        )
    )
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"twitter-search-{digest}"


def _extract_json_result(stdout: str) -> dict[str, Any]:
    for line in reversed(str(stdout or "").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict):
            return payload
    raise GrokBotSearchError("invalid_response")


def _run_aoitalk_turn_subprocess(
    prompt: str,
    *,
    section: Mapping[str, Any],
    owner_id: str,
    chat_id: str,
    turn_key: str,
    python_executable: str,
    aoitalk_root: Path,
    timeout: float,
) -> Tuple[str, str, Mapping[str, Any]]:
    """AoiTalk Chat serviceを隔離プロセスで呼ぶ（APIモデル呼び出しではない）。"""

    script = r'''
import json
import sys

try:
    from src.services.grok_bot_chat_service import (
        GrokBotChatService,
        resolve_grok_bot_chat_settings,
    )

    request = json.loads(sys.stdin.read())
    config = {"grok_bot_chat": request["section"]}
    settings, problem = resolve_grok_bot_chat_settings(config)
    if settings is None:
        print(json.dumps({"ok": False, "error": "BOT_BINDING_INVALID"}, ensure_ascii=False))
        raise SystemExit(0)
    service = GrokBotChatService(settings)
    try:
        result = service.send_turn(
            request["owner_id"],
            request["chat_id"],
            request["turn_key"],
            request["prompt"],
        )
        print(json.dumps({
            "ok": True,
            "state": result.state,
            "text": result.text,
            "operation_id": result.operation_id,
            "error_code": result.error_code,
            "completion_status": result.completion_status,
            "response_truncated": bool(result.response_truncated),
        }, ensure_ascii=False))
    finally:
        close = getattr(service, "close", None)
        if callable(close):
            close()
except SystemExit:
    raise
except Exception:
    # Exception text may contain credentials, profile paths, prompts, or URLs.
    print(json.dumps({"ok": False, "error": "BOT_RUNTIME_UNAVAILABLE"}, ensure_ascii=False))
'''
    request = {
        "section": dict(section),
        "owner_id": owner_id,
        "chat_id": chat_id,
        "turn_key": turn_key,
        "prompt": prompt,
    }
    command = [str(python_executable), "-c", script]
    kwargs: dict[str, Any] = {
        "input": json.dumps(request, ensure_ascii=False),
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "cwd": str(aoitalk_root),
        "timeout": max(1.0, float(timeout)),
        "check": False,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(command, **kwargs)
    except subprocess.TimeoutExpired as exc:
        # AoiTalk's operation ledger makes a later same-turn retry safe; do not
        # send a different turn here.
        raise GrokBotSearchError("unknown_delivery") from exc
    except OSError as exc:
        raise GrokBotSearchError("dependency_unavailable", type(exc).__name__) from exc

    payload = _extract_json_result(completed.stdout)
    if not payload.get("ok"):
        raise GrokBotSearchError(str(payload.get("error") or "bot_unavailable"))
    state = str(payload.get("state") or "").strip().lower()
    completion_status = str(payload.get("completion_status") or "").strip().lower()
    text = str(payload.get("text") or "")
    response_truncated = bool(payload.get("response_truncated"))

    # AoiTalk intentionally exposes reply_observed/nonterminal progress text.
    # It must never be parsed as an X-search answer: only the explicit
    # ``replied`` + ``completed`` terminal contract is authoritative.  The
    # same run_id/turn_key is retained by the caller, so a later retry can ask
    # AoiTalk to reconcile the existing operation instead of sending again.
    if state != "replied" or completion_status != "completed" or response_truncated:
        if response_truncated or completion_status == "truncated" or state == "incomplete_response":
            raise GrokBotSearchError("response_truncated")
        if state in {"pending", "sent", "uncertain", "reply_observed"} or completion_status in {
            "pending",
            "unknown",
            "nonterminal",
            "tool_only",
            "non_text",
        }:
            raise GrokBotSearchError("reply_pending")
        raise GrokBotSearchError("nonterminal_response")
    if not text.strip():
        raise GrokBotSearchError("empty_response")
    metadata = {
        "operation_id": str(payload.get("operation_id") or "")[:200],
        "state": state[:80],
        "completion_status": completion_status[:80],
        "response_truncated": response_truncated,
    }
    return text, "grok-bot", metadata


class GrokBotSearchClient:
    """AoiTalk Chat専用GatewayをX検索レスポンスへ適合させる。"""

    DEFAULT_MODEL = "grok-bot"

    def __init__(
        self,
        config: Any = None,
        *,
        runner: Optional[BotRunner] = None,
        python_executable: Optional[str] = None,
        aoitalk_root: Optional[str | Path] = None,
        owner_id: Optional[str] = None,
        chat_id: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        run_id: Optional[str] = None,
    ) -> None:
        self.config = config or {}
        self.section = _bot_section(self.config)
        raw_owner = owner_id or _value(self.config, "grok_bot_owner_id", None) or self.section.get("owner_id")
        if not raw_owner and isinstance(self.section.get("owners"), Mapping):
            raw_owner = next(iter(self.section["owners"]), None)
        self.owner_id = _safe_identifier(raw_owner, "")
        raw_chat = chat_id or _value(self.config, "grok_bot_chat_id", None) or self.section.get("chat_id")
        self.chat_id = _safe_identifier(raw_chat, DEFAULT_BOT_CHAT_ID)
        self.python_executable = python_executable or _value(self.config, "grok_bot_python", None) or sys.executable
        self.aoitalk_root = _resolve_root(self.config, aoitalk_root)
        self.timeout_seconds = float(
            timeout_seconds
            or _value(self.config, "grok_bot_timeout", None)
            or DEFAULT_BOT_TIMEOUT_SECONDS
        )
        configured_run_id = run_id or _value(self.config, "grok_search_run_id", None) or _value(
            self.config, "run_id", None
        )
        # pipeline run idが無い単体利用では、このclient instanceを1 runとする。
        self.run_id = _safe_identifier(configured_run_id, uuid.uuid4().hex)
        self.runner = runner

    def _prompt(self, event_name: str, additional_prompt: str) -> str:
        # AoiTalk側にAPIキーを渡さず、検索指示だけをChat turnへ委譲する。
        helper = object.__new__(GrokSearchClient)
        return helper._build_system_prompt(event_name, additional_prompt)

    def _query(
        self,
        username: str,
        event_name: str,
        event_date: datetime,
        days_before: int,
        days_after: int,
    ) -> str:
        helper = object.__new__(GrokSearchClient)
        from_date = (event_date - timedelta(days=int(days_before))).strftime("%Y-%m-%d")
        to_date = (event_date + timedelta(days=int(days_after))).strftime("%Y-%m-%d")
        return (
            helper._build_query(username)
            + f"\n対象イベント: {event_name}\n対象期間: {from_date}〜{to_date}\n"
            "上記のJSON形式だけを返してください。"
        )

    def _run(
        self,
        prompt: str,
        *,
        username: str,
        event_name: str,
        event_date: datetime,
        days_before: int,
        days_after: int,
    ) -> Tuple[str, str, Mapping[str, Any]]:
        if not self.owner_id:
            raise GrokBotSearchError("owner_not_configured")
        if not self.section:
            raise GrokBotSearchError("binding_not_configured")
        full_prompt = self._prompt(event_name, "") + "\n\n" + self._query(
            username, event_name, event_date, days_before, days_after
        ) + "\n\n" + prompt
        key = _turn_key(
            self.run_id,
            username,
            event_name,
            event_date,
            days_before,
            days_after,
            prompt,
        )
        if self.runner is not None:
            return self.runner(
                full_prompt,
                owner_id=self.owner_id,
                chat_id=self.chat_id,
                turn_key=key,
                timeout=self.timeout_seconds,
            )
        return _run_aoitalk_turn_subprocess(
            full_prompt,
            section=self.section,
            owner_id=self.owner_id,
            chat_id=self.chat_id,
            turn_key=key,
            python_executable=str(self.python_executable),
            aoitalk_root=self.aoitalk_root,
            timeout=self.timeout_seconds,
        )

    async def search_catalog_tweet(
        self,
        username: str,
        event_name: str,
        event_date: datetime,
        days_before: int = 30,
        days_after: int = 7,
        additional_prompt: str = "",
        **_kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = additional_prompt or ""
        try:
            response_text, model, metadata = await asyncio.to_thread(
                self._run,
                prompt,
                username=username,
                event_name=event_name,
                event_date=event_date,
                days_before=days_before,
                days_after=days_after,
            )
        except GrokBotSearchError as exc:
            logger.warning("Grok Bot検索を利用できません(%s)", exc.code)
            return self._default_result(error=exc.code)
        except Exception as exc:  # noqa: BLE001 - provider boundary
            logger.warning("Grok Bot検索で想定外のエラー(%s)", type(exc).__name__)
            return self._default_result(error="bot_runtime_error")

        helper = object.__new__(GrokSearchClient)
        result = helper._parse_response(response_text)
        result["summary"] = response_text
        result["model"] = model or self.DEFAULT_MODEL
        result["grok_bot"] = dict(metadata or {})
        return result

    @staticmethod
    def _default_result(error: str = "") -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "found": False,
            "tweet_url": None,
            "tweet_id": None,
            "is_absence": False,
            "is_existing_only": False,
            "is_preview": False,
            "has_image": False,
            "reason": "",
            "summary": "",
            "model": "grok-bot",
        }
        if error:
            result["error"] = str(error)[:120]
        return result


__all__ = ["DEFAULT_BOT_CHAT_ID", "GrokBotSearchClient", "GrokBotSearchError"]

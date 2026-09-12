"""安全な再処理 telemetry の共通ヘルパー。"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
import inspect
import re
import sys
import time
from typing import Any, Callable, Dict, Iterator, Optional


TraceCallback = Callable[..., Any]


def _safe_log_value(value: Any, fallback: str = "unknown") -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"[^A-Za-z0-9_.:-]", "_", text, flags=re.ASCII)
    return text[:200] or fallback


def _callback_for(trace: Any) -> Optional[Callable[..., Any]]:
    if trace is None:
        return None
    if isinstance(trace, list):
        return trace.append
    for method_name in ("record", "emit"):
        method = getattr(trace, method_name, None)
        if callable(method):
            return method
    return trace if callable(trace) else None


def _can_bind(signature: inspect.Signature, *args: Any, **kwargs: Any) -> bool:
    try:
        signature.bind(*args, **kwargs)
    except TypeError:
        return False
    return True


def _invoke_trace_callback(trace: Any, event: Dict[str, Any]) -> None:
    callback = _callback_for(trace)
    if callback is None:
        return

    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        callback(event)
        return

    named_values = {
        "run_id": event.get("run_id"),
        "stage": event["stage"],
        "outcome": event["outcome"],
        "elapsed_ms": event["elapsed_ms"],
    }
    named_parameters = set(signature.parameters)
    if {"stage", "outcome"}.issubset(named_parameters):
        named_kwargs = {
            name: value
            for name, value in named_values.items()
            if name in named_parameters
        }
        if _can_bind(signature, **named_kwargs):
            callback(**named_kwargs)
            return

    if _can_bind(signature, event):
        callback(event)
        return
    if _can_bind(
        signature,
        event.get("run_id"),
        event["stage"],
        event["outcome"],
        event["elapsed_ms"],
    ):
        callback(
            event.get("run_id"),
            event["stage"],
            event["outcome"],
            event["elapsed_ms"],
        )
        return
    if _can_bind(
        signature,
        event["stage"],
        event["outcome"],
        event["elapsed_ms"],
    ):
        callback(event["stage"], event["outcome"], event["elapsed_ms"])
        return
    callback(event)


def emit_reprocess_trace(
    run_id: Any,
    stage: str,
    outcome: str,
    elapsed_ms: int,
    trace: Any = None,
) -> None:
    """Emit stderr and callback telemetry without affecting the caller."""

    event: Dict[str, Any] = {
        "run_id": run_id,
        "stage": stage,
        "outcome": outcome,
        "elapsed_ms": max(0, int(elapsed_ms)),
    }

    if run_id is not None and str(run_id) != "":
        try:
            sys.stderr.write(
                "[EAP_REPROCESS] "
                f"run_id={_safe_log_value(run_id)} "
                f"stage={_safe_log_value(stage)} "
                f"outcome={_safe_log_value(outcome)} "
                f"elapsed_ms={event['elapsed_ms']}\n"
            )
            sys.stderr.flush()
        except BaseException:
            pass

    try:
        _invoke_trace_callback(trace, event)
    except BaseException:
        pass


@contextmanager
def trace_stage(
    run_id: Any,
    stage: str,
    trace: Any = None,
) -> Iterator[None]:
    """Record begin and exactly one terminal outcome for a stage."""

    started = time.monotonic()
    emit_reprocess_trace(run_id, stage, "begin", 0, trace)
    try:
        yield
    except asyncio.CancelledError:
        emit_reprocess_trace(run_id, stage, "cancel", _elapsed_ms(started), trace)
        raise
    except TimeoutError:
        emit_reprocess_trace(run_id, stage, "timeout", _elapsed_ms(started), trace)
        raise
    except BaseException:
        emit_reprocess_trace(run_id, stage, "error", _elapsed_ms(started), trace)
        raise
    else:
        emit_reprocess_trace(run_id, stage, "end", _elapsed_ms(started), trace)


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


def supports_keyword(callable_obj: Any, name: str) -> bool:
    """Return whether a callable accepts a keyword, conservatively."""

    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return True
    if any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    ):
        return True
    return name in signature.parameters


def call_with_optional_trace(
    callable_obj: Callable[..., Any],
    *args: Any,
    run_id: Any = None,
    trace: Any = None,
    **kwargs: Any,
) -> Any:
    """Call legacy-compatible code, forwarding only accepted telemetry kwargs."""

    optional_kwargs: Dict[str, Any] = {}
    if run_id is not None and supports_keyword(callable_obj, "run_id"):
        optional_kwargs["run_id"] = run_id
    if trace is not None and supports_keyword(callable_obj, "trace"):
        optional_kwargs["trace"] = trace
    return callable_obj(*args, **kwargs, **optional_kwargs)

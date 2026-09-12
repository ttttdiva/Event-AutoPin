"""Optional monotonic budgets for bounded reprocessing work."""

from __future__ import annotations

import math
import time
from typing import Callable, Optional


POST_REPROCESS_WORK_BUDGET_MS = 600_000
POST_REPROCESS_MAX_BUDGET_MS = POST_REPROCESS_WORK_BUDGET_MS


class ReprocessDeadlineExceeded(TimeoutError):
    """A reprocessing budget expired before or during a stage."""

    def __init__(self, message: str = "reprocess deadline exceeded", *, stage: Optional[str] = None):
        self.stage = stage
        super().__init__(message)


class ReprocessDeadline:
    """An optional, monotonic deadline shared by one reprocessing call."""

    def __init__(
        self,
        timeout_seconds: Optional[float] = None,
        *,
        timeout_ms: Optional[float] = None,
        deadline_monotonic: Optional[float] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if timeout_seconds is not None and timeout_ms is not None:
            raise ValueError("timeout_seconds and timeout_ms are mutually exclusive")
        if timeout_seconds is not None and deadline_monotonic is not None:
            raise ValueError("timeout_seconds and deadline_monotonic are mutually exclusive")
        if timeout_ms is not None and deadline_monotonic is not None:
            raise ValueError("timeout_ms and deadline_monotonic are mutually exclusive")

        self._clock = clock
        if deadline_monotonic is not None:
            deadline = float(deadline_monotonic)
        elif timeout_ms is not None:
            deadline = self._clock() + self._validate_duration(timeout_ms, "timeout_ms") / 1000.0
        elif timeout_seconds is not None:
            deadline = self._clock() + self._validate_duration(timeout_seconds, "timeout_seconds")
        else:
            raise ValueError("a timeout or monotonic deadline is required")
        if not math.isfinite(deadline):
            raise ValueError("deadline must be finite")
        self._deadline_monotonic = deadline

    @staticmethod
    def _validate_duration(value: float, name: str) -> float:
        try:
            duration = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be numeric") from exc
        if not math.isfinite(duration):
            raise ValueError(f"{name} must be finite")
        return duration

    @classmethod
    def from_timeout_ms(
        cls,
        timeout_ms: object,
        *,
        default_ms: float = POST_REPROCESS_WORK_BUDGET_MS,
        maximum_ms: float = POST_REPROCESS_MAX_BUDGET_MS,
        clock: Callable[[], float] = time.monotonic,
    ) -> Optional["ReprocessDeadline"]:
        """Build a bounded deadline from an optional JSON payload value.

        The direct-post bridge is intentionally bounded even when an older
        frontend omits the field; callers that need no budget should simply
        avoid constructing this helper.
        """

        if timeout_ms is None:
            timeout_ms = default_ms
        if isinstance(timeout_ms, bool):
            raise ValueError("reprocess_deadline_ms must be numeric")
        try:
            default_value = float(default_ms)
            maximum_value = float(maximum_ms)
            requested_value = float(timeout_ms)
        except (TypeError, ValueError) as exc:
            raise ValueError("reprocess_deadline_ms must be numeric") from exc
        if not math.isfinite(default_value) or default_value < 0:
            raise ValueError("default_ms must be a finite non-negative number")
        if not math.isfinite(maximum_value) or maximum_value < 0:
            raise ValueError("maximum_ms must be a finite non-negative number")
        if maximum_value < default_value:
            raise ValueError("maximum_ms must be greater than or equal to default_ms")
        if not math.isfinite(requested_value) or requested_value < 0:
            raise ValueError("reprocess_deadline_ms must be a finite non-negative number")
        return cls(
            timeout_ms=min(requested_value, maximum_value),
            clock=clock,
        )

    @property
    def remaining_seconds(self) -> float:
        """Return remaining budget, clamped at zero."""

        return max(0.0, self._deadline_monotonic - self._clock())

    @property
    def expired(self) -> bool:
        return self.remaining_seconds <= 0.0

    def require_time(
        self,
        minimum_seconds: float = 0.0,
        *,
        stage: Optional[str] = None,
    ) -> float:
        """Return remaining time or raise a ``TimeoutError``-compatible error."""

        minimum = self._validate_duration(minimum_seconds, "minimum_seconds")
        remaining = self.remaining_seconds
        if remaining <= 0.0 or (minimum > 0.0 and remaining < minimum):
            stage_text = f" at {stage}" if stage else ""
            raise ReprocessDeadlineExceeded(
                f"reprocess deadline exceeded{stage_text}",
                stage=stage,
            )
        return remaining

    def ensure_remaining(self, stage: Optional[str] = None) -> None:
        """Raise when no time remains; useful at explicit stage boundaries."""

        self.require_time(stage=stage)

    def clamp_seconds(
        self,
        requested: float,
        *,
        stage: Optional[str] = None,
    ) -> float:
        """Clamp a per-call timeout to the shared budget."""

        try:
            requested_value = float(requested)
        except (TypeError, ValueError) as exc:
            raise ValueError("requested timeout must be numeric") from exc
        if not math.isfinite(requested_value) or requested_value < 0:
            raise ValueError("requested timeout must be finite and non-negative")
        remaining = self.require_time(stage=stage)
        return min(requested_value, remaining)

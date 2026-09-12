from __future__ import annotations

import pytest

from src.utils.reprocess_deadline import (
    POST_REPROCESS_WORK_BUDGET_MS,
    ReprocessDeadline,
    ReprocessDeadlineExceeded,
)


def test_omitted_payload_uses_bounded_post_budget() -> None:
    now = [100.0]
    deadline = ReprocessDeadline.from_timeout_ms(None, clock=lambda: now[0])

    assert deadline is not None
    assert deadline.remaining_seconds == pytest.approx(
        POST_REPROCESS_WORK_BUDGET_MS / 1000.0
    )


def test_oversized_payload_is_clamped_to_production_budget() -> None:
    now = [0.0]
    deadline = ReprocessDeadline.from_timeout_ms(
        POST_REPROCESS_WORK_BUDGET_MS * 10,
        clock=lambda: now[0],
    )

    assert deadline is not None
    assert deadline.remaining_seconds == pytest.approx(
        POST_REPROCESS_WORK_BUDGET_MS / 1000.0
    )


def test_expiration_is_typed_and_keeps_stage() -> None:
    now = [0.0]
    deadline = ReprocessDeadline(
        timeout_seconds=1.0,
        clock=lambda: now[0],
    )
    now[0] = 1.0

    with pytest.raises(ReprocessDeadlineExceeded) as exc_info:
        deadline.ensure_remaining("catalog.ocr_a")

    assert exc_info.value.stage == "catalog.ocr_a"


def test_clamp_seconds_uses_remaining_time() -> None:
    now = [10.0]
    deadline = ReprocessDeadline(
        deadline_monotonic=12.5,
        clock=lambda: now[0],
    )

    assert deadline.clamp_seconds(180.0, stage="catalog.initial") == pytest.approx(2.5)

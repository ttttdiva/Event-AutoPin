import asyncio
from types import SimpleNamespace

from src.models import Circle, Event
from src.processors.twitter_post_processor import TwitterPostProcessor


class FakeProgress:
    def start_task(self, *_args):
        pass

    def end_task(self):
        pass


def test_twscrape_failure_is_exposed_in_run_summary():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True,
        debug_limit=None,
        event_date="2026-07-12",
        additional_prompt="",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(_twscrape_unavailable_reason=None)
    processor._print_summary = lambda _circles: None
    calls = []

    async def fail_first(circle, *_args):
        calls.append(circle.name)
        processor.twitter_extractor._twscrape_unavailable_reason = (
            "IndexError: list index out of range"
        )
        return circle

    processor._process_single_circle = fail_first
    circles = [
        Circle(name="A", twitter_url="https://twitter.com/example_a"),
        Circle(name="B", twitter_url="https://x.com/example_b"),
    ]

    asyncio.run(
        processor.process_circles(
            circles,
            Event(name="イベント", url="https://example.com", date=None),
        )
    )

    assert calls == ["A"]
    assert processor.last_run_summary["status"] == "failed"
    assert processor.last_run_summary["target_count"] == 2
    assert processor.last_run_summary["processed_count"] == 0
    assert processor.last_run_summary["failed_count"] == 2
    assert processor.last_run_summary["reason"] == (
        "twscrape: IndexError: list index out of range"
    )


def test_unexpected_processing_exception_is_exposed_in_run_summary():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True,
        debug_limit=None,
        event_date="2026-07-12",
        additional_prompt="",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(_twscrape_unavailable_reason=None)
    processor._print_summary = lambda _circles: None

    async def raise_error(*_args):
        raise RuntimeError("network failure")

    processor._process_single_circle = raise_error
    circles = [Circle(name="A", twitter_url="https://x.com/example_a")]

    asyncio.run(
        processor.process_circles(
            circles,
            Event(name="イベント", url="https://example.com", date=None),
        )
    )

    assert processor.last_run_summary["status"] == "failed"
    assert processor.last_run_summary["failed_count"] == 1
    assert processor.last_run_summary["reason"] == "RuntimeError: network failure"

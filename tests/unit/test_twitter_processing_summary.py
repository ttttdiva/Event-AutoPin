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


def test_fetch_success_counters_are_aggregated_per_target():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True,
        debug_limit=None,
        event_date="2026-09-13",
        additional_prompt="",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(
        _twscrape_unavailable_reason=None,
        _last_fetch_stats={},
    )
    processor._print_summary = lambda _circles: None

    async def process_one(circle, *_args):
        processor.twitter_extractor._last_fetch_stats = {
            "outcome": (
                "catalog_found"
                if circle.name == "A"
                else "no_catalog_found"
            ),
            "reason": None,
            "user_lookup_success_count": 1,
            "tweet_fetch_success_count": 1,
        }
        return circle

    processor._process_single_circle = process_one

    circles = [
        Circle(name="A", twitter_url="https://x.com/example_a"),
        Circle(name="B", twitter_url="https://x.com/example_b"),
    ]

    asyncio.run(
        processor.process_circles(
            circles,
            Event(
                name="イベント",
                url="https://example.com",
                date=None,
            ),
        )
    )

    summary = processor.last_run_summary

    assert summary["status"] == "ok"
    assert summary["target_count"] == 2
    assert summary["attempted_count"] == 2
    assert summary["processed_count"] == 2
    assert summary["user_lookup_success_count"] == 2
    assert summary["tweet_fetch_success_count"] == 2
    assert summary["catalog_found_count"] == 1
    assert summary["no_catalog_found_count"] == 1
    outcomes = summary["target_outcomes"]
    assert [item["fetch_outcome"] for item in outcomes] == [
        "catalog_found",
        "no_catalog_found",
    ]
    assert [item["processing_status"] for item in outcomes] == [
        "processed",
        "processed",
    ]
    assert all(len(item["circle_identity_sha256"]) == 64 for item in outcomes)
    assert all("circle_name" not in item and "twitter_url" not in item for item in outcomes)


def test_fetch_success_counters_preserve_partial_stage_success():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True,
        debug_limit=None,
        event_date="2026-09-13",
        additional_prompt="",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(
        _twscrape_unavailable_reason=None,
        _last_fetch_stats={},
    )
    processor._print_summary = lambda _circles: None

    async def unresolved(circle, *_args):
        processor.twitter_extractor._last_fetch_stats = {
            "outcome": "timeline_unresolved",
            "reason": "user_tweets yielded no parsed tweets",
            "user_lookup_success_count": 1,
            "tweet_fetch_success_count": 0,
        }
        return circle

    processor._process_single_circle = unresolved

    circles = [
        Circle(name="A", twitter_url="https://x.com/example_a")
    ]

    asyncio.run(
        processor.process_circles(
            circles,
            Event(
                name="イベント",
                url="https://example.com",
                date=None,
            ),
        )
    )

    summary = processor.last_run_summary

    assert summary["user_lookup_success_count"] == 1
    assert summary["tweet_fetch_success_count"] == 0
    assert summary["timeline_unresolved_count"] == 1
    assert summary["failed_count"] == 1
    assert summary["status"] == "failed"


def test_queue_unavailable_is_separate_from_transport_failure():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True,
        debug_limit=None,
        event_date="2026-09-13",
        additional_prompt="",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(
        _twscrape_unavailable_reason="queue unavailable for UserTweets",
        _last_fetch_stats={},
    )
    processor._print_summary = lambda _circles: None

    async def queue_exhausted(circle, *_args):
        processor.twitter_extractor._last_fetch_stats = {
            "outcome": "queue_unavailable",
            "reason": "no eligible account in request queue",
            "user_lookup_success_count": 1,
            "tweet_fetch_success_count": 0,
            "failure_stage": "timeline_fetch",
            "failure_queue": "UserTweets",
            "failure_code": "NO_ACCOUNT_AVAILABLE",
            "exception_type": "NoAccountError",
            "failed_request_dispatched": False,
            "response_status_code": None,
            "partial_tweet_count": 0,
        }
        return circle

    processor._process_single_circle = queue_exhausted
    circles = [Circle(name="A", twitter_url="https://x.com/example_a")]

    asyncio.run(
        processor.process_circles(
            circles,
            Event(name="イベント", url="https://example.com", date=None),
        )
    )

    summary = processor.last_run_summary
    assert summary["status"] == "failed"
    assert summary["queue_unavailable_count"] == 1
    assert summary["transport_failure_count"] == 0
    assert summary["timeline_unresolved_count"] == 0
    assert summary["queue_failure_details"] == [
        {
            "target_number": 1,
            "stage": "timeline_fetch",
            "queue": "UserTweets",
            "code": "NO_ACCOUNT_AVAILABLE",
            "exception_type": "NoAccountError",
            "failed_request_dispatched": False,
            "response_status_code": None,
            "partial_tweet_count": 0,
        }
    ]

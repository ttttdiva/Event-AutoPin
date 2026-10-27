import asyncio
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import src.utils.twitter_extractor as twitter_extractor_module
from src.utils.twitter_extractor import CatalogTweetResult, TwitterExtractor


class FailingUserLookupApi:
    def __init__(self, exc):
        self.exc = exc
        self.calls = 0

    async def user_by_login(self, _username):
        self.calls += 1
        raise self.exc


def make_extractor(api_instances):
    extractor = object.__new__(TwitterExtractor)
    extractor._initialized = True
    extractor.api_instances = api_instances
    extractor.current_account_index = 0
    extractor._twscrape_unavailable_reason = None
    return extractor


def test_extract_catalog_tweets_stops_after_twscrape_index_error():
    apis = [FailingUserLookupApi(IndexError("list index out of range")) for _ in range(3)]
    extractor = make_extractor(apis)

    result = asyncio.run(
        extractor.extract_catalog_tweets(
            username="broken_user",
            event_date=datetime(2026, 7, 4),
            event_name="event",
        )
    )

    assert isinstance(result, CatalogTweetResult)
    assert result == []
    assert [api.calls for api in apis] == [1, 1, 1]
    assert "IndexError" in extractor._twscrape_unavailable_reason


def test_extract_catalog_tweets_circuits_after_no_account_error():
    api = FailingUserLookupApi(
        Exception('No account available for queue "UserByScreenName"')
    )
    extractor = make_extractor([api])

    first = asyncio.run(
        extractor.extract_catalog_tweets(
            username="locked_user",
            event_date=datetime(2026, 7, 4),
            event_name="event",
        )
    )
    first_stats = dict(extractor._last_fetch_stats)
    second = asyncio.run(
        extractor.extract_catalog_tweets(
            username="skipped_user",
            event_date=datetime(2026, 7, 4),
            event_name="event",
        )
    )

    assert first == []
    assert second == []
    assert api.calls == 1
    assert extractor._twscrape_unavailable_reason == (
        "queue unavailable for UserByScreenName"
    )
    assert first_stats["failure_stage"] == "user_lookup"
    assert first_stats["failure_queue"] == "UserByScreenName"


def test_timeline_queue_exhaustion_is_classified_without_exception_text():
    secret_marker = "credential-canary-must-not-be-recorded"
    no_account = twitter_extractor_module.NoAccountError(
        f'No account available for queue "UserTweets"; token={secret_marker}'
    )

    class TimelineQueueExhaustedApi:
        async def user_by_login(self, _username):
            return SimpleNamespace(id=123)

        async def user_tweets(self, _user_id, limit=-1):
            raise no_account
            yield  # Make this an async generator, as twscrape's method is.

    extractor = make_extractor([TimelineQueueExhaustedApi()])

    result = asyncio.run(
        extractor.extract_catalog_tweets(
            username="sample_profile",
            event_date=datetime(2026, 7, 4),
            event_name="sample event",
        )
    )

    assert isinstance(result, CatalogTweetResult)
    assert result == []
    assert extractor._last_fetch_stats == {
        "outcome": "queue_unavailable",
        "reason": "no eligible account in request queue",
        "user_lookup_success_count": 1,
        "tweet_fetch_success_count": 0,
        "catalog_tweet_count": 0,
        "failure_stage": "timeline_fetch",
        "failure_queue": "UserTweets",
        "failure_code": "NO_ACCOUNT_AVAILABLE",
        "exception_type": "NoAccountError",
        "failed_request_dispatched": False,
        "response_status_code": None,
        "partial_tweet_count": 0,
    }
    assert extractor._twscrape_unavailable_reason == (
        "queue unavailable for UserTweets"
    )
    assert secret_marker not in repr(extractor._last_fetch_stats)
    assert secret_marker not in extractor._twscrape_unavailable_reason


def test_create_api_instance_requests_no_account_exception(monkeypatch):
    calls = []

    class FakeApi:
        def __init__(self, pool=None, **kwargs):
            calls.append((pool, kwargs))

    monkeypatch.setattr(twitter_extractor_module, "API", FakeApi)
    extractor = object.__new__(TwitterExtractor)

    api = extractor._create_api_instance()

    assert isinstance(api, FakeApi)
    expected_db = str(
        Path(twitter_extractor_module.__file__).resolve().parents[2] / "accounts.db"
    )
    assert calls == [(expected_db, {"raise_when_no_account": True})]


def test_create_api_instance_keeps_project_pool_when_cwd_is_temporary(monkeypatch, tmp_path):
    calls = []

    class FakeApi:
        def __init__(self, pool=None, **kwargs):
            calls.append((pool, kwargs))

    monkeypatch.setattr(twitter_extractor_module, "API", FakeApi)
    monkeypatch.chdir(tmp_path)
    extractor = object.__new__(TwitterExtractor)

    extractor._create_api_instance()

    expected_db = str(
        Path(twitter_extractor_module.__file__).resolve().parents[2] / "accounts.db"
    )
    assert Path(expected_db).is_absolute()
    assert Path(expected_db).parent != tmp_path
    assert calls == [(expected_db, {"raise_when_no_account": True})]

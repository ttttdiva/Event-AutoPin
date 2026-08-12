import asyncio
from datetime import datetime

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
    assert "No account available" in extractor._twscrape_unavailable_reason


def test_create_api_instance_requests_no_account_exception(monkeypatch):
    calls = []

    class FakeApi:
        def __init__(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(twitter_extractor_module, "API", FakeApi)
    extractor = object.__new__(TwitterExtractor)

    api = extractor._create_api_instance()

    assert isinstance(api, FakeApi)
    assert calls == [{"raise_when_no_account": True}]

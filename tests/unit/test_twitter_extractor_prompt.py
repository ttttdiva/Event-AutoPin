from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from src.utils.twitter_extractor import TwitterExtractor


class _PromptLLM:
    def __init__(self) -> None:
        self.keyword_calls: list[str] = []
        self.batch_prompts: list[str] = []

    def extract_event_keywords(self, prompt: str) -> list[str]:
        self.keyword_calls.append(prompt)
        return ["AKEY"] if "source-A" in prompt else ["BKEY"]

    def batch_filter_catalog_tweets(
        self, _tweets, _event_name, _event_date, prompt: str
    ) -> dict:
        self.batch_prompts.append(prompt)
        return {"catalog_indices": [0], "absence_indices": [], "best_index": 0}


class _TimelineApi:
    def __init__(self) -> None:
        self.raw_content = "AKEY"

    async def user_by_login(self, _username: str):
        return SimpleNamespace(id=1, followersCount=0)

    async def user_tweets(self, _user_id: int, limit: int = -1):
        yield SimpleNamespace(
            id=1,
            date=datetime(2026, 11, 2, tzinfo=timezone.utc),
            rawContent=self.raw_content,
            user=SimpleNamespace(id=1, username="circle"),
            retweetedTweet=None,
            media=None,
            quotedTweet=None,
            inReplyToTweetId=None,
            url="",
        )


def _extractor(llm: _PromptLLM, api: _TimelineApi) -> TwitterExtractor:
    extractor = object.__new__(TwitterExtractor)
    extractor.llm_client = llm
    extractor.event_date = "2026-11-03"
    extractor.additional_prompt = "common"
    extractor.effective_additional_prompt = "2026年11月3日\ncommon"
    extractor.dynamic_keywords = []
    extractor._dynamic_keyword_cache = {}
    extractor._initialized = True
    extractor.api_instances = [api]
    extractor.current_account_index = 0
    extractor._twscrape_unavailable_reason = None
    extractor._last_fetch_stats = {}
    extractor.catalog_keywords = ["お品書き"]
    extractor.absence_keywords = ["欠席"]
    return extractor


def test_source_prompt_switch_updates_timeline_prompt_and_dynamic_keywords() -> None:
    llm = _PromptLLM()
    api = _TimelineApi()
    extractor = _extractor(llm, api)

    extractor.set_additional_prompt("source-A", event_date="2026-11-03")
    first = asyncio.run(
        extractor.extract_catalog_tweets(
            username="circle",
            event_date=datetime(2026, 11, 3),
            event_name="event",
        )
    )
    assert first and first[0]["text"] == "AKEY"
    assert llm.batch_prompts[-1].endswith("source-A")
    assert extractor.dynamic_keywords == ["AKEY"]

    api.raw_content = "BKEY"
    extractor.set_additional_prompt("source-B", event_date="2026-11-03")
    second = asyncio.run(
        extractor.extract_catalog_tweets(
            username="circle",
            event_date=datetime(2026, 11, 3),
            event_name="event",
        )
    )
    assert second and second[0]["text"] == "BKEY"
    assert llm.batch_prompts[-1].endswith("source-B")
    assert extractor.dynamic_keywords == ["BKEY"]
    assert llm.keyword_calls == ["source-A", "source-B"]
    extractor.set_additional_prompt("source-A", event_date="2026-11-03")
    assert extractor.dynamic_keywords == ["AKEY"]
    assert llm.keyword_calls == ["source-A", "source-B"]

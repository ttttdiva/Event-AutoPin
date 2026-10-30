"""Grok Build(grok.exe)によるX再探索の段。実際のgrok.exe・X・画像モデルは呼ばない。"""

import asyncio
import json
import subprocess
from datetime import datetime
from types import SimpleNamespace

import pytest

from src.formatters.json_formatter import JSONFormatter
from src.models import Circle, Event
from src.processors.twitter_post_processor import TwitterPostProcessor
from src.utils import grok_build_x_search as gx
from src.utils.grok_build import GrokBuildError
from src.utils.grok_build_x_search import GrokBuildXSearch, build_prompt, parse_reply


@pytest.fixture(autouse=True)
def _allow_rescue(monkeypatch):
    monkeypatch.delenv(gx.DISABLE_ENV, raising=False)


EVENT_DATE = datetime(2026, 11, 1)
REPLY = """確認します。
- @alice | 存在:あり | お品書き:https://x.com/alice/status/111 | 2026-10-29 20:58。11/1 A-02
**@bob** | 存在:あり | お品書き:未発見 | 現在凍結（ユーザーID 1）。投稿を取得できず
@carol | 存在:なし | お品書き:未発見 | 検索に出ない
@dave | 存在:あり | お品書き:https://x.com/someone_else/status/222 | 他人の投稿
@erin | 存在:あり | お品書き:未発見 | 備考なし
@unrequested | 存在:あり | お品書き:https://x.com/unrequested/status/9 | 依頼外
"""


class FakeProgress:
    def start_task(self, *_a):
        pass

    def end_task(self):
        pass

    def update_progress(self, *_a):
        pass


def fake_searcher(replies, available=(True, ""), batch_size=12):
    calls = []

    def runner(prompt, model=None, timeout=None):
        calls.append(prompt)
        reply = replies[len(calls) - 1]
        if isinstance(reply, Exception):
            raise reply
        return reply, "grok-4.7-build"

    searcher = GrokBuildXSearch(runner=runner, availability=lambda: available, batch_size=batch_size)
    searcher.calls = calls
    return searcher


def make_processor(searcher, post_results=None):
    """twscrape段は何も見つけない状態の、Grok再探索だけを試すprocessor。"""
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True, debug_limit=None, event_date="2026-11-01", additional_prompt="",
        continue_on_error=True, rate_limit_seconds=0, use_grok_rescue=True,
        image_llm_provider="api:openai", image_llm_model="gpt-5.6-luna",
    )
    processor.grok_client = None
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(_twscrape_unavailable_reason=None)
    processor._print_summary = lambda _c: None
    processor.x_account_status = {}
    processor.grok_rescue_searcher = searcher
    processor.posts = []

    async def single(circle, *_a):
        return circle

    async def from_post(circle, url, event_name="", **_kw):
        processor.posts.append((circle.name, url, event_name))
        result = (post_results or {}).get(url)
        if isinstance(result, Exception):
            raise result
        processor._last_direct_post_outcome = result
        if result == "adopted":
            circle.catalog_status = "confirmed"
            circle.items = [{"name": "新刊", "catalog_evidence": {"model": "gpt-5.6-luna"}}]
            return True
        return False

    processor._process_single_circle = single
    processor.process_circle_from_post_url = from_post
    return processor


def run(processor, circles, **kwargs):
    event = Event(name="鳴花～ず", url="https://example.com", date=None)
    return asyncio.run(processor.process_circles(circles, event, **kwargs))


def circles_for(*handles):
    return [Circle(name=f"circle_{h}", space=f"A-{i}", twitter_url=f"https://x.com/{h}")
            for i, h in enumerate(handles)]


def test_parse_reply_extracts_url_suspension_and_ignores_foreign_urls():
    found = parse_reply(REPLY, ["alice", "bob", "carol", "dave", "erin"])
    assert found["alice"].post_url == "https://x.com/alice/status/111"
    assert found["bob"].suspended and found["bob"].post_url is None and found["bob"].not_found
    assert found["carol"].exists == "なし"
    assert found["dave"].post_url is None  # 他人のURLは採用しない
    assert found["erin"].not_found and not found["erin"].suspended
    assert "unrequested" not in found


def test_prompt_contains_event_date_name_and_handles():
    prompt = build_prompt(["alice", "bob"], "鳴花～ず", EVENT_DATE)
    assert "2026年11月1日開催" in prompt and "（鳴花～ず）" in prompt
    assert "@alice\n@bob" in prompt and "推測・捏造しない" in prompt


def test_handles_are_sent_in_sequential_batches_of_twelve():
    handles = [f"user{i:02d}" for i in range(30)]
    searcher = fake_searcher(["", "", ""])
    run(make_processor(searcher), circles_for(*handles))
    assert [c.count("@user") for c in searcher.calls] == [12, 12, 6]


def test_found_post_is_analyzed_and_models_are_recorded():
    searcher = fake_searcher([REPLY])
    processor = make_processor(searcher, {"https://x.com/alice/status/111": "adopted"})
    updated = run(processor, circles_for("alice", "bob", "carol", "dave", "erin"))

    alice = updated[0]
    assert alice.catalog_status == "confirmed"
    assert processor.posts == [("circle_alice", "https://x.com/alice/status/111", "鳴花～ず")]
    rescue = processor.last_run_summary["grok_rescue"]
    assert rescue["status"] == "ran" and rescue["discovery_model"] == "grok-4.7-build"
    adopted = [p for p in rescue["processed"] if p["outcome"] == "adopted"][0]
    assert adopted["analysis_model"] == "gpt-5.6-luna" and adopted["handle"] == "alice"
    assert alice._twitter_processing_succeeded is True
    assert 111 in alice._checked_tweet_ids
    assert "circle_alice" not in processor.x_account_status


def test_suspended_missing_and_unpublished_accounts_are_recorded_automatically():
    searcher = fake_searcher([REPLY])
    processor = make_processor(searcher, {"https://x.com/alice/status/111": "adopted"})
    updated = run(processor, circles_for("alice", "bob", "carol", "dave", "erin"))
    status = processor.x_account_status

    assert status["circle_bob"]["status"] == "account_suspended"
    assert status["circle_bob"]["discovery_model"] == "grok-4.7-build"
    assert status["circle_carol"]["status"] == "account_not_found"
    assert status["circle_erin"]["status"] == "catalog_not_published"
    assert status["circle_dave"]["status"] == "catalog_not_published"
    # 情報を補完しない: 凍結サークルは状態の記録以外に何も変更しない
    assert updated[1].catalog_status is None and not updated[1].items
    assert processor.metadata_for_event_json()["x_account_status"]["circle_bob"]["handle"] == "bob"


def test_suspended_account_is_removed_from_unresolved_targets():
    searcher = fake_searcher(["@bob | 存在:あり | お品書き:未発見 | 凍結"])
    processor = make_processor(searcher)

    async def unresolved(circle, *_a):
        processor._record_unresolved_target(circle, "user_lookup_unresolved", "suspended")
        return circle

    processor._process_single_circle = unresolved
    processor.twitter_extractor._last_fetch_stats = {"outcome": "user_lookup_unresolved"}
    run(processor, circles_for("bob"))
    assert processor.last_run_summary["unresolved_targets"] == []
    assert processor.last_run_summary["status"] == "ok"


def test_not_catalog_post_is_not_applied():
    searcher = fake_searcher(["@alice | 存在:あり | お品書き:https://x.com/alice/status/111 | 別イベント"])
    processor = make_processor(searcher, {"https://x.com/alice/status/111": "not_catalog"})
    updated = run(processor, circles_for("alice"))
    assert updated[0].catalog_status is None and not updated[0].items
    assert processor.x_account_status["circle_alice"]["status"] == "post_not_catalog"
    assert processor.x_account_status["circle_alice"]["post_url"] == "https://x.com/alice/status/111"


def test_fetch_failure_is_distinguished_from_not_catalog():
    searcher = fake_searcher(["@alice | 存在:あり | お品書き:https://x.com/alice/status/111 | -"])
    processor = make_processor(searcher, {"https://x.com/alice/status/111": RuntimeError("boom")})
    run(processor, circles_for("alice"))
    assert processor.x_account_status["circle_alice"]["status"] == "post_fetch_failed"


def test_unavailable_grok_is_skipped_with_reason_and_run_continues():
    searcher = fake_searcher([REPLY], available=(False, "grok is not logged in"))
    processor = make_processor(searcher)
    updated = run(processor, circles_for("alice"))
    assert len(updated) == 1
    assert searcher.calls == []
    rescue = processor.last_run_summary["grok_rescue"]
    assert rescue["status"] == "skipped" and "not logged in" in rescue["reason"]
    assert processor.x_account_status == {}


def test_disabled_by_environment_skips(monkeypatch):
    monkeypatch.setenv(gx.DISABLE_ENV, "1")
    searcher = fake_searcher([REPLY])
    processor = make_processor(searcher)
    run(processor, circles_for("alice"))
    assert searcher.calls == []
    assert "disabled" in processor.last_run_summary["grok_rescue"]["reason"]


def test_failed_batch_is_never_resent_and_stops_after_two_failures():
    err = GrokBuildError("unknown_delivery", "timeout")
    searcher = fake_searcher([err, err, "never used"], batch_size=1)
    processor = make_processor(searcher)
    run(processor, circles_for("a1", "a2", "a3"))
    assert len(searcher.calls) == 2  # 同じバッチの再送なし、連続2失敗で打ち切り
    rescue = processor.last_run_summary["grok_rescue"]
    assert [f["code"] for f in rescue["failed_batches"]] == ["unknown_delivery"] * 2


def test_circles_with_catalog_are_not_sent_to_grok():
    searcher = fake_searcher(["@bob | 存在:あり | お品書き:未発見 | -"])
    processor = make_processor(searcher)
    done = Circle(name="done", twitter_url="https://x.com/alice", catalog_status="confirmed")
    run(processor, [done] + circles_for("bob"))
    assert "@alice" not in searcher.calls[0] and "@bob" in searcher.calls[0]


def test_headless_runner_uses_web_search_without_tools_and_never_resends(monkeypatch):
    monkeypatch.setattr(gx, "resolve_grok_bin", lambda: "grok.exe")
    launched = []

    class FakeProc:
        pid = 1
        returncode = 0

        def __init__(self, command, **kwargs):
            launched.append(command)

        def communicate(self, timeout=None):
            payload = {"text": "@a | 存在:あり | お品書き:未発見 | -", "modelUsage": {"grok-4.7-build": {}}}
            return "noise\n" + json.dumps(payload), ""

    monkeypatch.setattr(gx.subprocess, "Popen", FakeProc)
    text, model = gx.run_headless_prompt("prompt", timeout=5)
    command = launched[0]
    assert model == "grok-4.7-build" and text.startswith("@a")
    assert command[command.index("--tools") + 1] == ""
    assert "--disable-web-search" not in command and "--always-approve" not in command
    assert command[command.index("--output-format") + 1] == "json"

    class HangingProc(FakeProc):
        def communicate(self, timeout=None):
            raise subprocess.TimeoutExpired("grok", timeout)

    launched.clear()
    monkeypatch.setattr(gx.subprocess, "Popen", HangingProc)
    monkeypatch.setattr(gx, "_kill_tree", lambda _p: None)
    with pytest.raises(GrokBuildError) as raised:
        gx.run_headless_prompt("prompt", timeout=1)
    assert raised.value.code == "unknown_delivery" and len(launched) == 1


def test_check_available_reports_missing_exe(monkeypatch):
    def missing():
        raise GrokBuildError("not_installed", "not found")

    monkeypatch.setattr(gx, "resolve_grok_bin", missing)
    available, reason = gx.check_available()
    assert not available and "not found" in reason


def test_x_account_status_is_carried_over_only_for_circles_without_catalog(tmp_path):
    formatter = object.__new__(JSONFormatter)
    formatter.config = SimpleNamespace(get_output_path=lambda name: str(tmp_path / name))
    formatter.logger = SimpleNamespace(info=lambda *_a, **_k: None, warning=lambda *_a, **_k: None)
    previous = {
        "event": {"name": "e"},
        "circles": [{"name": "bob"}, {"name": "alice"}],
        "metadata": {"x_account_status": {
            "bob": {"status": "account_suspended"},
            "alice": {"status": "catalog_not_published"},
        }},
    }
    (tmp_path / "event.json").write_text(json.dumps(previous), encoding="utf-8")
    data = {"event": {"name": "e"},
            "circles": [{"name": "bob", "catalog_status": None},
                        {"name": "alice", "catalog_status": "confirmed"}],
            "metadata": {}}
    formatter.save(data, "event.json")
    saved = json.loads((tmp_path / "event.json").read_text(encoding="utf-8"))
    assert set(saved["metadata"]["x_account_status"]) == {"bob"}


def test_legacy_xai_grok_api_error_falls_back_to_twscrape():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(
        enabled=True, debug_limit=None, event_date="2026-11-01", additional_prompt="",
        continue_on_error=True, rate_limit_seconds=0, use_grok_rescue=False,
        days_before_event=30, days_after_event=7,
    )
    processor.effective_additional_prompt = ""
    processor.progress = FakeProgress()
    processor.twitter_extractor = SimpleNamespace(_twscrape_unavailable_reason=None)
    processor._print_summary = lambda _c: None

    class ErrorClient:
        async def search_catalog_tweet(self, **_kw):
            return {"found": False, "error": "HTTP 500"}

    used = []

    async def twscrape(circle, *_a):
        used.append(circle.name)
        return circle

    processor.grok_client = ErrorClient()
    processor._process_with_twscrape = twscrape
    run(processor, circles_for("alice"))
    assert used == ["circle_alice"]


def test_parse_reply_handles_preamble_glued_to_first_row():
    text = ("存在確認と投稿検索を並行で進めます。@kina | 存在:あり | お品書き:https://x.com/kina/status/5 | 本文確認済み\n"
            "@zaku | 存在:あり | お品書き:未発見 | 凍結。タイムラインは取得できず\n\n時刻は日本時間です。")
    found = parse_reply(text, ["kina", "zaku"])
    assert found["kina"].post_url == "https://x.com/kina/status/5" and not found["kina"].suspended
    assert found["zaku"].suspended and found["zaku"].post_url is None

"""投稿の同時解析。外部API/Xへ接続せず、送信payloadと更新境界を検証する。"""

import asyncio
import copy
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image

from src.models import Circle, ItemImage
from src.processors import catalog_post
from src.processors.twitter_post_processor import TwitterConfig, TwitterPostProcessor
from src.utils.catalog_post_analyzer import CatalogPostAnalyzer
from src.utils.grok_build import GrokBuildError
from src.utils.llm_attempts import build_image_llm_attempts, build_text_llm_attempts
from src.utils.reprocess_deadline import ReprocessDeadline, ReprocessDeadlineExceeded


LUNA = "gpt-5.6-luna"
SOL = "gpt-5.6-sol"
POST = "訂正：新刊Aは500円です"
URL = "https://x.com/example/status/123"
MEDIA = ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"]


def product(**kwargs):
    return {"name": "新刊A", "type": "新刊(漫画)", "sale_kind": "single", "price": 500,
            "price_basis": "numeric", "price_text": "500円", "price_image_index": 1,
            "source_image_indices": [1], "text_evidence": "", "description": "",
            "needs_review": False, "review_reason": "", **kwargs}


def result(*items, **kwargs):
    return {"classification": "confirmed", "event_match": "match", "is_existing_only": False,
            "catalog_image_indices": [1, 2], "items": list(items or [product()]), **kwargs}


def parse(raw, text=POST, count=2):
    return CatalogPostAnalyzer.parse(json.dumps(raw, ensure_ascii=False), count, text)


@pytest.mark.parametrize("language", ["json", "JSON"])
def test_json_fence_language_case_preserves_valid_response(language):
    raw = result()
    response = f"```{language}\n{json.dumps(raw, ensure_ascii=False)}\n```"
    assert CatalogPostAnalyzer.parse(response, 2, POST) == parse(raw)


def test_truncated_json_fence_is_not_accepted():
    response = "```JSON\n" + json.dumps(result(), ensure_ascii=False)[:-1] + "\n```"
    with pytest.raises(json.JSONDecodeError):
        CatalogPostAnalyzer.parse(response, 2, POST)


def make_analyzer():
    return CatalogPostAnalyzer(SimpleNamespace(attempts=build_image_llm_attempts(
                                                  fallback_provider="api:openai", fallback_model=SOL,
                                                  fallback_effort="medium"),
                                              api_clients={LUNA: object(), SOL: object()}))


def test_defaults_use_luna_max_for_text_and_images():
    assert build_text_llm_attempts()[0]["model"] == LUNA
    assert build_image_llm_attempts() == [
        {"kind": "api", "provider": "openai", "model": LUNA, "effort": "max"},
        {"kind": "cli", "provider": "grok", "model": "grok-4.7", "effort": "medium"},
    ]
    config = TwitterConfig({})
    assert (config.image_llm_provider, config.image_llm_model, config.image_llm_effort) == ("api:openai", LUNA, "max")
    assert config.api_reasoning_effort == "max"


def test_fallback_disabled_does_not_inject_an_implicit_candidate():
    assert build_text_llm_attempts(fallback_enabled=False) == [
        {"kind": "api", "provider": "", "model": LUNA, "effort": "max"},
    ]
    assert build_image_llm_attempts(fallback_enabled=False) == [
        {"kind": "api", "provider": "openai", "model": LUNA, "effort": "max"},
    ]


def test_post_role_attempts_are_used_for_joint_instead_of_vision_attempts(tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        "src.processors.twitter_post_processor.TwitterExtractor",
        lambda **kwargs: captured.update(text_attempts=kwargs["attempts"]) or SimpleNamespace(),
    )
    monkeypatch.setattr(
        "src.processors.twitter_post_processor.CatalogImageAnalyzer",
        lambda **kwargs: SimpleNamespace(
            attempts=kwargs["attempts"], api_clients={}, api_reasoning_effort_map={}
        ),
    )
    processor = TwitterPostProcessor(TwitterConfig({
        "output_dir": str(tmp_path),
        "image_llm_provider": "api:openai",
        "image_llm_model": "vision-model",
        "image_llm_effort": "max",
        "image_fallback_llm_provider": "api:openai",
        "image_fallback_llm_model": "vision-fallback",
        "oshinagaki_post": {
            "provider": "api:openai",
            "model": "post-model",
            "effort": "low",
            "fallback_provider": "api:xai",
            "fallback_model": "post-fallback",
            "fallback_effort": "medium",
        },
    }))
    assert [attempt["model"] for attempt in captured["text_attempts"]] == [
        "post-model", "post-fallback",
    ]
    assert [attempt["model"] for attempt in processor.catalog_post_analyzer.attempts] == [
        "post-model", "post-fallback",
    ]
    assert processor.catalog_post_analyzer.attempts[0]["effort"] == "low"


def test_grok_unknown_delivery_stops_joint_fallback(monkeypatch):
    attempts = [
        {"kind": "cli", "provider": "grok", "model": "grok-4.7", "effort": "medium"},
        {"kind": "api", "provider": "openai", "model": LUNA, "effort": "max"},
    ]
    analyzer = CatalogPostAnalyzer(SimpleNamespace(attempts=attempts, api_clients={LUNA: object()}))
    monkeypatch.setattr(
        analyzer,
        "_request_grok",
        Mock(side_effect=GrokBuildError("unknown_delivery", "fixture")),
    )
    request = Mock(side_effect=AssertionError("後続APIへ進めない"))
    monkeypatch.setattr(analyzer, "_request", request)
    with pytest.raises(GrokBuildError) as error:
        analyzer.analyze([], POST)
    assert error.value.code == "unknown_delivery"
    request.assert_not_called()


def test_anthropic_joint_request_uses_messages_content_for_all_images(monkeypatch, tmp_path):
    from src.utils import llm_client

    calls = []

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "content": [{"type": "text", "text": json.dumps(result())}],
                "usage": {"input_tokens": 2, "output_tokens": 3},
            }

    monkeypatch.setattr(
        llm_client.requests,
        "post",
        lambda url, **kwargs: calls.append((url, kwargs)) or Response(),
    )
    images = []
    for index in range(2):
        path = tmp_path / f"anthropic-{index}.png"
        Image.new("RGB", (8, 8), "white").save(path)
        images.append(path)
    model = "claude-post"
    llm = SimpleNamespace(
        clients=[{"model": model, "api_type": "anthropic", "api_key": "dummy-key", "client": None}],
        api_provider_map={model: "anthropic"},
        _api_reasoning_effort_for=lambda _model: "low",
    )
    analyzer = CatalogPostAnalyzer(
        SimpleNamespace(
            attempts=[{"kind": "api", "provider": "anthropic", "model": model, "effort": "low"}],
            api_clients={model: llm},
        )
    )
    parsed = analyzer.analyze(images, POST)
    assert parsed["model"] == model
    assert len(calls) == 1
    body = calls[0][1]["json"]
    assert body["model"] == model
    assert len([part for part in body["messages"][0]["content"] if part["type"] == "image"]) == 2


def test_modern_post_role_does_not_initialize_unused_vision_analyzer(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "src.processors.twitter_post_processor.TwitterExtractor",
        lambda **kwargs: SimpleNamespace(attempts=kwargs["attempts"]),
    )

    def fail_vision_init(**_kwargs):
        raise AssertionError("vision analyzer must remain lazy for modern post role")

    monkeypatch.setattr("src.processors.twitter_post_processor.CatalogImageAnalyzer", fail_vision_init)
    processor = TwitterPostProcessor(TwitterConfig({
        "output_dir": str(tmp_path),
        "image_llm_provider": "api:gemini",
        "image_llm_model": "vision-without-key",
        "image_fallback_llm_enabled": False,
        "oshinagaki_post": {
            "provider": "api:openai",
            "model": "post-model",
            "effort": "low",
            "fallback_enabled": False,
        },
    }))
    assert processor.catalog_analyzer is None
    assert processor.catalog_post_analyzer.attempts[0]["model"] == "post-model"


def test_explicit_cli_configuration_is_not_silently_rerouted():
    attempts = build_image_llm_attempts("cli:antigravity", "custom", "none")
    assert not CatalogPostAnalyzer.supports(attempts)
    assert attempts == [{"kind": "cli", "provider": "antigravity", "model": "custom", "effort": "none"}]
    assert not catalog_post.enabled(SimpleNamespace())


def test_evidence_and_free_correction_are_retained():
    item = product(price=0, price_basis="free_explicit", price_text="無料", price_image_index=0,
                   text_evidence="訂正：新刊Aは無料", source_image_indices=[1, 2])
    parsed = parse(result(item), "訂正：新刊Aは無料です")
    assert parsed["items"][0]["price"] == 0
    assert parsed["items"][0]["catalog_evidence"]["price_basis"] == "free_explicit"


def test_unknown_price_is_distinct_from_free():
    parsed = parse(result(product(price=0, price_basis="not_shown", price_text="", price_image_index=None)))
    assert parsed["items"][0]["catalog_evidence"]["price_basis"] == "not_shown"


@pytest.mark.parametrize("quote,price", [("各５００円", 500), ("￥5,000", 5000), ("各1500円", 1500), ("700", 700)])
def test_price_digits_and_shared_prices(quote, price):
    assert parse(result(product(price=price, price_text=quote)))["items"][0]["price"] == price


@pytest.mark.parametrize("change", [
    {"price": True}, {"price": -1}, {"price": 50}, {"price": "500"},
    {"price_basis": "unknown"}, {"price_basis": "free_explicit", "price": 0},
    {"price_basis": "not_shown", "price": 0}, {"price_image_index": 3},
    {"price_image_index": True}, {"price_image_index": 2},
    {"price_image_index": 0}, {"price_text": ""},
    {"source_image_indices": [True]}, {"source_image_indices": [3]},
    {"source_image_indices": []}, {"name": ""}, {"type": "invalid"},
    {"sale_kind": "component"}, {"text_evidence": "存在しない引用"},
    {"needs_review": True, "review_reason": "500か5000か不明"},
])
def test_unverified_item_is_not_accepted(change):
    with pytest.raises(ValueError):
        parse(result(product(**change)))


@pytest.mark.parametrize("change", [
    {"classification": "unknown"}, {"event_match": "mismatch"},
    {"is_existing_only": "false"}, {"catalog_image_indices": [3]},
    {"catalog_image_indices": []}, {"items": None}, {"items": []},
    {"classification": "preview"}, {"classification": "not_catalog"},
])
def test_invalid_post_response_is_not_accepted(change):
    with pytest.raises(ValueError):
        parse(result(**change))


def test_duplicate_images_deduplicate_but_sets_remain_separate():
    parsed = parse(result(product(), product(source_image_indices=[2], price_image_index=2),
                          product(sale_kind="set", name="新刊Aセット", price=1000, price_text="1000円")))
    assert len(parsed["items"]) == 2
    assert parsed["items"][0]["catalog_evidence"]["image_indices"] == [1, 2]


def test_conflicting_duplicate_prices_require_repair():
    with pytest.raises(ValueError, match="矛盾"):
        parse(result(product(), product(price=5000, price_text="5000円")))


def test_text_only_products_require_literal_source():
    parsed = parse(result(product(source_image_indices=[], price_image_index=0, text_evidence=POST),
                          catalog_image_indices=[]), count=0)
    assert parsed["items"][0]["catalog_evidence"]["text"] == POST


@pytest.mark.parametrize("envelope", ["output_text", "output"])
def test_responses_payload_contains_all_original_images_text_and_max(tmp_path, monkeypatch, envelope):
    from src.utils import api_cost_tracker
    from src.utils.llm_client import LLMClient

    calls, costs = [], []
    paths = []
    for index, fmt in enumerate(("PNG", "WEBP")):
        path = tmp_path / f"image{index}.jpg"  # MIMEは拡張子ではなく実体を確認する。
        Image.new("RGB", (16, 16), (index * 30, 0, 0)).save(path, format=fmt)
        paths.append(path)
    body = json.dumps(result(), ensure_ascii=False)
    payload = {"status": "completed", "usage": {"input_tokens": 12, "output_tokens": 7}}
    if envelope == "output_text":
        payload["output_text"] = body
    else:
        payload["output"] = [{"type": "message", "content": [{"type": "output_text", "text": body}]}]
    sdk = SimpleNamespace(responses=SimpleNamespace(create=lambda **kwargs: calls.append(kwargs) or payload))
    llm = SimpleNamespace(clients=[{"model": LUNA, "api_type": "openai", "client": sdk}],
        _api_reasoning_effort_for=lambda model: "max", _client_with_timeout=lambda client, timeout: client,
        _uses_responses_api=LLMClient._uses_responses_api, _responses_output_text=LLMClient._responses_output_text,
        _response_field=LLMClient._response_field)
    monkeypatch.setattr(api_cost_tracker, "get_cost_tracker", lambda: SimpleNamespace(add_tokens=lambda *args: costs.append(args)))
    analyzer = CatalogPostAnalyzer(SimpleNamespace(attempts=[build_image_llm_attempts()[0]], api_clients={LUNA: llm}))
    parsed = analyzer.analyze(paths, POST, "テストイベント", "2026-09-13")
    assert parsed["model"] == LUNA
    assert len(calls) == 1
    assert calls[0]["reasoning"] == {"effort": "max"}
    content = calls[0]["input"][0]["content"]
    images = [part for part in content if part["type"] == "input_image"]
    assert len(images) == 2 and all(image["detail"] == "high" for image in images)
    assert images[0]["image_url"].startswith("data:image/png;base64,")
    assert images[1]["image_url"].startswith("data:image/webp;base64,")
    assert POST in content[0]["text"] and "テストイベント" in content[0]["text"] and "2026-09-13" in content[0]["text"]
    assert costs == [(LUNA, 12, 7)]


def test_unknown_openai_joint_request_omits_reasoning_none(tmp_path, monkeypatch):
    from src.utils import api_cost_tracker

    model = "gpt-new-live-generative"
    calls = []
    path = tmp_path / "future.png"
    Image.new("RGB", (8, 8), "white").save(path)

    sdk = SimpleNamespace(
        responses=SimpleNamespace(
            create=lambda **kwargs: calls.append(kwargs)
            or {
                "output_text": json.dumps(result(catalog_image_indices=[1])),
                "status": "completed",
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }
        )
    )
    llm = SimpleNamespace(
        clients=[{"model": model, "api_type": "openai", "client": sdk}],
        _api_reasoning_effort_for=lambda _model, override=None, provider=None: None,
        _client_with_timeout=lambda client, timeout: client,
        _uses_responses_api=lambda _model: True,
        _responses_output_text=lambda response: response["output_text"],
        _response_field=lambda obj, key, default=None: obj.get(key, default),
    )
    monkeypatch.setattr(
        api_cost_tracker,
        "get_cost_tracker",
        lambda: SimpleNamespace(add_tokens=lambda *_args: None),
    )
    analyzer = CatalogPostAnalyzer(
        SimpleNamespace(
            attempts=[
                {
                    "kind": "api",
                    "provider": "openai",
                    "model": model,
                    "effort": "none",
                }
            ],
            api_clients={model: llm},
        )
    )

    parsed = analyzer.analyze([path], POST)
    assert parsed["model"] == model
    assert len(calls) == 1
    assert "reasoning" not in calls[0]


def test_invalid_response_repairs_only_once_then_uses_configured_fallback(monkeypatch):
    analyzer = make_analyzer()
    calls = []
    def request(llm, model, prompt, images, deadline):
        calls.append((model, prompt, len(images)))
        return "not JSON" if model == LUNA else json.dumps(result(product(source_image_indices=[], price_image_index=0, text_evidence=POST), catalog_image_indices=[]))
    monkeypatch.setattr(analyzer, "_request", request)
    parsed = analyzer.analyze([], POST)
    assert parsed["model"] == SOL
    assert [call[0] for call in calls] == [LUNA, LUNA, SOL]
    assert POST in calls[1][1] and "前回" in calls[1][1]


def test_api_exception_moves_to_fallback_without_blind_validation_retry(monkeypatch):
    analyzer = make_analyzer()
    calls = []
    def request(llm, model, prompt, images, deadline):
        calls.append(model)
        if model == LUNA:
            raise OSError("unavailable")
        return json.dumps(result(product(source_image_indices=[], price_image_index=0, text_evidence=POST), catalog_image_indices=[]))
    monkeypatch.setattr(analyzer, "_request", request)
    assert analyzer.analyze([], POST)["model"] == SOL
    assert calls == [LUNA, SOL]


def test_deadline_never_accepts_or_retries_late_result(monkeypatch):
    analyzer = make_analyzer()
    now, calls = [0.0], []
    deadline = ReprocessDeadline(timeout_seconds=1, clock=lambda: now[0])
    def request(*args):
        calls.append(True)
        now[0] = 2.0
        return "not JSON"
    monkeypatch.setattr(analyzer, "_request", request)
    with pytest.raises(ReprocessDeadlineExceeded):
        analyzer.analyze([], POST, deadline=deadline)
    assert len(calls) == 1


def prepare_processor(tmp_path, monkeypatch, responses):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = TwitterConfig({"output_dir": str(tmp_path), "event_date": "2026-09-13"})
    processor.output_path = tmp_path
    processor.effective_additional_prompt = "イベントの略称"
    processor._post_reprocess_cache = {}
    processor.catalog_post_analyzer = make_analyzer()
    replies = iter(responses)
    requests, downloads, fetches = [], [], []
    def request(llm, model, prompt, images, deadline):
        requests.append((model, prompt, images))
        response = next(replies)
        if isinstance(response, Exception):
            raise response
        return json.dumps(response, ensure_ascii=False)
    monkeypatch.setattr(processor.catalog_post_analyzer, "_request", request)
    async def download(url, output_path, filename):
        downloads.append(url)
        image = Path(output_path) / filename
        Image.new("RGB", (8, 8), (len(downloads) * 10, 0, 0)).save(image, format="PNG")
        return image
    async def fetch(tweet_id, **kwargs):
        fetches.append(tweet_id)
        return {"text": POST, "media_urls": MEDIA}
    processor._fetch_tweet_detail = fetch
    processor.twitter_extractor = SimpleNamespace(download_catalog_image=download,
        llm_client=SimpleNamespace(analyze_catalog_tweet_detail=Mock(side_effect=AssertionError("text-only detail")),
            extract_catalog_items_from_text=Mock(side_effect=AssertionError("text-only extraction"))))
    return processor, requests, downloads, fetches


def test_direct_post_joint_replaces_catalog_preserves_checks_and_image_mapping(tmp_path, monkeypatch):
    processor, requests, downloads, _ = prepare_processor(tmp_path, monkeypatch, [result(product(source_image_indices=[2], price_image_index=0, text_evidence=POST))])
    circle = Circle(name="circle", items=[{"name": "新刊A", "type": "新刊(漫画)", "price": 5000, "checked": 1}], existing_only_status="既刊のみ")
    trace = []
    assert asyncio.run(processor.process_circle_from_post_url(circle, URL, "event", use_text_detail=True, trace=trace))
    assert len(requests) == 1 and len(requests[0][2]) == 2 and downloads == MEDIA
    assert circle.items[0]["price"] == 500 and circle.items[0]["checked"] == 1
    assert circle.items[0]["image"] == circle.item_images[1].path
    assert circle.items[0]["catalog_evidence"]["source_url"] == URL
    assert circle.existing_only_status is None and circle.catalog_status == "confirmed"
    assert [event["stage"] for event in trace if event["outcome"] == "end"][-1] == "catalog.joint"
    assert not list(tmp_path.glob(".catalog_joint_*"))


def test_free_correction_overrides_old_nonzero_price(tmp_path, monkeypatch):
    raw = result(product(price=0, price_basis="free_explicit", price_text="無料", price_image_index=0, text_evidence="新刊Aは無料"))
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    async def fetch(*args, **kwargs):
        return {"text": "訂正：新刊Aは無料", "media_urls": MEDIA}
    processor._fetch_tweet_detail = fetch
    circle = Circle(name="circle", items=[{"name": "新刊A", "type": "新刊(漫画)", "price": 500}])
    asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert circle.items[0]["price"] == 0


def test_partial_download_does_not_call_model_or_change_circle(tmp_path, monkeypatch):
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [])
    original_download = processor.twitter_extractor.download_catalog_image
    async def download(url, *args):
        return None if url == MEDIA[1] else await original_download(url, *args)
    processor.twitter_extractor.download_catalog_image = download
    circle = Circle(name="circle", items=[{"name": "old", "price": 100}], item_images=[ItemImage(path="old.png")])
    before = copy.deepcopy(circle.__dict__)
    with pytest.raises(RuntimeError, match="全画像"):
        asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert requests == [] and circle.__dict__ == before and processor._joint_post_cache == {}
    assert list(tmp_path.iterdir()) == []


def test_invalid_analysis_does_not_change_circle_or_cache(tmp_path, monkeypatch):
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [result(product(price=50))] * 4)
    circle = Circle(name="circle", items=[{"name": "old", "price": 100}])
    before = copy.deepcopy(circle.__dict__)
    with pytest.raises(RuntimeError) as error:
        asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert error.value.stage == "catalog.joint"
    assert len(requests) == 4 and circle.__dict__ == before
    assert processor._joint_post_cache == {} and list(tmp_path.iterdir()) == []


def test_cache_is_event_scoped_and_preserves_each_circles_purchase_state(tmp_path, monkeypatch):
    processor, requests, _, fetches = prepare_processor(tmp_path, monkeypatch, [result(), result()])
    first = Circle(name="first", items=[{"name": "新刊A", "type": "新刊(漫画)", "checked": 1}])
    second = Circle(name="second", items=[{"name": "新刊A", "type": "新刊(漫画)", "checked": 2}])
    asyncio.run(processor.process_circle_from_post_url(first, URL, "A"))
    asyncio.run(processor.process_circle_from_post_url(second, URL, "A"))
    assert second.items[0]["checked"] == 2 and len(requests) == 1
    asyncio.run(processor.process_circle_from_post_url(second, URL, "B"))
    assert len(requests) == 2 and len(fetches) == 2


def test_normal_crawl_bypasses_text_preview_and_keeps_posts_paired(tmp_path, monkeypatch):
    preview = result(items=[], classification="preview", catalog_image_indices=[])
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [preview, result()])
    candidates = [{"text": "予告", "media": [MEDIA[0]], "url": URL, "is_best": True},
                  {"text": "完成版の本文", "media": MEDIA, "url": URL + "4"}]
    async def extract(**kwargs):
        return candidates
    processor.twitter_extractor.extract_catalog_tweets = extract
    circle = Circle(name="circle")
    asyncio.run(processor._process_with_twscrape(circle, "user", datetime(2026, 9, 13), "event"))
    assert circle.catalog_status == "confirmed" and circle.items[0]["name"] == "新刊A"
    assert "予告" in requests[0][1] and len(requests[0][2]) == 1
    assert "完成版の本文" in requests[1][1] and len(requests[1][2]) == 2


def test_normal_failure_restores_checked_tweets(tmp_path, monkeypatch):
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [OSError("offline")] * 2)
    class Candidates(list):
        checked_tweet_ids = [123]
    async def extract(**kwargs):
        return Candidates([{"text": POST, "media": MEDIA, "url": URL}])
    processor.twitter_extractor.extract_catalog_tweets = extract
    circle = Circle(name="circle", items=[{"name": "old"}])
    circle._checked_tweet_ids = [7]
    with pytest.raises(RuntimeError):
        asyncio.run(processor._process_with_twscrape(circle, "user", datetime(2026, 9, 13), "event"))
    assert circle._checked_tweet_ids == [7] and circle.items == [{"name": "old"}]


def test_text_only_post_uses_same_joint_route(tmp_path, monkeypatch):
    raw = result(product(source_image_indices=[], price_image_index=0, text_evidence=POST), catalog_image_indices=[])
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    async def fetch(*args, **kwargs):
        return {"text": POST, "media_urls": []}
    processor._fetch_tweet_detail = fetch
    circle = Circle(name="circle")
    assert asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert len(requests) == 1 and requests[0][2] == []
    assert circle.item_images == [] and circle.items[0]["price"] == 500


def test_expired_deadline_cannot_replay_cache(tmp_path, monkeypatch):
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [result()])
    circle = Circle(name="circle")
    asyncio.run(processor.process_circle_from_post_url(circle, URL))
    before = copy.deepcopy(circle.__dict__)
    with pytest.raises(ReprocessDeadlineExceeded):
        asyncio.run(processor.process_circle_from_post_url(circle, URL, deadline=ReprocessDeadline(timeout_seconds=0)))
    assert circle.__dict__ == before


@pytest.mark.parametrize("quote,price", [("B5 500円", 5), ("500円→700円", 500), ("500.50円", 50), ("B5", 5)])
def test_non_price_digits_or_ambiguous_amounts_are_not_evidence(quote, price):
    with pytest.raises(ValueError):
        parse(result(product(price_text=quote, price=price)))


def test_timeout_while_executor_finishes_late_does_not_mutate_data(tmp_path, monkeypatch):
    import time
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [])
    def late(*args, **kwargs):
        time.sleep(0.05)
        return {**parse(result()), "model": LUNA}
    monkeypatch.setattr(processor.catalog_post_analyzer, "analyze", late)
    circle = Circle(name="circle", items=[{"name": "old"}])
    before = copy.deepcopy(circle.__dict__)
    with pytest.raises(ReprocessDeadlineExceeded):
        asyncio.run(processor.process_circle_from_post_url(circle, URL, deadline=ReprocessDeadline(timeout_seconds=0.02)))
    assert circle.__dict__ == before and processor._joint_post_cache == {}
    assert list(tmp_path.iterdir()) == []


def test_explicit_other_event_auto_does_not_replace_existing_data(tmp_path, monkeypatch):
    raw = result(items=[], classification="not_catalog", event_match="mismatch", catalog_image_indices=[])
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle", items=[{"name": "old"}])
    before = copy.deepcopy(circle.__dict__)
    assert asyncio.run(catalog_post.process_post(processor, circle, POST, MEDIA, "event")) is None
    assert len(requests) == 1 and circle.__dict__ == before


def test_automatic_direct_post_rejects_other_event(tmp_path, monkeypatch):
    raw = result(items=[], classification="not_catalog", event_match="mismatch", catalog_image_indices=[])
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle", items=[{"name": "old"}])
    before = copy.deepcopy(circle.__dict__)
    assert not asyncio.run(processor.process_circle_from_post_url(circle, URL, "event", manual=False))
    assert circle.__dict__ == before and len(requests) == 1
    assert processor._last_direct_post_outcome == "not_catalog"


@pytest.mark.parametrize("kind", ["absence", "preview"])
def test_manual_non_catalog_kinds_preserve_goods_and_cache(tmp_path, monkeypatch, kind):
    raw = result(items=[], classification=kind, catalog_image_indices=[])
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    first = Circle(name="first", items=[{"name": "old", "checked": 1}])
    second = Circle(name="second", items=[{"name": "other", "checked": 2}])
    for circle in (first, second):
        before = copy.deepcopy(circle.items)
        assert asyncio.run(processor.process_circle_from_post_url(circle, URL))
        assert circle.items == before
        assert (circle.absence_status == "欠席") if kind == "absence" else (circle.catalog_status == "preview")
    assert len(requests) == 1
    assert '"classification": "confirmed|preview|absence"' in requests[0][1]


@pytest.mark.parametrize("kind", ["not_catalog", "irrelevant", "", None])
def test_manual_invalid_kind_rejected(kind):
    raw = result(items=[], classification=kind, catalog_image_indices=[])
    with pytest.raises(ValueError, match="classification"):
        CatalogPostAnalyzer.parse(json.dumps(raw), 2, POST, manual=True)


def test_manual_confirmed_requires_items():
    with pytest.raises(ValueError, match="商品が抽出"):
        CatalogPostAnalyzer.parse(json.dumps(result(items=[], catalog_image_indices=[])), 2, POST, manual=True)


def test_preview_does_not_delete_existing_goods(tmp_path, monkeypatch):
    raw = result(items=[], classification="preview", catalog_image_indices=[])
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle", items=[{"name": "old", "price": 200, "checked": 1}])
    assert asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert circle.catalog_status == "preview" and circle.items == [{"name": "old", "price": 200, "checked": 1}]
    assert list(tmp_path.iterdir()) == []


def test_input_images_are_not_resized_or_reencoded(tmp_path):
    import base64
    path = tmp_path / "catalog.png"
    Image.new("RGB", (1200, 800)).save(path)
    encoded = CatalogPostAnalyzer._image_data([path])[0]
    assert base64.b64decode(encoded["data"]) == path.read_bytes()


def test_image_payload_limit_is_checked_before_api_call(tmp_path, monkeypatch):
    path = tmp_path / "catalog.png"
    Image.new("RGB", (16, 16)).save(path)
    analyzer = make_analyzer()
    monkeypatch.setattr(CatalogPostAnalyzer, "MAX_TOTAL_IMAGE_BYTES", 1)
    request = Mock(side_effect=AssertionError("API must not run"))
    monkeypatch.setattr(analyzer, "_request", request)
    with pytest.raises(ValueError, match="上限"):
        analyzer.analyze([path], POST)
    request.assert_not_called()


@pytest.mark.parametrize("quote,price", [("1万円", 10000), ("0.5万円", 5000), ("各2千円", 2000)])
def test_japanese_price_units(quote, price):
    assert parse(result(product(price_text=quote, price=price)))["items"][0]["price"] == price


@pytest.mark.parametrize("change", [{"classification": []}, {"event_match": []}])
def test_invalid_enum_shapes_raise_validation_error(change):
    with pytest.raises(ValueError):
        parse(result(**change))


def test_duplicate_json_keys_are_rejected():
    response = json.dumps(result()).replace('"price": 500', '"price": 50, "price": 500')
    with pytest.raises(ValueError, match="重複"):
        CatalogPostAnalyzer.parse(response, 2, POST)


def grok_analyzer():
    return CatalogPostAnalyzer(SimpleNamespace(attempts=build_image_llm_attempts(),
                                              api_clients={LUNA: object()}))


def test_default_image_fallback_is_a_different_vendor_than_the_primary():
    primary, fallback = build_image_llm_attempts()
    assert (primary["kind"], primary["provider"]) == ("api", "openai")
    assert (fallback["kind"], fallback["provider"]) == ("cli", "grok")
    assert CatalogPostAnalyzer.supports(build_image_llm_attempts())
    # 同じOpenAIの主+fallbackなら429で道連れ、という設定が既定に戻らないこと
    assert text_fallback_is_distinct()


def text_fallback_is_distinct():
    primary, fallback = build_text_llm_attempts()
    return (primary["kind"], primary["provider"]) != (fallback["kind"], fallback["provider"])


def test_fallback_identical_to_primary_is_deduplicated_without_injecting_default():
    attempts = build_image_llm_attempts("api:openai", SOL, "medium", "api:openai", SOL, "medium")
    assert attempts == [{"kind": "api", "provider": "openai", "model": SOL, "effort": "medium"}]
    text = build_text_llm_attempts("api", SOL, None, None, "api:openai", SOL, "medium")
    assert text == [{"kind": "api", "provider": "", "model": SOL, "effort": None}]


def test_explicit_other_model_fallback_is_kept():
    attempts = build_image_llm_attempts("api:openai", LUNA, "max", "api:openai", SOL, "medium")
    assert [a["model"] for a in attempts] == [LUNA, SOL]


def test_openai_429_falls_back_to_grok_build_with_all_images(monkeypatch, tmp_path):
    analyzer = grok_analyzer()
    images = []
    for name in ("a.png", "b.png"):
        path = tmp_path / name
        Image.new("RGB", (8, 8), "white").save(path)
        images.append(path)
    monkeypatch.setattr(analyzer, "_request", Mock(side_effect=RuntimeError("429 rate limit")))
    sent = []

    def fake_grok(prompt, **kwargs):
        sent.append((prompt, kwargs))
        return True, json.dumps(result(product(), catalog_image_indices=[1, 2]))

    monkeypatch.setattr("src.utils.grok_build.execute_grok_build_prompt", fake_grok)
    parsed = analyzer.analyze(images, POST)
    assert parsed["model"] == "grok-4.7"
    assert len(sent) == 1 and sent[0][1]["image_paths"] == images
    assert "image_index=2" in sent[0][0]

def test_manual_partial_review_preserves_existing_and_cache_per_circle(tmp_path, monkeypatch):
    raw = result(product(name="確定品"), product(name="不確定品", needs_review=True, review_reason="価格が読めない"))
    processor, requests, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    first = Circle(name="first", items=[{"name": "不確定品", "type": "新刊(漫画)", "price": 123, "checked": 1, "description": "手編集"}, {"name": "追加品", "price": 9}])
    second = Circle(name="second", items=[{"name": "不確定品", "type": "新刊(漫画)", "price": 456, "checked": 2}])
    for circle in (first, second):
        assert asyncio.run(processor.process_circle_from_post_url(circle, URL, "event"))
        assert circle.catalog_status == "needs_recheck"
        assert "価格が読めない" in circle.memo
        assert any(item["name"] == "確定品" and item["price"] == 500 for item in circle.items)
    assert first.items[0]["price"] == 123 and first.items[0]["description"] == "手編集" and first.items[0]["checked"] == 1
    assert first.items[1]["name"] == "追加品"
    assert second.items[0]["price"] == 456 and second.items[0]["checked"] == 2
    assert len(requests) == 1


def test_manual_all_review_and_missing_price_are_not_free(tmp_path, monkeypatch):
    raw = result(product(needs_review=True, review_reason="500か5000か不明", price_text="¥500/¥5000"),
                 product(name="価格なし", price=0, price_basis="not_shown", price_text="", price_image_index=None),
                 product(name="無料", price=0, price_basis="free_explicit", price_text="無料"))
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle")
    assert asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert circle.catalog_status == "needs_recheck"
    assert {i["name"]: i["price"] for i in circle.items} == {"新刊A": None, "価格なし": None, "無料": 0}
    assert "500か5000か不明" in circle.memo and "価格未記載" in circle.memo


def test_manual_unrepresentable_review_is_visible(tmp_path, monkeypatch):
    raw = result(product(name="", needs_review=True, review_reason="判読不能"))
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle", items=[{"name": "既存", "price": 100}])
    assert asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert circle.items == [{"name": "既存", "price": 100}]
    assert circle.catalog_status == "needs_recheck" and "判読不能" in circle.memo

def test_partial_review_failed_staging_keeps_original_lists(tmp_path, monkeypatch):
    raw = result(product(needs_review=True, review_reason="価格不明"))
    processor, _, _, _ = prepare_processor(tmp_path, monkeypatch, [raw])
    circle = Circle(name="circle", items=[{"name": "既存", "price": 100}], item_images=[ItemImage(path="old.png")])
    before = copy.deepcopy(circle.__dict__)
    original_apply = catalog_post._apply

    def fail_after_staging(processor, target, state, post_url):
        original_apply(processor, target, state, post_url)
        if state.get("_partial_review"):
            raise RuntimeError("stage failure")

    monkeypatch.setattr(catalog_post, "_apply", fail_after_staging)
    with pytest.raises(RuntimeError, match="stage failure"):
        asyncio.run(processor.process_circle_from_post_url(circle, URL))
    assert circle.__dict__ == before
    assert processor._joint_post_cache == {}


@pytest.mark.parametrize("review_first", [True, False])
def test_manual_review_duplicate_keeps_confirmed_and_reason(review_first):
    confirmed = product()
    uncertain = product(needs_review=True, review_reason="価格が不明")
    items = [uncertain, confirmed] if review_first else [confirmed, uncertain]
    parsed = CatalogPostAnalyzer.parse(json.dumps(result(*items), ensure_ascii=False), 2, POST, manual=True)
    assert len(parsed["items"]) == 1 and parsed["items"][0]["price"] == 500
    assert "価格が不明" in parsed["review_notes"][0]


def test_manual_review_price_evidence_and_schema():
    items = [product(name="仮題", needs_review=True, review_reason="題名不明"),
             product(name="対応不明", needs_review=True, review_reason="対応不明", price_text="¥500/¥1000")]
    parsed = CatalogPostAnalyzer.parse(json.dumps(result(*items), ensure_ascii=False), 2, POST, manual=True)
    assert [item["price"] for item in parsed["items"]] == [500, None]
    for changes in ({"price_text": None}, {"price_image_index": 99}, {"price_basis": "invalid"}, {"price": "500"}):
        bad = product(needs_review=True, review_reason="要確認", **changes)
        with pytest.raises(ValueError):
            CatalogPostAnalyzer.parse(json.dumps(result(bad), ensure_ascii=False), 2, POST, manual=True)

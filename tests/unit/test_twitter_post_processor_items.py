from __future__ import annotations

import asyncio
from types import SimpleNamespace

from src.utils.llm_client import LLMClient
from src.utils.catalog_image_analyzer import CatalogImageAnalyzer
from src.utils.twitter_extractor import CatalogTweetResult
from src.models import Circle, ItemImage
from src.processors.twitter_post_processor import TwitterPostProcessor


def test_apply_catalog_detail_does_not_create_items_from_text_products():
    processor = object.__new__(TwitterPostProcessor)
    circle = Circle(name="サークルA")

    processor._apply_catalog_detail(
        circle,
        {
            "classification": "confirmed",
            "is_existing_only": False,
            "existing_only_confidence": 0.0,
            "product_types": ["CD"],
            "genre": "音楽",
        },
    )

    assert circle.catalog_status == "confirmed"
    assert circle.items == []
    assert circle._product_types == ["CD"]


def test_circle_to_dict_serializes_catalog_status():
    circle = Circle(name="サークルA", catalog_status="confirmed")

    assert circle.to_dict()["catalog_status"] == "confirmed"


def test_extract_username_from_url_accepts_x_at_profile():
    assert (
        TwitterPostProcessor._extract_username_from_url("https://x.com/@syuheki_Stolk")
        == "syuheki_Stolk"
    )
    assert (
        TwitterPostProcessor._extract_username_from_url("https://twitter.com/@user_name")
        == "user_name"
    )


def test_extract_catalog_items_from_text_requires_specific_items(monkeypatch):
    client = object.__new__(LLMClient)
    client.logger = type("Logger", (), {"warning": lambda *args, **kwargs: None})()

    monkeypatch.setattr(
        client,
        "extract_data",
        lambda *args, **kwargs: '[{"name":"新刊A","type":"新刊(漫画)","price":500}]',
    )

    assert client.extract_catalog_items_from_text("新刊A 500円") == [
        {"name": "新刊A", "type": "新刊(漫画)", "price": 500, "description": "", "checked": 3}
    ]


def test_catalog_image_analyzer_skips_sample_page_response():
    analyzer = object.__new__(CatalogImageAnalyzer)

    result = analyzer._parse_response(
        """
        {
          "image_type": "sample_page",
          "is_catalog_image": false,
          "items": [
            {"name": "かつ丼", "type": "その他", "price": 0}
          ]
        }
        """
    )

    assert result == []


def test_catalog_image_analyzer_parses_catalog_object_response():
    analyzer = object.__new__(CatalogImageAnalyzer)

    result = analyzer._parse_response(
        """
        {
          "image_type": "catalog_menu",
          "is_catalog_image": true,
          "items": [
            {"name": "Album A", "type": "音楽", "price": 1000}
          ]
        }
        """
    )

    assert result == [
        {"name": "Album A", "type": "音楽", "price": 1000, "description": "", "checked": 3}
    ]


def test_catalog_image_analyzer_parses_cover_only_catalog_response():
    analyzer = object.__new__(CatalogImageAnalyzer)

    result = analyzer._parse_response(
        """
        {
          "image_type": "cover",
          "is_catalog_image": true,
          "items": [
            {"name": "表紙だけの新刊", "type": "新刊(漫画)", "price": 0}
          ]
        }
        """
    )

    assert result == [
        {"name": "表紙だけの新刊", "type": "新刊(漫画)", "price": 0, "description": "", "checked": 3}
    ]


def test_catalog_image_analyzer_keeps_legacy_array_response():
    analyzer = object.__new__(CatalogImageAnalyzer)

    result = analyzer._parse_response(
        '[{"name": "Album A", "type": "音楽", "price": 1000}]'
    )

    assert result == [
        {"name": "Album A", "type": "音楽", "price": 1000, "description": "", "checked": 3}
    ]


def test_process_circle_from_post_url_uses_detailed_text_items(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            return [{"name": "Album A", "type": "音楽", "price": 1000, "description": ""}]

    async def fake_fetch(_tweet_id):
        return {"text": "Album A 1000", "media_urls": []}

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    processor.twitter_extractor = SimpleNamespace(llm_client=FakeLLM())

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert circle.catalog_status == "confirmed"
    assert circle.items == [{"name": "Album A", "type": "音楽", "price": 1000, "description": "", "checked": 3}]


def test_process_circle_from_post_url_merges_image_and_text_items(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def __init__(self):
            self.text_calls = 0

        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            self.text_calls += 1
            return [{"name": "Album A", "type": "音楽", "price": 1000, "description": "text"}]

    async def fake_fetch(_tweet_id):
        return {"text": "Album A 1000", "media_urls": ["https://pbs.twimg.com/media/catalog.jpg"]}

    async def fake_download(circle, _img_url):
        circle.items = [{"name": "Album A", "type": "音楽", "price": 0, "description": "image"}]
        circle.item_images = [ItemImage(path="catalog.jpg", source="twitter")]
        return True

    fake_llm = FakeLLM()
    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)
    processor.twitter_extractor = SimpleNamespace(llm_client=fake_llm)

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert fake_llm.text_calls == 1
    assert circle.catalog_status == "confirmed"
    assert circle.items == [
        {
            "name": "Album A",
            "type": "音楽",
            "price": 1000,
            "description": "text",
            "image": "catalog.jpg",
            "checked": 3,
        }
    ]


def test_process_circle_from_post_url_consolidates_near_duplicate_items(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def __init__(self):
            self.consolidate_calls = 0

        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            return [{"name": "New Album A", "type": "音楽", "price": 1000, "description": "text"}]

        def consolidate_catalog_items(self, items, _event_name=""):
            self.consolidate_calls += 1
            assert [item["name"] for item in items] == ["Album A", "New Album A"]
            return [
                {
                    "name": "Album A",
                    "type": "音楽",
                    "price": 1000,
                    "description": "text",
                    "image": "catalog.jpg",
                    "checked": 3,
                }
            ]

    async def fake_fetch(_tweet_id):
        return {"text": "New Album A 1000", "media_urls": ["https://pbs.twimg.com/media/catalog.jpg"]}

    async def fake_download(circle, _img_url):
        circle.items = [{"name": "Album A", "type": "音楽", "price": 0, "description": "image", "image": "catalog.jpg"}]
        circle.item_images = [ItemImage(path="catalog.jpg", source="twitter")]
        return True

    fake_llm = FakeLLM()
    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)
    processor.twitter_extractor = SimpleNamespace(llm_client=fake_llm)

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert fake_llm.consolidate_calls == 1
    assert circle.items == [
        {
            "name": "Album A",
            "type": "音楽",
            "price": 1000,
            "description": "text",
            "image": "catalog.jpg",
            "checked": 3,
        }
    ]


def test_process_circle_from_post_url_replaces_existing_images(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    async def fake_fetch(_tweet_id):
        return {
            "text": "",
            "media_urls": [
                "https://pbs.twimg.com/media/new_a.jpg",
                "https://pbs.twimg.com/media/new_b.jpg",
            ],
        }

    async def fake_download(circle, img_url):
        name = img_url.rsplit("/", 1)[-1]
        circle.item_images.append(ItemImage(path=name, source="twitter"))
        return True

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)

    circle = Circle(name="circle")
    circle.items = [
        {"name": "Existing", "image": "old.jpg"},
        {"name": "Manual", "image": "manual.jpg"},
    ]
    circle.item_images = [ItemImage(path="old.jpg", source="twitter")]
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert [img.path for img in circle.item_images] == ["new_a.jpg", "new_b.jpg"]
    assert circle.items[0]["image"] == "new_a.jpg"
    assert circle.items[1]["image"] == "manual.jpg"


def test_process_circle_from_post_url_restores_existing_images_when_download_fails(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    async def fake_fetch(_tweet_id):
        return {"text": "", "media_urls": ["https://pbs.twimg.com/media/new_a.jpg"]}

    async def fake_download(_circle, _img_url):
        return False

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)

    circle = Circle(name="circle")
    circle.item_images = [ItemImage(path="old.jpg", source="twitter")]
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is False
    assert [img.path for img in circle.item_images] == ["old.jpg"]


def test_process_circle_from_post_url_keeps_preview_reprocessable(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "preview",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": [],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            raise AssertionError("preview should not extract items")

    async def fake_fetch(_tweet_id):
        return {"text": "preview", "media_urls": []}

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    processor.twitter_extractor = SimpleNamespace(llm_client=FakeLLM())

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert circle.catalog_status == "preview"
    assert circle.items == []


def test_process_circle_from_post_url_marks_confirmed_without_items_terminal(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            return []

    async def fake_fetch(_tweet_id):
        return {"text": "CD only", "media_urls": []}

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    processor.twitter_extractor = SimpleNamespace(llm_client=FakeLLM())

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is True
    assert circle.catalog_status == "no_extractable_items"
    assert circle.items == []


def test_process_circle_from_post_url_does_not_terminal_on_detail_error(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor._post_reprocess_cache = {}

    class FakeLLM:
        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": [],
                "error": True,
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            return []

    async def fake_fetch(_tweet_id):
        return {"text": "unknown", "media_urls": []}

    monkeypatch.setattr(processor, "_fetch_tweet_detail", fake_fetch)
    processor.twitter_extractor = SimpleNamespace(llm_client=FakeLLM())

    circle = Circle(name="circle")
    updated = asyncio.run(
        processor.process_circle_from_post_url(
            circle,
            "https://x.com/user/status/123",
            "event",
            use_text_detail=True,
        )
    )

    assert updated is False
    assert circle.catalog_status is None
    assert circle.items == []


def test_process_with_twscrape_uses_per_call_checked_ids():
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(days_before_event=30, days_after_event=7)

    class FakeExtractor:
        async def extract_catalog_tweets(self, **_kwargs):
            return CatalogTweetResult(checked_tweet_ids=[2, 3])

    processor.twitter_extractor = FakeExtractor()

    circle = Circle(name="circle", twitter_url="https://x.com/user")
    circle._skip_tweet_ids = [1, 2]

    result = asyncio.run(
        processor._process_with_twscrape(
            circle,
            "user",
            SimpleNamespace(strftime=lambda _fmt: "2026-05-24"),
            "event",
        )
    )

    assert result is circle
    assert sorted(circle._checked_tweet_ids) == [1, 2, 3]


def test_process_with_twscrape_merges_best_tweet_text_items(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(days_before_event=30, days_after_event=7)

    class FakeLLM:
        def __init__(self):
            self.text_calls = 0

        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            self.text_calls += 1
            return [{"name": "Text Bonus", "type": "音楽", "price": 500, "description": ""}]

    fake_llm = FakeLLM()

    class FakeExtractor:
        llm_client = fake_llm

        async def extract_catalog_tweets(self, **_kwargs):
            return CatalogTweetResult(
                [
                    {
                        "id": 3,
                        "text": "Album A 1000 / Text Bonus 500",
                        "media": ["https://pbs.twimg.com/media/catalog.jpg"],
                        "is_absence": False,
                        "is_best": True,
                        "url": "https://x.com/user/status/3",
                    }
                ],
                checked_tweet_ids=[3],
            )

    async def fake_download(circle, _img_url):
        circle.items = [{"name": "Album A", "type": "音楽", "price": 1000, "description": ""}]
        circle.item_images = [ItemImage(path="catalog.jpg", source="twitter")]
        return True

    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)
    processor.twitter_extractor = FakeExtractor()

    circle = Circle(name="circle", twitter_url="https://x.com/user")
    result = asyncio.run(
        processor._process_with_twscrape(
            circle,
            "user",
            SimpleNamespace(strftime=lambda _fmt: "2026-05-24"),
            "event",
        )
    )

    assert result is circle
    assert fake_llm.text_calls == 1
    assert circle.catalog_status == "confirmed"
    assert [item["name"] for item in circle.items] == ["Album A", "Text Bonus"]


def test_process_with_twscrape_processes_all_best_tweet_images(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(days_before_event=30, days_after_event=7)

    class FakeLLM:
        def analyze_catalog_tweet_detail(self, *_args, **_kwargs):
            return {
                "classification": "confirmed",
                "is_existing_only": False,
                "existing_only_confidence": 0.0,
                "product_types": ["CD"],
            }

        def extract_catalog_items_from_text(self, *_args, **_kwargs):
            return []

    class FakeExtractor:
        llm_client = FakeLLM()

        async def extract_catalog_tweets(self, **_kwargs):
            return CatalogTweetResult(
                [
                    {
                        "id": 3,
                        "text": "Album A / Album B",
                        "media": [
                            "https://pbs.twimg.com/media/catalog_a.jpg",
                            "https://pbs.twimg.com/media/catalog_b.jpg",
                        ],
                        "is_absence": False,
                        "is_best": True,
                        "url": "https://x.com/user/status/3",
                    }
                ],
                checked_tweet_ids=[3],
            )

    processed_urls = []

    async def fake_download(circle, img_url):
        processed_urls.append(img_url)
        name = img_url.rsplit("/", 1)[-1]
        circle.items.append({"name": name, "type": "髻ｳ讌ｽ", "price": 1000, "checked": 3})
        circle.item_images.append(ItemImage(path=name, source="twitter"))
        return True

    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)
    processor.twitter_extractor = FakeExtractor()

    circle = Circle(name="circle", twitter_url="https://x.com/user")
    result = asyncio.run(
        processor._process_with_twscrape(
            circle,
            "user",
            SimpleNamespace(strftime=lambda _fmt: "2026-05-24"),
            "event",
        )
    )

    assert result is circle
    assert processed_urls == [
        "https://pbs.twimg.com/media/catalog_a.jpg",
        "https://pbs.twimg.com/media/catalog_b.jpg",
    ]
    assert [img.path for img in circle.item_images] == ["catalog_a.jpg", "catalog_b.jpg"]


def test_process_with_grok_processes_all_tweet_images(monkeypatch):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(days_before_event=30, days_after_event=7)
    processor.effective_additional_prompt = ""

    class FakeGrok:
        async def search_catalog_tweet(self, **_kwargs):
            return {
                "found": True,
                "is_absence": False,
                "is_existing_only": False,
                "is_preview": False,
                "tweet_url": "https://x.com/user/status/3",
                "tweet_id": "3",
                "genre": "",
                "product_types": ["CD"],
            }

    async def fake_fetch_media(_tweet_id):
        return [
            "https://pbs.twimg.com/media/catalog_a.jpg",
            "https://pbs.twimg.com/media/catalog_b.jpg",
        ]

    processed_urls = []

    async def fake_download(circle, img_url):
        processed_urls.append(img_url)
        name = img_url.rsplit("/", 1)[-1]
        circle.item_images.append(ItemImage(path=name, source="twitter"))
        return True

    processor.grok_client = FakeGrok()
    monkeypatch.setattr(processor, "_fetch_tweet_media", fake_fetch_media)
    monkeypatch.setattr(processor, "_download_and_process_image", fake_download)

    circle = Circle(name="circle", twitter_url="https://x.com/user")
    result = asyncio.run(
        processor._process_with_grok(
            circle,
            "user",
            SimpleNamespace(strftime=lambda _fmt: "2026-05-24"),
            "event",
        )
    )

    assert result is circle
    assert processed_urls == [
        "https://pbs.twimg.com/media/catalog_a.jpg",
        "https://pbs.twimg.com/media/catalog_b.jpg",
    ]
    assert [img.path for img in circle.item_images] == ["catalog_a.jpg", "catalog_b.jpg"]


def test_download_and_process_image_can_skip_image_analysis(tmp_path):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(skip_catalog_image_analysis=True)
    processor.output_path = tmp_path

    class FakeExtractor:
        async def download_catalog_image(self, _img_url, output_path, filename):
            path = output_path / filename
            path.write_bytes(b"image")
            return path

    class FakeAnalyzer:
        def analyze_catalog_items(self, _image_path):
            raise AssertionError("image analysis should be skipped")

    processor.twitter_extractor = FakeExtractor()
    processor.catalog_analyzer = FakeAnalyzer()

    circle = Circle(name="circle")
    result = asyncio.run(
        processor._download_and_process_image(
            circle,
            "https://pbs.twimg.com/media/catalog.jpg",
        )
    )

    assert result is True
    assert circle.items == []
    assert [img.path for img in circle.item_images] == ["catalog_catalog.jpg"]


def test_download_and_process_image_keeps_sample_image_without_items(tmp_path):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(skip_catalog_image_analysis=False)
    processor.output_path = tmp_path

    class FakeExtractor:
        async def download_catalog_image(self, _img_url, output_path, filename):
            path = output_path / filename
            path.write_bytes(b"image")
            return path

    class FakeAnalyzer:
        def analyze_catalog_items(self, _image_path):
            return []

    processor.twitter_extractor = FakeExtractor()
    processor.catalog_analyzer = FakeAnalyzer()

    circle = Circle(name="circle")
    result = asyncio.run(
        processor._download_and_process_image(
            circle,
            "https://pbs.twimg.com/media/sample.jpg",
        )
    )

    assert result is True
    assert circle.items == []
    assert [img.path for img in circle.item_images] == ["catalog_sample.jpg"]


def test_download_and_process_images_merges_items_and_image_refs(tmp_path):
    processor = object.__new__(TwitterPostProcessor)
    processor.config = SimpleNamespace(skip_catalog_image_analysis=False)
    processor.output_path = tmp_path

    class FakeExtractor:
        async def download_catalog_image(self, _img_url, output_path, filename):
            path = output_path / filename
            path.write_bytes(b"image")
            return path

    class FakeAnalyzer:
        def analyze_catalog_items(self, image_path):
            item_name = image_path.stem.replace("catalog_", "")
            return [
                {
                    "name": item_name,
                    "type": "髻ｳ讌ｽ",
                    "price": 1000,
                    "description": "",
                }
            ]

    processor.twitter_extractor = FakeExtractor()
    processor.catalog_analyzer = FakeAnalyzer()

    circle = Circle(name="circle")
    result = asyncio.run(
        processor._download_and_process_images(
            circle,
            [
                "https://pbs.twimg.com/media/album_a.jpg",
                "https://pbs.twimg.com/media/album_b.jpg",
            ],
        )
    )

    assert result is True
    assert [item["name"] for item in circle.items] == ["album_a", "album_b"]
    assert [item["image"] for item in circle.items] == [
        "catalog_album_a.jpg",
        "catalog_album_b.jpg",
    ]
    assert [img.path for img in circle.item_images] == [
        "catalog_album_a.jpg",
        "catalog_album_b.jpg",
    ]

from __future__ import annotations

import json
from pathlib import Path

from src.utils.json_reprocessor import JSONReprocessor
from src.utils.reprocess_helpers import REASON_NO_CATALOG, REASON_PREVIEW_ONLY


def test_extract_circles_without_catalog_reprocesses_memo_only_rows(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "URLあり",
                "twitter_url": "https://x.com/a",
                "memo": "メモ\nhttps://example.com/catalog",
            },
            {
                "name": "未取得",
                "space": "あ-01",
                "twitter_url": "https://x.com/b",
                "memo": "メモだけ",
            },
        ]
    }

    result = reprocessor.extract_circles_without_catalog(data)

    assert result == [
        {
            "name": "URLあり",
            "space": "",
            "twitter_url": "https://x.com/a",
            "circle_index": 0,
            "reason": "おしながき未取得",
            "catalog_urls": [],
        },
        {
            "name": "未取得",
            "space": "あ-01",
            "twitter_url": "https://x.com/b",
            "circle_index": 1,
            "reason": "おしながき未取得",
            "catalog_urls": [],
        }
    ]


def test_extract_circles_without_catalog_keeps_item_rows_done(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "取得済み",
                "twitter_url": "https://x.com/a",
                "memo": "https://x.com/a/status/123",
                "items": [{"name": "新刊", "type": "新刊(漫画)", "price": 500}],
            }
        ]
    }

    assert reprocessor.extract_circles_without_catalog(data) == []


def test_extract_circles_without_catalog_reprocesses_image_only_rows(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "image only",
                "twitter_url": "https://x.com/a",
                "memo": "https://x.com/a/status/123",
                "item_images": [{"path": "catalog.jpg", "source": "twitter"}],
            }
        ]
    }

    result = reprocessor.extract_circles_without_catalog(data)

    assert len(result) == 1
    assert result[0]["reason"] == REASON_NO_CATALOG


def test_extract_circles_without_catalog_keeps_no_extractable_items_done(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "done",
                "twitter_url": "https://x.com/a",
                "memo": "https://x.com/a/status/123",
                "catalog_status": "no_extractable_items",
            }
        ]
    }

    assert reprocessor.extract_circles_without_catalog(data) == []


def test_extract_circles_without_catalog_keeps_preview_reprocessable(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "preview",
                "twitter_url": "https://x.com/a",
                "memo": "https://x.com/a/status/123",
                "catalog_status": "preview",
            }
        ]
    }

    result = reprocessor.extract_circles_without_catalog(data)

    assert len(result) == 1
    assert result[0]["reason"] == REASON_PREVIEW_ONLY


def test_update_catalog_links_does_not_duplicate_memo_url(tmp_path: Path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {
        "circles": [
            {
                "name": "サークルA",
                "memo": "既存\nhttps://example.com/catalog",
                "item_images": [],
                "tags": ["既存タグ"],
            }
        ]
    }

    result = reprocessor.update_catalog_links(
        data,
        [
            {
                "circle_index": 0,
                "catalog_url": "https://example.com/catalog",
                "catalog_image": "catalog_a.jpg",
                "catalog_type": "おしながき",
                "items": [{"name": "CD", "type": "音楽", "price": 0}],
                "catalog_status": "confirmed",
                "existing_only_status": "既刊のみ",
            }
        ],
    )

    circle = result["circles"][0]
    assert circle["memo"] == "既存\nhttps://example.com/catalog"
    assert circle["item_images"] == [{"path": "catalog_a.jpg", "source": "twitter"}]
    assert circle["tags"] == ["既存タグ", "おしながき"]
    assert circle["items"] == [{"name": "CD", "type": "音楽", "price": 0}]
    assert circle["catalog_status"] == "confirmed"
    assert circle["existing_only_status"] == "既刊のみ"

    # サークル単位チェックポイント後に最終保存で同じ更新を再適用しても、
    # おしながき画像を二重登録しない。
    reprocessor.update_catalog_links(
        data,
        [
            {
                "circle_index": 0,
                "catalog_url": "https://example.com/catalog",
                "catalog_image": "catalog_a.jpg",
                "catalog_type": "おしながき",
                "items": [{"name": "CD", "type": "音楽", "price": 0}],
                "catalog_status": "confirmed",
                "existing_only_status": "既刊のみ",
            }
        ],
    )
    assert circle["item_images"] == [{"path": "catalog_a.jpg", "source": "twitter"}]


def test_load_existing_json_returns_data(tmp_path: Path):
    path = tmp_path / "event.json"
    path.write_text(json.dumps({"circles": [{"name": "A"}]}), encoding="utf-8")

    reprocessor = JSONReprocessor(str(path), output_dir=str(tmp_path))

    assert reprocessor.load_existing_json() == {"circles": [{"name": "A"}]}


def test_follower_metadata_reprocess_patch_preserves_old_and_rejects_invalid(tmp_path):
    reprocessor = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    data = {"circles": [{"name": "A", "twitter_url": "https://twitter.com/A/", "items": [{"name": "本", "purchase_status": 1}], "catalog_status": "complete"}, {"name": "B", "follower_count": 7}]}
    update = {"circle_index": 0, "twitter_url": "https://www.x.com/a", "follower_count": 0,
              "follower_observed_at": "2026-01-01T00:00:00+00:00",
              "follower_source": "twscrape_user_by_login"}
    result = reprocessor.update_catalog_links(data, [update, {"circle_index": 1, "follower_count": -1}])
    assert result["circles"][0]["follower_count"] == 0
    assert result["circles"][0]["follower_observed_at"] == update["follower_observed_at"]
    assert result["circles"][1]["follower_count"] == 7


def test_metric_update_requires_same_known_account(tmp_path):
    r = JSONReprocessor(str(tmp_path / "event.json"), output_dir=str(tmp_path))
    for stored, incoming in [("https://x.com/a", "https://x.com/b"), (None, "https://x.com/a"), ("https://x.com/a", None), ("bad", "bad")]:
        data = {"circles": [{"twitter_url": stored, "items": [{"name": "本", "purchase_status": 1}], "catalog_status": "complete"}]}
        r.update_catalog_links(data, [{"circle_index": 0, "twitter_url": incoming, "follower_count": 3}])
        assert "follower_count" not in data["circles"][0]
        assert data["circles"][0]["items"][0]["purchase_status"] == 1
        assert data["circles"][0]["catalog_status"] == "complete"

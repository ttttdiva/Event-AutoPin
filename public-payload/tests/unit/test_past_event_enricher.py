import json

from src.utils.past_event_enricher import PastEventEnricher


def test_enricher_rejects_invalid_twitter_root_url(tmp_path):
    event_dir = tmp_path / "past"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps(
            {"circles": [{"name": "サークルA", "twitter_url": "https://x.com/"}]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    circles = [{"name": "サークルA"}]

    enriched = PastEventEnricher(str(tmp_path)).enrich_circles(circles)

    assert enriched == 0
    assert "twitter_url" not in circles[0]


def test_enricher_normalizes_valid_twitter_profile_url(tmp_path):
    event_dir = tmp_path / "past"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps(
            {
                "circles": [
                    {
                        "name": "サークルA",
                        "twitter_url": "https://twitter.com/example_user?s=20",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    circles = [{"name": "サークルA"}]

    enriched = PastEventEnricher(str(tmp_path)).enrich_circles(circles)

    assert enriched == 1
    assert circles[0]["twitter_url"] == "https://x.com/example_user"


def test_enricher_rejects_status_and_reserved_urls(tmp_path):
    event_dir = tmp_path / "past"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps(
            {
                "circles": [
                    {
                        "name": "Status URL",
                        "twitter_url": "https://x.com/example/status/123",
                    },
                    {"name": "Reserved", "twitter_url": "https://x.com/home"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    circles = [{"name": "Status URL"}, {"name": "Reserved"}]

    enriched = PastEventEnricher(str(tmp_path)).enrich_circles(circles)

    assert enriched == 0
    assert all("twitter_url" not in circle for circle in circles)


def test_invalid_current_twitter_url_does_not_block_valid_past_url(tmp_path):
    event_dir = tmp_path / "past"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps(
            {
                "circles": [
                    {"name": "サークルA", "twitter_url": "https://x.com/example_a"}
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    circles = [{"name": "サークルA", "twitter_url": "https://x.com/"}]

    enriched = PastEventEnricher(str(tmp_path)).enrich_circles(circles)

    assert enriched == 1
    assert circles[0]["twitter_url"] == "https://x.com/example_a"

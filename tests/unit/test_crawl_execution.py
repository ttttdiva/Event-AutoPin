from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from src.commands.desktop_bridge import run_job
from src.utils.crawl_execution import (
    CrawlExecutionBusyError,
    CrawlValidationError,
    create_backup,
    crawl_output_lock,
    normalize_crawl_payload,
    save_crawl_project_config,
    validate_crawl_payload,
)


def test_nested_settings_and_event_sources_are_normalized() -> None:
    payload = normalize_crawl_payload(
        {
            "event_sources": [
                {
                    "name": "主催イベント",
                    "url": "https://example.test/event",
                    "map_urls": ["https://example.test/map.png"],
                    "catalog_additional_prompt": "開催日を優先",
                }
            ],
            "event_date": "2026-11-03",
            "crawl_settings": {
                "collect_catalogs": False,
                "enable_twitter_catalog": True,
                "use_grok_search": True,
                "grok_search_mode": "build",
                "days_before": 14,
                "days_after": 2,
            },
        },
        require_event_date=True,
    )

    assert payload["collect_catalogs"] is False
    assert payload["grok_search_mode"] == "build"
    assert payload["days_before"] == 14
    assert payload["event_urls"] == ["https://example.test/event"]
    assert payload["crawl_data_source_urls"] == ["https://example.test/event"]
    assert payload["execution_plan"]["twitter_strategy"] == "disabled"
    assert payload["execution_plan"]["effective_stages"] == ["site_catalog", "circle_images"]


def test_single_source_config_uses_effective_source_prompt_without_duplicate_common(
    tmp_path: Path,
) -> None:
    from src.commands.desktop_bridge import _build_main_config

    config = _build_main_config(
        {
            "url": "https://example.test/event",
            "output_dir": str(tmp_path / "event"),
            "project_root": str(tmp_path),
            "catalog_additional_prompt": "common prompt",
            "event_sources": [
                {
                    "url": "https://example.test/event",
                    "catalog_additional_prompt": "common prompt\nspecific prompt",
                    "map_urls": ["https://example.test/map-source.png"],
                }
            ],
        }
    )
    assert config["catalog_additional_prompt"] == "common prompt\nspecific prompt"
    assert config["catalog_additional_prompt"].count("common prompt") == 1
    assert config["map_urls"] == ["https://example.test/map-source.png"]


def test_single_source_explicit_empty_prompt_clears_common(tmp_path: Path) -> None:
    from src.commands.desktop_bridge import _build_main_config

    config = _build_main_config(
        {
            "url": "https://example.test/event",
            "output_dir": str(tmp_path / "event"),
            "project_root": str(tmp_path),
            "catalog_additional_prompt": "common prompt",
            "event_sources": [
                {"url": "https://example.test/event", "catalog_additional_prompt": ""}
            ],
        }
    )
    assert config["catalog_additional_prompt"] == ""

    cleared_maps = _build_main_config(
        {
            "url": "https://example.test/event",
            "output_dir": str(tmp_path / "event-map"),
            "project_root": str(tmp_path),
            "map_url": "https://old.test/map.png",
            "event_sources": [
                {"url": "https://example.test/event", "map_urls": []}
            ],
        }
    )
    assert "map_url" not in cleared_maps
    assert "map_urls" not in cleared_maps


def test_reprocess_source_metadata_prompt_reaches_main_config(tmp_path: Path) -> None:
    from src.commands.desktop_bridge import _build_main_config

    config = _build_main_config(
        {
            "output_dir": str(tmp_path / "event"),
            "project_root": str(tmp_path),
            "reprocess": True,
            "catalog_additional_prompt": "common prompt",
            "event_sources": [
                {
                    "url": "https://source-b.test/event",
                    "catalog_additional_prompt": "common prompt\nsource B",
                }
            ],
        }
    )
    assert config["url"] == "https://source-b.test/event"
    assert config["catalog_additional_prompt"] == "common prompt\nsource B"


@pytest.mark.parametrize(
    "payload,needle",
    [
        ({"url": "https://example.test", "event_date": "2026-02-31"}, "event_date"),
        ({"url": "https://example.test", "event_date": "2026-11-03", "days_before": -1}, "days_before"),
        ({"url": "ftp://example.test", "event_date": "2026-11-03"}, "URL"),
        (
            {
                "reprocess": True,
                "collect_catalogs": False,
                "enable_twitter_catalog": False,
                "skip_circle_images": True,
                "regenerate_coordinates": False,
            },
            "再処理",
        ),
    ],
)
def test_invalid_execution_payload_is_explicit(payload, needle: str) -> None:
    result = validate_crawl_payload(payload, require_event_date=True)
    assert result["valid"] is False
    assert any(needle in error for error in result["errors"])


def test_reprocess_ignores_urls_but_keeps_execution_options() -> None:
    normalized = normalize_crawl_payload(
        {
            "reprocess": True,
            "url": "https://ignored.test/event",
            "event_date": "2026-11-03",
            "collect_catalogs": True,
            "enable_twitter_catalog": False,
        },
        require_event_date=True,
    )
    assert normalized["event_urls"] == []
    assert normalized["event_sources"] == []
    assert normalized["enable_twitter_catalog"] is False
    assert any("URL" in warning for warning in normalized["validation_warnings"])


def test_lock_rejects_concurrent_execution(tmp_path: Path) -> None:
    with crawl_output_lock(tmp_path):
        with pytest.raises(CrawlExecutionBusyError):
            with crawl_output_lock(tmp_path):
                pass
    lock_path = tmp_path.parent / f".{tmp_path.name}.crawl.lock"
    assert lock_path.exists()
    with crawl_output_lock(tmp_path):
        assert lock_path.exists()


def test_backup_copies_event_and_assets_without_lock(tmp_path: Path) -> None:
    output = tmp_path / "event"
    output.mkdir()
    (output / "event.json").write_text('{"event": {}}', encoding="utf-8")
    (output / "circles").mkdir()
    (output / "circles" / "cut.jpg").write_bytes(b"cut")

    backup = create_backup(output)

    assert backup is not None
    assert backup.parent.name == ".event-autopin-backups"
    assert backup.parent != output.parent
    assert (backup / "event.json").read_text(encoding="utf-8") == '{"event": {}}'
    assert (backup / "circles" / "cut.jpg").read_bytes() == b"cut"


def test_save_project_config_deep_merges_and_preserves_unknown_keys(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """secret_key: keep-me\nsite:\n  known: old\n  unknown: keep\nitems:\n  - old\nclear_me:\n  old: true\n""",
        encoding="utf-8",
    )

    result = save_crawl_project_config(
        tmp_path,
        """site:\n  known: new\nitems:\n  - new\nclear_me: {}\ncollect_catalogs: false\n""",
    )

    assert result == {"status": "ok"}
    saved = config_path.read_text(encoding="utf-8")
    assert "secret_key: keep-me" in saved
    loaded = yaml.safe_load(saved)
    assert loaded["site"] == {"known": "new", "unknown": "keep"}
    assert loaded["items"] == ["new"]
    assert loaded["clear_me"] == {}
    assert loaded["collect_catalogs"] is False


def test_save_project_config_rejects_malformed_input_without_overwrite(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    original = "keep: true\n"
    config_path.write_text(original, encoding="utf-8")

    with pytest.raises(ValueError):
        run_job(
            "save_crawl_project_config",
            {"project_root": str(tmp_path), "yaml_content": "broken: ["},
        )
    assert config_path.read_text(encoding="utf-8") == original

    config_path.write_text("broken: [", encoding="utf-8")
    with pytest.raises(ValueError):
        save_crawl_project_config(tmp_path, "collect_catalogs: false\n")
    assert config_path.read_text(encoding="utf-8") == "broken: ["


def test_bridge_merge_keeps_legacy_item_image_and_event_image(tmp_path: Path) -> None:
    from src.commands.desktop_bridge import _merge_multi_event_outputs

    source = tmp_path / "source"
    final = tmp_path / "final"
    source.mkdir()
    (source / "event.png").write_bytes(b"event")
    (source / "item.png").write_bytes(b"item")
    (source / "event.json").write_text(
        json.dumps(
            {
                "event": {"name": "A", "url": "https://a.test", "event_image": "event.png"},
                "circles": [{"name": "C", "item_images": ["item.png"]}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    merged = _merge_multi_event_outputs(
        [{"url": "https://a.test", "output_dir": str(source)}], final
    )
    assert merged["event"]["event_image"] == "ev01_event.png"
    assert merged["circles"][0]["item_images"] == ["ev01_item.png"]
    assert (final / "ev01_event.png").read_bytes() == b"event"
    assert (final / "ev01_item.png").read_bytes() == b"item"


def test_json_formatter_keeps_crawl_metadata_on_existing_event(tmp_path: Path) -> None:
    from datetime import datetime

    from src.formatters.json_formatter import JSONFormatter
    from src.models import Circle, Event, OutputConfig, OutputFormat

    event_path = tmp_path / "event.json"
    event_path.write_text(
        json.dumps(
            {
                "event": {
                    "name": "旧",
                    "event_sources": [{"url": "https://old.test"}],
                    "crawl_settings": {"days_before": 1},
                    "map_config": "legacy",
                },
                "circles": [{"name": "C", "checked": 1}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    formatter = JSONFormatter(
        OutputConfig(format=OutputFormat.JSON, output_dir=str(tmp_path))
    )
    saved = formatter.save(
        formatter.format_data([Circle(name="C")], Event(name="新", url="https://new.test", date=datetime(2026, 11, 3))),
        "event.json",
    )
    data = json.loads(Path(saved).read_text(encoding="utf-8"))
    assert data["event"]["event_sources"] == [{"url": "https://old.test"}]
    assert data["event"]["crawl_settings"] == {"days_before": 1}
    assert data["event"]["map_config"] == "legacy"


def test_bridge_jobs_expose_validation_and_grok_probe_without_sending() -> None:
    validation = run_job(
        "validate_crawl",
        {"url": "https://example.test/event", "event_date": "2026-11-03"},
    )
    assert validation["job"] == "validate_crawl"
    assert validation["valid"] is True
    assert validation["plan"]["collect_catalogs"] is True

    probe = run_job("probe_grok_search", {"grok_search_mode": "api"})
    assert probe["job"] == "probe_grok_search"
    assert set(probe["modes"]) == {"api", "build", "bot"}
    encoded = json.dumps(probe, ensure_ascii=False)
    assert "sk-test-secret" not in encoded

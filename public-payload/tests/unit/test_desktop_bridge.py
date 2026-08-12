"""src.commands.desktop_bridge のテスト。

Tauri → Python サブプロセス呼び出しの入り口。引数/payload解釈と
コマンド組立ロジックを中心に検証する（subprocess実行は検証しない）。
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

import pytest

from src.commands.desktop_bridge import (
    _build_extract_command,
    _build_main_config,
    _aggregate_twitter_processing_results,
    _extract_twitter_processing_result,
    _job_create_mobile_zip,
    _job_reprocess_circle_from_image,
    _job_reprocess_circle_from_post,
    _job_run_main_pipeline,
    _merge_multi_event_outputs,
    _payload_url_list,
    _job_validate_mobile_json,
    _load_payload,
    run_job,
)


def test_twitter_processing_resultをstderrマーカーから復元できる():
    result = _extract_twitter_processing_result(
        [
            "通常ログ",
            'TWITTER_PROCESSING_RESULT={"status":"failed","failed_count":2}',
        ]
    )

    assert result == {"status": "failed", "failed_count": 2}


def test_複数イベントのTwitter失敗を集約できる():
    result = _aggregate_twitter_processing_results(
        [
            {
                "twitter_processing": {
                    "status": "ok",
                    "target_count": 2,
                    "processed_count": 2,
                    "failed_count": 0,
                    "invalid_url_count": 1,
                }
            },
            {
                "twitter_processing": {
                    "status": "failed",
                    "target_count": 3,
                    "processed_count": 0,
                    "failed_count": 3,
                    "invalid_url_count": 0,
                    "reason": "twscrape error",
                }
            },
        ]
    )

    assert result == {
        "status": "failed",
        "target_count": 5,
        "processed_count": 2,
        "failed_count": 3,
        "invalid_url_count": 1,
        "reason": "twscrape error",
    }


class TestLoadPayload:
    def test_インラインJSONをパースできる(self):
        ns = argparse.Namespace(payload=None, payload_json='{"foo": "bar"}')
        assert _load_payload(ns) == {"foo": "bar"}

    def test_ファイルから読み込める(self, tmp_path: Path):
        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"url": "https://example.com"}', encoding="utf-8")
        ns = argparse.Namespace(payload=str(payload_file), payload_json=None)
        assert _load_payload(ns) == {"url": "https://example.com"}

    def test_両方指定はエラー(self):
        ns = argparse.Namespace(payload="a", payload_json="{}")
        with pytest.raises(ValueError, match="cannot be used together"):
            _load_payload(ns)

    def test_存在しないファイルはFileNotFoundError(self, tmp_path: Path):
        ns = argparse.Namespace(
            payload=str(tmp_path / "missing.json"), payload_json=None
        )
        with pytest.raises(FileNotFoundError):
            _load_payload(ns)

    def test_両方未指定は空ディクト(self):
        ns = argparse.Namespace(payload=None, payload_json=None)
        assert _load_payload(ns) == {}


class TestBuildExtractCommand:
    def test_必須項のみでコマンドを組み立てる(self):
        cmd = _build_extract_command(
            {"event_file": "event.json", "event_date": "2026-03-29"}
        )
        assert cmd[0] == sys.executable
        assert cmd[1:4] == ["-m", "src.commands.extract_twitter_catalogs", "event.json"]
        assert "--event-date" in cmd
        assert "2026-03-29" in cmd

    def test_オプションを全て追加する(self):
        cmd = _build_extract_command(
            {
                "event_file": "e.json",
                "event_date": "2026-03-29",
                "output_dir": "/tmp/out",
                "days_before": 7,
                "days_after": 3,
                "backup": True,
            }
        )
        assert "--output-dir" in cmd and "/tmp/out" in cmd
        assert "--days-before" in cmd and "7" in cmd
        assert "--days-after" in cmd and "3" in cmd
        assert "--backup" in cmd

    def test_backupがFalseならフラグは付かない(self):
        cmd = _build_extract_command(
            {"event_file": "e.json", "event_date": "2026-03-29", "backup": False}
        )
        assert "--backup" not in cmd

    def test_event_file不足はエラー(self):
        with pytest.raises(ValueError, match="event_file"):
            _build_extract_command({"event_date": "2026-03-29"})

    def test_event_date不足はエラー(self):
        with pytest.raises(ValueError, match="event_date"):
            _build_extract_command({"event_file": "e.json"})


class TestBuildMainConfig:
    def test_必須項のみでconfigを生成する(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": str(tmp_path / "out"),
                "project_root": str(tmp_path),
            }
        )
        assert config["url"] == "https://example.com"
        assert config["models"] == ["gpt-5.6-sol"]
        assert config["enable_twitter_catalog"] is True
        assert Path(config["output_dir"]).is_absolute()

    def test_カンマ区切りモデルをリストに展開する(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": str(tmp_path / "out"),
                "project_root": str(tmp_path),
                "model": "gpt-5-mini, gpt-4o , gemini-pro",
            }
        )
        assert config["models"] == ["gpt-5-mini", "gpt-4o", "gemini-pro"]

    def test_相対パスはproject_rootで解決される(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": "sub/out",
                "project_root": str(tmp_path),
            }
        )
        expected = str((tmp_path / "sub/out").resolve())
        assert Path(config["output_dir"]) == Path(expected)

    def test_絶対パスはそのまま使われる(self, tmp_path: Path):
        abs_dir = str((tmp_path / "abs_out").resolve())
        config = _build_main_config(
            {"url": "https://example.com", "output_dir": abs_dir}
        )
        assert config["output_dir"] == abs_dir

    def test_オプションキーは空値なら省略される(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": str(tmp_path / "out"),
                "map_url": "",
                "event_date": None,
                "debug_limit": 10,
            }
        )
        assert "map_url" not in config
        assert "event_date" not in config
        assert config["debug_limit"] == 10

    def test_url不足はエラー(self, tmp_path: Path):
        with pytest.raises(ValueError, match="url"):
            _build_main_config({"output_dir": str(tmp_path / "out")})

    def test_再処理はurlなしでもconfigを生成できる(self, tmp_path: Path):
        config = _build_main_config(
            {
                "output_dir": str(tmp_path / "out"),
                "project_root": str(tmp_path),
                "reprocess": True,
                "days_before": 14,
                "days_after": 3,
            }
        )
        assert config["url"] == ""
        assert Path(config["output_dir"]).is_absolute()
        assert config["days_before"] == 14
        assert config["days_after"] == 3

    def test_output_dir不足はエラー(self):
        with pytest.raises(ValueError, match="output_dir"):
            _build_main_config({"url": "https://example.com"})


    def test_event_name_is_preserved(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": str(tmp_path / "out"),
                "event_name": "声音の宴6次会",
            }
        )
        assert config["event_name"] == "声音の宴6次会"

    def test_text_llm_cli_timeout_is_preserved(self, tmp_path: Path):
        config = _build_main_config(
            {
                "url": "https://example.com",
                "output_dir": str(tmp_path / "out"),
                "text_llm_cli_timeout": 900,
            }
        )
        assert config["text_llm_cli_timeout"] == 900

    def test_multiple_urls_are_preserved_as_sources(self, tmp_path: Path):
        payload = {
            "url": "https://one.test/list/\nhttps://two.test/list/",
            "output_dir": str(tmp_path / "out"),
        }
        config = _build_main_config(payload)
        assert config["url"] == "https://one.test/list/"
        assert config["source_urls"] == [
            "https://one.test/list/",
            "https://two.test/list/",
        ]

    def test_map_urls_are_preserved(self, tmp_path: Path):
        payload = {
            "url": "https://one.test/list/",
            "map_urls": ["https://map.test/1.png", "https://map.test/2.png"],
            "output_dir": str(tmp_path / "out"),
        }
        config = _build_main_config(payload)
        assert config["map_url"] == "https://map.test/1.png"
        assert config["map_urls"] == [
            "https://map.test/1.png",
            "https://map.test/2.png",
        ]


def test_既存イベントのTwitter再処理は複数urlでも再マージしない(tmp_path: Path):
    event_dir = tmp_path / "event"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps(
            {
                "event": {"name": "テストイベント", "url": ""},
                "circles": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = _job_run_main_pipeline(
        {
            "project_root": str(Path.cwd()),
            "output_dir": str(event_dir),
            "reprocess": True,
            "enable_twitter_catalog": True,
            "urls": ["https://example.com/a", "https://example.com/b"],
        }
    )

    assert result["status"] == "ok"
    assert result["returncode"] == 0
    assert "--reprocess" in result["command"]
    assert result.get("mode") != "multi_event"


def test_既存イベントのTwitter再処理は実在しないイベント日を拒否する(tmp_path: Path):
    event_dir = tmp_path / "event"
    event_dir.mkdir()
    (event_dir / "event.json").write_text(
        json.dumps({"event": {"name": "テスト"}, "circles": []}, ensure_ascii=False),
        encoding="utf-8",
    )

    result = _job_run_main_pipeline(
        {
            "project_root": str(Path.cwd()),
            "output_dir": str(event_dir),
            "reprocess": True,
            "event_date": "2026-02-31",
        }
    )

    assert result["status"] == "error"
    assert result["returncode"] != 0
    assert "event_date" in result["stderr"]


class TestMultiEventHelpers:
    def test_payload_url_list_extracts_and_deduplicates_urls(self):
        assert _payload_url_list(
            {
                "url": "https://one.test/list/\nhttps://two.test/list/",
                "urls": ["https://two.test/list/", "https://three.test/list/"],
            }
        ) == [
            "https://two.test/list/",
            "https://three.test/list/",
            "https://one.test/list/",
        ]

    def test_payload_url_list_trims_section_punctuation(self):
        assert _payload_url_list({"url": "[https://one.test/list/]"}) == [
            "https://one.test/list/"
        ]

    def test_merge_multi_event_outputs_copies_files_and_marks_sources(
        self, tmp_path: Path
    ):
        source1 = tmp_path / "source1"
        source2 = tmp_path / "source2"
        final = tmp_path / "final"
        source1.mkdir()
        source2.mkdir()
        (source1 / "cut.jpg").write_bytes(b"cut1")
        (source1 / "item.jpg").write_bytes(b"item1")
        (source2 / "cut.jpg").write_bytes(b"cut2")
        (source1 / "event.json").write_text(
            json.dumps(
                {
                    "event": {"name": "Event A", "url": "https://a.test"},
                    "circles": [
                        {
                            "name": "Circle A",
                            "circle_cut_filename": "cut.jpg",
                            "item_images": [{"path": "item.jpg", "source": "twitter"}],
                            "tags": [],
                        }
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (source2 / "event.json").write_text(
            json.dumps(
                {
                    "event": {"name": "Event B", "url": "https://b.test"},
                    "circles": [
                        {
                            "name": "Circle B",
                            "circle_cut_filename": "cut.jpg",
                            "item_images": [],
                        }
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        merged = _merge_multi_event_outputs(
            [
                {"url": "https://a.test", "output_dir": str(source1)},
                {"url": "https://b.test", "output_dir": str(source2)},
            ],
            final,
            final_event_name="Joint Event",
        )

        assert merged["event"]["name"] == "Joint Event"
        assert merged["event"]["source_urls"] == ["https://a.test", "https://b.test"]
        assert len(merged["circles"]) == 2
        assert merged["circles"][0]["circle_cut_filename"] == "ev01_cut.jpg"
        assert merged["circles"][1]["circle_cut_filename"] == "ev02_cut.jpg"
        assert (final / "ev01_cut.jpg").read_bytes() == b"cut1"
        assert (final / "ev01_item.jpg").read_bytes() == b"item1"
        assert any(tag.startswith("併催:") for tag in merged["circles"][0]["tags"])

    def test_merge_multi_event_outputs_deduplicates_common_map(self, tmp_path: Path):
        source1 = tmp_path / "source1"
        source2 = tmp_path / "source2"
        final = tmp_path / "final"
        source1.mkdir()
        source2.mkdir()
        (source1 / "map_01.jpg").write_bytes(b"map1")
        (source2 / "map_01.jpg").write_bytes(b"map2")
        for source, name, circle in [
            (source1, "Event A", "Circle A"),
            (source2, "Event B", "Circle B"),
        ]:
            (source / "event.json").write_text(
                json.dumps(
                    {
                        "event": {
                            "name": name,
                            "url": "https://shared.test/map.png",
                            "maps": [
                                {
                                    "url": "https://shared.test/map.png",
                                    "filename": "map_01.jpg",
                                    "map_number": 1,
                                }
                            ],
                        },
                        "circles": [{"name": circle, "map_number": 1}],
                        "metadata": {},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

        merged = _merge_multi_event_outputs(
            [
                {"url": "https://a.test", "output_dir": str(source1)},
                {"url": "https://b.test", "output_dir": str(source2)},
            ],
            final,
        )

        assert len(merged["event"]["maps"]) == 1
        assert [c["map_number"] for c in merged["circles"]] == [1, 1]


class TestCreateMobileZip:
    def test_event_map_filename_is_included_even_with_prefixed_name(
        self, tmp_path: Path
    ):
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        (output_dir / "ev01_map.png").write_bytes(b"map")
        event_json = output_dir / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {
                        "name": "Joint Event",
                        "maps": [{"filename": "ev01_map.png"}],
                    },
                    "circles": [],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        zip_path = tmp_path / "mobile.zip"

        result = _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )

        assert result["status"] == "ok"
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            assert "asset_manifest.json" in names
            manifest = json.loads(zf.read("asset_manifest.json"))
            assert manifest["aliases"]["ev01_map.png"].startswith("assets/sha256/")
            assert manifest["aliases"]["ev01_map.png"] in names

    def test_event_image_is_included_from_event_metadata(self, tmp_path: Path):
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        (output_dir / "event_image.png").write_bytes(b"thumbnail")
        event_json = output_dir / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {
                        "name": "Thumbnail Event",
                        "event_image": "event_image.png",
                    },
                    "circles": [],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        zip_path = tmp_path / "mobile.zip"

        result = _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )

        assert result["status"] == "ok"
        assert result["event_images"] == 1
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            manifest = json.loads(zf.read("asset_manifest.json"))
            asset_name = manifest["aliases"]["event_image/event_image.png"]
            assert asset_name.startswith("assets/sha256/")
            assert asset_name in names

    def test_same_image_content_is_stored_once_with_manifest_aliases(self, tmp_path: Path):
        output_dir = tmp_path / "output"
        output_dir.mkdir()
        (output_dir / "circles").mkdir()
        (output_dir / "items").mkdir()
        (output_dir / "circles" / "cut.jpg").write_bytes(b"same-image")
        (output_dir / "items" / "catalog.jpg").write_bytes(b"same-image")
        event_json = output_dir / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {"name": "Dedupe Event", "maps": []},
                    "circles": [
                        {
                            "name": "Circle A",
                            "circle_cut_filename": "circles/cut.jpg",
                            "item_images": [
                                {"path": "items/catalog.jpg", "source": "catalog"}
                            ],
                        }
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        zip_path = tmp_path / "mobile.zip"

        result = _job_create_mobile_zip(
            {
                "event_json": str(event_json),
                "output_dir": str(output_dir),
                "zip_output_path": str(zip_path),
            }
        )

        assert result["status"] == "ok"
        assert result["circle_images"] == 1
        assert result["item_images"] == 1
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            manifest = json.loads(zf.read("asset_manifest.json"))
            cut_asset = manifest["aliases"]["circles/cut.jpg"]
            item_asset = manifest["aliases"]["items/catalog.jpg"]
            assert cut_asset == item_asset
            assert names.count(cut_asset) == 1
            assert "circles/cut.jpg" not in names
            assert "items/catalog.jpg" not in names


class TestValidateMobileJson:
    def _write_json(self, path: Path, data: dict) -> Path:
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def test_正常なJSONはokを返す(self, tmp_path: Path):
        json_file = self._write_json(
            tmp_path / "event.json",
            {
                "event": {"name": "test", "maps": [{"image_data": "xxx"}]},
                "circles": [
                    {
                        "name": "サークルA",
                        "pin_x": 0.5,
                        "pin_y": 0.5,
                        "map_number": 1,
                        "absence_status": None,
                        "existing_only_status": None,
                        "circle_cut_data": "yyy",
                    }
                ],
                "metadata": {},
            },
        )
        result = _job_validate_mobile_json({"json_file": str(json_file)})
        assert result["status"] == "ok"
        assert result["errors"] == []
        assert result["image_counts"]["map_image_data"] == 1
        assert result["image_counts"]["circle_cut_data"] == 1

    def test_必須キー不足はstatusがerror(self, tmp_path: Path):
        json_file = self._write_json(tmp_path / "broken.json", {"event": {}})
        result = _job_validate_mobile_json({"json_file": str(json_file)})
        assert result["status"] == "error"
        assert any("circles" in e for e in result["errors"])
        assert any("metadata" in e for e in result["errors"])

    def test_画像が0件ならwarningを出す(self, tmp_path: Path):
        json_file = self._write_json(
            tmp_path / "noimg.json",
            {
                "event": {"name": "x", "maps": []},
                "circles": [{"name": "A"}],
                "metadata": {},
            },
        )
        result = _job_validate_mobile_json({"json_file": str(json_file)})
        assert result["status"] == "ok"
        assert any("image_data" in w for w in result["warnings"])

    def test_json_file不足はValueError(self):
        with pytest.raises(ValueError, match="json_file"):
            _job_validate_mobile_json({})

    def test_存在しないファイルはFileNotFoundError(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError):
            _job_validate_mobile_json({"json_file": str(tmp_path / "nope.json")})


class TestReprocessCircleFromPost:
    def test_latest_event_json_is_patched_without_overwriting_parallel_edits(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        event_json = tmp_path / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {"name": "Event"},
                    "circles": [
                        {
                            "name": "Circle A",
                            "space": "A-01",
                            "memo": "old",
                            "items": [],
                            "item_images": [],
                        },
                        {"name": "Circle B", "space": "B-01", "memo": "keep"},
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        import src.processors.twitter_post_processor as tpp

        class FakeProcessor:
            def __init__(self, _config):
                pass

            async def process_circle_from_post_url(
                self, circle, _post_url, _event_name, use_text_detail=True
            ):
                assert use_text_detail is True
                latest = json.loads(event_json.read_text(encoding="utf-8"))
                latest["circles"][1]["memo"] = "parallel edit"
                event_json.write_text(
                    json.dumps(latest, ensure_ascii=False),
                    encoding="utf-8",
                )
                circle.items = [{"name": "New Book", "price": 500}]
                circle.catalog_status = "confirmed"
                return True

        monkeypatch.setattr(tpp, "TwitterPostProcessor", FakeProcessor)

        result = _job_reprocess_circle_from_post(
            {
                "event_json": str(event_json),
                "circle_index": 0,
                "circle_identity": {"name": "Circle A", "space": "A-01"},
                "post_url": "https://x.com/user/status/1234567890",
                "output_dir": str(tmp_path),
                "project_root": str(tmp_path),
            }
        )

        saved = json.loads(event_json.read_text(encoding="utf-8"))
        assert result["status"] == "ok"
        assert saved["circles"][0]["items"] == [{"name": "New Book", "price": 500}]
        assert saved["circles"][0]["catalog_status"] == "confirmed"
        assert saved["circles"][1]["memo"] == "parallel edit"

    def test_circle_identity_resolves_shifted_index(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        event_json = tmp_path / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {"name": "Event"},
                    "circles": [
                        {"name": "Circle A", "space": "A-01", "items": []},
                        {"name": "Circle B", "space": "B-01", "items": []},
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        import src.processors.twitter_post_processor as tpp

        class FakeProcessor:
            def __init__(self, _config):
                pass

            async def process_circle_from_post_url(self, circle, *_args, **_kwargs):
                latest = json.loads(event_json.read_text(encoding="utf-8"))
                latest["circles"].insert(0, {"name": "Inserted", "space": "Z-99"})
                event_json.write_text(
                    json.dumps(latest, ensure_ascii=False),
                    encoding="utf-8",
                )
                circle.items = [{"name": "Shifted Item"}]
                return True

        monkeypatch.setattr(tpp, "TwitterPostProcessor", FakeProcessor)

        result = _job_reprocess_circle_from_post(
            {
                "event_json": str(event_json),
                "circle_index": 0,
                "circle_identity": {"name": "Circle A", "space": "A-01"},
                "post_url": "https://x.com/user/status/1234567890",
                "output_dir": str(tmp_path),
                "project_root": str(tmp_path),
            }
        )

        saved = json.loads(event_json.read_text(encoding="utf-8"))
        assert result["circle_index"] == 1
        assert saved["circles"][0]["name"] == "Inserted"
        assert saved["circles"][1]["items"] == [{"name": "Shifted Item"}]
        assert saved["circles"][2]["items"] == []

    def test_reprocess_replaces_item_images(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        event_json = tmp_path / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {"name": "Event"},
                    "circles": [
                        {
                            "name": "Circle A",
                            "space": "A-01",
                            "items": [],
                            "item_images": [{"path": "old.jpg", "source": "twitter"}],
                        },
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        import src.processors.twitter_post_processor as tpp
        from src.models import ItemImage

        class FakeProcessor:
            def __init__(self, _config):
                pass

            async def process_circle_from_post_url(self, circle, *_args, **_kwargs):
                assert [img.path for img in circle.item_images] == ["old.jpg"]
                circle.items = [{"name": "New Book", "image": "new_a.jpg"}]
                circle.item_images = [
                    ItemImage(path="new_a.jpg", source="twitter"),
                    ItemImage(path="new_b.jpg", source="twitter"),
                ]
                return True

        monkeypatch.setattr(tpp, "TwitterPostProcessor", FakeProcessor)

        result = _job_reprocess_circle_from_post(
            {
                "event_json": str(event_json),
                "circle_index": 0,
                "circle_identity": {"name": "Circle A", "space": "A-01"},
                "post_url": "https://x.com/user/status/1234567890",
                "output_dir": str(tmp_path),
                "project_root": str(tmp_path),
            }
        )

        saved = json.loads(event_json.read_text(encoding="utf-8"))
        assert result["status"] == "ok"
        assert result["image_updated"] is True
        assert saved["circles"][0]["item_images"] == [
            {"path": "new_a.jpg", "source": "twitter"},
            {"path": "new_b.jpg", "source": "twitter"},
        ]
        assert saved["circles"][0]["items"] == [
            {"name": "New Book", "image": "new_a.jpg"}
        ]


class TestReprocessCircleFromImage:
    def test_image_analysis_merges_items_and_sets_local_image(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        image_file = tmp_path / "dropped.jpg"
        image_file.write_bytes(b"fake-image")
        event_json = tmp_path / "event.json"
        event_json.write_text(
            json.dumps(
                {
                    "event": {"name": "Event"},
                    "circles": [
                        {
                            "name": "Circle A",
                            "space": "A-01",
                            "items": [
                                {"name": "Existing Book", "type": "book", "price": 100}
                            ],
                            "item_images": [{"path": "old.jpg", "source": "twitter"}],
                        }
                    ],
                    "metadata": {},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        import src.utils.catalog_image_analyzer as cia

        class FakeAnalyzer:
            def __init__(self, **_kwargs):
                pass

            def analyze_catalog_items(self, path):
                assert Path(path) == image_file
                return [
                    {"name": "Existing Book", "type": "book", "price": 200},
                    {"name": "New Book", "type": "book", "price": 500},
                ]

        monkeypatch.setattr(cia, "CatalogImageAnalyzer", FakeAnalyzer)

        result = _job_reprocess_circle_from_image(
            {
                "event_json": str(event_json),
                "circle_index": 0,
                "circle_identity": {"name": "Circle A", "space": "A-01"},
                "image_path": str(image_file),
                "image_filename": "dropped.jpg",
                "output_dir": str(tmp_path),
                "project_root": str(tmp_path),
            }
        )

        saved = json.loads(event_json.read_text(encoding="utf-8"))
        circle = saved["circles"][0]
        assert result["status"] == "ok"
        assert result["detected_items_count"] == 2
        assert result["image_updated"] is True
        assert circle["catalog_status"] == "confirmed"
        assert circle["item_images"] == [{"path": "dropped.jpg", "source": "local"}]
        assert circle["items"] == [
            {
                "name": "Existing Book",
                "type": "book",
                "price": 200,
                "image": "dropped.jpg",
            },
            {
                "name": "New Book",
                "type": "book",
                "price": 500,
                "image": "dropped.jpg",
            },
        ]


class TestRunJobDispatch:
    def test_pingジョブが返る(self):
        result = run_job("ping", {"hello": "world"})
        assert result["status"] == "ok"
        assert result["job"] == "ping"
        assert result["echo"] == {"hello": "world"}

    def test_list_jobsはpingを含む(self):
        result = run_job("list_jobs", {})
        assert result["status"] == "ok"
        assert "ping" in result["jobs"]
        assert "auto_place_map_pins" in result["jobs"]
        assert "reprocess_circle_from_image" in result["jobs"]

    def test_未知ジョブはValueError(self):
        with pytest.raises(ValueError, match="Unknown job"):
            run_job("nonexistent_job", {})

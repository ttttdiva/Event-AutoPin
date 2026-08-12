"""src.formatters.json_formatter のテスト。

event.json 出力の整形ロジック・既存メタデータの保持・検証関数を確認する。
"""

from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime

import pytest

from src.formatters.json_formatter import JSONFormatter
from src.models import (
    Circle,
    CircleImage,
    Event,
    ItemImage,
    OutputConfig,
    OutputFormat,
)


@pytest.fixture
def formatter(tmp_path: Path) -> JSONFormatter:
    config = OutputConfig(format=OutputFormat.JSON, output_dir=str(tmp_path))
    return JSONFormatter(config)


@pytest.fixture
def sample_event() -> Event:
    return Event(name="テストイベント", url="https://example.com/event")


@pytest.fixture
def sample_circles() -> list[Circle]:
    c1 = Circle(name="サークルA", penname="作者A", space="あ-01")
    c1.circle_cut = CircleImage(url="https://example.com/a.jpg", filename="a.jpg")
    c1.item_images.append(ItemImage(path="item_a.jpg", source="twitter"))
    c2 = Circle(name="サークルB", penname="作者B", space="い-02")
    return [c1, c2]


class TestFormatData:
    def test_基本スキーマを満たす(self, formatter, sample_event, sample_circles):
        data = formatter.format_data(sample_circles, sample_event)
        assert set(data.keys()) == {"event", "circles", "metadata"}
        assert data["metadata"]["total_circles"] == 2
        assert data["metadata"]["format_version"] == "3.0"

    def test_circlesが辞書化される(self, formatter, sample_event, sample_circles):
        data = formatter.format_data(sample_circles, sample_event)
        assert len(data["circles"]) == 2
        assert data["circles"][0]["name"] == "サークルA"
        assert data["circles"][0]["penname"] == "作者A"
        assert data["circles"][0]["space"] == "あ-01"
        assert data["circles"][0]["circle_cut_filename"] == "a.jpg"
        assert data["circles"][0]["item_images"] == [
            {"path": "item_a.jpg", "source": "twitter"}
        ]

    def test_空サークルリストでも整形できる(self, formatter, sample_event):
        data = formatter.format_data([], sample_event)
        assert data["circles"] == []
        assert data["metadata"]["total_circles"] == 0


class TestSave:
    def test_datetime_date_is_serialized_as_date_only(self, formatter):
        event = Event(
            name="event",
            url="https://example.com/event",
            date=datetime(2026, 5, 24, 0, 0, 0),
        )
        data = formatter.format_data([], event)
        assert data["event"]["date"] == "2026-05-24"

    def test_ファイルに保存される(
        self, formatter, sample_event, sample_circles, tmp_path: Path
    ):
        data = formatter.format_data(sample_circles, sample_event)
        out_path = formatter.save(data, "event.json")
        assert Path(out_path).exists()

        saved = json.loads(Path(out_path).read_text(encoding="utf-8"))
        assert saved["event"]["name"] == "テストイベント"
        assert len(saved["circles"]) == 2

    def test_既存のdateやvenueを保持する(
        self, formatter, sample_event, sample_circles, tmp_path: Path
    ):
        existing = {
            "event": {
                "name": "古いイベント",
                "date": "2026-03-29",
                "venue": "東京ビッグサイト",
                "organizer": "既存主催",
            }
        }
        out_path = Path(tmp_path) / "event.json"
        out_path.write_text(json.dumps(existing, ensure_ascii=False), encoding="utf-8")

        data = formatter.format_data(sample_circles, sample_event)
        # format_dataが生成したeventにdate/venueが無いので、既存値が保持されるはず
        formatter.save(data, "event.json")
        saved = json.loads(out_path.read_text(encoding="utf-8"))
        assert saved["event"]["date"] == "2026-03-29"
        assert saved["event"]["venue"] == "東京ビッグサイト"
        assert saved["event"]["organizer"] == "既存主催"
        # nameは新しい方が優先
        assert saved["event"]["name"] == "テストイベント"

    def test_既存ファイルが壊れていても書き込む(
        self, formatter, sample_event, sample_circles, tmp_path: Path
    ):
        out_path = Path(tmp_path) / "event.json"
        out_path.write_text("{broken json", encoding="utf-8")

        data = formatter.format_data(sample_circles, sample_event)
        formatter.save(data, "event.json")
        saved = json.loads(out_path.read_text(encoding="utf-8"))
        assert saved["event"]["name"] == "テストイベント"

    def test_manual_event_meta_is_preserved(
        self, formatter, sample_event, sample_circles, tmp_path: Path
    ):
        existing = {
            "event": {
                "name": "old",
                "url": "https://example.com/old",
                "event_url": "https://example.com/old",
                "map_url": "https://example.com/map.png",
                "additional_prompt": "略称として「声音」等もある",
                "event_image": "event_image.png",
                "memo": "manual memo",
                "completed": False,
            }
        }
        out_path = Path(tmp_path) / "event.json"
        out_path.write_text(json.dumps(existing, ensure_ascii=False), encoding="utf-8")

        data = formatter.format_data(sample_circles, sample_event)
        formatter.save(data, "event.json")
        saved = json.loads(out_path.read_text(encoding="utf-8"))

        assert saved["event"]["map_url"] == "https://example.com/map.png"
        assert saved["event"]["additional_prompt"] == "略称として「声音」等もある"
        assert saved["event"]["event_image"] == "event_image.png"
        assert saved["event"]["memo"] == "manual memo"
        assert saved["event"]["completed"] is False
        assert saved["event"]["event_url"] == "https://example.com/old"

    def test_dictでない値はTypeError(self, formatter):
        with pytest.raises(TypeError):
            formatter.save("not a dict", "event.json")


class TestValidateOutput:
    def test_正常な出力はエラー無し(self, formatter, sample_event, sample_circles):
        data = formatter.format_data(sample_circles, sample_event)
        assert formatter.validate_output(data) == []

    def test_event欠落を検出する(self, formatter):
        errors = formatter.validate_output({"circles": [{"name": "A"}]})
        assert any("event" in e for e in errors)

    def test_circles欠落を検出する(self, formatter):
        errors = formatter.validate_output({"event": {"name": "x"}})
        assert any("circles" in e for e in errors)

    def test_circlesが空ならエラー(self, formatter):
        errors = formatter.validate_output({"event": {"name": "x"}, "circles": []})
        assert any("空" in e for e in errors)

    def test_dict以外はエラー(self, formatter):
        errors = formatter.validate_output("not dict")
        assert len(errors) == 1

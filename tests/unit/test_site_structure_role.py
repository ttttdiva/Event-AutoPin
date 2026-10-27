import json
import pytest

from bs4 import BeautifulSoup

from src.adapters import generic_adapter
from src.adapters.learned_pattern_adapter import LearnedPatternAdapter
from src.models import SiteConfig, SiteType
from src.models.config import SiteParsingConfig
from src.utils.grok_build import GrokBuildError


class PatternManager:
    def get_pattern(self, _url):
        return {
            "site_key": "known.example/list",
            "event_structure": {},
            "circle_structure": {},
            "extraction_rules": {
                "table_header_schemas": [
                    {
                        "headers": ["配置", "サークル名"],
                        "field_map": {"0": "space", "1": "name"},
                    }
                ]
            },
        }

    def has_pattern(self, _url):
        return True


def structure_config():
    return SiteParsingConfig(
        provider="cli:grok",
        model="grok-4.7",
        effort="high",
        cli_model_map={"grok": "grok-4.7"},
    )


def make_site_config(url, site_parsing):
    return SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url=url,
        event_name="イベント",
        site_parsing_config=site_parsing,
    )


def test_new_site_structure_analysis_uses_structure_role(monkeypatch):
    seen = []

    def parse(_prompt, config):
        seen.append(config)
        return json.dumps({"tables": [{"table_index": 0, "columns": {"0": "space", "1": "name"}}]})

    monkeypatch.setattr(generic_adapter, "parse_with_high_end_model", parse)
    adapter = generic_adapter.GenericAdapter(
        make_site_config("https://new.example/list", structure_config()),
        llm_client=object(),
    )
    html = "<table><tr><th>卓番号</th><th>参加名義</th></tr><tr><td>A-01</td><td>新規サークル</td></tr></table>"

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert [circle.name for circle in circles] == ["新規サークル"]
    assert seen[0].provider == "cli:grok"
    assert seen[0].model == "grok-4.7"


def test_known_site_changed_headers_reanalysis_uses_structure_role(monkeypatch):
    seen = []

    def parse(_prompt, config):
        seen.append(config)
        return json.dumps({"tables": [{"table_index": 0, "columns": {"0": "space", "1": "name"}}]})

    monkeypatch.setattr(generic_adapter, "parse_with_high_end_model", parse)
    site = make_site_config("https://known.example/list", structure_config())
    adapter = LearnedPatternAdapter(site, PatternManager(), llm_client=object())
    html = "<table><tr><th>ブース</th><th>出展者</th></tr><tr><td>B-02</td><td>既知サークル</td></tr></table>"

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert [circle.name for circle in circles] == ["既知サークル"]
    assert len(seen) == 1
    assert seen[0].provider == "cli:grok"


def test_unknown_delivery_on_structure_header_call_does_not_retry_text_role(monkeypatch):
    structure_calls = []
    text_fallback_calls = []

    def unknown_delivery(_prompt, _config):
        structure_calls.append(True)
        raise GrokBuildError("unknown_delivery", "fixture response unavailable")

    class FakeTextClient:
        def extract_data(self, *_args, **_kwargs):
            text_fallback_calls.append(True)
            return '{"tables":[{"table_index":0,"columns":{"0":"space","1":"name"}}]}'

    monkeypatch.setattr(generic_adapter, "parse_with_high_end_model", unknown_delivery)
    adapter = generic_adapter.GenericAdapter(
        make_site_config("https://new.example/list", structure_config()),
        llm_client=FakeTextClient(),
    )
    html = (
        "<table><tr><th>卓番号</th><th>参加名義</th></tr>"
        "<tr><td>A-01</td><td>新規サークル</td></tr></table>"
    )

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert circles == []
    assert structure_calls == [True]
    assert text_fallback_calls == []


def test_unknown_delivery_on_candidate_table_stops_without_text_retry(monkeypatch):
    calls = []

    def unknown_delivery(_prompt, _config):
        calls.append("site_structure")
        raise GrokBuildError("unknown_delivery", "fixture response unavailable")

    class FakeTextClient:
        def extract_data(self, *_args, **_kwargs):
            calls.append("text")
            return '{"circles":[]}'

    monkeypatch.setattr(generic_adapter, "parse_with_high_end_model", unknown_delivery)
    adapter = generic_adapter.GenericAdapter(
        make_site_config("http://127.0.0.1:8765/fixture.html", structure_config()),
        llm_client=FakeTextClient(),
    )
    html = (
        "<table><tr><th>卓番号</th><th>参加名義</th></tr>"
        "<tr><td>A-01</td><td>新規サークル</td></tr></table>"
    )

    assert adapter.extract_circles(BeautifulSoup(html, "html.parser")) == []
    assert calls == ["site_structure"]

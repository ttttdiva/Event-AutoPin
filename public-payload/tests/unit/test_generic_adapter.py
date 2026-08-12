from bs4 import BeautifulSoup

from src.adapters.generic_adapter import GenericAdapter
from src.models import SiteConfig, SiteType


class FailingLLMClient:
    def extract_data(self, prompt: str) -> str:
        raise AssertionError("event_name should skip event LLM extraction")


def test_event_name_skips_event_llm_extraction():
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://example.com/catalog",
        event_name="声音の宴6次会",
        event_date="2026-5-24",
    )
    adapter = GenericAdapter(config, llm_client=FailingLLMClient())

    event = adapter.extract_event_info(BeautifulSoup("<html></html>", "html.parser"))

    assert event.name == "声音の宴6次会"
    assert event.url == "https://example.com/catalog"
    assert event.date is not None
    assert event.date.isoformat() == "2026-05-24T00:00:00"


class HeaderMappingLLMClient:
    def __init__(self):
        self.prompts = []

    def extract_data(self, prompt: str, **_kwargs) -> str:
        self.prompts.append(prompt)
        return '{"tables":[{"table_index":0,"columns":{"0":"space","1":"name","2":"twitter_url"}}]}'


def test_first_time_site_uses_only_headers_for_llm_mapping():
    html = """
    <table>
      <tr><th>ブース</th><th>出展者</th><th>SNS</th></tr>
      <tr><td>A-01</td><td>秘密のサークル名</td><td><a href="https://twitter.com/example_user">X</a></td></tr>
    </table>
    """
    client = HeaderMappingLLMClient()
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://new.example/catalog",
        event_name="テストイベント",
    )
    adapter = GenericAdapter(config, llm_client=client)

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert circles[0].name == "秘密のサークル名"
    assert circles[0].space == "A-01"
    assert circles[0].twitter_url == "https://twitter.com/example_user"
    assert len(client.prompts) == 1
    assert "ブース" in client.prompts[0]
    assert "秘密のサークル名" not in client.prompts[0]

    adapter.extract_event_info(BeautifulSoup("<html></html>", "html.parser"))
    assert adapter.extracted_event["name"] == "テストイベント"


class InvalidHeaderLLMClient:
    def __init__(self):
        self.calls = 0

    def extract_data(self, _prompt: str, **_kwargs) -> str:
        self.calls += 1
        return "not-json"


def test_header_mapping_failure_does_not_send_table_rows_to_llm():
    client = InvalidHeaderLLMClient()
    adapter = GenericAdapter(
        SiteConfig(
            site_type=SiteType.CUSTOM,
            base_url="https://new.example/catalog",
            event_name="イベント",
        ),
        llm_client=client,
    )
    html = """
    <table><tr><th>ブース</th><th>出展者</th></tr>
    <tr><td>A-01</td><td>秘密の行データ</td></tr></table>
    """

    assert adapter.extract_circles(BeautifulSoup(html, "html.parser")) == []
    assert client.calls == 1


def test_no_llm_mode_keeps_legacy_table_fallback():
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://example.com/catalog",
        event_name="イベント",
        use_llm=False,
    )
    adapter = GenericAdapter(config, llm_client=FailingLLMClient())
    html = """
    <table><tr><th>配置</th><th>サークル名</th><th>SNSリンク</th></tr>
    <tr><td>A-01</td><td>サークルA</td><td>なし</td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert circles[0].name == "サークルA"

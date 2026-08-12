from bs4 import BeautifulSoup

from src.adapters.learned_pattern_adapter import LearnedPatternAdapter
from src.models import Circle, SiteConfig, SiteType


class FakePatternManager:
    table_header_schemas = []

    def get_pattern(self, _url):
        return {
            "site_key": "known.example/list",
            "event_structure": {},
            "circle_structure": {},
            "extraction_rules": {
                "table_header_schemas": self.table_header_schemas,
            },
        }

    def has_pattern(self, _url):
        return True


class RecordingLLM:
    def __init__(self):
        self.prompts = []

    def extract_data(self, prompt, **_kwargs):
        self.prompts.append(prompt)
        return '{"tables":[{"table_index":0,"columns":{"0":"space","1":"name","2":"twitter_url"}}]}'


def make_adapter(llm):
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://known.example/list",
        event_name="イベント",
    )
    return LearnedPatternAdapter(config, FakePatternManager(), llm)


def test_known_domain_with_exact_headers_skips_llm():
    llm = RecordingLLM()
    adapter = make_adapter(llm)
    html = """
    <table><tr><th>配置</th><th>サークル名</th><th>Twitter</th></tr>
    <tr><td>A-01</td><td>サークルA</td><td><a href="https://x.com/example_a">X</a></td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert llm.prompts == []


def test_known_domain_with_changed_headers_uses_header_llm():
    llm = RecordingLLM()
    adapter = make_adapter(llm)
    html = """
    <table><tr><th>ブース</th><th>出展者</th><th>SNS</th></tr>
    <tr><td>A-01</td><td>サークルA</td><td><a href="https://x.com/example_a">X</a></td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert len(llm.prompts) == 1
    assert "ブース" in llm.prompts[0]
    assert "サークルA" not in llm.prompts[0]


def test_known_domain_with_saved_header_schema_skips_llm():
    llm = RecordingLLM()
    manager = FakePatternManager()
    manager.table_header_schemas = [
        {
            "headers": ["ブース", "出展者", "SNS"],
            "field_map": {"0": "space", "1": "name", "2": "twitter_url"},
        }
    ]
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://known.example/list",
        event_name="イベント",
    )
    adapter = LearnedPatternAdapter(config, manager, llm)
    html = """
    <table><tr><th>ブース</th><th>出展者</th><th>SNS</th></tr>
    <tr><td>A-01</td><td>サークルA</td><td><a href="https://x.com/example_a">X</a></td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert llm.prompts == []


def test_multiple_tables_only_rechecks_changed_schema():
    llm = RecordingLLM()
    manager = FakePatternManager()
    manager.table_header_schemas = [
        {
            "headers": ["配置", "サークル名", "Twitter"],
            "field_map": {"0": "space", "1": "name", "2": "twitter_url"},
        }
    ]
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://known.example/list",
        event_name="イベント",
    )
    adapter = LearnedPatternAdapter(config, manager, llm)
    html = """
    <table><tr><th>配置</th><th>サークル名</th><th>Twitter</th></tr>
    <tr><td>A-01</td><td>既知サークル</td><td><a href="https://x.com/known_a">X</a></td></tr></table>
    <table><tr><th>ブース</th><th>出展者</th><th>SNS</th></tr>
    <tr><td>B-01</td><td>変更サークル</td><td><a href="https://x.com/changed_b">X</a></td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert {circle.name for circle in circles} == {"既知サークル", "変更サークル"}
    assert len(llm.prompts) == 1
    assert "ブース" in llm.prompts[0]
    assert "既知サークル" not in llm.prompts[0]
    assert "変更サークル" not in llm.prompts[0]


def test_changed_headers_fall_back_to_pattern_when_llm_is_unavailable():
    adapter = make_adapter(None)
    adapter._extract_circles_with_pattern = lambda _soup: [
        Circle(name="パターン補完", space="A-01")
    ]
    html = """
    <table><tr><th>ブース</th><th>出展者</th></tr>
    <tr><td>A-01</td><td>パターン補完</td></tr></table>
    """

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert [(circle.name, circle.space) for circle in circles] == [
        ("パターン補完", "A-01")
    ]

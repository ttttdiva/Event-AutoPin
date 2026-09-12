from bs4 import BeautifulSoup
import pytest

from src.core.base_adapter import BaseSiteAdapter
from src.models import Event, EventMap, SiteConfig, SiteType


class DirectTableAdapter(BaseSiteAdapter):
    def can_handle(self, url: str) -> bool:
        return True

    def extract_event_info(self, soup: BeautifulSoup) -> Event:
        return Event(name="test", url=self.config.base_url)

    def extract_circles(self, soup: BeautifulSoup):
        return self.try_direct_table_extraction(soup)

    def extract_circle_images(self, soup: BeautifulSoup):
        return []

    def extract_event_maps(self, soup: BeautifulSoup):
        return [EventMap(url="https://example.com/map.png")]


def test_direct_table_keeps_hyphenated_space_without_hall_split():
    html = """
    <table>
      <tr><th>配置</th><th>サークル名</th><th>ペンネーム</th></tr>
      <tr><td>と-16</td><td>サークルA</td><td>作者A</td></tr>
    </table>
    """
    adapter = DirectTableAdapter(
        SiteConfig(site_type=SiteType.CUSTOM, base_url="https://example.com/")
    )

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert circles[0].space == "と-16"
    assert circles[0].hall is None


def test_direct_table_rejects_partially_unknown_headers():
    html = """
    <table>
      <tr><th>配置</th><th>サークル名</th><th>SNSリンク</th></tr>
      <tr><td>A-01</td><td>サークルA</td><td><a href="https://x.com/example">X</a></td></tr>
    </table>
    """
    adapter = DirectTableAdapter(
        SiteConfig(site_type=SiteType.CUSTOM, base_url="https://example.com/")
    )

    assert adapter.extract_circles(BeautifulSoup(html, "html.parser")) == []


@pytest.mark.parametrize("header", ["X", "Web", ""])
@pytest.mark.parametrize(
    "links, expected_x, expected_web",
    [
        ('<a href="https://circle.wix.com/home">Web</a>', None, "https://circle.wix.com/home"),
        ('<a href="https://x.com/circle">X</a>', "https://x.com/circle", None),
        (
            '<a href="https://circle.example/">Web</a><a href="https://x.com/circle">X</a>',
            "https://x.com/circle", "https://circle.example/",
        ),
        (
            '<a href="https://twitter.com/circle">X</a><a href="https://circle.example/">Web</a>',
            "https://twitter.com/circle", "https://circle.example/",
        ),
        ('https://circle.example/', None, "https://circle.example/"),
        ('<a href="//circle.example/">Web</a>', None, "https://circle.example/"),
        ('<a href="#">なし</a>', None, None),
    ],
)
def test_link_column_classifies_all_urls_by_destination(header, links, expected_x, expected_web):
    html = f"""
    <table><tr><th>配置</th><th>サークル名</th><th>{header}</th></tr>
    <tr><td>A-01</td><td>サークルA</td><td>{links}</td></tr></table>
    """
    adapter = DirectTableAdapter(
        SiteConfig(site_type=SiteType.CUSTOM, base_url="https://event.example/")
    )

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert circles[0].twitter_url == expected_x
    assert circles[0].website_url == expected_web

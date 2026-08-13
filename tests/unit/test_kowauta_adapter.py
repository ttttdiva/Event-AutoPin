from bs4 import BeautifulSoup

from src.adapters.kowauta_adapter import KowaUtaAdapter
from src.models import SiteConfig, SiteType


def test_kowauta_extracts_hyphenated_space_and_non_twitter_website():
    html = """
    <table>
      <tr><th>配置番号</th><th>サークル</th><th>ペンネーム</th><th></th></tr>
      <tr>
        <td>A-01,02</td>
        <td>雛菊書房</td>
        <td>小鳥遊 昴</td>
        <td>
          <a href="https://x.com/HinagikuBooks">X</a>
          <a href="https://www.hinagiku-books.jp">Web</a>
        </td>
      </tr>
    </table>
    """
    adapter = KowaUtaAdapter(
        SiteConfig(
            site_type=SiteType.CUSTOM,
            base_url="https://kowa-uta.com/6th/circleList/",
        )
    )

    circles = adapter.extract_circles(BeautifulSoup(html, "html.parser"))

    assert len(circles) == 1
    assert circles[0].name == "雛菊書房"
    assert circles[0].penname == "小鳥遊 昴"
    assert circles[0].space == "A-01,02"
    assert circles[0].hall is None
    assert circles[0].twitter_url == "https://x.com/HinagikuBooks"
    assert circles[0].website_url == "https://www.hinagiku-books.jp"

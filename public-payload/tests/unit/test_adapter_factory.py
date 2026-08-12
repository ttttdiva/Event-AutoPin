from src.adapters.adapter_factory import AdapterFactory
from src.adapters.generic_adapter import GenericAdapter
from src.adapters.kowauta_adapter import KowaUtaAdapter
from src.models import SiteConfig, SiteType


class FailingPatternManager:
    def has_pattern(self, url: str) -> bool:
        raise AssertionError("kowa-uta.com should not check learned patterns first")


def test_kowauta_url_uses_dedicated_adapter_without_llm_or_patterns():
    config = SiteConfig(
        site_type=SiteType.CUSTOM,
        base_url="https://kowa-uta.com/6th/circleList/",
    )

    adapter = AdapterFactory.create_adapter(
        config,
        llm_client=object(),
        pattern_manager=FailingPatternManager(),
    )

    assert isinstance(adapter, KowaUtaAdapter)
    assert not isinstance(adapter, GenericAdapter)

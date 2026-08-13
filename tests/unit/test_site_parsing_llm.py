import json

from src.models.config import SiteParsingConfig
from src.utils import site_parsing_llm


def test_parse_with_high_end_model_uses_configured_cli_timeout(monkeypatch):
    calls = []

    def fake_execute(prompt, provider, model=None, timeout=120, effort=None):
        calls.append(
            {
                "provider": provider,
                "model": model,
                "timeout": timeout,
                "effort": effort,
            }
        )
        return True, '{"circles": []}'

    monkeypatch.setattr(site_parsing_llm, "execute_cli_prompt", fake_execute)

    class FailingApiClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("API unavailable in this CLI fallback test")

    monkeypatch.setattr(site_parsing_llm, "LLMClient", FailingApiClient)

    result = site_parsing_llm.parse_with_high_end_model(
        "return JSON",
        SiteParsingConfig(
            prefer_cli=True,
            codex_model="gpt-5.5",
            reasoning_effort="high",
            cli_timeout=900,
        ),
    )

    assert json.loads(result) == {"circles": []}
    assert calls == [
        {
            "provider": "codex",
            "model": "gpt-5.5",
            "timeout": 900,
            "effort": "high",
        }
    ]

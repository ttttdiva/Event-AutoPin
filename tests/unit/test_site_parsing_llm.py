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


def test_explicit_site_structure_role_uses_only_selected_provider(monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def extract_data(self, prompt, **kwargs):
            captured["prompt"] = prompt
            captured["extract_kwargs"] = kwargs
            return '{"tables":[]}'

    monkeypatch.setattr(site_parsing_llm, "LLMClient", FakeClient)
    config = SiteParsingConfig(
        provider="cli:grok",
        model="grok-4.7",
        effort="high",
        cli_model_map={"grok": "grok-4.7"},
        cli_effort_map={"grok": "high"},
        fallback_provider=None,
    )

    result = site_parsing_llm.parse_with_high_end_model("header-only schema", config)

    assert json.loads(result) == {"tables": []}
    assert captured["attempts"] == [
        {"kind": "cli", "provider": "grok", "model": "grok-4.7", "effort": "high"}
    ]
    assert captured["cli_timeout"] == 900
    assert captured["extract_kwargs"]["temperature"] == 0.0


def test_explicit_api_structure_role_disables_transport_retries(monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def extract_data(self, _prompt, **_kwargs):
            return '{"tables":[]}'

    monkeypatch.setattr(site_parsing_llm, "LLMClient", FakeClient)
    config = SiteParsingConfig(
        provider="api:openai",
        model="gpt-5.6-luna",
        effort="max",
        fallback_provider=None,
        fallback_model=None,
    )

    result = site_parsing_llm.parse_with_high_end_model(
        "synthetic table headers",
        config,
    )

    assert json.loads(result) == {"tables": []}
    assert captured["max_api_retries"] == 0

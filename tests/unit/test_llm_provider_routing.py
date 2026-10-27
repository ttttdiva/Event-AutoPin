import base64
import pytest

from src.utils import catalog_image_analyzer, cli_llm, grok_build, llm_client


def test_xai_model_uses_xai_key_and_openai_compatible_endpoint(monkeypatch):
    captured = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setenv("XAI_API_KEY", "fixture-value")
    monkeypatch.setattr(llm_client, "OpenAI", FakeOpenAI)
    client = llm_client.LLMClient(
        model="grok-4.7",
        api_provider_map={"grok-4.7": "xai"},
    )

    assert captured["base_url"] == "https://api.x.ai/v1"
    assert captured["api_key"] == "fixture-value"
    assert client.clients[0]["api_type"] == "xai"


def test_llm_client_passes_explicit_api_retry_limit_to_openai(monkeypatch):
    from types import SimpleNamespace

    captured = []
    request_calls = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.append(kwargs)
            self.responses = self
            self.chat = SimpleNamespace(completions=self)

        def with_options(self, **_kwargs):
            return self

        def create(self, **_kwargs):
            request_calls.append(True)
            return SimpleNamespace(
                output_text='{"ok":true}',
                usage=None,
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok":true}'))],
            )

    monkeypatch.setattr(llm_client, "OpenAI", FakeOpenAI)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-only")
    client = llm_client.LLMClient(
        model="gpt-5.6-luna",
        attempts=[{
            "kind": "api",
            "provider": "openai",
            "model": "gpt-5.6-luna",
            "effort": "max",
        }],
        max_api_retries=0,
    )
    result = client.extract_data("fixture prompt")

    assert result == '{"ok":true}'
    assert len(captured) == 2  # attempt coordinator and its actual API client
    assert all(kwargs["max_retries"] == 0 for kwargs in captured)
    assert request_calls == [True]
    assert client.clients[0]["api_type"] == "openai"


def test_anthropic_api_role_initializes_without_openai_fallback(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fixture-value")

    client = llm_client.LLMClient(
        model="claude-sonnet-current",
        api_provider_map={"claude-sonnet-current": "anthropic"},
    )

    assert client.clients[0]["api_type"] == "anthropic"
    assert client.clients[0]["client"] is None
    assert client.clients[0]["api_key"] == "fixture-value"


def test_anthropic_text_and_image_payloads_use_messages_contract(monkeypatch, tmp_path):
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "content": [{"type": "text", "text": '{"ok":true}'}],
                "usage": {"input_tokens": 12, "output_tokens": 3},
            }

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr(llm_client.requests, "post", fake_post)
    image_path = tmp_path / "menu.png"
    image_bytes = b"\x89PNG\r\n\x1a\nfixture"
    image_path.write_bytes(image_bytes)

    text, usage = llm_client.LLMClient._generate_anthropic_content(
        "claude-sonnet-current", "fixture-key", "parse the menu",
        image_path=str(image_path), timeout=7,
    )

    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    assert captured["timeout"] == 7
    blocks = captured["json"]["messages"][0]["content"]
    assert blocks[0]["source"]["type"] == "base64"
    assert blocks[0]["source"]["media_type"] == "image/png"
    assert blocks[0]["source"]["data"] == base64.b64encode(image_bytes).decode("ascii")
    assert blocks[1] == {"type": "text", "text": "parse the menu"}
    assert text == '{"ok":true}'
    assert usage == {"input_tokens": 12, "output_tokens": 3}


@pytest.mark.parametrize("failure_code", ["unknown_delivery", "cancelled"])
def test_unknown_grok_delivery_stops_text_attempt_fallback(monkeypatch, failure_code):
    calls = []
    original_execute = cli_llm.execute_cli_prompt

    def tracked_execute(prompt, provider="antigravity", **kwargs):
        calls.append(provider)
        return original_execute(prompt, provider=provider, **kwargs)

    def unknown_delivery(*_args, **_kwargs):
        raise grok_build.GrokBuildError(failure_code, "fixture response lost")

    monkeypatch.setattr(cli_llm, "execute_cli_prompt", tracked_execute)
    monkeypatch.setattr(grok_build, "execute_grok_build_prompt", unknown_delivery)
    client = llm_client.LLMClient(
        model=[],
        attempts=[
            {"kind": "cli", "provider": "grok", "model": "grok-4.7"},
            {"kind": "cli", "provider": "codex", "model": "gpt-5.5"},
        ],
    )

    with pytest.raises(grok_build.GrokBuildError) as captured:
        client.extract_data("fixture prompt")

    assert captured.value.code == failure_code
    assert calls == ["grok"]


def test_unknown_grok_image_delivery_stops_image_attempt_fallback(monkeypatch, tmp_path):
    image_path = tmp_path / "menu.png"
    image_path.write_bytes(b"fixture image")
    calls = []
    original_execute = cli_llm.execute_cli_prompt

    def tracked_execute(prompt, provider="antigravity", **kwargs):
        calls.append(provider)
        return original_execute(prompt, provider=provider, **kwargs)

    def unknown_delivery(*_args, **_kwargs):
        raise grok_build.GrokBuildError("unknown_delivery", "fixture response lost")

    monkeypatch.setattr(cli_llm, "execute_cli_prompt", tracked_execute)
    monkeypatch.setattr(grok_build, "execute_grok_build_prompt", unknown_delivery)
    analyzer = object.__new__(catalog_image_analyzer.CatalogImageAnalyzer)
    analyzer.attempts = [
        {"kind": "cli", "provider": "grok", "model": "grok-4.7"},
        {"kind": "cli", "provider": "codex", "model": "gpt-5.5"},
    ]

    with pytest.raises(grok_build.GrokBuildError) as captured:
        analyzer._run_analysis_once_impl(image_path, "fixture prompt")

    assert captured.value.code == "unknown_delivery"
    assert calls == []

from src.utils.llm_client import extract_event_keywords_from_text
from src.utils.llm_client import LLMClient


def test_extract_event_keywords_from_japanese_quotes():
    assert extract_event_keywords_from_text("略称として「声音」等もある") == ["声音"]


def test_extract_event_keywords_from_hashtag_and_quotes_dedupes():
    assert extract_event_keywords_from_text("略称は「声音」。タグは #声音 #声音の宴") == [
        "声音",
        "#声音",
        "#声音の宴",
    ]


def test_extract_event_keywords_ignores_generic_terms():
    assert extract_event_keywords_from_text("「イベント」「開催」「声音」") == ["声音"]


def test_extract_event_keywords_returns_explicit_keywords_without_llm_call():
    client = object.__new__(LLMClient)
    client.logger = type(
        "Logger",
        (),
        {"info": lambda self, message: None},
    )()

    def fail_extract_data(*args, **kwargs):
        raise AssertionError("LLM should not be called for explicit quoted keywords")

    client.extract_data = fail_extract_data

    assert client.extract_event_keywords("略称として「声音」等もある") == ["声音"]

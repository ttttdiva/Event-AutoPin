"""Grok検索3方式の設定解決と、無送信probeの純粋回帰テスト。"""

from __future__ import annotations

from datetime import datetime

from src.utils.grok_build_x_search import GrokBuildXSearch, build_prompt
from src.utils.grok_search_modes import (
    check_grok_search_availability,
    normalize_grok_search_mode,
    resolve_grok_search_settings,
)


def test_explicit_mode_selects_only_one_backend():
    for mode in ("api", "build", "bot"):
        settings = resolve_grok_search_settings(
            {"use_grok_search": True, "grok_search_mode": mode}
        )
        assert settings.explicit_mode is True
        assert settings.mode == mode
        assert settings.api_enabled is (mode == "api")
        assert settings.build_enabled is (mode == "build")
        assert settings.bot_enabled is (mode == "bot")


def test_explicit_off_disables_build_rescue_even_when_legacy_default_is_true():
    settings = resolve_grok_search_settings(
        {
            "use_grok_search": False,
            "grok_search_mode": "build",
            # 新GUIが送らなくても、legacy既定値が混入しても停止する。
            "use_grok_rescue": True,
        }
    )
    assert settings.explicit_mode is True
    assert settings.enabled is False
    assert settings.api_enabled is False
    assert settings.build_enabled is False
    assert settings.bot_enabled is False


def test_legacy_keeps_api_and_build_independent():
    api = resolve_grok_search_settings(
        {"use_grok_search": True, "use_grok_rescue": False}
    )
    assert api.legacy and api.api_enabled and not api.build_enabled

    rescue = resolve_grok_search_settings(
        {"use_grok_search": False, "use_grok_rescue": True}
    )
    assert rescue.legacy and not rescue.api_enabled and rescue.build_enabled


def test_invalid_explicit_mode_is_fail_closed():
    settings = resolve_grok_search_settings(
        {"use_grok_search": True, "grok_search_mode": "unknown"}
    )
    assert settings.explicit_mode is True
    assert settings.mode_valid is False
    assert not settings.api_enabled
    assert not settings.build_enabled
    assert not settings.bot_enabled
    assert normalize_grok_search_mode("xai") == "api"
    assert normalize_grok_search_mode("grok-build") == "build"
    assert normalize_grok_search_mode("grok-bot") == "bot"
    assert normalize_grok_search_mode("unknown") is None


def test_switching_mode_does_not_retain_previous_backend_flags():
    api = resolve_grok_search_settings(
        {"use_grok_search": True, "grok_search_mode": "api"}
    )
    build = resolve_grok_search_settings(
        {"use_grok_search": True, "grok_search_mode": "build"}
    )
    assert api.api_enabled and not api.build_enabled
    assert build.build_enabled and not build.api_enabled


def test_availability_probe_uses_injected_non_network_build_probe(monkeypatch):
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    result = check_grok_search_availability(
        mode="build",
        config={"use_grok_search": True, "grok_search_mode": "build"},
        build_probe=lambda: {
            "available": True,
            "installed": True,
            "authenticated": True,
            "auth_status": "authenticated",
            "reason": None,
        },
    )
    assert result["available"] is True
    assert result["mode"] == "build"
    assert result["modes"]["build"]["installed"] is True
    assert "XAI_API_KEY" not in str(result)


def test_build_prompt_propagates_search_date_window():
    prompt = build_prompt(
        ["alice"],
        "鳴花～ず",
        datetime(2026, 11, 1),
        days_before=7,
        days_after=3,
    )
    assert "検索対象期間は2026-10-25から2026-11-04まで" in prompt


def test_build_ask_batch_passes_date_window_to_prompt():
    prompts = []

    def runner(prompt, *, model=None, timeout=None):
        prompts.append(prompt)
        return "@alice | 存在:あり | お品書き:未発見 | -", "fixture-build"

    searcher = GrokBuildXSearch(
        runner=runner,
        availability=lambda: (True, ""),
    )
    searcher.ask_batch(
        ["alice"],
        "鳴花～ず",
        datetime(2026, 11, 1),
        days_before=2,
        days_after=4,
    )
    assert len(prompts) == 1
    assert "検索対象期間は2026-10-30から2026-11-05まで" in prompts[0]

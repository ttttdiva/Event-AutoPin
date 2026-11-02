"""X用Cookieの明示選択・自動検出・APIアカウント反映を検証する。"""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

import src.utils.twitter_extractor as twitter_extractor_module
from src.processors.twitter_post_processor import TwitterConfig, TwitterPostProcessor
from src.utils.twitter_extractor import TwitterExtractor


def _write_cookie_file(path: Path, rows: list[tuple[str, str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Netscape HTTP Cookie File"]
    for domain, name, value in rows:
        flag = "TRUE" if domain.startswith(".") else "FALSE"
        lines.append(f"{domain}\t{flag}\t/\tTRUE\t\t{name}\t{value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _make_cookie_extractor(
    project_root: Path,
    cookie_file: Path | None = None,
) -> TwitterExtractor:
    extractor = object.__new__(TwitterExtractor)
    extractor.cookie_file = str(cookie_file) if cookie_file else None
    extractor.project_root = project_root
    extractor._cookie_routing_reason = None
    return extractor


def test_explicit_x_cookie_is_selected_instead_of_auto_candidates(tmp_path: Path):
    selected = tmp_path / "selected.txt"
    _write_cookie_file(
        selected,
        [(".x.com", "auth_token", "dummy-selected-auth"), (".x.com", "ct0", "dummy-selected-csrf")],
    )
    _write_cookie_file(
        tmp_path / "cookies" / "auto.txt",
        [(".x.com", "auth_token", "dummy-auto-auth"), (".x.com", "ct0", "dummy-auto-csrf")],
    )

    extractor = _make_cookie_extractor(tmp_path, selected)

    assert extractor._get_all_cookies_from_files() == [
        "auth_token=dummy-selected-auth; ct0=dummy-selected-csrf"
    ]
    assert "選択されたCookie" in extractor._cookie_routing_reason


def test_site_only_selected_cookie_falls_back_to_project_root_auto_detection(
    tmp_path: Path,
):
    selected = tmp_path / "site.txt"
    _write_cookie_file(selected, [("example.com", "session", "site-only")])
    _write_cookie_file(
        tmp_path / "cookies" / "x.txt",
        [("x.com", "auth_token", "dummy-auto-auth"), ("x.com", "ct0", "dummy-auto-csrf")],
    )

    extractor = _make_cookie_extractor(tmp_path, selected)

    assert extractor._get_all_cookies_from_files() == [
        "auth_token=dummy-auto-auth; ct0=dummy-auto-csrf"
    ]
    assert "X用認証情報がない" in extractor._cookie_routing_reason


def test_explicit_x_cookie_with_one_missing_token_fails_clearly(tmp_path: Path):
    selected = tmp_path / "partial.txt"
    _write_cookie_file(selected, [(".x.com", "auth_token", "dummy-only-auth")])
    extractor = _make_cookie_extractor(tmp_path, selected)

    with pytest.raises(ValueError, match="auth_tokenまたはct0が不足") as error:
        extractor._get_all_cookies_from_files()

    assert "dummy-only-auth" not in str(error.value)
    assert str(selected) not in str(error.value)


def test_auto_detection_uses_passed_project_root_not_module_root(tmp_path: Path):
    _write_cookie_file(
        tmp_path / "cookies" / "x.txt",
        [(".twitter.com", "auth_token", "dummy-root-auth"), (".twitter.com", "ct0", "dummy-root-csrf")],
    )
    extractor = _make_cookie_extractor(tmp_path)

    assert extractor._get_all_cookies_from_files() == [
        "auth_token=dummy-root-auth; ct0=dummy-root-csrf"
    ]


def test_selected_cookie_is_imported_into_twscrape_account(monkeypatch, tmp_path: Path):
    selected = tmp_path / "selected.txt"
    _write_cookie_file(
        selected,
        [("x.com", "auth_token", "dummy-runtime-auth"), ("x.com", "ct0", "dummy-runtime-csrf")],
    )
    add_calls = []
    login_calls = []

    class FakePool:
        async def add_account(self, **kwargs):
            add_calls.append(kwargs)

        async def login_all(self, *, usernames=None):
            login_calls.append(usernames)

    api = SimpleNamespace(pool=FakePool())
    extractor = _make_cookie_extractor(tmp_path, selected)
    extractor._initialized = False
    extractor.all_accounts = []
    extractor.api_instances = []
    monkeypatch.setattr(extractor, "_create_api_instance", lambda: api)

    asyncio.run(extractor.initialize())

    assert add_calls[0]["cookies"] == "auth_token=dummy-runtime-auth; ct0=dummy-runtime-csrf"
    assert login_calls == [[add_calls[0]["username"]]]


def test_twitter_config_passes_cookie_routing_fields_to_extractor(monkeypatch, tmp_path: Path):
    captured = {}

    class FakeExtractor:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(
        "src.processors.twitter_post_processor.TwitterExtractor", FakeExtractor
    )

    config = TwitterConfig(
        {
            "output_dir": str(tmp_path),
            "cookie_file": "cookies/selected.txt",
            "project_root": str(tmp_path),
        }
    )
    TwitterPostProcessor(config)

    assert config.cookie_file == "cookies/selected.txt"
    assert config.project_root == str(tmp_path)
    assert captured["cookie_file"] == "cookies/selected.txt"
    assert captured["project_root"] == str(tmp_path)

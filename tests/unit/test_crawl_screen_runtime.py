"""クロール画面刷新の実renderer回帰。

Viteでdesktop rendererを起動し、Tauri invoke/bridgeだけを固定fixtureへ置換する。
外部API・Grok/X・実イベントファイル・Cookieは使用しない。Playwrightは常に
headlessで起動し、fixtureの証跡は``.local/ui07-crawl-runtime``へ残す。
"""

from __future__ import annotations

import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest

from tests.unit.test_post_model_settings_runtime import (
    _cached_chromium_executable,
    _free_port,
    _start_fixture,
    _stop_process,
    sync_playwright,
)


ROOT = Path(__file__).resolve().parents[2]
SCRATCH_ROOT = ROOT / ".local" / "ui07-crawl-runtime"


def _event_entries() -> list[dict[str, Any]]:
    """イベント切替用の固定データ。機密情報・外部URLは含めない。"""

    def event(name: str, date: str, url: str, circle: str) -> dict[str, Any]:
        return {
            "event": {
                "name": name,
                "date": date,
                "venue": "Fixture Hall",
                "url": url,
                "source_urls": [url],
            },
            "circles": [
                {
                    "name": circle,
                    "penname": "fixture penname",
                    "space": "A01",
                    "hall": "A",
                    "genres": [],
                    "items": [],
                    "memo": "",
                    "catalog_status": "needs_recheck",
                    "pin_x": 0,
                    "pin_y": 0,
                    "map_number": 1,
                    "priority_color": 5,
                }
            ],
        }

    return [
        {
            "slug": "ui07-crawl-a",
            "dir": "fixture-crawl-a",
            "meta": {
                "name": "UI07 crawl A",
                "date": "2026-10-17",
                "event_url": "https://example.invalid/crawl-a",
                "event_urls": ["https://example.invalid/crawl-a"],
            },
            "data": event(
                "UI07 crawl A",
                "2026-10-17",
                "https://example.invalid/crawl-a",
                "fixture circle A",
            ),
        },
        {
            "slug": "ui07-crawl-b",
            "dir": "fixture-crawl-b",
            "meta": {
                "name": "UI07 crawl B",
                "date": "2026-11-02",
                "event_url": "https://example.invalid/crawl-b",
                "event_urls": ["https://example.invalid/crawl-b"],
            },
            "data": event(
                "UI07 crawl B",
                "2026-11-02",
                "https://example.invalid/crawl-b",
                "fixture circle B",
            ),
        },
    ]


@contextmanager
def _crawl_page(
    *,
    viewport: dict[str, int] | None = None,
    event_entries: list[dict[str, Any]] | None = None,
) -> Iterator[tuple[Any, Path]]:
    """固定Tauri/Vite fixtureを起動し、headless pageを返す。"""

    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=SCRATCH_ROOT))
    process = None
    browser = None
    try:
        process, url = _start_fixture(
            run_dir,
            _free_port(),
            event_entries=event_entries,
            grok_authenticated=True,
        )
        assert sync_playwright is not None
        with sync_playwright() as playwright:
            browser_args: dict[str, Any] = {"headless": True}
            executable = _cached_chromium_executable()
            if executable:
                browser_args["executable_path"] = executable
            browser = playwright.chromium.launch(**browser_args)
            try:
                page = browser.new_page(viewport=viewport or {"width": 1440, "height": 960})
                # Viteのmodule graphが大きいWindows端末ではDOMContentLoadedの通知が
                # 遅れることがあるため、navigationはcommit後にrendererのDOMを待つ。
                page.goto(url, wait_until="commit")
                page.locator("#tab-crawl").wait_for(state="attached", timeout=30_000)
                yield page, run_dir
            finally:
                browser.close()
                browser = None
    finally:
        if browser is not None:
            browser.close()
        _stop_process(process)
        _cleanup_run_dir(run_dir)


def _cleanup_run_dir(run_dir: Path) -> None:
    """fixtureソースを除去し、スクリーンショットとViteログだけ残す。"""

    for path in run_dir.iterdir():
        if path.name == "vite.log" or path.suffix.lower() == ".png":
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def _select_event(page: Any, slug: str) -> None:
    card = page.locator(f'.event-card[data-slug="{slug}"]')
    try:
        card.wait_for(state="visible", timeout=30_000)
    except Exception as error:
        diagnostic = page.evaluate(
            "() => ({cards: Array.from(document.querySelectorAll('.event-card')).map(card => ({slug: card.dataset.slug, text: card.textContent})), calls: (window.__eventAutoPinPostModelFixture?.calls || []).slice(-8), result: document.querySelector('#result')?.textContent || ''})"
        )
        raise AssertionError(f"イベントカード {slug} が表示されません: {diagnostic}") from error
    card.click()
    page.locator(f'.event-card[data-slug="{slug}"].active').wait_for(state="visible")
    expected_dir = "fixture-event" if slug == "ui07-post" else slug.replace("ui07-", "fixture-")
    page.wait_for_function(
        "dir => { const output = document.querySelector('#pipelineOutputDir')?.value || ''; const json = (document.querySelector('#eventJsonHidden')?.value || '').replaceAll('\\\\', '/'); return output === dir && json === `${dir}/event.json`; }",
        arg=expected_dir,
        timeout=30_000,
    )
    page.wait_for_function(
        "() => document.querySelectorAll('#crawlSourceRows tr').length > 0"
    )


def _set_switch(page: Any, name: str, checked: bool) -> None:
    toggle = page.locator(f'[data-crawl-toggle="{name}"]')
    toggle.wait_for(state="visible")
    current = toggle.get_attribute("aria-checked") == "true"
    if current != checked:
        toggle.click()
    assert (toggle.get_attribute("aria-checked") == "true") is checked


def _add_layout_source(page: Any) -> None:
    """nativeQA証跡用にfixture sourceを1件追加する。"""

    if page.locator("#crawlSourceRows tr").count() >= 2:
        return
    page.locator("#crawlAddSourceBtn").click()
    source_dialog = page.locator("#crawlSourceDialog")
    source_dialog.wait_for(state="visible")
    page.locator("#crawlSourceName").fill("代表ソース")
    page.locator("#crawlSourceUrl").fill("https://example.invalid/layout-source")
    page.locator("#crawlSourceMaps").fill("https://example.invalid/layout-map")
    page.locator("#crawlSourcePrompt").fill("layout source prompt")
    page.locator("#crawlSourceSaveBtn").click()
    source_dialog.wait_for(state="hidden")
    page.wait_for_function("() => document.querySelectorAll('#crawlSourceRows tr').length === 2")


def _prepare_visual_capture(page: Any) -> None:
    """比較用captureだけを初期source1件・2026-12-06・30/7へ揃える。"""

    rows = page.locator("#crawlSourceRows tr")
    if rows.count() > 1:
        rows.nth(rows.count() - 1).locator("[data-crawl-source-delete]").click()
        page.wait_for_function("() => document.querySelectorAll('#crawlSourceRows tr').length === 1")
    page.locator("#crawlEditEventBtn").click()
    event_dialog = page.locator("#crawlEventDialog")
    event_dialog.wait_for(state="visible")
    page.locator("#eventDate").fill("2026-12-06")
    page.locator("#crawlEventSaveBtn").click()
    event_dialog.wait_for(state="hidden")
    page.locator("#daysBefore").fill("30")
    page.locator("#daysAfter").fill("7")
    page.locator("#daysBefore").dispatch_event("change")
    page.locator("#daysAfter").dispatch_event("change")
    _set_switch(page, "useGrokSearch", False)
    page.locator("#tab-crawl").evaluate("el => { el.scrollTop = 0; }")
    page.locator(".crawl-main-grid").evaluate("el => { el.scrollTop = 0; }")


def _bridge_calls(page: Any, job: str) -> list[dict[str, Any]]:
    return page.evaluate(
        "job => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.job === job)",
        job,
    )


def _wait_bridge_call(page: Any, job: str, previous_count: int = 0) -> dict[str, Any]:
    try:
        page.wait_for_function(
            "({job, count}) => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.job === job).length > count",
            arg={"job": job, "count": previous_count},
            timeout=20_000,
        )
    except Exception as error:
        diagnostic = page.evaluate(
            "() => ({calls: (window.__eventAutoPinPostModelFixture?.calls || []).slice(-8), result: document.querySelector('#result')?.textContent || '', settings: document.querySelector('#crawlSettingsCheck')?.textContent || '', state: document.querySelector('.crawl-run-bar')?.dataset.state || '', disabled: document.querySelector('#runPipelineBtn')?.disabled || false, eventJson: document.querySelector('#eventJsonHidden')?.value || '', outputDir: document.querySelector('#pipelineOutputDir')?.value || '', editorJson: document.querySelector('#editorJsonPath')?.value || ''})"
        )
        raise AssertionError(f"bridge job {job} が開始されませんでした: {diagnostic}") from error
    calls = _bridge_calls(page, job)
    assert len(calls) > previous_count, f"run_python_bridge({job}) が記録されていません"
    return calls[-1]


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_source_event_dialog_and_owner_switch_preserve_values():
    """source別map/prompt、イベント情報、イベント切替の所有者分離を確認する。"""

    with _crawl_page(event_entries=_event_entries()) as (page, run_dir):
        _select_event(page, "ui07-crawl-a")
        output_dir = page.locator("#outputDir")
        assert output_dir.get_attribute("readonly") is not None
        assert output_dir.input_value() == "fixture-crawl-a"
        before_open = page.evaluate(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'open_file_default').length"
        )
        page.locator("#crawlOutputBrowseBtn").click()
        page.wait_for_function(
            "count => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'open_file_default').length > count",
            arg=before_open,
        )
        open_call = page.evaluate(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'open_file_default').at(-1)"
        )
        assert open_call["args"]["filePath"] == "fixture-crawl-a"

        # イベント情報は旧summaryではなくnative dialogで編集する。
        page.locator("#crawlEditEventBtn").click()
        event_dialog = page.locator("#crawlEventDialog")
        event_dialog.wait_for(state="visible")
        page.locator("#eventName").fill("UI07 crawl A edited")
        page.locator("#eventDate").fill("2026-10-18")
        page.locator("#eventVenue").fill("Edited Fixture Hall")
        page.locator("#crawlEventSaveBtn").click()
        event_dialog.wait_for(state="hidden")
        assert "UI07 crawl A edited" in page.locator("#crawlActiveEvent").inner_text()

        # 追加→sourceごとのmap/prompt編集→削除を独立に確認する。
        assert page.locator("#crawlSourceRows tr").count() == 1
        page.locator("#crawlAddSourceBtn").click()
        source_dialog = page.locator("#crawlSourceDialog")
        source_dialog.wait_for(state="visible")
        page.locator("#crawlSourceName").fill("公式マップ")
        page.locator("#crawlSourceUrl").fill("https://example.invalid/source-a")
        page.locator("#crawlSourceMaps").fill("https://example.invalid/map-a-1\nhttps://example.invalid/map-a-2")
        page.locator("#crawlSourcePrompt").fill("source A prompt")
        page.locator("#crawlSourceSaveBtn").click()
        source_dialog.wait_for(state="hidden")
        page.wait_for_function("() => document.querySelectorAll('#crawlSourceRows tr').length === 2")
        page.wait_for_function(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.command === 'write_event_meta' && call.args?.meta?.event_sources?.length === 2)"
        )
        page.wait_for_timeout(1_200)
        assert "source A prompt" in page.locator("#crawlSourceRows tr").nth(1).inner_text()
        assert "map-a-1" in page.locator("#crawlSourceRows tr").nth(1).inner_text()

        page.locator('[data-crawl-source-edit="1"]').click()
        source_dialog.wait_for(state="visible")
        page.locator("#crawlSourceMaps").fill("https://example.invalid/map-a-edited")
        page.locator("#crawlSourcePrompt").fill("source A edited prompt")
        page.locator("#crawlSourceSaveBtn").click()
        source_dialog.wait_for(state="hidden")
        row_text = page.locator("#crawlSourceRows tr").nth(1).inner_text()
        assert "map-a-edited" in row_text
        assert "source A edited prompt" in row_text

        page.locator("#crawlCommonPromptBtn").click()
        common_dialog = page.locator("#crawlCommonPromptDialog")
        common_dialog.wait_for(state="visible")
        page.locator("#crawlCommonPrompt").fill("common fixture prompt")
        page.locator("#crawlCommonPromptSaveBtn").click()
        common_dialog.wait_for(state="hidden")
        assert "common fixture prompt" in page.locator("#additionalPrompt").input_value()

        # 旧sourceを削除して、新sourceだけがAに残ることを確認する。
        page.locator('[data-crawl-source-delete="0"]').click()
        page.wait_for_function("() => document.querySelectorAll('#crawlSourceRows tr').length === 1")
        assert "https://example.invalid/source-a" in page.locator("#crawlSourceRows").inner_text()
        page.wait_for_function(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.command === 'write_event_meta' && call.args?.meta?.event_sources?.length === 1 && call.args?.meta?.event_sources?.some(source => source.url === 'https://example.invalid/source-a') && call.args?.meta?.crawl_settings && Array.isArray(call.args?.meta?.crawl_data_source_urls))"
        )
        page.wait_for_timeout(1_200)

        # Bの編集はBに閉じ、Aのsource/event値を壊さない。
        _select_event(page, "ui07-crawl-b")
        assert "https://example.invalid/crawl-b" in page.locator("#crawlSourceRows").inner_text()
        assert "UI07 crawl B" in page.locator("#crawlRunEvent").inner_text()
        assert "イベント未選択" not in page.locator("#crawlRunEvent").inner_text()
        assert "イベントを選択してください" not in page.locator("#crawlSettingsCheck").inner_text()
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        page.locator("#eventName").fill("UI07 crawl B edited")
        page.locator("#eventVenue").fill("B Fixture Hall")
        page.locator("#crawlEventSaveBtn").click()
        event_dialog.wait_for(state="hidden")

        _select_event(page, "ui07-crawl-a")
        assert "https://example.invalid/source-a" in page.locator("#crawlSourceRows").inner_text()
        assert "source A edited prompt" in page.locator("#crawlSourceRows").inner_text()
        assert "UI07 crawl A" in page.locator("#crawlRunEvent").inner_text()
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        assert page.locator("#eventName").input_value() == "UI07 crawl A edited"
        assert page.locator("#eventDate").input_value() == "2026-10-18"
        assert page.locator("#eventVenue").input_value() == "Edited Fixture Hall"
        page.locator('[data-crawl-close="crawlEventDialog"]').click()

        screenshot_path = run_dir / "crawl-source-event-switch.png"
        page.screenshot(path=str(screenshot_path), full_page=True)
        assert screenshot_path.exists()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_dialog_cancel_escape_backdrop_do_not_mutate_canonical_values():
    """event/source/commonのcancel・Escape・backdropで未保存値を捨てる。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        event_dialog = page.locator("#crawlEventDialog")
        original = {
            "name": page.locator("#eventName").input_value(),
            "date": page.locator("#eventDate").input_value(),
            "venue": page.locator("#eventVenue").input_value(),
        }

        # 明示closeボタンで未保存値を破棄する。
        before_close = len(
            page.evaluate(
                "() => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'write_event_meta')"
            )
        )
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        page.locator("#eventName").fill("cancelled event name")
        page.locator("#eventDate").fill("2026-12-31")
        page.locator('[data-crawl-close="crawlEventDialog"]').click()
        event_dialog.wait_for(state="hidden")
        page.wait_for_timeout(1_200)
        assert len(
            page.evaluate(
                "() => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'write_event_meta')"
            )
        ) == before_close

        # Escapeでもcanonicalと永続保存を変更しない。
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        page.locator("#eventName").fill("escaped event name")
        page.keyboard.press("Escape")
        event_dialog.wait_for(state="hidden")
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        assert page.locator("#eventName").input_value() == original["name"]
        assert page.locator("#eventDate").input_value() == original["date"]
        page.locator('[data-crawl-close="crawlEventDialog"]').click()

        # backdropクリックも変更をcommitしない。
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        page.locator("#eventVenue").fill("backdrop-only venue")
        page.mouse.click(3, 3)
        event_dialog.wait_for(state="hidden")
        page.locator("#crawlEditEventBtn").click()
        event_dialog.wait_for(state="visible")
        assert page.locator("#eventVenue").input_value() == original["venue"]
        page.locator('[data-crawl-close="crawlEventDialog"]').click()

        # source/common dialogのcancelもhidden canonicalへ値を混ぜない。
        rows_before = page.locator("#crawlSourceRows tr").count()
        event_url_before = page.locator("#eventUrl").input_value()
        page.locator("#crawlAddSourceBtn").click()
        source_dialog = page.locator("#crawlSourceDialog")
        source_dialog.wait_for(state="visible")
        page.locator("#crawlSourceUrl").fill("https://example.invalid/not-saved")
        page.locator("#crawlSourcePrompt").fill("not-saved prompt")
        page.locator('[data-crawl-close="crawlSourceDialog"]').click()
        source_dialog.wait_for(state="hidden")
        assert page.locator("#crawlSourceRows tr").count() == rows_before
        assert page.locator("#eventUrl").input_value() == event_url_before

        prompt_before = page.locator("#additionalPrompt").input_value()
        page.locator("#crawlCommonPromptBtn").click()
        common_dialog = page.locator("#crawlCommonPromptDialog")
        common_dialog.wait_for(state="visible")
        page.locator("#crawlCommonPrompt").fill("not-saved common prompt")
        page.keyboard.press("Escape")
        common_dialog.wait_for(state="hidden")
        assert page.locator("#additionalPrompt").input_value() == prompt_before


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_url_mismatch_exposes_overwrite_new_event_cancel_and_cancel_stops_run():
    """保存済みsource URLと入力URLの不一致に3択を出し、取消で実行しない。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        page.locator('[data-crawl-source-edit="0"]').click()
        source_dialog = page.locator("#crawlSourceDialog")
        source_dialog.wait_for(state="visible")
        page.locator("#crawlSourceUrl").fill("https://example.invalid/crawl-a-changed")
        page.locator("#crawlSourceSaveBtn").click()
        source_dialog.wait_for(state="hidden")
        page.wait_for_function(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.command === 'write_event_meta' && call.args?.meta?.event_sources?.some(source => source.url === 'https://example.invalid/crawl-a-changed'))"
        )
        page.wait_for_timeout(1_200)

        page.locator("#reprocess").select_option("false")
        before_run = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        mismatch = page.locator("div.img-modal-overlay:not(#importModalOverlay)")
        mismatch.wait_for(state="visible", timeout=30_000)
        assert page.locator("#mismatchOverwrite").is_visible()
        assert page.locator("#mismatchNewEvent").is_visible()
        assert page.locator("#mismatchCancel").is_visible()
        page.locator("#mismatchCancel").click()
        mismatch.wait_for(state="hidden")
        page.wait_for_timeout(300)
        assert len(_bridge_calls(page, "run_main_pipeline")) == before_run
        assert "キャンセル" in page.locator("#result").inner_text()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_runtime_payload_flags_normal_api():
    """通常実行のAPI/on・収集・backup・座標再生成flagsをpayloadで確認する。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        page.wait_for_function("() => document.querySelector('#crawlRunBar') || document.querySelector('.crawl-run-bar')")

        # 通常実行: API/on。全flagがrun_main_pipeline payloadへ出る。
        _set_switch(page, "useGrokSearch", True)
        page.locator("#grokSearchMode").select_option("api")
        page.wait_for_function(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.job === 'probe_grok_search' && call.payload?.grok_search_mode === 'api')"
        )
        assert "利用可能" in page.locator("#crawlGrokAvailability").inner_text()
        _set_switch(page, "collectCatalogs", True)
        _set_switch(page, "enableTwitter", True)
        page.locator("#backup").select_option("true")
        page.locator("#reprocess").select_option("false")
        page.locator("#regen").select_option("true")
        before_main = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        normal_call = _wait_bridge_call(page, "run_main_pipeline", before_main)
        normal_payload = normal_call["payload"]
        assert normal_payload["collect_catalogs"] is True
        assert normal_payload["enable_twitter_catalog"] is True
        assert normal_payload["use_grok_search"] is True
        assert normal_payload["grok_search_mode"] == "api"
        assert normal_payload["backup"] is True
        assert normal_payload["reprocess"] is False
        assert normal_payload["regenerate_coordinates"] is True
        assert normal_payload["urls"] == ["https://example.invalid/crawl-a"]
        page.wait_for_function(
            "() => !document.querySelector('#runPipelineBtn').disabled",
            timeout=30_000,
        )



@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_collect_off_keeps_saved_x_grok_for_basic_source_collection():
    """本文収集OFFでも保存済みX/Grok値を保持して基本source収集を実行できる。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        _set_switch(page, "collectCatalogs", False)
        _set_switch(page, "enableTwitter", True)
        _set_switch(page, "useGrokSearch", True)
        page.locator("#grokSearchMode").select_option("api")
        page.locator("#backup").select_option("false")
        page.locator("#reprocess").select_option("false")
        page.locator("#regen").select_option("false")
        before = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        call = _wait_bridge_call(page, "run_main_pipeline", before)
        payload = call["payload"]
        assert payload["collect_catalogs"] is False
        assert payload["enable_twitter_catalog"] is True
        assert payload["use_grok_search"] is True
        assert payload["grok_search_mode"] == "api"
        page.wait_for_function(
            "() => !document.querySelector('#runPipelineBtn').disabled",
            timeout=30_000,
        )


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_reprocess_build_off_omits_urls_and_invalid_guard():
    """再処理のBuild/off flags、URL不要、無効組合せfail-closedを確認する。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")

        # 再処理: Build/off。URL・sourcesはbackendへ渡さず、他flagは保持する。
        _set_switch(page, "useGrokSearch", True)
        page.locator("#grokSearchMode").select_option("build")
        page.wait_for_function(
            "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.job === 'probe_grok_search' && call.payload?.grok_search_mode === 'build')"
        )
        assert "利用可能" in page.locator("#crawlGrokAvailability").inner_text()
        _set_switch(page, "collectCatalogs", True)
        _set_switch(page, "enableTwitter", True)
        _set_switch(page, "useGrokSearch", False)
        page.locator("#backup").select_option("false")
        page.locator("#reprocess").select_option("true")
        page.locator("#regen").select_option("false")
        before_reprocess = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        reprocess_call = _wait_bridge_call(page, "run_main_pipeline", before_reprocess)
        reprocess_payload = reprocess_call["payload"]
        assert reprocess_payload["collect_catalogs"] is True
        assert reprocess_payload["enable_twitter_catalog"] is True
        assert reprocess_payload["use_grok_search"] is False
        assert reprocess_payload["grok_search_mode"] == "build"
        assert reprocess_payload["backup"] is False
        assert reprocess_payload["reprocess"] is True
        assert reprocess_payload["regenerate_coordinates"] is False
        assert reprocess_payload["url"] == ""
        assert reprocess_payload["urls"] == []
        assert reprocess_payload["event_sources"] == []
        page.wait_for_function(
            "() => !document.querySelector('#runPipelineBtn').disabled",
            timeout=30_000,
        )

        # 無効組合せ（再処理で収集/座標を全off）は実行を増やさずfail-closed。
        page.locator("#reprocess").select_option("true")
        _set_switch(page, "collectCatalogs", False)
        _set_switch(page, "enableTwitter", False)
        page.locator("#regen").select_option("false")
        before_invalid = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        page.wait_for_function("() => document.querySelector('.crawl-run-bar')?.dataset.state === 'invalid'")
        assert len(_bridge_calls(page, "run_main_pipeline")) == before_invalid
        assert "再処理で実行する収集・座標処理がありません" in page.locator("#crawlSettingsCheck").inner_text()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_raw_search_days_fail_closed_instead_of_normalizing_invalid_input():
    """検索期間の実入力（負数/小数/空/過大）を丸めず実行前に停止する。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        page.locator("#reprocess").select_option("false")
        _set_switch(page, "collectCatalogs", True)
        _set_switch(page, "enableTwitter", False)
        _set_switch(page, "useGrokSearch", False)
        page.locator("#regen").select_option("false")

        for raw in ("-1", "1.5", "", "3651"):
            page.locator("#daysBefore").fill(raw)
            page.locator("#daysAfter").fill("7")
            page.locator("#daysBefore").dispatch_event("change")
            before = len(_bridge_calls(page, "run_main_pipeline"))
            page.locator("#runPipelineBtn").click()
            page.wait_for_function(
                "() => document.querySelector('.crawl-run-bar')?.dataset.state === 'invalid'"
            )
            assert len(_bridge_calls(page, "run_main_pipeline")) == before
            assert "開催日前" in page.locator("#crawlSettingsCheck").inner_text()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_busy_event_switch_double_run_and_failure_recovery():
    """busy中のイベント切替/二重実行防止と失敗後の再実行を確認する。"""

    with _crawl_page(event_entries=_event_entries()) as (page, _run_dir):
        _select_event(page, "ui07-crawl-a")
        page.locator("#reprocess").select_option("true")
        page.evaluate("() => { window.__eventAutoPinPostModelFixture.holdPipeline = true; }")
        before = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        page.wait_for_function("() => window.__eventAutoPinPostModelFixture.pipelineWaiting === true")
        assert len(_bridge_calls(page, "run_main_pipeline")) == before + 1
        assert page.locator("#runPipelineBtn").is_disabled()
        assert page.locator(".crawl-run-bar").get_attribute("data-state") == "busy"
        assert page.locator("#tab-crawl").get_attribute("aria-busy") == "true"

        # 二重実行はdisabledで増えず、busy中のイベント切替も現在ownerを変えない。
        page.evaluate("() => document.querySelector('#runPipelineBtn').click()")
        page.locator('.event-card[data-slug="ui07-crawl-b"]').click(force=True)
        page.wait_for_timeout(100)
        assert page.locator('.event-card[data-slug="ui07-crawl-a"].active').count() == 1
        assert len(_bridge_calls(page, "run_main_pipeline")) == before + 1

        page.evaluate("() => window.__eventAutoPinPostModelFixture.releasePipeline()")
        page.wait_for_function("() => !document.querySelector('#runPipelineBtn').disabled", timeout=20_000)
        assert page.locator(".crawl-run-bar").get_attribute("data-state") == "complete"

        # 失敗後もrun buttonを復旧し、次の成功実行を受け付ける。
        page.evaluate("() => { window.__eventAutoPinPostModelFixture.pipelineFailure = true; }")
        failed_before = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        _wait_bridge_call(page, "run_main_pipeline", failed_before)
        page.wait_for_function(
            "() => !document.querySelector('#runPipelineBtn').disabled && document.querySelector('.crawl-run-bar')?.dataset.state === 'error'",
            timeout=20_000,
        )

        page.evaluate("() => { window.__eventAutoPinPostModelFixture.pipelineFailure = false; }")
        recovered_before = len(_bridge_calls(page, "run_main_pipeline"))
        page.locator("#runPipelineBtn").click()
        _wait_bridge_call(page, "run_main_pipeline", recovered_before)
        page.wait_for_function(
            "() => !document.querySelector('#runPipelineBtn').disabled && document.querySelector('.crawl-run-bar')?.dataset.state === 'complete'",
            timeout=20_000,
        )


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_crawl_preset_theme_help_and_responsive_layout():
    """preset保存/選択/削除、theme、help、主要viewportの到達性を確認する。"""

    with _crawl_page(
        viewport={"width": 1648, "height": 954}, event_entries=_event_entries()
    ) as (page, run_dir):
        _select_event(page, "ui07-crawl-a")
        # nativeQA比較用に代表sourceを1件追加しておく。
        _add_layout_source(page)

        # native preset dialogで保存→select→管理画面から削除。
        # 実行時optionsはpresetに含めず、現在値を保持する契約を確認する。
        _set_switch(page, "collectCatalogs", False)
        _set_switch(page, "enableTwitter", False)
        _set_switch(page, "useGrokSearch", False)
        page.locator("#backup").select_option("true")
        page.locator("#reprocess").select_option("true")
        page.locator("#regen").select_option("true")
        page.locator("#grokSearchMode").select_option("build")
        page.locator("#crawlSavePresetBtn").click()
        preset_dialog = page.locator("#crawlPresetDialog")
        preset_dialog.wait_for(state="visible")
        page.locator("#crawlPresetName").fill("UI07 build preset")
        page.locator("#crawlPresetCreateBtn").click()
        page.wait_for_function(
            "() => document.querySelector('#crawlPresetSelect option[value=\"UI07 build preset\"]')"
        )
        _set_switch(page, "collectCatalogs", True)
        _set_switch(page, "enableTwitter", True)
        _set_switch(page, "useGrokSearch", True)
        page.locator("#backup").select_option("false")
        page.locator("#reprocess").select_option("false")
        page.locator("#regen").select_option("false")
        page.locator("#grokSearchMode").select_option("api")
        page.locator("#crawlPresetSelect").select_option("UI07 build preset")
        # モデル系の値だけpresetから戻り、実行時optionsは変更後の値を維持する。
        assert page.locator("#grokSearchMode").input_value() == "api"
        assert page.locator("#backup").input_value() == "false"
        assert page.locator("#reprocess").input_value() == "false"
        assert page.locator("#regen").input_value() == "false"
        assert page.locator('[data-crawl-toggle="collectCatalogs"]').get_attribute("aria-checked") == "true"
        assert page.locator('[data-crawl-toggle="enableTwitter"]').get_attribute("aria-checked") == "true"
        assert page.locator('[data-crawl-toggle="useGrokSearch"]').get_attribute("aria-checked") == "true"
        page.locator("#crawlManagePresetsBtn").click()
        preset_dialog.wait_for(state="visible")
        delete = page.locator('[data-crawl-preset-delete="UI07 build preset"]')
        delete.wait_for(state="visible")
        delete.click()
        page.wait_for_function(
            "() => !document.querySelector('#crawlPresetSelect option[value=\"UI07 build preset\"]')"
        )
        page.locator('[data-crawl-close="crawlPresetDialog"]').click()

        # helpは常時表示せず、Escape/外側クリックで閉じる。
        trigger = page.locator("#crawlOverviewHelpTrigger")
        trigger.click()
        assert trigger.get_attribute("aria-expanded") == "true"
        page.keyboard.press("Escape")
        assert trigger.get_attribute("aria-expanded") == "false"
        trigger.click()
        assert trigger.get_attribute("aria-expanded") == "true"
        page.locator("#tab-crawl").click(position={"x": 5, "y": 5})
        assert trigger.get_attribute("aria-expanded") == "false"

        # theme toggleはreloadを伴うためstorageの反転だけを固定検証する。
        page.evaluate("() => localStorage.setItem('eventtrail-theme', 'dark')")
        page.reload(wait_until="commit")
        page.locator("#tab-crawl").wait_for(state="attached", timeout=30_000)
        _select_event(page, "ui07-crawl-a")
        _prepare_visual_capture(page)
        dark_screenshot = run_dir / "crawl-layout-dark-1648x954.png"
        page.screenshot(path=str(dark_screenshot), full_page=True)
        assert dark_screenshot.exists()
        page.locator("#themeToggleBtn").click()
        page.wait_for_function("() => localStorage.getItem('eventtrail-theme') === 'light'")
        page.reload(wait_until="commit")
        page.locator("#tab-crawl").wait_for(state="attached", timeout=30_000)
        assert page.evaluate("() => localStorage.getItem('eventtrail-theme')") == "light"
        _select_event(page, "ui07-crawl-a")
        _prepare_visual_capture(page)
        light_screenshot = run_dir / "crawl-layout-light-1648x954.png"
        page.screenshot(path=str(light_screenshot), full_page=True)
        assert light_screenshot.exists()

        for viewport, name in (
            ({"width": 1648, "height": 954}, "1648x954"),
            ({"width": 1280, "height": 900}, "1280x900"),
            ({"width": 760, "height": 900}, "narrow-760x900"),
        ):
            page.set_viewport_size(viewport)
            page.wait_for_timeout(100)
            metrics = page.locator("#tab-crawl").evaluate(
                "el => ({scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight})"
            )
            if viewport["width"] >= 1080:
                assert metrics["scrollWidth"] <= metrics["clientWidth"] + 2
            else:
                # 狭幅ではsource/model tableの内側scrollだけを許容する。
                assert metrics["scrollWidth"] >= metrics["clientWidth"]
                assert page.locator(".crawl-table-scroll").count() >= 1
            scroll_host = page.locator(".crawl-main-grid")
            scroll_host.evaluate("el => { el.scrollTop = el.scrollHeight; }")
            bar_box = page.locator(".crawl-run-bar").bounding_box()
            grid_box = scroll_host.bounding_box()
            assert bar_box is not None
            assert grid_box is not None
            assert bar_box["y"] + bar_box["height"] <= viewport["height"] + 2
            # main-gridのカード末尾がsticky runbarに潜り込まない予約領域を確認する。
            assert grid_box["y"] + grid_box["height"] <= bar_box["y"] + 2
            screenshot_path = run_dir / f"crawl-layout-{name}.png"
            page.screenshot(path=str(screenshot_path), full_page=True)
            assert screenshot_path.exists()

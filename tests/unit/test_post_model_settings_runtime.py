"""おしながきポスト用モデル設定を実rendererで検証する。

Playwrightが利用できる環境では、Viteでdesktop rendererを起動し、Tauri
invokeだけを固定fixtureへ差し替える。外部API・X・LLM・実イベントファイルは
一切使用しない。fixtureのログとスクリーンショットは.local配下へ残す。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest


try:
    from playwright.sync_api import Page, expect, sync_playwright
except ImportError:  # pragma: no cover - 開発端末のブラウザQA環境で実行する
    Page = Any  # type: ignore[misc,assignment]
    expect = None
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "desktop-app"
SCRATCH_ROOT = ROOT / ".local" / "ui07-post-model-runtime"
POST_URL = "https://x.com/fixture/status/1234567890"


INITIAL_PROJECT_YAML = """# fixture project config
url: "https://example.invalid/event"
output_dir: "fixture-event"
models:
  - "post-primary-model"
text_llm_provider: "api:openai"
text_llm_cli_models: {}
text_llm_cli_efforts: {}
api_reasoning_effort: "high"
api_reasoning_effort_map:
  post-primary-model: "high"
text_fallback_llm_provider: ""
text_fallback_llm_model: ""
text_fallback_llm_effort: ""
image_llm_provider: "api:openai"
image_llm_model: "vision-primary-model"
image_llm_effort: "medium"
image_fallback_llm_provider: ""
image_fallback_llm_model: ""
image_fallback_llm_effort: ""
image_api_reasoning_effort_map:
  vision-primary-model: "medium"
site_parsing:
  provider: "api:openai"
  model: "post-primary-model"
  effort: "high"
oshinagaki_post:
  provider: "api:openai"
  model: "post-primary-model"
  effort: "high"
  fallback_enabled: true
  fallback_provider: "cli:grok"
  fallback_model: "grok-post-fallback"
  fallback_effort: "none"
skip_circle_images: true
enable_twitter_catalog: true
use_grok_search: false
verbose: false
catalog_additional_prompt: ""
"""


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _cached_chromium_executable() -> str | None:
    """Playwright Python版と既存ブラウザ版が異なるQA端末でも再利用する。"""

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if not local_app_data:
        return None
    root = Path(local_app_data) / "ms-playwright"
    candidates = sorted(root.glob("chromium-*/chrome-win64/chrome.exe"), reverse=True)
    return str(candidates[0]) if candidates else None


def _write_fixture(
    run_dir: Path,
    *,
    initial_project_yaml: str = INITIAL_PROJECT_YAML,
    dynamic_api_models: list[dict[str, Any]] | None = None,
    grok_authenticated: bool = False,
    env_keys: dict[str, str] | None = None,
) -> Path:
    """Tauri APIを同一ページ内の記録用fixtureへ置き換える。"""

    dynamic_api_models = dynamic_api_models or []
    env_keys = env_keys or {
        "openaiApiKey": "fixture-key",
        "geminiApiKey": "",
        "anthropicApiKey": "",
        "xaiApiKey": "",
    }
    stubs = run_dir / "tauri-stubs"
    stubs.mkdir(parents=True)
    tauri_source = r"""
const OPENAI_MODELS = [
  {
    id: "post-primary-model",
    label: "Post Primary",
    provider: "openai",
    source: "fixture",
    source_label: "fixture",
    availability: "available",
    capabilities: { text: "verified", image: "verified" },
    reasoning_efforts: ["none", "low", "medium", "high", "max"],
  },
  {
    id: "vision-primary-model",
    label: "Vision Primary",
    provider: "openai",
    source: "fixture",
    source_label: "fixture",
    availability: "available",
    capabilities: { text: "verified", image: "verified" },
    reasoning_efforts: ["none", "low", "medium", "high", "max"],
  },
  {
    id: "vision-fallback-model",
    label: "Vision Fallback",
    provider: "openai",
    source: "fixture",
    source_label: "fixture",
    availability: "available",
    capabilities: { text: "verified", image: "verified" },
    reasoning_efforts: ["none", "low", "medium", "high", "max"],
  },
];
const DYNAMIC_OPENAI_MODELS = __DYNAMIC_OPENAI_MODELS__;
const GROK_AUTHENTICATED_DEFAULT = __GROK_AUTHENTICATED_DEFAULT__;
const ENV_KEYS = __ENV_KEYS__;

const INITIAL_PROJECT_YAML = __INITIAL_PROJECT_YAML__;
function projectConfig() {
  return localStorage.getItem("ui07-post-project-yaml") || INITIAL_PROJECT_YAML;
}

const EVENT = {
  event: {
    name: "UI07 post model fixture",
    date: "2026-10-17",
    url: "https://example.invalid/event",
    source_urls: ["https://example.invalid/event"],
  },
  circles: [{
    name: "fixture circle",
    penname: "fixture penname",
    space: "A01",
    hall: "A",
    genres: [],
    items: [],
    memo: "",
    catalog_status: "needs_recheck",
    pin_x: 0,
    pin_y: 0,
    map_number: 1,
    priority_color: 5,
  }],
};

function catalog() {
  const grokAuthenticated = GROK_AUTHENTICATED_DEFAULT || localStorage.getItem("ui07-post-grok-auth") === "true";
  return {
    providers: [
      {
        id: "codex",
        label: "Codex CLI",
        kind: "cli",
        available: true,
        authenticated: true,
        auth_status: "authenticated",
        models: [{
          id: "gpt-5.5",
          label: "GPT-5.5",
          source_label: "fixture",
          availability: "available",
          capabilities: { text: "verified", image: "verified" },
          reasoning_efforts: ["none", "low", "medium", "high", "max"],
        }],
      },
      {
        id: "antigravity",
        label: "Antigravity CLI",
        kind: "cli",
        available: true,
        authenticated: true,
        auth_status: "authenticated",
        models: [{
          id: "default",
          label: "default",
          source_label: "fixture",
          availability: "available",
          capabilities: { text: "verified", image: "verified" },
          reasoning_efforts: ["none", "low", "medium", "high", "max"],
        }],
      },
      {
        id: "grok",
        label: "Grok Build",
        kind: "cli",
        available: true,
        authenticated: grokAuthenticated,
        auth_status: grokAuthenticated ? "authenticated" : "unauthenticated",
        models: [{
          id: "grok-post-fallback",
          label: "Grok Post Fallback",
          source_label: "fixture",
          availability: "available",
          capabilities: { text: "verified", image: "verified" },
          reasoning_efforts: ["none", "low", "medium", "high", "max"],
        }],
      },
    ],
    apiProviders: [{
      id: "openai",
      label: "OpenAI API",
      status: "available",
      credential_configured: true,
    }],
    apiModels: [...OPENAI_MODELS, ...DYNAMIC_OPENAI_MODELS],
    apiErrors: [],
    cache_state: "fresh",
  };
}

const fixture = (globalThis.__eventAutoPinPostModelFixture ||= { calls: [] });
function record(command, args) {
  fixture.calls.push({
    command,
    args: args || null,
    job: args?.job,
    payload: args?.payload,
  });
}

export async function invoke(command, args = {}) {
  record(command, args);
  if (command === "load_desktop_config") {
    return {
      pythonExe: "python",
      projectRoot: ".",
      timeoutMs: 10800000,
      foamDir: "",
      unlimitedOcrModel: "baidu/Unlimited-OCR",
      unlimitedOcrModelPath: "",
      unlimitedOcrVenv: "",
      unlimitedOcrHfHome: "",
      unlimitedOcrRevision: "fixture",
      unlimitedOcrDevice: "cpu",
      unlimitedOcrMode: "base",
      unlimitedOcrStrategy: "balanced",
    };
  }
  if (command === "load_env_keys") {
    return ENV_KEYS;
  }
  if (command === "load_project_config") {
    return { found: true, raw: projectConfig() };
  }
  if (command === "save_project_config") {
    localStorage.setItem("ui07-post-project-yaml", String(args.yamlContent || ""));
    return { status: "ok" };
  }
  if (command === "save_desktop_config" || command === "save_env_keys") {
    return { status: "ok" };
  }
  if (command === "list_model_catalog") return catalog();
  if (command === "list_event_dirs") {
    return {
      status: "ok",
      events: [{
        slug: "ui07-post",
        dir: "fixture-event",
        meta: {
          name: "UI07 post model fixture",
          date: "2026-10-17",
          event_url: "https://example.invalid/event",
          event_urls: ["https://example.invalid/event"],
        },
      }],
    };
  }
  if (command === "load_event_bundle") {
    return {
      data: EVENT,
      meta: {
        name: "UI07 post model fixture",
        date: "2026-10-17",
        event_url: "https://example.invalid/event",
        event_urls: ["https://example.invalid/event"],
      },
      modified_ms: 1,
      modified_ns: 1,
      file_size: 1,
      content_hash: "fixture-hash-1",
    };
  }
  if (command === "list_event_map_images" || command === "list_map_images") {
    return { status: "ok", maps: [] };
  }
  if (command === "get_desktop_performance_counters") {
    return { python_bridge_spawn_count: 0, tauri_event_io_ipc_count: 0 };
  }
  if (command === "save_event_json_native" || command === "save_event_json_native_checked") {
    return { modified_ms: 2, modified_ns: 2, file_size: 1, content_hash: "fixture-hash-2" };
  }
  if (command === "append_log") return { status: "ok" };
  if (command === "check_for_update" || command === "cleanup_old_update") {
    return command === "check_for_update"
      ? { updateAvailable: false, currentVersion: "fixture" }
      : { status: "ok" };
  }
  if (command === "run_python_bridge") {
    if (args.job === "load_circle_master") {
      return { ok: true, bridge: { status: "ok", data: { circles: {} } } };
    }
    if (args.job === "reprocess_circle_from_post") {
      // 外部処理は行わず、payloadを観測した時点でfixtureジョブを終了する。
      return { ok: false, bridge: { status: "error", error: "fixture-stop-before-network" } };
    }
    return { ok: true, bridge: { status: "ok", data: {} } };
  }
  throw new Error("UI07 post model fixture blocked Tauri command: " + command);
}

export function convertFileSrc(path) { return path; }
"""
    (stubs / "tauri.ts").write_text(
        tauri_source
        .replace("__INITIAL_PROJECT_YAML__", json.dumps(initial_project_yaml))
        .replace("__DYNAMIC_OPENAI_MODELS__", json.dumps(dynamic_api_models))
        .replace("__GROK_AUTHENTICATED_DEFAULT__", json.dumps(grok_authenticated))
        .replace("__ENV_KEYS__", json.dumps(env_keys)),
        encoding="utf-8",
    )
    (stubs / "event.ts").write_text(
        "export async function listen(_name, _handler) { return () => {}; }\n",
        encoding="utf-8",
    )
    (stubs / "window.ts").write_text(
        """
export const appWindow = {
  async close() {},
  async onCloseRequested(_handler) { return () => {}; },
};
""".strip()
        + "\n",
        encoding="utf-8",
    )
    (stubs / "dialog.ts").write_text(
        "export async function open(_options) { return null; }\n",
        encoding="utf-8",
    )

    desktop_root = DESKTOP.as_posix()
    stub_root = stubs.as_posix()
    vite_index = (DESKTOP / "node_modules" / "vite" / "dist" / "node" / "index.js").as_posix()
    tailwind_index = (
        DESKTOP / "node_modules" / "@tailwindcss" / "vite" / "dist" / "index.mjs"
    ).as_posix()
    config = f"""
import {{ defineConfig }} from "{vite_index}";
import tailwindcss from "{tailwind_index}";

const darkReaderLock = {{
  name: "ui07-post-model-darkreader-lock",
  transformIndexHtml() {{
    return [{{ tag: "meta", attrs: {{ name: "darkreader-lock" }}, injectTo: "head-prepend" }}];
  }},
}};

export default defineConfig({{
  root: "{desktop_root}",
  plugins: [darkReaderLock, tailwindcss()],
  clearScreen: false,
  resolve: {{
    alias: {{
      "@tauri-apps/api/tauri": "{stub_root}/tauri.ts",
      "@tauri-apps/api/event": "{stub_root}/event.ts",
      "@tauri-apps/api/window": "{stub_root}/window.ts",
      "@tauri-apps/api/dialog": "{stub_root}/dialog.ts",
    }},
  }},
  server: {{ strictPort: true }},
}});
"""
    config_path = run_dir / "vite.fixture.config.mjs"
    config_path.write_text(config, encoding="utf-8")
    return config_path


def _start_fixture(
    run_dir: Path,
    port: int,
    **fixture_options: Any,
) -> tuple[subprocess.Popen[str], str]:
    config_path = _write_fixture(run_dir, **fixture_options)
    node = shutil.which("node") or "node"
    vite_js = DESKTOP / "node_modules" / "vite" / "bin" / "vite.js"
    log_path = run_dir / "vite.log"
    log = log_path.open("w", encoding="utf-8")
    startupinfo = None
    creationflags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            [
                node,
                str(vite_js),
                "--config",
                str(config_path),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=DESKTOP,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
    finally:
        log.close()

    assert process is not None
    url = f"http://127.0.0.1:{port}/"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Vite fixture exited: {log_path}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return process, url
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    _stop_process(process)
    raise TimeoutError(f"Vite fixture did not start: {log_path}")


def _stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _select_value(page: Page, selector: str, value: str) -> None:
    """selectのイベントをUIへ渡し、更新後のvalueを確認する。"""

    control = page.locator(selector)
    control.wait_for(state="visible")
    option_state = control.locator(f"option[value='{value}']").evaluate(
        "(option) => ({disabled: option.disabled, parentDisabled: option.parentElement.disabled})"
    )
    assert option_state == {"disabled": False, "parentDisabled": False}, (
        f"{selector} の {value} が選択不可: {option_state}"
    )
    control.select_option(value)
    assert control.input_value() == value


def _wait_for_bridge_call(page: Page, job: str) -> dict[str, Any]:
    page.wait_for_function(
        "job => window.__eventAutoPinPostModelFixture?.calls?.some(call => call.job === job)",
        arg=job,
        timeout=15_000,
    )
    calls = page.evaluate(
        "job => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === job)",
        job,
    )
    assert calls, f"run_python_bridge({job}) が記録されていません"
    return calls[-1]


def _open_post_context_menu(page: Page) -> None:
    row = page.locator("#circleEditor tr.circle-row[data-circle-row='0']")
    row.wait_for(state="visible")
    row.evaluate(
        """row => row.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }))"""
    )
    page.get_by_text("このサークルを再処理（XポストURL指定）", exact=True).wait_for(
        state="visible"
    )


def _cleanup_run_dir(run_dir: Path) -> None:
    """fixtureの一時ソースは消し、指定されたログ・画像だけ残す。"""

    for path in run_dir.iterdir():
        if path.name in {"vite.log", "post-model-settings.png"}:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_live_api_model_catalog_supports_unknown_future_openai_models():
    """provider-apiの未知モデルを自動取得・選択・post実行まで実rendererで確認する。"""

    future_model = "gpt-future-ui07"
    unsupported_model = "gpt-known-unsupported-ui07"
    retired_model = "gpt-retired-ui07"
    stale_model = "gpt-stale-ui07"
    dynamic_models = [
        {
            "id": future_model,
            "label": "GPT Future UI07",
            "provider": "openai",
            "source": "provider-api",
            "source_label": "API取得",
            "availability": "available",
            "capabilities": {"text": "unknown", "image": "unknown"},
        },
        {
            "id": unsupported_model,
            "label": "GPT Unsupported UI07",
            "provider": "openai",
            "source": "provider-api",
            "source_label": "API取得",
            "availability": "available",
            "capabilities": {"text": "unsupported", "image": "unsupported"},
        },
        {
            "id": retired_model,
            "label": "GPT Retired UI07",
            "provider": "openai",
            "source": "provider-api",
            "source_label": "API取得",
            "availability": "retired",
            "capabilities": {"text": "verified", "image": "verified"},
        },
        {
            "id": stale_model,
            "label": "GPT Stale UI07",
            "provider": "openai",
            "source": "stale-cache",
            "source_label": "保存済み候補（更新失敗）",
            "availability": "available",
            "stale": True,
            "capabilities": {"text": "unknown", "image": "unknown"},
        },
    ]
    dynamic_yaml = (
        INITIAL_PROJECT_YAML.replace('"post-primary-model"', f'"{future_model}"')
        .replace('"vision-primary-model"', f'"{future_model}"')
    )

    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="dynamic-run-", dir=SCRATCH_ROOT))
    process = None
    try:
        process, url = _start_fixture(
            run_dir,
            _free_port(),
            initial_project_yaml=dynamic_yaml,
            dynamic_api_models=dynamic_models,
            grok_authenticated=True,
            env_keys={
                "openaiApiKey": "fixture-key",
                "geminiApiKey": "",
                "anthropicApiKey": "dummy-key",
                "xaiApiKey": "",
            },
        )
        with sync_playwright() as playwright:
            browser_args: dict[str, Any] = {"headless": True}
            executable = _cached_chromium_executable()
            if executable:
                browser_args["executable_path"] = executable
            browser = playwright.chromium.launch(**browser_args)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 960})
                page.goto(url, wait_until="domcontentloaded")

                # 起動時loadModelCatalog()が手動refreshなしに実行されること、
                # provider-apiの動的候補がそのままUIへ反映されることを確認する。
                page.wait_for_function(
                    "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.command === 'list_model_catalog')"
                )
                initial_catalog_calls = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.command === 'list_model_catalog')"
                )
                assert initial_catalog_calls[0]["args"]["forceRefresh"] is False
                page.wait_for_function(
                    "model => document.querySelectorAll(`#catalogPostModel option[value='${model}']`).length === 1",
                    arg=future_model,
                )

                page.locator('.event-card[data-slug="ui07-post"]').click()
                page.locator('.event-card[data-slug="ui07-post"].active').wait_for()

                model_selectors = ("#model", "#visionModelId", "#catalogPostModel")
                for selector in model_selectors:
                    _select_value(page, selector, future_model)
                    option = page.locator(f"{selector} option[value='{future_model}']")
                    assert "API取得" in option.inner_text()
                    assert "能力未確認" in option.inner_text()

                # API metadataのない未知OpenAI IDはeffortを推測せずnone(API既定)にする。
                for selector in (
                    "#textReasoningEffort",
                    "#visionReasoningEffort",
                    "#catalogPostReasoningEffort",
                ):
                    assert page.locator(selector).input_value() == "none"
                    assert page.locator(f"{selector} option").all_inner_texts() == ["none"]

                # 既知unsupported/retiredおよびstale unknownはlive候補へ誤昇格させない。
                for selector in model_selectors:
                    for excluded in (unsupported_model, retired_model, stale_model):
                        assert page.locator(
                            f"{selector} option[value='{excluded}']"
                        ).count() == 0

                # 手動refresh後も未知候補・選択・effortを保持する。
                before_refresh = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.length"
                )
                page.locator("#refreshModelCatalogBtn").click()
                page.wait_for_function(
                    "count => (window.__eventAutoPinPostModelFixture?.calls || []).slice(count).some(call => call.command === 'list_model_catalog')",
                    arg=before_refresh,
                )
                for selector in model_selectors:
                    assert page.locator(selector).input_value() == future_model
                for selector in (
                    "#textReasoningEffort",
                    "#visionReasoningEffort",
                    "#catalogPostReasoningEffort",
                ):
                    assert page.locator(selector).input_value() == "none"

                # Anthropicキーはpassword欄でload/saveされる。値はfixtureのdummy-keyのみ。
                anthropic_key = page.locator("#anthropicApiKey")
                assert anthropic_key.get_attribute("type") == "password"
                assert anthropic_key.input_value() == "dummy-key"
                page.locator('[data-tab="tab-settings"]').click()
                before_env_save = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.length"
                )
                page.locator("#saveConfigBtn").click()
                page.wait_for_function(
                    "count => (window.__eventAutoPinPostModelFixture?.calls || []).slice(count).some(call => call.command === 'save_env_keys')",
                    arg=before_env_save,
                )
                env_save_calls = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls"
                )
                env_save = [
                    call
                    for call in env_save_calls
                    if call.get("command") == "save_env_keys"
                ][-1]
                assert env_save["args"]["keys"]["anthropicApiKey"] == "dummy-key"

                # URL再処理のpreflightでも選択を維持し、能力unknownだけでは主/予備を止めない。
                page.locator('[data-tab="tab-edit"]').click()
                page.locator("#circleEditor tr.circle-row[data-circle-row='0']").wait_for()
                before_post_runs = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length"
                )
                page.once("dialog", lambda dialog: dialog.accept(POST_URL))
                _open_post_context_menu(page)
                page.get_by_text("このサークルを再処理（XポストURL指定）", exact=True).click()
                page.wait_for_function(
                    "count => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length > count",
                    arg=before_post_runs,
                    timeout=15_000,
                )
                post_call = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').at(-1)"
                )
                payload = post_call["payload"]
                assert payload["model"] == future_model
                assert payload["text_llm_provider"] == "api:openai"
                assert payload["api_reasoning_effort"] == "none"
                assert payload["image_llm_model"] == future_model
                assert payload["image_llm_effort"] == "none"
                post_role = payload["oshinagaki_post"]
                assert post_role["provider"] == "api:openai"
                assert post_role["model"] == future_model
                assert post_role["effort"] == "none"
                assert post_role["fallback_enabled"] is True
                preflight_text = page.locator("#modelPreflightStatus").inner_text()
                assert "能力未確認" in preflight_text
                assert "実行前チェックで停止" not in preflight_text
                assert "今回だけ予備を除外" not in preflight_text
            finally:
                browser.close()
    finally:
        _stop_process(process)
        _cleanup_run_dir(run_dir)


@pytest.mark.skipif(sync_playwright is None, reason="Playwright Python is unavailable")
def test_post_model_settings_and_reprocess_runtime_evidence():
    """post主/予備、認証再取得、payload、保存復元、help/layoutを実行時に確認する。"""

    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=SCRATCH_ROOT))
    process = None
    try:
        process, url = _start_fixture(run_dir, _free_port())
        with sync_playwright() as playwright:
            browser_args: dict[str, Any] = {"headless": True}
            executable = _cached_chromium_executable()
            if executable:
                browser_args["executable_path"] = executable
            browser = playwright.chromium.launch(**browser_args)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 960})
                page.goto(url, wait_until="domcontentloaded")
                page.locator('.event-card[data-slug="ui07-post"]').click()
                page.locator('.event-card[data-slug="ui07-post"].active').wait_for()

                # UIのモデル候補をfixtureから取得する。外部APIは呼ばれない。
                page.locator("#refreshModelCatalogBtn").click()
                page.wait_for_function(
                    "() => document.querySelectorAll('#catalogPostModel option').length > 0"
                )
                page.locator("#catalogPostFallbackSettings summary").click()

                primary_provider = page.locator("#catalogPostModelProvider")
                primary_model = page.locator("#catalogPostModel")
                primary_effort = page.locator("#catalogPostReasoningEffort")
                fallback_provider = page.locator("#catalogPostFallbackModelProvider")
                fallback_model = page.locator("#catalogPostFallbackModel")
                fallback_effort = page.locator("#catalogPostFallbackReasoningEffort")
                for control in (
                    primary_provider,
                    primary_model,
                    primary_effort,
                    fallback_provider,
                    fallback_model,
                    fallback_effort,
                ):
                    assert control.count() == 1
                    control.wait_for(state="visible")

                assert "未認証" in fallback_provider.locator(
                    "option[value='cli:grok']"
                ).inner_text()
                fallback_enabled = page.locator("#catalogPostFallbackEnabled")
                assert fallback_enabled.is_checked()
                _select_value(page, "#catalogPostModelProvider", "api:openai")
                _select_value(page, "#catalogPostModel", "post-primary-model")
                _select_value(page, "#catalogPostReasoningEffort", "high")
                assert fallback_provider.input_value() == "cli:grok"
                assert fallback_model.input_value() == "grok-post-fallback"
                assert fallback_effort.input_value() == "none"
                _select_value(page, "#visionModel", "api:openai")
                _select_value(page, "#visionModelId", "vision-primary-model")
                _select_value(page, "#visionReasoningEffort", "medium")
                # 画像fallbackはLLM詳細設定内にあるため、閉じたdetailsを
                # 直接操作せず開いてから、別モデルを選択する。
                page.locator("#llmAdvancedSettings summary").click()
                _select_value(page, "#visionFallbackModelProvider", "api:openai")
                _select_value(page, "#visionFallbackModel", "vision-fallback-model")

                order = page.locator(
                    "#catalogPostExecutionOrder, [data-post-execution-order]"
                )
                assert order.count() == 1
                order_text = order.inner_text()
                assert "post-primary-model" in order_text
                assert "grok-post-fallback" in order_text
                assert order_text.index("post-primary-model") < order_text.index(
                    "grok-post-fallback"
                )

                # 隣接するクリック式ヘルプのEscape/外側クリックを確認する。
                page.locator('[data-tab="tab-history"]').click()
                help_trigger = page.locator("#historySearchHelpTrigger")
                help_trigger.click()
                assert help_trigger.get_attribute("aria-expanded") == "true"
                page.keyboard.press("Escape")
                assert help_trigger.get_attribute("aria-expanded") == "false"
                help_trigger.click()
                assert help_trigger.get_attribute("aria-expanded") == "true"
                page.locator("#tab-history h2").click(position={"x": 5, "y": 5})
                assert help_trigger.get_attribute("aria-expanded") == "false"

                # 保存設定には選択値を残す。ブラウザlocalStorage経由でreload復元する。
                page.locator('[data-tab="tab-settings"]').click()
                page.locator("#saveConfigBtn").click()
                page.wait_for_function(
                    "() => (window.__eventAutoPinPostModelFixture?.calls || []).some(call => call.command === 'save_project_config')"
                )
                saved_yaml = page.evaluate(
                    "() => localStorage.getItem('ui07-post-project-yaml') || ''"
                )
                assert 'provider: "api:openai"' in saved_yaml
                assert 'model: "post-primary-model"' in saved_yaml
                assert 'fallback_provider: "cli:grok"' in saved_yaml
                assert 'fallback_model: "grok-post-fallback"' in saved_yaml

                # 未認証fallbackでもprimaryが正常なら開始し、runtimeだけ無効化する。
                page.locator('[data-tab="tab-edit"]').click()
                page.locator("#circleEditor tr.circle-row[data-circle-row='0']").wait_for()
                page.once("dialog", lambda dialog: dialog.accept(POST_URL))
                _open_post_context_menu(page)
                page.get_by_text("このサークルを再処理（XポストURL指定）", exact=True).click()
                unauth_call = _wait_for_bridge_call(page, "reprocess_circle_from_post")
                unauth_payload = unauth_call["payload"]
                post_role = unauth_payload["oshinagaki_post"]
                assert post_role["provider"] == "api:openai"
                assert post_role["model"] == "post-primary-model"
                assert post_role["effort"] == "high"
                assert post_role["fallback_provider"] == "cli:grok"
                assert post_role["fallback_model"] == "grok-post-fallback"
                assert post_role["fallback_effort"] == "none"
                assert post_role["fallback_enabled"] is False
                assert unauth_payload["image_llm_model"] == "vision-primary-model"
                assert unauth_payload["image_fallback_llm_model"] == "vision-fallback-model"
                preflight_status = page.locator("#modelPreflightStatus")
                preflight_status.wait_for(state="visible")
                expect(preflight_status).to_have_text(re.compile("予備.*主"))

                # 認証状態を切替え、手動再取得を実行直前に行う。
                page.locator('[data-tab="tab-crawl"]').click()
                page.evaluate("() => localStorage.setItem('ui07-post-grok-auth', 'true')")
                before_refresh = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.length"
                )
                page.locator("#refreshModelCatalogBtn").click()
                page.wait_for_function(
                    "count => (window.__eventAutoPinPostModelFixture?.calls || []).slice(count).some(call => call.command === 'list_model_catalog')",
                    arg=before_refresh,
                )
                catalog_calls = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.command === 'list_model_catalog')"
                )
                assert catalog_calls[-1]["args"]["forceRefresh"] is True
                assert "未認証" not in page.locator("#modelCatalogStatus").inner_text()
                assert "未認証" not in fallback_provider.locator(
                    "option[value='cli:grok']"
                ).inner_text()

                # 認証反映後の再処理では、実行直前forceRefresh=trueの結果を
                # 使って予備をruntimeで再有効化する。
                page.locator('[data-tab="tab-edit"]').click()
                before_post_runs = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length"
                )
                page.once("dialog", lambda dialog: dialog.accept(POST_URL))
                _open_post_context_menu(page)
                page.get_by_text("このサークルを再処理（XポストURL指定）", exact=True).click()
                page.wait_for_function(
                    "count => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length > count",
                    arg=before_post_runs,
                    timeout=15_000,
                )
                post_calls = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post')"
                )
                assert post_calls[-1]["payload"]["oshinagaki_post"]["fallback_enabled"] is True
                all_calls = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls"
                )
                latest_run_index = max(
                    index
                    for index, call in enumerate(all_calls)
                    if call.get("job") == "reprocess_circle_from_post"
                )
                catalogs_before_run = [
                    call
                    for call in all_calls[:latest_run_index]
                    if call.get("command") == "list_model_catalog"
                ]
                assert catalogs_before_run
                assert catalogs_before_run[-1]["args"]["forceRefresh"] is True

                # 予備を無効化して保存し、選択値を残したまま
                # YAML/payloadの両方で復元可能なことを確認。
                page.locator('[data-tab="tab-crawl"]').click()
                fallback_enabled.uncheck()
                assert not fallback_enabled.is_checked()
                assert "フォールバックなし" in order.inner_text()

                # 保存設定を無効にしても、選択した予備値は保持したまま、
                # runtime payloadだけfallback_enabled=falseになる。
                page.locator('[data-tab="tab-edit"]').click()
                before_post_runs = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length"
                )
                page.once("dialog", lambda dialog: dialog.accept(POST_URL))
                _open_post_context_menu(page)
                page.get_by_text("このサークルを再処理（XポストURL指定）", exact=True).click()
                page.wait_for_function(
                    "count => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').length > count",
                    arg=before_post_runs,
                    timeout=15_000,
                )
                no_fallback_call = page.evaluate(
                    "() => window.__eventAutoPinPostModelFixture.calls.filter(call => call.job === 'reprocess_circle_from_post').at(-1)"
                )
                no_fallback_role = no_fallback_call["payload"]["oshinagaki_post"]
                assert no_fallback_role["fallback_enabled"] is False
                assert no_fallback_role["fallback_provider"] == "cli:grok"
                assert no_fallback_role["fallback_model"] == "grok-post-fallback"

                page.locator('[data-tab="tab-settings"]').click()
                page.locator("#saveConfigBtn").click()
                page.wait_for_function(
                    "() => (window.__eventAutoPinPostModelFixture?.calls || []).filter(call => call.command === 'save_project_config').length >= 2"
                )
                none_yaml = page.evaluate(
                    "() => localStorage.getItem('ui07-post-project-yaml') || ''"
                )
                assert "fallback_enabled: false" in none_yaml

                page.reload(wait_until="domcontentloaded")
                page.locator("#refreshModelCatalogBtn").click()
                page.wait_for_function(
                    "() => document.querySelectorAll('#catalogPostModel option').length > 0"
                )
                page.locator("#catalogPostFallbackSettings summary").click()
                assert page.locator("#catalogPostModel").input_value() == "post-primary-model"
                assert page.locator("#catalogPostFallbackModelProvider").input_value() == "cli:grok"
                assert page.locator("#catalogPostFallbackModel").input_value() == "grok-post-fallback"
                assert not page.locator("#catalogPostFallbackEnabled").is_checked()

                # レイアウト証跡はignored temp内に残す。
                screenshot_path = run_dir / "post-model-settings.png"
                page.screenshot(path=str(screenshot_path), full_page=True)
                assert screenshot_path.exists()
            finally:
                browser.close()
    finally:
        _stop_process(process)
        _cleanup_run_dir(run_dir)


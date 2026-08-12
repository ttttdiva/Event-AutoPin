#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod history_search;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Write;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use history_search::search_past_participations;

#[cfg(target_os = "windows")]
mod windows_process_job {
    use std::io;
    use std::mem;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct ProcessJob {
        handle: HANDLE,
    }

    impl ProcessJob {
        pub fn for_child(child: &Child) -> Result<Self, String> {
            let job = Self::new_kill_on_close()?;
            job.assign(child)?;
            Ok(job)
        }

        fn new_kill_on_close() -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(ptr::null(), ptr::null());
                if handle.is_null() {
                    return Err(format!(
                        "CreateJobObjectW failed: {}",
                        io::Error::last_os_error()
                    ));
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let err = io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(format!("SetInformationJobObject failed: {err}"));
                }

                Ok(Self { handle })
            }
        }

        fn assign(&self, child: &Child) -> Result<(), String> {
            unsafe {
                let process_handle = child.as_raw_handle() as HANDLE;
                if AssignProcessToJobObject(self.handle, process_handle) == 0 {
                    return Err(format!(
                        "AssignProcessToJobObject failed: {}",
                        io::Error::last_os_error()
                    ));
                }
                Ok(())
            }
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            unsafe {
                if !self.handle.is_null() {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    python_exe: String,
    project_root: String,
    timeout_ms: u64,
    #[serde(default)]
    foam_dir: String,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Default for DesktopConfig {
    fn default() -> Self {
        let root = exe_dir().to_string_lossy().to_string();
        Self {
            python_exe: "python".to_string(),
            project_root: root,
            timeout_ms: 3_600_000,
            foam_dir: String::new(),
        }
    }
}

fn config_path() -> PathBuf {
    exe_dir().join("desktop.config.json")
}

#[tauri::command]
fn load_desktop_config() -> Result<DesktopConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(DesktopConfig::default());
    }

    let text =
        fs::read_to_string(path).map_err(|e| format!("Failed to read desktop config: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Invalid desktop config JSON: {e}"))
}

#[tauri::command]
fn save_desktop_config(config: DesktopConfig) -> Result<Value, String> {
    let text = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize desktop config: {e}"))?;
    fs::write(config_path(), text).map_err(|e| format!("Failed to write desktop config: {e}"))?;
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn load_project_config(project_root: String) -> Result<Value, String> {
    let path = PathBuf::from(&project_root).join("config.yaml");
    if !path.exists() {
        return Ok(json!({"found": false}));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("config.yaml読み込み失敗: {e}"))?;
    Ok(json!({"found": true, "raw": text}))
}

#[tauri::command]
fn save_project_config(project_root: String, yaml_content: String) -> Result<Value, String> {
    let path = PathBuf::from(&project_root).join("config.yaml");
    fs::write(&path, yaml_content).map_err(|e| format!("config.yaml書き込み失敗: {e}"))?;
    Ok(json!({"status": "ok"}))
}

fn command_available(dotenv: &HashMap<String, String>, env_key: &str, default_bin: &str) -> bool {
    let bin = env_value(dotenv, &[env_key]).unwrap_or_else(|| default_bin.to_string());
    command_candidate_available(&bin) || known_windows_command_available(default_bin)
}

fn command_candidate_available(bin: &str) -> bool {
    let candidate = PathBuf::from(&bin);
    if candidate.is_absolute() || bin.contains('\\') || bin.contains('/') {
        return candidate.exists();
    }
    Command::new("where.exe")
        .arg(&bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
        || Command::new("cmd")
            .args(["/C", "where", bin])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn known_windows_command_available(default_bin: &str) -> bool {
    let mut candidates = Vec::new();
    if let Some(appdata) = env::var_os("APPDATA") {
        let npm_dir = PathBuf::from(appdata).join("npm");
        candidates.push(npm_dir.join(default_bin));
        candidates.push(npm_dir.join(format!("{default_bin}.cmd")));
        candidates.push(npm_dir.join(format!("{default_bin}.ps1")));
        candidates.push(npm_dir.join(format!("{default_bin}.exe")));
    }
    if let Some(local_appdata) = env::var_os("LOCALAPPDATA") {
        if default_bin == "agy" {
            candidates.push(
                PathBuf::from(&local_appdata)
                    .join("agy")
                    .join("bin")
                    .join("agy.exe"),
            );
        }
        let windows_apps = PathBuf::from(local_appdata)
            .join("Microsoft")
            .join("WindowsApps");
        candidates.push(windows_apps.join(default_bin));
        candidates.push(windows_apps.join(format!("{default_bin}.exe")));
    }
    candidates.iter().any(|candidate| candidate.exists())
}

#[cfg(not(target_os = "windows"))]
fn known_windows_command_available(_default_bin: &str) -> bool {
    false
}

#[tauri::command]
fn list_model_catalog(project_root: String) -> Result<Value, String> {
    let dotenv = read_dotenv(&project_root);
    let config_text =
        fs::read_to_string(PathBuf::from(&project_root).join("config.yaml")).unwrap_or_default();
    let configured_api_models = parse_yaml_list(&config_text, "models");
    let text_model_config = parse_yaml_map(&config_text, "text_llm_cli_models");

    let (api_models, api_errors) = build_api_model_catalog(&dotenv, &configured_api_models);
    let codex_models = configured_models(
        cli_candidate_models(
            "codex",
            vec![
                ("gpt-5.5", "GPT-5.5"),
                ("gpt-5.4", "GPT-5.4"),
                ("gpt-5.4-mini", "GPT-5.4 Mini"),
                ("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
                ("gpt-5.3-codex", "GPT-5.3 Codex"),
                ("gpt-5.2-codex", "GPT-5.2 Codex"),
                ("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
                ("gpt-5.1-codex", "GPT-5.1 Codex"),
                ("gpt-5-codex", "GPT-5 Codex"),
            ],
        ),
        &[text_model_config.get("codex").cloned()],
        "codex",
    );
    let antigravity_cli_models = configured_models(
        cli_candidate_models(
            "antigravity",
            vec![
                ("default", "default"),
                ("Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (High)"),
                ("Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (Medium)"),
                ("Gemini 3.5 Flash (Low)", "Gemini 3.5 Flash (Low)"),
                ("Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (High)"),
                ("Gemini 3.1 Pro (Low)", "Gemini 3.1 Pro (Low)"),
                (
                    "Claude Sonnet 4.6 (Thinking)",
                    "Claude Sonnet 4.6 (Thinking)",
                ),
                ("Claude Opus 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)"),
            ],
        ),
        &[text_model_config.get("antigravity").cloned()],
        "antigravity",
    );
    let claude_models = configured_models(
        cli_candidate_models(
            "claude",
            vec![
                ("default", "Claude default"),
                ("best", "best"),
                ("sonnet", "sonnet"),
                ("opus", "opus"),
                ("haiku", "haiku"),
                ("sonnet[1m]", "sonnet[1m]"),
                ("opus[1m]", "opus[1m]"),
                ("opusplan", "opusplan"),
            ],
        ),
        &[text_model_config.get("claude").cloned()],
        "claude",
    );

    Ok(json!({
        "providers": [
            {
                "id": "codex",
                "label": "Codex CLI",
                "kind": "cli",
                "available": command_available(&dotenv, "CODEX_BIN", "codex"),
                "source": "cli-suggested",
                "models": codex_models
            },
            {
                "id": "antigravity",
                "label": "Antigravity CLI",
                "kind": "cli",
                "available": command_available(&dotenv, "AGY_BIN", "agy")
                    || env_value(&dotenv, &["ANTIGRAVITY_BIN", "ANTIGRAVITY_CLI_BIN"])
                        .map(|bin| command_candidate_available(&bin))
                        .unwrap_or(false),
                "source": "cli-suggested",
                "models": antigravity_cli_models
            },
            {
                "id": "claude",
                "label": "Claude Code",
                "kind": "cli",
                "available": command_available(&dotenv, "CLAUDE_BIN", "claude"),
                "source": "cli-suggested",
                "models": claude_models
            }
        ],
        "apiModels": api_models,
        "apiErrors": api_errors
    }))
}

fn read_dotenv(project_root: &str) -> HashMap<String, String> {
    let path = PathBuf::from(project_root).join(".env");
    let mut values = HashMap::new();
    let Ok(text) = fs::read_to_string(path) else {
        return values;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_string(), unquote_yaml(value.trim()));
        }
    }
    values
}

fn env_value(dotenv: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
        if let Some(value) = dotenv.get(*key) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn unquote_yaml(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches(',');
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if (bytes[0] == b'"' && bytes[trimmed.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[trimmed.len() - 1] == b'\'')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn parse_yaml_list(raw: &str, key: &str) -> Vec<String> {
    let mut result = Vec::new();
    let target = format!("{key}:");
    let lines: Vec<&str> = raw.lines().collect();
    let Some(start) = lines
        .iter()
        .position(|line| line.trim_start().starts_with(&target))
    else {
        return result;
    };
    let line = lines[start].trim();
    let after = line[target.len()..].trim();
    if after.starts_with('[') && after.ends_with(']') {
        let inner = after.trim_start_matches('[').trim_end_matches(']');
        for item in inner.split(',') {
            let value = unquote_yaml(item);
            if !value.is_empty() {
                result.push(value);
            }
        }
        return result;
    }
    for line in lines.iter().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('-') {
            let value = unquote_yaml(rest.trim());
            if !value.is_empty() {
                result.push(value);
            }
        }
    }
    result
}

fn parse_yaml_map(raw: &str, key: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let target = format!("{key}:");
    let lines: Vec<&str> = raw.lines().collect();
    let Some(start) = lines
        .iter()
        .position(|line| line.trim_start().starts_with(&target))
    else {
        return result;
    };
    for line in lines.iter().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let trimmed = line.trim();
        if let Some((map_key, value)) = trimmed.split_once(':') {
            let value = unquote_yaml(value.trim());
            if !map_key.trim().is_empty() && !value.is_empty() {
                result.insert(map_key.trim().to_string(), value);
            }
        }
    }
    result
}

fn model_json(id: &str, label: &str, provider: &str, source: &str, source_label: &str) -> Value {
    json!({
        "id": id,
        "label": label,
        "provider": provider,
        "source": source,
        "source_label": source_label,
    })
}

fn cli_candidate_models(provider: &str, models: Vec<(&str, &str)>) -> Vec<Value> {
    models
        .into_iter()
        .map(|(id, label)| model_json(id, label, provider, "cli-suggested", "CLI候補"))
        .collect()
}

fn configured_models(
    mut models: Vec<Value>,
    configured: &[Option<String>],
    provider: &str,
) -> Vec<Value> {
    for value in configured.iter().flatten().rev() {
        if value.trim().is_empty() {
            continue;
        }
        if !models
            .iter()
            .any(|model| model.get("id").and_then(Value::as_str) == Some(value.as_str()))
        {
            models.insert(
                0,
                model_json(
                    value,
                    value,
                    provider,
                    "provider-configured",
                    "保存済み設定",
                ),
            );
        }
    }
    dedupe_models(models)
}

fn static_api_models() -> Vec<Value> {
    vec![
        model_json(
            "gemini-3-flash-preview",
            "Gemini 3 Flash Preview",
            "gemini",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gemini-3-pro-preview",
            "Gemini 3 Pro Preview",
            "gemini",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            "gemini",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gemini-2.5-flash",
            "Gemini 2.5 Flash",
            "gemini",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gemini-2.5-flash-lite",
            "Gemini 2.5 Flash-Lite",
            "gemini",
            "static-suggested",
            "候補",
        ),
        model_json("gpt-5.2", "GPT-5.2", "openai", "static-suggested", "候補"),
        model_json("gpt-5.1", "GPT-5.1", "openai", "static-suggested", "候補"),
        model_json("gpt-5", "GPT-5", "openai", "static-suggested", "候補"),
        model_json(
            "gpt-5-mini",
            "GPT-5 mini",
            "openai",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gpt-5-nano",
            "GPT-5 nano",
            "openai",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gpt-5.2-pro",
            "GPT-5.2 pro",
            "openai",
            "static-suggested",
            "候補",
        ),
        model_json(
            "gpt-5-pro",
            "GPT-5 pro",
            "openai",
            "static-suggested",
            "候補",
        ),
        model_json("gpt-4.1", "GPT-4.1", "openai", "static-suggested", "候補"),
    ]
}

fn provider_for_model_id(id: &str) -> &str {
    if id.starts_with("gemini-") {
        "gemini"
    } else {
        "openai"
    }
}

fn build_api_model_catalog(
    dotenv: &HashMap<String, String>,
    configured_models: &[String],
) -> (Vec<Value>, Vec<Value>) {
    let mut models = Vec::new();
    let mut errors = Vec::new();

    if let Some(key) = env_value(dotenv, &["OPENAI_API_KEY"]) {
        match fetch_openai_models(&key) {
            Ok(fetched) => models.extend(fetched),
            Err(error) => errors.push(json!({"provider": "openai", "message": error})),
        }
    }
    if let Some(key) = env_value(dotenv, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
        match fetch_gemini_models(&key) {
            Ok(fetched) => models.extend(fetched),
            Err(error) => errors.push(json!({"provider": "gemini", "message": error})),
        }
    }

    models.extend(static_api_models());
    for model in configured_models.iter().rev() {
        if model.trim().is_empty() {
            continue;
        }
        let provider = provider_for_model_id(model);
        if !models
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(model.as_str()))
        {
            models.insert(
                0,
                model_json(
                    model,
                    model,
                    provider,
                    "provider-configured",
                    "保存済み設定",
                ),
            );
        }
    }
    (dedupe_models(models), errors)
}

fn fetch_openai_models(api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let data: Value = response.json().map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    if let Some(items) = data.get("data").and_then(Value::as_array) {
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id.starts_with("gpt-")
                || id.starts_with("o1")
                || id.starts_with("o3")
                || id.starts_with("o4")
                || id.starts_with("codex-")
            {
                models.push(model_json(id, id, "openai", "provider-api", "API取得"));
            }
        }
    }
    models.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(models)
}

fn fetch_gemini_models(api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!(
            "https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
        ))
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let data: Value = response.json().map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    if let Some(items) = data.get("models").and_then(Value::as_array) {
        for item in items {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let supports_generate = item
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .map(|methods| {
                    methods
                        .iter()
                        .any(|method| method.as_str() == Some("generateContent"))
                })
                .unwrap_or(true);
            if !supports_generate {
                continue;
            }
            let id = name.strip_prefix("models/").unwrap_or(name);
            let label = item
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(id);
            models.push(model_json(id, label, "gemini", "provider-api", "API取得"));
        }
    }
    models.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(models)
}

fn dedupe_models(models: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for model in models {
        let key = format!(
            "{}:{}",
            model.get("provider").and_then(Value::as_str).unwrap_or(""),
            model.get("id").and_then(Value::as_str).unwrap_or("")
        );
        if seen.insert(key) {
            output.push(model);
        }
    }
    output
}

fn resolve_python_exe(python_exe: &str, project_root: &str) -> String {
    if python_exe != "python" && !python_exe.is_empty() {
        return python_exe.to_string();
    }
    let venv_python = PathBuf::from(project_root)
        .join("venv")
        .join("Scripts")
        .join("python.exe");
    if venv_python.exists() {
        return venv_python.to_string_lossy().to_string();
    }
    python_exe.to_string()
}

fn upgrade_legacy_twscrape_patch_source(source: &str) -> Option<String> {
    let upgraded = source
        .replace(
            "async def _patched_parse_anim_idx(text: str) -> list:",
            "async def _patched_parse_anim_idx(text: str, clt=None) -> list:",
        )
        .replace(
            "await xclid.get_tw_page_text(url)",
            "await xclid.get_tw_page_text(url, clt)",
        )
        .replace(
            "return await _original_parse_anim_idx(text)",
            "return await _original_parse_anim_idx(text, clt)",
        );
    (upgraded != source).then_some(upgraded)
}

fn migrate_legacy_twscrape_patches(project_root: &str) -> Result<(), String> {
    for relative_path in [
        "src/utils/twitter_extractor.py",
        "src/utils/twitter_extractor_v2.py",
    ] {
        let path = PathBuf::from(project_root).join(relative_path);
        if !path.exists() {
            continue;
        }
        let source = fs::read_to_string(&path)
            .map_err(|e| format!("{relative_path} の互換性確認に失敗しました: {e}"))?;
        if let Some(upgraded) = upgrade_legacy_twscrape_patch_source(&source) {
            fs::write(&path, upgraded)
                .map_err(|e| format!("{relative_path} のtwscrape互換化に失敗しました: {e}"))?;
        }
    }
    Ok(())
}

fn ensure_twscrape_runtime(python_exe: &str, project_root: &str) -> Result<(), String> {
    let version_check = "import importlib.metadata as m; p=tuple(int(x) for x in m.version('twscrape').split('.')[:3]); raise SystemExit(0 if (0,19,1)<=p<(0,20,0) else 1)";
    let is_compatible = Command::new(python_exe)
        .args(["-c", version_check])
        .current_dir(project_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    if !is_compatible {
        let output = Command::new(python_exe)
            .args([
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "twscrape>=0.19.1,<0.20",
            ])
            .current_dir(project_root)
            .output()
            .map_err(|e| format!("twscrape対応版の自動更新を開始できませんでした: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "twscrape対応版の自動更新に失敗しました。ネットワーク接続を確認して再実行してください。\n{}",
                truncate_log_value(&stderr, 4000)
            ));
        }
    }

    // v0.1.5以前のPythonソースが残るEXE自動更新環境でも、0.19系の
    // parse_anim_idx(text, client)シグネチャで動作するよう既知の旧パッチだけを移行する。
    migrate_legacy_twscrape_patches(project_root)
}

fn requires_twscrape_runtime(job: &str, payload: &Value) -> bool {
    job == "run_main_pipeline"
        && payload
            .get("enable_twitter_catalog")
            .and_then(Value::as_bool)
            .unwrap_or(true)
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(child: &mut std::process::Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn run_python_bridge_sync(
    window: tauri::Window,
    python_exe: String,
    project_root: String,
    job: String,
    payload: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    let resolved_python = resolve_python_exe(&python_exe, &project_root);
    if requires_twscrape_runtime(&job, &payload) {
        let _ = window.emit("pipeline-log", "X/Twitter実行環境を確認しています...");
        ensure_twscrape_runtime(&resolved_python, &project_root)?;
    }
    let payload_json = payload.to_string();

    // Windows コマンドライン長制限(~32KB)を回避: 大きいペイロードは一時ファイル経由
    let payload_file: Option<PathBuf> = if payload_json.len() > 28000 {
        let tmp =
            std::env::temp_dir().join(format!("eventtrail_payload_{}.json", std::process::id()));
        fs::write(&tmp, &payload_json)
            .map_err(|e| format!("一時ペイロードファイル書き込み失敗: {e}"))?;
        Some(tmp)
    } else {
        None
    };

    let mut args = vec![
        "-m".to_string(),
        "src.commands.desktop_bridge".to_string(),
        "--job".to_string(),
        job.clone(),
    ];
    if let Some(ref pf) = payload_file {
        args.push("--payload".to_string());
        args.push(pf.to_string_lossy().to_string());
    } else {
        args.push("--payload-json".to_string());
        args.push(payload_json);
    }

    let mut cmd = Command::new(&resolved_python);
    cmd.args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .current_dir(&project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Windows: Pythonプロセスのコンソールウィンドウを非表示
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute Python bridge: {e}"))?;
    #[cfg(target_os = "windows")]
    let _process_job = match windows_process_job::ProcessJob::for_child(&child) {
        Ok(job) => Some(job),
        Err(e) => {
            append_internal_log(
                &project_root,
                &format!("run_python_bridge process job setup failed: {e}"),
            );
            None
        }
    };
    append_internal_log(
        &project_root,
        &format!(
            "run_python_bridge start: job={job}, python={}, timeout_ms={timeout_ms}",
            resolved_python
        ),
    );

    // stderrを別スレッドで1行ずつ読み、Tauriイベントとして送信
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;
    let stderr_thread = {
        let win = window.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr_pipe);
            let mut lines = Vec::new();
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = win.emit("pipeline-log", &line);
                    lines.push(line);
                }
            }
            lines.join("\n")
        })
    };

    // stdoutを別スレッドで読み取り（デッドロック防止）
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stdout_thread = thread::spawn(move || {
        let mut buf = String::new();
        let mut reader = BufReader::new(stdout_pipe);
        let _ = reader.read_to_string(&mut buf);
        buf
    });

    // タイムアウト付きでプロセス完了を待つ
    let start = Instant::now();
    let mut timed_out = false;

    loop {
        if start.elapsed() > Duration::from_millis(timeout_ms) {
            timed_out = true;
            terminate_process_tree(&mut child);
            break;
        }

        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Failed while waiting for Python bridge: {e}")),
        }
    }

    let _ = child.wait();
    // 一時ペイロードファイルを削除
    if let Some(ref pf) = payload_file {
        let _ = fs::remove_file(pf);
    }
    let stderr = stderr_thread.join().unwrap_or_default();
    let stdout = stdout_thread.join().unwrap_or_default().trim().to_string();
    append_internal_log(
        &project_root,
        &format!(
            "run_python_bridge finished: job={job}, timed_out={timed_out}, stderr=\n{}\nstdout=\n{}",
            truncate_log_value(&stderr, 12000),
            truncate_log_value(&stdout, 12000)
        ),
    );

    if timed_out {
        return Ok(json!({
            "ok": false,
            "timedOut": true,
            "exit_code": null,
            "stderr": stderr,
            "bridge": {"status": "error", "error": format!("Timed out after {} ms", timeout_ms)}
        }));
    }

    if stdout.is_empty() {
        return Err(format!(
            "Python bridge returned empty stdout. stderr: {stderr}"
        ));
    }

    let parsed: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Invalid JSON from bridge: {e}; stdout={stdout}"))?;

    Ok(json!({
        "ok": parsed.get("status").and_then(|s| s.as_str()) == Some("ok"),
        "timedOut": false,
        "exit_code": parsed.get("returncode"),
        "bridge": parsed,
        "stderr": stderr,
    }))
}

#[tauri::command]
async fn run_python_bridge(
    window: tauri::Window,
    python_exe: String,
    project_root: String,
    job: String,
    payload: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        run_python_bridge_sync(window, python_exe, project_root, job, payload, timeout_ms)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
fn delete_file(file_path: String) -> Result<Value, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(json!({"status": "ok", "note": "already absent"}));
    }
    fs::remove_file(&path).map_err(|e| format!("削除失敗: {e}"))?;
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn copy_file_to_dir(source_path: String, dest_dir: String) -> Result<Value, String> {
    let source = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    if !source.exists() {
        return Err(format!("ファイルが見つかりません: {}", source_path));
    }
    fs::create_dir_all(&dest).ok();
    let file_name = source
        .file_name()
        .ok_or_else(|| "ファイル名を取得できません".to_string())?;
    let dest_path = dest.join(file_name);
    fs::copy(&source, &dest_path).map_err(|e| format!("コピー失敗: {e}"))?;
    Ok(json!({"status": "ok", "dest": dest_path.to_string_lossy()}))
}

#[tauri::command]
fn copy_file_as(source_path: String, dest_dir: String, file_name: String) -> Result<Value, String> {
    let source = PathBuf::from(&source_path);
    let dest = PathBuf::from(&dest_dir);
    if !source.exists() {
        return Err(format!(
            "繝輔ぃ繧､繝ｫ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ: {}",
            source_path
        ));
    }
    let safe_name = Path::new(&file_name)
        .file_name()
        .ok_or_else(|| "繝輔ぃ繧､繝ｫ蜷阪ｒ蜿門ｾ励〒縺阪∪縺帙ｓ".to_string())?;
    fs::create_dir_all(&dest).ok();
    let dest_path = dest.join(safe_name);
    if source.canonicalize().ok() == dest_path.canonicalize().ok() {
        return Ok(json!({"status": "ok", "dest": dest_path.to_string_lossy()}));
    }
    fs::copy(&source, &dest_path).map_err(|e| format!("繧ｳ繝斐・螟ｱ謨・ {e}"))?;
    Ok(json!({"status": "ok", "dest": dest_path.to_string_lossy()}))
}

#[tauri::command]
fn save_image_bytes(dest_dir: String, file_name: String, bytes: Vec<u8>) -> Result<Value, String> {
    let dest = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest).ok();
    let dest_path = dest.join(&file_name);
    fs::write(&dest_path, &bytes).map_err(|e| format!("画像保存失敗: {e}"))?;
    Ok(json!({"status": "ok", "dest": dest_path.to_string_lossy(), "size": bytes.len()}))
}

#[tauri::command]
fn register_default_cut(
    project_root: String,
    circle_name: String,
    penname: String,
    image_source_path: String,
    genre: Option<String>,
) -> Result<Value, String> {
    let root = PathBuf::from(&project_root);
    let cm_path = root.join("circle_master.json");
    let cuts_dir = root.join("default_cuts");

    // circle_master.json読み込み（なければ新規作成）
    let mut cm: Value = if cm_path.exists() {
        let content = fs::read_to_string(&cm_path)
            .map_err(|e| format!("circle_master.json読み込み失敗: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("circle_master.jsonパース失敗: {e}"))?
    } else {
        json!({"circles": {}})
    };

    // ソース画像の存在確認
    let source = PathBuf::from(&image_source_path);
    if !source.exists() {
        return Err(format!("画像が見つかりません: {}", image_source_path));
    }
    fs::create_dir_all(&cuts_dir).ok();

    // circles操作（ブロックスコープで可変借用を限定）
    let (status, filename) = {
        let circles = cm
            .get_mut("circles")
            .and_then(|c| c.as_object_mut())
            .ok_or("circle_master.jsonのcirclesフィールドが不正です")?;

        // 既存エントリのdefault_cutから最大番号を取得
        let mut max_num: i32 = -1;
        for entry in circles.values() {
            if let Some(cut_file) = entry.get("default_cut").and_then(|v| v.as_str()) {
                let stem = std::path::Path::new(cut_file)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                if let Ok(n) = stem.parse::<i32>() {
                    if n > max_num {
                        max_num = n;
                    }
                }
            }
        }

        // 登録済みチェック
        let existing_cut = circles
            .get(&circle_name)
            .and_then(|e| e.get("default_cut"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        if let Some(existing) = existing_cut {
            // 登録済み: 画像上書き更新
            let dest_path = cuts_dir.join(&existing);
            fs::copy(&source, &dest_path)
                .map_err(|e| format!("デフォルトカット画像上書き失敗: {e}"))?;
            // genre更新（指定があれば）
            if let Some(ref g) = genre {
                if let Some(entry_mut) = circles.get_mut(&circle_name) {
                    entry_mut["genre"] = json!(g);
                }
            }
            ("updated".to_string(), existing)
        } else {
            // 新規登録: 画像コピー
            let new_filename = format!("{:04}.jpg", max_num + 1);
            let dest_path = cuts_dir.join(&new_filename);
            fs::copy(&source, &dest_path).map_err(|e| format!("画像コピー失敗: {e}"))?;

            // circle_master.jsonにエントリ追加/更新
            let genre_str = genre.as_deref().unwrap_or("");
            if let Some(entry) = circles.get_mut(&circle_name) {
                entry["default_cut"] = json!(&new_filename);
                if entry
                    .get("penname")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
                {
                    entry["penname"] = json!(penname);
                }
                if entry
                    .get("genre")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
                    && !genre_str.is_empty()
                {
                    entry["genre"] = json!(genre_str);
                }
            } else {
                circles.insert(
                    circle_name.clone(),
                    json!({
                        "penname": penname,
                        "favorite": false,
                        "genre": genre_str,
                        "default_cut": &new_filename
                    }),
                );
            }
            ("registered".to_string(), new_filename)
        }
    };

    // JSON書き込み
    let cm_text = serde_json::to_string_pretty(&cm).map_err(|e| format!("JSON変換失敗: {e}"))?;
    fs::write(&cm_path, &cm_text).map_err(|e| format!("circle_master.json書き込み失敗: {e}"))?;

    Ok(json!({
        "status": status,
        "filename": filename,
        "circle_name": circle_name
    }))
}

#[tauri::command]
fn append_log(project_root: Option<String>, message: String) -> Result<(), String> {
    let base = project_root.map(PathBuf::from).unwrap_or_else(exe_dir);
    let logs_dir = base.join("logs");
    let _ = fs::create_dir_all(&logs_dir);
    let log_path = logs_dir.join("eventtrail_studio.log");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("ログファイル書き込み失敗: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    writeln!(f, "[{now}] {message}").map_err(|e| format!("ログ書き込み失敗: {e}"))?;
    Ok(())
}

fn append_internal_log(project_root: &str, message: &str) {
    let _ = append_log(Some(project_root.to_string()), message.to_string());
}

fn truncate_log_value(value: &str, max_chars: usize) -> String {
    let mut out: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        out.push_str("\n...<truncated>");
    }
    out
}

#[tauri::command]
fn list_map_images(project_root: String) -> Result<Value, String> {
    let output_dir = PathBuf::from(&project_root).join("output");
    let mut maps: Vec<Value> = Vec::new();
    if output_dir.exists() {
        if let Ok(entries) = fs::read_dir(&output_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("map_")
                    && (name.ends_with(".jpg")
                        || name.ends_with(".jpeg")
                        || name.ends_with(".png")
                        || name.ends_with(".webp"))
                {
                    let full = entry
                        .path()
                        .to_string_lossy()
                        .to_string()
                        .replace("\\", "/");
                    maps.push(json!({"name": name, "path": full}));
                }
            }
        }
    }
    maps.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(json!({"status": "ok", "maps": maps}))
}

#[tauri::command]
fn download_image(url: String, dest_dir: String, file_name: String) -> Result<Value, String> {
    let dest = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest).ok();
    let dest_path = dest.join(&file_name);

    let response =
        reqwest::blocking::get(&url).map_err(|e| format!("画像ダウンロード失敗: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTPエラー: {}", response.status()));
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("画像読み込み失敗: {e}"))?;
    fs::write(&dest_path, &bytes).map_err(|e| format!("画像保存失敗: {e}"))?;

    Ok(json!({"status": "ok", "dest": dest_path.to_string_lossy(), "size": bytes.len()}))
}

// ── イベント管理 ──

fn normalize_event_meta_aliases(mut meta: Value) -> Value {
    if let Some(obj) = meta.as_object_mut() {
        let url = obj.get("url").cloned();
        let event_url = obj.get("event_url").cloned();
        let date = obj
            .get("date")
            .and_then(|v| v.as_str())
            .and_then(normalize_event_date_string);

        if !obj.contains_key("event_url") {
            if let Some(value) = url.clone() {
                if !value.is_null() {
                    obj.insert("event_url".to_string(), value);
                }
            }
        }
        if !obj.contains_key("url") {
            if let Some(value) = event_url {
                if !value.is_null() {
                    obj.insert("url".to_string(), value);
                }
            }
        }
        if let Some(value) = date {
            obj.insert("date".to_string(), json!(value));
        }
    }
    meta
}

fn normalize_event_date_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let date = &trimmed[..10];
    let bytes = date.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return Some(date.to_string());
    }
    None
}

fn find_event_image_file(event_dir: &Path) -> Option<String> {
    let entries = fs::read_dir(event_dir).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("event_image.") {
            return Some(name);
        }
    }
    let event_image_dir = event_dir.join("event_image");
    if let Ok(entries) = fs::read_dir(&event_image_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map_or(false, |ft| ft.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".png")
                || lower.ends_with(".webp")
            {
                return Some(format!("event_image/{name}"));
            }
        }
    }
    None
}

fn basename_from_reference(reference: &str) -> Option<String> {
    let trimmed = reference.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn normalize_imported_asset_reference(
    event_dir: &Path,
    reference: &str,
    preferred_dir: &str,
) -> Option<String> {
    let trimmed = reference.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    if event_dir.join(&normalized).exists() {
        return Some(normalized);
    }
    let basename = basename_from_reference(trimmed)?;
    let preferred = format!("{preferred_dir}/{basename}");
    if event_dir.join(&preferred).exists() {
        return Some(preferred);
    }
    if event_dir.join(&basename).exists() {
        return Some(basename);
    }
    Some(normalized)
}

fn normalize_imported_circle_asset_refs(data: &mut Value, event_dir: &Path) {
    let Some(circles) = data.get_mut("circles").and_then(Value::as_array_mut) else {
        return;
    };
    for circle in circles {
        if let Some(cut) = circle
            .get("circle_cut_filename")
            .and_then(Value::as_str)
            .and_then(|s| normalize_imported_asset_reference(event_dir, s, "circles"))
        {
            circle["circle_cut_filename"] = json!(cut);
        }

        if let Some(images) = circle.get_mut("item_images").and_then(Value::as_array_mut) {
            for image in images {
                if let Some(path) = image
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|s| normalize_imported_asset_reference(event_dir, s, "items"))
                {
                    image["path"] = json!(path);
                }
            }
        }

        if let Some(items) = circle.get_mut("items").and_then(Value::as_array_mut) {
            for item in items {
                if let Some(path) = item
                    .get("image")
                    .and_then(Value::as_str)
                    .and_then(|s| normalize_imported_asset_reference(event_dir, s, "items"))
                {
                    item["image"] = json!(path);
                }
            }
        }
    }
}

fn resolve_event_image_reference(event_dir: &Path, image: &str) -> Option<String> {
    let image = image.trim().replace('\\', "/");
    if image.is_empty() {
        return None;
    }

    if !Path::new(&image).is_absolute() && event_dir.join(&image).is_file() {
        return Some(image);
    }

    let file_name = Path::new(&image)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("");
    if file_name.is_empty() {
        return None;
    }

    let root_ref = file_name.to_string();
    if event_dir.join(&root_ref).is_file() {
        return Some(root_ref);
    }

    let nested_ref = format!("event_image/{file_name}");
    if event_dir.join(&nested_ref).is_file() {
        return Some(nested_ref);
    }

    None
}

fn normalize_event_meta_for_dir(meta: Value, event_dir: &Path) -> Value {
    let mut meta = normalize_event_meta_aliases(meta);
    if let Some(obj) = meta.as_object_mut() {
        let event_image = obj
            .get("event_image")
            .or_else(|| obj.get("event_image_filename"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(image) = event_image {
            if let Some(normalized) = resolve_event_image_reference(event_dir, &image) {
                obj.insert("event_image".to_string(), json!(normalized));
            } else {
                obj.remove("event_image");
            }
        }
        if !obj.contains_key("event_image") {
            if let Some(file_name) = find_event_image_file(event_dir) {
                obj.insert("event_image".to_string(), json!(file_name));
            }
        }
    }
    meta
}

#[cfg(test)]
mod event_meta_tests {
    use super::*;

    #[test]
    fn upgrades_legacy_twscrape_xclid_patch_to_current_signature() {
        let legacy = r#"async def _patched_parse_anim_idx(text: str) -> list:
    js_text = await xclid.get_tw_page_text(url)
    return await _original_parse_anim_idx(text)
"#;
        let upgraded = upgrade_legacy_twscrape_patch_source(legacy).unwrap();

        assert!(upgraded.contains("_patched_parse_anim_idx(text: str, clt=None)"));
        assert!(upgraded.contains("get_tw_page_text(url, clt)"));
        assert!(upgraded.contains("_original_parse_anim_idx(text, clt)"));
    }

    #[test]
    fn leaves_current_twscrape_source_unchanged() {
        assert!(upgrade_legacy_twscrape_patch_source("from twscrape import API\n").is_none());
    }

    #[test]
    fn skips_twscrape_setup_when_twitter_processing_is_disabled() {
        assert!(!requires_twscrape_runtime(
            "run_main_pipeline",
            &json!({"enable_twitter_catalog": false})
        ));
        assert!(requires_twscrape_runtime(
            "run_main_pipeline",
            &json!({"enable_twitter_catalog": true})
        ));
    }

    #[test]
    fn normalize_event_meta_adds_event_url_from_url() {
        let meta = normalize_event_meta_aliases(json!({"url": "https://example.test/event"}));

        assert_eq!(
            meta.get("event_url").and_then(|v| v.as_str()),
            Some("https://example.test/event")
        );
        assert_eq!(
            meta.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/event")
        );
    }

    #[test]
    fn normalize_event_meta_trims_midnight_time_from_date() {
        let meta = normalize_event_meta_aliases(json!({"date": "2026-05-24T00:00:00"}));
        assert_eq!(
            meta.get("date").and_then(|v| v.as_str()),
            Some("2026-05-24")
        );
    }

    #[test]
    fn normalize_event_meta_adds_url_from_event_url() {
        let meta = normalize_event_meta_aliases(json!({"event_url": "https://example.test/event"}));

        assert_eq!(
            meta.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/event")
        );
        assert_eq!(
            meta.get("event_url").and_then(|v| v.as_str()),
            Some("https://example.test/event")
        );
    }

    #[test]
    fn normalize_event_meta_removes_missing_event_image() {
        let dir = std::env::temp_dir().join(format!("eventtrail-meta-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let meta = normalize_event_meta_for_dir(json!({"event_image": "event_image.png"}), &dir);
        assert!(meta.get("event_image").is_none());

        fs::write(dir.join("event_image.png"), b"image").unwrap();
        let meta = normalize_event_meta_for_dir(json!({"event_image": "event_image.png"}), &dir);
        assert_eq!(
            meta.get("event_image").and_then(|v| v.as_str()),
            Some("event_image.png")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_event_meta_restores_event_image_from_file() {
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-meta-test-restore-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("event_image.png"), b"image").unwrap();

        let meta = normalize_event_meta_for_dir(json!({}), &dir);
        assert_eq!(
            meta.get("event_image").and_then(|v| v.as_str()),
            Some("event_image.png")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_event_map_images_prefers_maps_dir_with_root_fallback() {
        let dir =
            std::env::temp_dir().join(format!("eventtrail-map-list-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("maps")).unwrap();
        fs::write(dir.join("map_01.jpg"), b"old").unwrap();
        fs::write(dir.join("map_02.png"), b"legacy").unwrap();
        fs::write(dir.join("maps/map_01.jpg"), b"new").unwrap();

        let result = list_event_map_images(dir.to_string_lossy().to_string()).unwrap();
        let maps = result["maps"].as_array().unwrap();

        assert_eq!(maps.len(), 2);
        assert_eq!(maps[0]["name"].as_str(), Some("map_01.jpg"));
        assert!(maps[0]["path"]
            .as_str()
            .unwrap()
            .contains("/maps/map_01.jpg"));
        assert_eq!(maps[1]["name"].as_str(), Some("map_02.png"));

        let _ = fs::remove_dir_all(&dir);
    }

    fn write_test_event(event_dir: &Path, name: &str, date: &str, source: &str) {
        fs::create_dir_all(event_dir).unwrap();
        let event_json = json!({
            "event": {
                "name": name,
                "date": date
            },
            "circles": [],
            "metadata": {
                "source": source
            }
        });
        fs::write(
            event_dir.join("event.json"),
            serde_json::to_string_pretty(&event_json).unwrap(),
        )
        .unwrap();
    }

    fn write_mobile_result_zip(zip_path: &Path, name: &str, date: &str) {
        let file = fs::File::create(zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        let event_json = json!({
            "event": {
                "name": name,
                "date": date,
                "event_image_filename": "event_image.png"
            },
            "circles": [
                {"name": "Circle A", "checked": 1},
                {"name": "Circle B", "checked": 0}
            ],
            "metadata": {}
        });

        zip.start_file("event.json", options).unwrap();
        zip.write_all(serde_json::to_string(&event_json).unwrap().as_bytes())
            .unwrap();
        zip.add_directory("event_image/", options).unwrap();
        zip.start_file("event_image/event_image.png", options)
            .unwrap();
        zip.write_all(b"thumbnail").unwrap();
        zip.finish().unwrap();
    }

    fn write_manifest_mobile_result_zip(zip_path: &Path, name: &str, date: &str) {
        let file = fs::File::create(zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        let event_json = json!({
            "event": {
                "name": name,
                "date": date,
                "event_image_filename": "event_image.png"
            },
            "circles": [{
                "name": "Circle A",
                "circle_cut_filename": "circles/cut.jpg",
                "item_images": [{"path": "items/catalog.jpg", "source": "catalog"}]
            }],
            "metadata": {}
        });
        let manifest = json!({
            "format": "eventtrail_asset_manifest",
            "format_version": 1,
            "assets": {
                "same": {
                    "algorithm": "sha256",
                    "hash": "same",
                    "path": "assets/sha256/sa/same.jpg",
                    "size": 10,
                    "original_names": [
                        "event_image/event_image.png",
                        "circles/cut.jpg",
                        "items/catalog.jpg"
                    ]
                }
            },
            "aliases": {
                "event_image/event_image.png": "assets/sha256/sa/same.jpg",
                "circles/cut.jpg": "assets/sha256/sa/same.jpg",
                "items/catalog.jpg": "assets/sha256/sa/same.jpg"
            }
        });

        zip.start_file("event.json", options).unwrap();
        zip.write_all(serde_json::to_string(&event_json).unwrap().as_bytes())
            .unwrap();
        zip.start_file("asset_manifest.json", options).unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
            .unwrap();
        zip.start_file("assets/sha256/sa/same.jpg", options)
            .unwrap();
        zip.write_all(b"same-image").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn start_file_server_removes_cleanup_file_on_stop() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-file-server-cleanup-test-{}-{}",
            std::process::id(),
            suffix
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("mobile_export.zip");
        fs::write(&zip_path, b"zip").unwrap();

        let _ = stop_file_server();
        let result = start_file_server(zip_path.to_string_lossy().to_string(), Some(true)).unwrap();
        assert_eq!(result["status"].as_str(), Some("ok"));
        assert!(zip_path.is_file());

        stop_file_server().unwrap();
        for _ in 0..30 {
            if !zip_path.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }

        assert!(!zip_path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_result_zip_updates_existing_same_name_date_and_event_image() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-import-result-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let events_dir = root.join("events");
        let original_dir = events_dir.join("same_event_original");
        let mobile_duplicate_dir = events_dir.join("same_event_mobile");
        write_test_event(
            &original_dir,
            "Same Event",
            "2026-05-24",
            "multi_event_pipeline",
        );
        write_test_event(
            &mobile_duplicate_dir,
            "Same Event",
            "2026-05-24",
            "mobile_import",
        );

        let zip_path = root.join("mobile_result.zip");
        write_mobile_result_zip(&zip_path, "Same Event", "2026-05-24");

        let result = import_result_zip(
            zip_path.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(result["slug"].as_str(), Some("same_event_original"));
        assert_eq!(result["duplicate_mobile_imports_removed"].as_u64(), Some(1));
        assert!(original_dir.join("event_image/event_image.png").is_file());
        assert!(!mobile_duplicate_dir.exists());
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(original_dir.join("event.json")).unwrap())
                .unwrap();
        assert_eq!(
            saved["event"]["event_image"].as_str(),
            Some("event_image/event_image.png")
        );
        assert_eq!(saved["metadata"]["source"].as_str(), Some("mobile_import"));
        assert_eq!(
            fs::read_dir(&events_dir)
                .unwrap()
                .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_dir())
                .count(),
            1
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_result_zip_expands_asset_manifest_aliases() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-import-manifest-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let zip_path = root.join("mobile_result_manifest.zip");
        fs::create_dir_all(&root).unwrap();
        write_manifest_mobile_result_zip(&zip_path, "Manifest Event", "2026-05-25");

        let result = import_result_zip(
            zip_path.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();

        let event_dir = PathBuf::from(result["dir"].as_str().unwrap());
        assert!(event_dir.join("event_image/event_image.png").is_file());
        assert!(event_dir.join("circles/cut.jpg").is_file());
        assert!(event_dir.join("items/catalog.jpg").is_file());
        assert!(!event_dir.join("assets/sha256/sa/same.jpg").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normalize_imported_circle_asset_refs_prefers_zip_asset_paths() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-import-asset-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("circles")).unwrap();
        fs::create_dir_all(root.join("items")).unwrap();
        fs::write(root.join("circles").join("cut.jpg"), b"cut").unwrap();
        fs::write(root.join("items").join("catalog.jpg"), b"item").unwrap();

        let mut data = json!({
            "circles": [{
                "circle_cut_filename": "file:///data/user/0/com.eventtrail.go/files/images/17/cuts/cut.jpg",
                "item_images": [{
                    "path": "file:///data/user/0/com.eventtrail.go/files/images/17/items/catalog.jpg",
                    "source": "twitter"
                }],
                "items": [{
                    "image": "file:///data/user/0/com.eventtrail.go/files/images/17/items/catalog.jpg"
                }]
            }]
        });

        normalize_imported_circle_asset_refs(&mut data, &root);

        let circle = &data["circles"][0];
        assert_eq!(
            circle["circle_cut_filename"].as_str(),
            Some("circles/cut.jpg")
        );
        assert_eq!(
            circle["item_images"][0]["path"].as_str(),
            Some("items/catalog.jpg")
        );
        assert_eq!(
            circle["items"][0]["image"].as_str(),
            Some("items/catalog.jpg")
        );

        let _ = fs::remove_dir_all(&root);
    }
}

#[tauri::command]
fn list_event_dirs(project_root: String) -> Result<Value, String> {
    let events_dir = PathBuf::from(&project_root).join("events");
    let mut events: Vec<Value> = Vec::new();
    if !events_dir.exists() {
        return Ok(json!({"status": "ok", "events": events}));
    }
    if let Ok(entries) = fs::read_dir(&events_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                let slug = entry.file_name().to_string_lossy().to_string();
                // event.jsonからeventセクションを読み取り
                let ej_path = entry.path().join("event.json");
                if !ej_path.exists() {
                    continue;
                }
                let meta = {
                    let text = fs::read_to_string(&ej_path).unwrap_or_default();
                    let full: Value = serde_json::from_str(&text).unwrap_or(json!({}));
                    // eventセクション + metadataのsource/purchase_resultsをマージ
                    let mut m = full.get("event").cloned().unwrap_or(json!({}));
                    if let Some(md) = full.get("metadata") {
                        if let Some(src) = md.get("source") {
                            m["source"] = src.clone();
                        }
                        if let Some(pr) = md.get("purchase_results") {
                            m["purchase_results"] = pr.clone();
                        }
                    }
                    normalize_event_meta_for_dir(m, &entry.path())
                };
                events.push(json!({
                    "slug": slug,
                    "dir": entry.path().to_string_lossy().to_string().replace("\\", "/"),
                    "meta": meta
                }));
            }
        }
    }
    // ソートはフロントエンド側で行う
    Ok(json!({"status": "ok", "events": events}))
}

#[tauri::command]
fn read_event_meta(event_dir: String) -> Result<Value, String> {
    let event_dir = PathBuf::from(&event_dir);
    let ej_path = event_dir.join("event.json");
    if !ej_path.exists() {
        return Ok(json!({"found": false}));
    }
    let text = fs::read_to_string(&ej_path).map_err(|e| format!("event.json読み込み失敗: {e}"))?;
    let full: Value =
        serde_json::from_str(&text).map_err(|e| format!("event.json解析失敗: {e}"))?;
    let meta =
        normalize_event_meta_for_dir(full.get("event").cloned().unwrap_or(json!({})), &event_dir);
    Ok(json!({"found": true, "meta": meta}))
}

#[tauri::command]
fn write_event_meta(event_dir: String, meta: Value) -> Result<Value, String> {
    let dir = PathBuf::from(&event_dir);
    fs::create_dir_all(&dir).ok();
    let ej_path = dir.join("event.json");

    // 既存のevent.jsonがあれば読み込み、eventセクションだけ更新
    let mut full: Value = if ej_path.exists() {
        let text = fs::read_to_string(&ej_path).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(json!({}))
    } else {
        json!({"circles": [], "metadata": {"format_version": "3.0", "source": "desktop_created"}})
    };

    full["event"] = normalize_event_meta_aliases(meta);

    let text = serde_json::to_string_pretty(&full)
        .map_err(|e| format!("event.jsonシリアライズ失敗: {e}"))?;
    fs::write(&ej_path, text).map_err(|e| format!("event.json書き込み失敗: {e}"))?;
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn create_event_dir(project_root: String, slug: String) -> Result<Value, String> {
    let event_dir = PathBuf::from(&project_root).join("events").join(&slug);
    fs::create_dir_all(&event_dir).map_err(|e| format!("イベントディレクトリ作成失敗: {e}"))?;
    let ej_path = event_dir.join("event.json");
    if !ej_path.exists() {
        let now = chrono::Local::now().to_rfc3339();
        let data = json!({
            "event": {
                "name": slug,
                "created_at": now,
            },
            "circles": [],
            "metadata": {
                "format_version": "3.0",
                "source": "desktop_created"
            }
        });
        let text = serde_json::to_string_pretty(&data).unwrap_or_default();
        fs::write(&ej_path, text).ok();
    }
    Ok(json!({
        "status": "ok",
        "dir": event_dir.to_string_lossy().to_string().replace("\\", "/")
    }))
}

#[tauri::command]
fn delete_event_dir(event_dir: String) -> Result<Value, String> {
    let dir = PathBuf::from(&event_dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("イベントディレクトリ削除失敗: {e}"))?;
    }
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn rename_event_dir(
    project_root: String,
    old_slug: String,
    new_slug: String,
) -> Result<Value, String> {
    let events_dir = PathBuf::from(&project_root).join("events");
    let old_dir = events_dir.join(&old_slug);
    let new_dir = events_dir.join(&new_slug);
    if !old_dir.exists() {
        return Err(format!("元のディレクトリが見つかりません: {}", old_slug));
    }
    if new_dir.exists() {
        return Err(format!("移動先ディレクトリが既に存在します: {}", new_slug));
    }
    fs::rename(&old_dir, &new_dir).map_err(|e| format!("ディレクトリ名変更失敗: {e}"))?;
    Ok(json!({
        "status": "ok",
        "new_dir": new_dir.to_string_lossy().to_string().replace("\\", "/"),
        "new_slug": new_slug
    }))
}

#[tauri::command]
fn list_event_map_images(event_dir: String) -> Result<Value, String> {
    let dir = PathBuf::from(&event_dir);
    let mut maps: Vec<Value> = Vec::new();
    let mut seen_names = HashSet::new();
    let mut scan_dir = |scan_path: PathBuf| {
        if scan_path.exists() {
            if let Ok(entries) = fs::read_dir(&scan_path) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("map_")
                        && (name.ends_with(".jpg")
                            || name.ends_with(".jpeg")
                            || name.ends_with(".png")
                            || name.ends_with(".webp"))
                        && seen_names.insert(name.clone())
                    {
                        let full = entry
                            .path()
                            .to_string_lossy()
                            .to_string()
                            .replace("\\", "/");
                        maps.push(json!({"name": name, "path": full}));
                    }
                }
            }
        }
    };
    scan_dir(dir.join("maps"));
    scan_dir(dir);
    maps.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(json!({"status": "ok", "maps": maps}))
}

fn sanitize_event_slug_name(event_name: &str) -> String {
    let safe_name: String = event_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || ('\u{3000}'..='\u{9FFF}').contains(&c)
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe_name.trim_matches('_').is_empty() {
        "unknown".to_string()
    } else {
        safe_name
    }
}

fn event_field_string(event: &Value, key: &str) -> Option<String> {
    event
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn normalized_event_date(event: &Value) -> Option<String> {
    event_field_string(event, "date").and_then(|date| normalize_event_date_string(&date))
}

fn find_existing_event_dir(
    project_root: &Path,
    event_name: &str,
    event_date: Option<&str>,
) -> Option<(String, PathBuf)> {
    let events_dir = project_root.join("events");
    let mut candidates: Vec<(u8, String, PathBuf)> = Vec::new();
    let entries = fs::read_dir(&events_dir).ok()?;

    for entry in entries.flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
            continue;
        }
        let event_json = entry.path().join("event.json");
        let text = match fs::read_to_string(&event_json) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let full: Value = match serde_json::from_str(&text) {
            Ok(full) => full,
            Err(_) => continue,
        };
        let local_event = full.get("event").unwrap_or(&Value::Null);
        let Some(local_name) = event_field_string(local_event, "name") else {
            continue;
        };
        if local_name != event_name {
            continue;
        }
        if let Some(incoming_date) = event_date {
            if normalized_event_date(local_event).as_deref() != Some(incoming_date) {
                continue;
            }
        }
        let source = full
            .get("metadata")
            .and_then(|md| md.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let source_priority = if source == "mobile_import" { 1 } else { 0 };
        candidates.push((
            source_priority,
            entry.file_name().to_string_lossy().to_string(),
            entry.path(),
        ));
    }

    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .next()
        .map(|(_, slug, path)| (slug, path))
}

fn remove_redundant_mobile_import_dirs(
    project_root: &Path,
    event_name: &str,
    event_date: Option<&str>,
    keep_slug: &str,
) -> Result<usize, String> {
    let events_dir = project_root.join("events");
    let mut remove_targets: Vec<PathBuf> = Vec::new();
    let entries = match fs::read_dir(&events_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };

    for entry in entries.flatten() {
        if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().to_string();
        if slug == keep_slug {
            continue;
        }
        let event_json = entry.path().join("event.json");
        let text = match fs::read_to_string(&event_json) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let full: Value = match serde_json::from_str(&text) {
            Ok(full) => full,
            Err(_) => continue,
        };
        let local_event = full.get("event").unwrap_or(&Value::Null);
        if event_field_string(local_event, "name").as_deref() != Some(event_name) {
            continue;
        }
        if let Some(incoming_date) = event_date {
            if normalized_event_date(local_event).as_deref() != Some(incoming_date) {
                continue;
            }
        }
        let source = full
            .get("metadata")
            .and_then(|md| md.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if source == "mobile_import" {
            remove_targets.push(entry.path());
        }
    }

    let removed = remove_targets.len();
    for path in remove_targets {
        fs::remove_dir_all(&path).map_err(|e| {
            format!(
                "重複モバイル受信イベントの削除失敗: {}: {e}",
                path.display()
            )
        })?;
    }
    Ok(removed)
}

fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn read_asset_manifest_aliases(archive: &mut zip::ZipArchive<fs::File>) -> HashMap<String, String> {
    let Ok(mut file) = archive.by_name("asset_manifest.json") else {
        return HashMap::new();
    };
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return HashMap::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(&buf) else {
        return HashMap::new();
    };
    value
        .get("aliases")
        .and_then(|aliases| aliases.as_object())
        .map(|aliases| {
            aliases
                .iter()
                .filter_map(|(logical, asset)| {
                    asset.as_str().map(|asset_name| {
                        (logical.replace('\\', "/"), asset_name.replace('\\', "/"))
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn import_result_zip(zip_path: String, project_root: String) -> Result<Value, String> {
    let zip_file =
        fs::File::open(&zip_path).map_err(|e| format!("ZIPファイル読み込み失敗: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP展開失敗: {e}"))?;

    // event.jsonを読んでイベント情報を取得
    let event_data: Value = {
        let mut f = archive
            .by_name("event.json")
            .map_err(|e| format!("event.jsonが見つかりません: {e}"))?;
        let mut buf = String::new();
        f.read_to_string(&mut buf)
            .map_err(|e| format!("event.json読み込み失敗: {e}"))?;
        serde_json::from_str(&buf).map_err(|e| format!("event.json解析失敗: {e}"))?
    };

    // イベント名からslugを生成
    let project_root_path = PathBuf::from(&project_root);
    let event_obj = event_data.get("event").unwrap_or(&Value::Null);
    let event_name = event_field_string(event_obj, "name").unwrap_or_else(|| "unknown".to_string());
    let event_date = normalized_event_date(event_obj);
    let (slug, event_dir) = if let Some((slug, dir)) =
        find_existing_event_dir(&project_root_path, &event_name, event_date.as_deref())
    {
        (slug, dir)
    } else {
        let now = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let safe_name = sanitize_event_slug_name(&event_name);
        let slug = format!("{}_{}", safe_name, now);
        let dir = project_root_path.join("events").join(&slug);
        (slug, dir)
    };
    fs::create_dir_all(&event_dir).map_err(|e| format!("イベントディレクトリ作成失敗: {e}"))?;

    // 購入結果を集計してmetadataに追加
    let circles = event_data["circles"].as_array();
    let total = circles.map_or(0, |c| c.len());
    let bought = circles.map_or(0, |c| {
        c.iter()
            .filter(|ci| ci["checked"].as_i64() == Some(1))
            .count()
    });
    let couldnt_buy = circles.map_or(0, |c| {
        c.iter()
            .filter(|ci| ci["checked"].as_i64() == Some(2))
            .count()
    });
    let remaining = total - bought - couldnt_buy;

    // event.jsonを保存（metadataにpurchase_resultsとsourceを追加）
    let mut data_to_save = event_data.clone();
    if let Some(md) = data_to_save.get_mut("metadata") {
        md["source"] = json!("mobile_import");
        md["purchase_results"] = json!({
            "total": total,
            "bought": bought,
            "couldnt_buy": couldnt_buy,
            "remaining": remaining
        });
    } else {
        data_to_save["metadata"] = json!({
            "source": "mobile_import",
            "purchase_results": {
                "total": total,
                "bought": bought,
                "couldnt_buy": couldnt_buy,
                "remaining": remaining
            }
        });
    }
    // created_atを追加
    if data_to_save["event"].get("created_at").is_none() {
        data_to_save["event"]["created_at"] = json!(chrono::Local::now().to_rfc3339());
    }

    // circle_master.jsonのマージ（ZIPに含まれていれば）
    let mut has_circle_master = false;
    if let Ok(mut cm_file) = archive.by_name("circle_master.json") {
        let mut cm_buf = String::new();
        if cm_file.read_to_string(&mut cm_buf).is_ok() {
            if let Ok(incoming_cm) = serde_json::from_str::<Value>(&cm_buf) {
                // 既存のcircle_master.jsonを読み込み
                let cm_path = PathBuf::from(&project_root).join("circle_master.json");
                let mut local_cm: Value = if cm_path.exists() {
                    fs::read_to_string(&cm_path)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(json!({"circles": {}}))
                } else {
                    json!({"circles": {}})
                };

                // マージ: お気に入り=OR、ジャンル/カット/ペンネーム=空なら埋める
                if let (Some(local_circles), Some(incoming_circles)) = (
                    local_cm.get_mut("circles").and_then(|c| c.as_object_mut()),
                    incoming_cm.get("circles").and_then(|c| c.as_object()),
                ) {
                    for (name, inc_entry) in incoming_circles {
                        if let Some(local_entry) = local_circles.get_mut(name) {
                            // favorite: OR
                            if inc_entry
                                .get("favorite")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                                && !local_entry
                                    .get("favorite")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false)
                            {
                                local_entry["favorite"] = json!(true);
                            }
                            // genre: 空なら埋める
                            if local_entry
                                .get("genre")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .is_empty()
                            {
                                if let Some(g) = inc_entry.get("genre").and_then(|v| v.as_str()) {
                                    if !g.is_empty() {
                                        local_entry["genre"] = json!(g);
                                    }
                                }
                            }
                            // default_cut: 空なら埋める
                            if local_entry
                                .get("default_cut")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .is_empty()
                                && local_entry.get("default_cut") != Some(&json!(null))
                            {
                                // pass
                            }
                            if local_entry.get("default_cut").is_none()
                                || local_entry["default_cut"].is_null()
                                || local_entry
                                    .get("default_cut")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .is_empty()
                            {
                                if let Some(dc) = inc_entry.get("default_cut") {
                                    if !dc.is_null() && dc.as_str().unwrap_or("") != "" {
                                        local_entry["default_cut"] = dc.clone();
                                    }
                                }
                            }
                            // penname: 空なら埋める
                            if local_entry
                                .get("penname")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .is_empty()
                            {
                                if let Some(p) = inc_entry.get("penname").and_then(|v| v.as_str()) {
                                    if !p.is_empty() {
                                        local_entry["penname"] = json!(p);
                                    }
                                }
                            }
                        } else {
                            // ローカルに存在しない → 丸ごと追加
                            local_circles.insert(name.clone(), inc_entry.clone());
                        }
                    }
                }

                // マージ結果を保存
                if let Ok(cm_text) = serde_json::to_string_pretty(&local_cm) {
                    let _ = fs::write(&cm_path, &cm_text);
                    has_circle_master = true;
                }
            }
        }
    }

    // ZIPからファイルを展開（event.json, circle_master.json以外）
    let asset_aliases = read_asset_manifest_aliases(&mut archive);

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entry読み込み失敗: {e}"))?;
        let name = file.name().to_string();
        if name == "event.json"
            || name == "circle_master.json"
            || name == "asset_manifest.json"
            || name.starts_with("assets/")
            || name.ends_with('/')
        {
            continue;
        }
        let Some(enclosed_name) = file.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        let dest_path = if name.starts_with("default_cuts/") {
            project_root_path.join(enclosed_name)
        } else {
            event_dir.join(enclosed_name)
        };
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("ファイル読み込み失敗: {e}"))?;
        fs::write(&dest_path, &buf).map_err(|e| format!("ファイル書き込み失敗: {e}"))?;
    }

    let mut expanded_aliases: HashSet<String> = HashSet::new();
    for (logical_name, asset_name) in asset_aliases {
        if !expanded_aliases.insert(logical_name.clone()) {
            continue;
        }
        let Some(enclosed_name) = safe_relative_path(&logical_name) else {
            continue;
        };
        if safe_relative_path(&asset_name).is_none() {
            continue;
        }
        let mut file = archive
            .by_name(&asset_name)
            .map_err(|e| format!("asset manifest entry読み込み失敗 {asset_name}: {e}"))?;
        if file.name().ends_with('/') {
            continue;
        }
        let dest_path = if logical_name.starts_with("default_cuts/") {
            project_root_path.join(enclosed_name)
        } else {
            event_dir.join(enclosed_name)
        };
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("asset manifest entry読み込み失敗 {asset_name}: {e}"))?;
        fs::write(&dest_path, &buf)
            .map_err(|e| format!("asset manifest entry書き込み失敗: {e}"))?;
    }

    let meta = normalize_event_meta_for_dir(
        data_to_save.get("event").cloned().unwrap_or(json!({})),
        &event_dir,
    );
    data_to_save["event"] = meta.clone();
    normalize_imported_circle_asset_refs(&mut data_to_save, &event_dir);
    let ej_text = serde_json::to_string_pretty(&data_to_save).unwrap_or_default();
    fs::write(event_dir.join("event.json"), &ej_text)
        .map_err(|e| format!("event.json書き込み失敗: {e}"))?;
    let duplicate_mobile_imports_removed = remove_redundant_mobile_import_dirs(
        &project_root_path,
        &event_name,
        event_date.as_deref(),
        &slug,
    )?;

    Ok(json!({
        "status": "ok",
        "slug": slug,
        "dir": event_dir.to_string_lossy().to_string().replace("\\", "/"),
        "meta": meta,
        "circle_master_merged": has_circle_master,
        "duplicate_mobile_imports_removed": duplicate_mobile_imports_removed
    }))
}

// ── 感想ファイル連携 ──

#[tauri::command]
fn append_review_entry(
    foam_dir: String,
    event_name: String,
    item_name: String,
    penname: String,
) -> Result<Value, String> {
    let dir = PathBuf::from(&foam_dir);
    let kanso_path = dir.join("感想.md");
    if !kanso_path.exists() {
        return Err(format!("感想.mdが見つかりません: {}", kanso_path.display()));
    }

    let kanso_content =
        fs::read_to_string(&kanso_path).map_err(|e| format!("感想.md読み込み失敗: {e}"))?;

    // イベントのWikilinkを検索（[[UUID|イベント名]] 形式）
    let mut review_uid: Option<String> = None;
    for line in kanso_content.lines() {
        // [[20260329175407|そうぞうパレッツ東京2026]] のような形式を探す
        if let Some(start) = line.find("[[") {
            if let Some(end) = line[start..].find("]]") {
                let inner = &line[start + 2..start + end];
                if let Some(pipe) = inner.find('|') {
                    let link_name = &inner[pipe + 1..];
                    if link_name == event_name {
                        review_uid = Some(inner[..pipe].to_string());
                        break;
                    }
                }
            }
        }
    }

    let mut created_new = false;

    // 感想ファイルが無い場合、新規作成
    let uid = if let Some(uid) = review_uid {
        uid
    } else {
        // 現在時刻からUIDを生成
        let now = chrono::Local::now();
        let uid = now.format("%Y%m%d%H%M%S").to_string();
        let datetime_str = now.format("%Y-%m-%d %H:%M:%S").to_string();

        // 感想ファイルを新規作成
        let review_path = dir.join(format!("{}.md", uid));
        let frontmatter = format!(
            "---\ntitle: {}\nuid: {}\naliases: \ndate: {}\nupdate: {}\ntags: anything\ndraft: true\nwork: false\nfoam_template:\n  filepath: 'Inbox/{}.md'\n---\n\n# ノート\n",
            event_name, uid, datetime_str, datetime_str, uid
        );
        fs::write(&review_path, &frontmatter).map_err(|e| format!("感想ファイル作成失敗: {e}"))?;

        // 感想.mdにWikilink追記（## イベントごと セクションの末尾に）
        let wikilink = format!("[[{}|{}]]", uid, event_name);
        let new_kanso = format!("{}\n{}", kanso_content.trim_end(), wikilink);
        fs::write(&kanso_path, new_kanso).map_err(|e| format!("感想.md更新失敗: {e}"))?;

        // 感想.mdのupdate日時を更新
        created_new = true;
        uid
    };

    let review_path = dir.join(format!("{}.md", uid));
    let review_content =
        fs::read_to_string(&review_path).map_err(|e| format!("感想ファイル読み込み失敗: {e}"))?;

    // 既存の見出しチェック（# アイテム名 が既にあるか）
    let heading = format!("# {}", item_name);
    let already_exists = review_content.lines().any(|line| line.trim() == heading);

    if !already_exists {
        // 末尾に追記
        let entry = if penname.is_empty() {
            format!("\n\n{}\n\n", heading)
        } else {
            format!("\n\n{}\n{}さん作\n\n", heading, penname)
        };
        let new_content = format!("{}{}", review_content.trim_end(), entry);
        fs::write(&review_path, new_content).map_err(|e| format!("感想ファイル追記失敗: {e}"))?;
    }

    // update日時を更新
    let now_str = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let updated_content =
        fs::read_to_string(&review_path).map_err(|e| format!("感想ファイル再読み込み失敗: {e}"))?;
    if let Some(pos) = updated_content.find("update: ") {
        if let Some(end) = updated_content[pos..].find('\n') {
            let old_line = &updated_content[pos..pos + end];
            let new_line = format!("update: {}", now_str);
            let final_content = updated_content.replacen(old_line, &new_line, 1);
            fs::write(&review_path, final_content)
                .map_err(|e| format!("update日時更新失敗: {e}"))?;
        }
    }

    Ok(json!({
        "status": "ok",
        "filePath": review_path.to_string_lossy().to_string().replace("\\", "/"),
        "uid": uid,
        "createdNew": created_new,
        "alreadyExists": already_exists
    }))
}

#[tauri::command]
fn open_file_default(file_path: String) -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("cmd")
            .args(["/C", "start", "", &file_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("ファイルを開けません: {e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("ファイルを開けません: {e}"))?;
    }
    Ok(json!({"status": "ok"}))
}

// ── 受信サーバー（逆QR方式）──

fn receive_server_running() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    static FLAG: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
    FLAG.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn start_receive_server(window: tauri::Window, project_root: String) -> Result<Value, String> {
    let mut guard = receive_server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    if let Some(ref flag) = *guard {
        if flag.load(Ordering::Relaxed) {
            return Err("受信サーバーは既に起動中です".to_string());
        }
    }

    // 固定ポートを優先（ファイアウォール対策）、使用中なら自動割当にフォールバック
    let server = tiny_http::Server::http("0.0.0.0:18722")
        .or_else(|_| tiny_http::Server::http("0.0.0.0:0"))
        .map_err(|e| format!("受信サーバー起動失敗: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "サーバーアドレス取得失敗".to_string())?
        .port();

    let ip = local_ip_address::local_ip().map_err(|e| format!("LAN IP取得失敗: {e}"))?;
    let upload_url = format!("http://{}:{}/upload", ip, port);

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let project_root_for_import = project_root.clone();

    thread::spawn(move || {
        while running_clone.load(Ordering::Relaxed) {
            match server.recv_timeout(Duration::from_millis(500)) {
                Ok(Some(mut request)) => {
                    // CORSプリフライト対応
                    if request.method().as_str() == "OPTIONS" {
                        let resp = tiny_http::Response::from_string("")
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Access-Control-Allow-Origin"[..],
                                    &b"*"[..],
                                )
                                .unwrap(),
                            )
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Access-Control-Allow-Methods"[..],
                                    &b"POST, OPTIONS"[..],
                                )
                                .unwrap(),
                            )
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Access-Control-Allow-Headers"[..],
                                    &b"Content-Type"[..],
                                )
                                .unwrap(),
                            );
                        let _ = request.respond(resp);
                        continue;
                    }

                    // POST /upload のみ受け付け
                    if request.url() != "/upload" || *request.method() != tiny_http::Method::Post {
                        let resp = tiny_http::Response::from_string("Not Found")
                            .with_status_code(tiny_http::StatusCode(404));
                        let _ = request.respond(resp);
                        continue;
                    }

                    // ZIPデータを受信
                    let mut body = Vec::new();
                    if let Err(e) = request.as_reader().read_to_end(&mut body) {
                        let resp = tiny_http::Response::from_string(format!("読み込みエラー: {e}"))
                            .with_status_code(tiny_http::StatusCode(500));
                        let _ = request.respond(resp);
                        continue;
                    }

                    // 一時ファイルに保存
                    let tmp_path = std::env::temp_dir()
                        .join(format!("eventtrail_received_{}.zip", std::process::id()));
                    if let Err(e) = fs::write(&tmp_path, &body) {
                        let resp = tiny_http::Response::from_string(format!("保存エラー: {e}"))
                            .with_status_code(tiny_http::StatusCode(500));
                        let _ = request.respond(resp);
                        continue;
                    }

                    let zip_path = tmp_path.to_string_lossy().to_string().replace("\\", "/");
                    let size = body.len();
                    let _ = window.emit(
                        "result-uploaded",
                        json!({
                            "zipPath": zip_path.clone(),
                            "size": size
                        }),
                    );

                    let import_result = match import_result_zip(
                        zip_path.clone(),
                        project_root_for_import.clone(),
                    ) {
                        Ok(value) => value,
                        Err(e) => {
                            let error = e.clone();
                            let _ = window.emit(
                                "result-receive-error",
                                json!({
                                    "zipPath": zip_path.clone(),
                                    "size": size,
                                    "error": error
                                }),
                            );
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": e}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(500))
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Access-Control-Allow-Origin"[..],
                                    &b"*"[..],
                                )
                                .unwrap(),
                            )
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    &b"application/json"[..],
                                )
                                .unwrap(),
                            );
                            let _ = request.respond(resp);
                            running_clone.store(false, Ordering::Relaxed);
                            break;
                        }
                    };

                    let payload = json!({
                        "status": "ok",
                        "zipPath": zip_path.clone(),
                        "size": size,
                        "importResult": import_result
                    });
                    let resp = tiny_http::Response::from_string(payload.to_string())
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Access-Control-Allow-Origin"[..],
                                &b"*"[..],
                            )
                            .unwrap(),
                        )
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/json"[..],
                            )
                            .unwrap(),
                        );
                    let _ = request.respond(resp);

                    // Tauriイベントで通知
                    let _ = window.emit("result-received", payload);

                    // 受信後サーバー停止
                    running_clone.store(false, Ordering::Relaxed);
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    *guard = Some(running);

    Ok(json!({
        "status": "ok",
        "ip": ip.to_string(),
        "port": port,
        "url": upload_url
    }))
}

#[tauri::command]
fn stop_receive_server() -> Result<Value, String> {
    let mut guard = receive_server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    if let Some(flag) = guard.take() {
        flag.store(false, Ordering::Relaxed);
    }
    Ok(json!({"status": "ok"}))
}

// ── ファイル配信HTTPサーバー ──

struct FileServerState {
    flag: Arc<AtomicBool>,
    cleanup_path: Option<PathBuf>,
}

fn server_running() -> &'static Mutex<Option<FileServerState>> {
    static FLAG: OnceLock<Mutex<Option<FileServerState>>> = OnceLock::new();
    FLAG.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn start_file_server(file_path: String, cleanup_on_stop: Option<bool>) -> Result<Value, String> {
    let mut guard = server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    if let Some(ref state) = *guard {
        if state.flag.load(Ordering::Relaxed) {
            return Err(
                "サーバーは既に起動中です。先に stop_file_server を呼んでください。".to_string(),
            );
        }
    }

    // 固定ポートを優先（ファイアウォール対策）、使用中なら自動割当にフォールバック
    if let Some(state) = guard.take() {
        if let Some(path) = state.cleanup_path {
            let _ = fs::remove_file(path);
        }
    }

    let server = tiny_http::Server::http("0.0.0.0:18721")
        .or_else(|_| tiny_http::Server::http("0.0.0.0:0"))
        .map_err(|e| format!("HTTPサーバー起動失敗: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "サーバーアドレス取得失敗".to_string())?
        .port();

    let ip = local_ip_address::local_ip().map_err(|e| format!("LAN IP取得失敗: {e}"))?;

    let file_name = PathBuf::from(&file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let url = format!("http://{}:{}/{}", ip, port, file_name);

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let serve_path = file_path.clone();
    let cleanup_path = if cleanup_on_stop.unwrap_or(false) {
        Some(PathBuf::from(&file_path))
    } else {
        None
    };
    let cleanup_path_for_thread = cleanup_path.clone();

    // サーバーをバックグラウンドスレッドに移動
    thread::spawn(move || {
        // recv_timeout でポーリングしてフラグチェック
        while running_clone.load(Ordering::Relaxed) {
            match server.recv_timeout(Duration::from_millis(500)) {
                Ok(Some(request)) => {
                    let file = match fs::File::open(&serve_path) {
                        Ok(f) => f,
                        Err(_) => {
                            let resp = tiny_http::Response::from_string("File not found")
                                .with_status_code(tiny_http::StatusCode(404));
                            let _ = request.respond(resp);
                            continue;
                        }
                    };
                    let len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        Vec::new(),
                        file,
                        Some(len),
                        None,
                    )
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/zip"[..],
                        )
                        .unwrap(),
                    )
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Disposition"[..],
                            format!("attachment; filename=\"{}\"", file_name).as_bytes(),
                        )
                        .unwrap(),
                    )
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Length"[..],
                            len.to_string().as_bytes(),
                        )
                        .unwrap(),
                    );
                    let _ = request.respond(response);
                }
                Ok(None) => {} // タイムアウト — ループ継続
                Err(_) => break,
            }
        }
        if let Some(path) = cleanup_path_for_thread {
            let _ = fs::remove_file(path);
        }
    });

    *guard = Some(FileServerState {
        flag: running,
        cleanup_path,
    });

    Ok(json!({
        "status": "ok",
        "ip": ip.to_string(),
        "port": port,
        "url": url
    }))
}

#[tauri::command]
fn stop_file_server() -> Result<Value, String> {
    let mut guard = server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    if let Some(state) = guard.take() {
        state.flag.store(false, Ordering::Relaxed);
    }
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn get_local_ip() -> Result<Value, String> {
    let ip = local_ip_address::local_ip().map_err(|e| format!("LAN IP取得失敗: {e}"))?;
    Ok(json!({"status": "ok", "ip": ip.to_string()}))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvKeys {
    openai_api_key: String,
    gemini_api_key: String,
    xai_api_key: String,
}

/// .env ファイルからAPIキーを読み込む
#[tauri::command]
fn load_env_keys(project_root: String) -> Result<EnvKeys, String> {
    let path = PathBuf::from(&project_root).join(".env");
    let mut keys = EnvKeys {
        openai_api_key: String::new(),
        gemini_api_key: String::new(),
        xai_api_key: String::new(),
    };
    if !path.exists() {
        return Ok(keys);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!(".env読み込み失敗: {e}"))?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim();
            match k {
                "OPENAI_API_KEY" => keys.openai_api_key = v.to_string(),
                "GEMINI_API_KEY" => keys.gemini_api_key = v.to_string(),
                "XAI_API_KEY" => keys.xai_api_key = v.to_string(),
                _ => {}
            }
        }
    }
    Ok(keys)
}

/// .env ファイルにAPIキーを保存する（既存の未知キーは保持）
#[tauri::command]
fn save_env_keys(project_root: String, keys: EnvKeys) -> Result<Value, String> {
    let path = PathBuf::from(&project_root).join(".env");
    let known = ["OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"];

    // 既存ファイルから未知の行を保持
    let mut other_lines: Vec<String> = Vec::new();
    if path.exists() {
        let text = fs::read_to_string(&path).map_err(|e| format!(".env読み込み失敗: {e}"))?;
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                other_lines.push(line.to_string());
                continue;
            }
            if let Some((k, _)) = trimmed.split_once('=') {
                if !known.contains(&k.trim()) {
                    other_lines.push(line.to_string());
                }
            } else {
                other_lines.push(line.to_string());
            }
        }
    }

    let mut output = other_lines.join("\n");
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(&format!("OPENAI_API_KEY={}\n", keys.openai_api_key));
    output.push_str(&format!("GEMINI_API_KEY={}\n", keys.gemini_api_key));
    output.push_str(&format!("XAI_API_KEY={}\n", keys.xai_api_key));

    fs::write(&path, output).map_err(|e| format!(".env書き込み失敗: {e}"))?;
    Ok(json!({"status": "ok"}))
}

// ==================== 自動更新 ====================

/// latest.json の desktop セクション
#[derive(Debug, Deserialize)]
struct UpdateInfo {
    version: String,
    url: String,
    notes: String,
    #[allow(dead_code)]
    date: String,
}

/// latest.json 全体
#[derive(Debug, Deserialize)]
struct LatestJson {
    desktop: UpdateInfo,
}

/// フロントエンドに返す更新チェック結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResult {
    update_available: bool,
    current_version: String,
    latest_version: Option<String>,
    download_url: Option<String>,
    release_notes: Option<String>,
}

/// セマンティックバージョン比較 (X.Y.Z)
fn is_newer_version(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let cur = parse(current);
    let lat = parse(latest);
    for i in 0..3 {
        let c = cur.get(i).copied().unwrap_or(0);
        let l = lat.get(i).copied().unwrap_or(0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    false
}

const UPDATE_CHECK_URL: &str =
    "https://raw.githubusercontent.com/ttttdiva/autocircle/main/latest.json";

/// 更新チェック: latest.json をフェッチし、バージョン比較
#[tauri::command]
fn check_for_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTPクライアント作成失敗: {e}"))?;

    let resp = client
        .get(UPDATE_CHECK_URL)
        .send()
        .map_err(|e| format!("更新チェック失敗: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("更新チェック失敗: HTTP {}", resp.status()));
    }

    let latest: LatestJson = resp.json().map_err(|e| format!("JSONパース失敗: {e}"))?;

    let available =
        !latest.desktop.url.is_empty() && is_newer_version(current, &latest.desktop.version);

    let result = UpdateCheckResult {
        update_available: available,
        current_version: current.to_string(),
        latest_version: if available {
            Some(latest.desktop.version)
        } else {
            None
        },
        download_url: if available {
            Some(latest.desktop.url)
        } else {
            None
        },
        release_notes: if available && !latest.desktop.notes.is_empty() {
            Some(latest.desktop.notes)
        } else {
            None
        },
    };
    serde_json::to_value(&result).map_err(|e| format!("シリアライズ失敗: {e}"))
}

/// 更新ダウンロード: 新しい exe を .exe.new として保存
#[tauri::command]
fn download_update(window: tauri::Window, url: String) -> Result<Value, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("exe パス取得失敗: {e}"))?;
    let new_path = exe_path.with_extension("exe.new");

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTPクライアント作成失敗: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("ダウンロード失敗: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ダウンロード失敗: HTTP {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&new_path).map_err(|e| format!("ファイル作成失敗: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut buf = [0u8; 8192];
    let mut reader = BufReader::new(resp);
    let mut last_emit = Instant::now();

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("読み込みエラー: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("書き込みエラー: {e}"))?;
        downloaded += n as u64;

        // 100ms ごとに進捗を通知
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let progress = if total_size > 0 {
                (downloaded as f64 / total_size as f64 * 100.0) as u32
            } else {
                0
            };
            let _ = window.emit(
                "update-download-progress",
                json!({
                    "downloaded": downloaded,
                    "totalSize": total_size,
                    "progress": progress
                }),
            );
            last_emit = Instant::now();
        }
    }

    // 最終進捗を通知
    let _ = window.emit(
        "update-download-progress",
        json!({
            "downloaded": downloaded,
            "totalSize": total_size,
            "progress": 100
        }),
    );

    Ok(json!({
        "status": "ok",
        "path": new_path.display().to_string(),
        "size": downloaded
    }))
}

/// 更新適用: PowerShell スクリプトを生成・実行し、アプリ終了
#[tauri::command]
fn apply_update(app_handle: tauri::AppHandle) -> Result<Value, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("exe パス取得失敗: {e}"))?;
    let new_path = exe_path.with_extension("exe.new");

    if !new_path.exists() {
        return Err("更新ファイルが見つかりません".into());
    }

    let exe_dir = exe_path.parent().ok_or("exe ディレクトリ取得失敗")?;
    let script_path = exe_dir.join("_update.ps1");
    let pid = std::process::id();
    let exe_name = exe_path.file_name().unwrap_or_default().to_string_lossy();
    let bak_name = format!("{}.bak", exe_name);

    let script = format!(
        r#"# EventTrail Studio 自動更新スクリプト
$ErrorActionPreference = "Stop"
$exeDir = "{exe_dir}"
$exePath = Join-Path $exeDir "{exe_name}"
$newPath = Join-Path $exeDir "{exe_name}.new"
$bakPath = Join-Path $exeDir "{bak_name}"
$pid = {pid}

# 旧プロセス終了待ち (最大30秒)
$waited = 0
while ($waited -lt 30) {{
    try {{
        Get-Process -Id $pid -ErrorAction Stop | Out-Null
        Start-Sleep -Milliseconds 500
        $waited += 0.5
    }} catch {{
        break
    }}
}}
Start-Sleep -Seconds 1

# 旧バックアップがあれば削除
if (Test-Path $bakPath) {{
    Remove-Item $bakPath -Force
}}

# 旧 exe をバックアップにリネーム
try {{
    Rename-Item -Path $exePath -NewName "{bak_name}" -Force
}} catch {{
    exit 1
}}

# 新 exe を正式名にリネーム
try {{
    Rename-Item -Path $newPath -NewName "{exe_name}" -Force
}} catch {{
    # ロールバック
    Rename-Item -Path $bakPath -NewName "{exe_name}" -Force
    exit 1
}}

Start-Sleep -Seconds 1
Start-Process -FilePath $exePath

# スクリプト自己削除
Start-Sleep -Seconds 2
Remove-Item -Path $MyInvocation.MyCommand.Path -Force
"#,
        exe_dir = exe_dir.display(),
        exe_name = exe_name,
        bak_name = bak_name,
        pid = pid,
    );

    fs::write(&script_path, &script).map_err(|e| format!("更新スクリプト作成失敗: {e}"))?;

    // PowerShell をウィンドウなしで起動
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("powershell")
            .args([
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                &script_path.display().to_string(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("更新スクリプト実行失敗: {e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("自動更新は現在 Windows のみ対応しています".into());
    }

    app_handle.exit(0);

    #[allow(unreachable_code)]
    Ok(json!({"status": "ok"}))
}

/// 前回の更新で残った一時ファイルを削除
#[tauri::command]
fn cleanup_old_update() -> Result<Value, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("exe パス取得失敗: {e}"))?;
    let exe_dir = exe_path.parent().ok_or("exe ディレクトリ取得失敗")?;

    let targets = [
        exe_path.with_extension("exe.bak"),
        exe_path.with_extension("exe.new"),
        exe_dir.join("_update.ps1"),
    ];

    let mut cleaned = Vec::new();
    for path in &targets {
        if path.exists() {
            if fs::remove_file(path).is_ok() {
                cleaned.push(path.display().to_string());
            }
        }
    }

    Ok(json!({ "cleaned": cleaned }))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_python_bridge,
            load_desktop_config,
            save_desktop_config,
            load_env_keys,
            save_env_keys,
            load_project_config,
            save_project_config,
            list_model_catalog,
            copy_file_to_dir,
            copy_file_as,
            delete_file,
            download_image,
            save_image_bytes,
            append_log,
            list_map_images,
            list_event_map_images,
            start_file_server,
            stop_file_server,
            get_local_ip,
            search_past_participations,
            list_event_dirs,
            read_event_meta,
            write_event_meta,
            create_event_dir,
            delete_event_dir,
            rename_event_dir,
            import_result_zip,
            start_receive_server,
            stop_receive_server,
            register_default_cut,
            append_review_entry,
            open_file_default,
            check_for_update,
            download_update,
            apply_update,
            cleanup_old_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

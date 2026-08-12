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

fn absolute_project_root(project_root: &str) -> Result<PathBuf, String> {
    let input = if project_root.trim().is_empty() {
        Path::new(".")
    } else {
        Path::new(project_root)
    };
    let joined = if input.is_absolute() {
        input.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("current directory取得失敗: {e}"))?
            .join(input)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                normalized.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err("project rootがfilesystem root外を参照しています".to_string());
                }
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    if normalized.exists() {
        fs::canonicalize(&normalized).map_err(|e| {
            format!(
                "project root canonicalize失敗 {}: {e}",
                normalized.display()
            )
        })
    } else if normalized.is_absolute() {
        Ok(normalized)
    } else {
        Err("project rootをabsolute pathへ正規化できません".to_string())
    }
}

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
    #[serde(default = "default_ocr_model")]
    unlimited_ocr_model: String,
    #[serde(default)]
    unlimited_ocr_model_path: String,
    #[serde(default)]
    unlimited_ocr_venv: String,
    #[serde(default)]
    unlimited_ocr_hf_home: String,
    #[serde(default = "default_ocr_revision")]
    unlimited_ocr_revision: String,
    #[serde(default = "default_ocr_device")]
    unlimited_ocr_device: String,
    #[serde(default = "default_ocr_mode")]
    unlimited_ocr_mode: String,
    #[serde(default = "default_ocr_strategy")]
    unlimited_ocr_strategy: String,
}

fn default_ocr_model() -> String {
    "baidu/Unlimited-OCR".to_string()
}

fn default_ocr_revision() -> String {
    "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead".to_string()
}

fn default_ocr_device() -> String {
    "auto".to_string()
}

fn default_ocr_mode() -> String {
    "gundam".to_string()
}

fn default_ocr_strategy() -> String {
    "small_digits".to_string()
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
            unlimited_ocr_model: "baidu/Unlimited-OCR".to_string(),
            unlimited_ocr_model_path: String::new(),
            unlimited_ocr_venv: String::new(),
            unlimited_ocr_hf_home: String::new(),
            unlimited_ocr_revision:
                "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead".to_string(),
            unlimited_ocr_device: "auto".to_string(),
            unlimited_ocr_mode: "gundam".to_string(),
            unlimited_ocr_strategy: "small_digits".to_string(),
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
        // eventtrail_* の一時ファイル名は既存インストールとの互換性のため維持する。
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
    let _write_guard = circle_master_write_lock()
        .lock()
        .map_err(|e| format!("circle master書込ロック取得失敗: {e}"))?;
    let root = absolute_project_root(&project_root)?;
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
    // eventtrail_* のログ名は既存インストールとの互換性のため維持する。
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

        let result = list_event_map_images(dir.to_string_lossy().to_string(), None).unwrap();
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

    #[test]
    fn list_event_map_images_keeps_old_extension_orphan_but_returns_newest_active() {
        let dir =
            std::env::temp_dir().join(format!("eventtrail-map-active-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("maps")).unwrap();
        let old = dir.join("maps/map_01.jpg");
        let new = dir.join("maps/map_01.png");
        fs::write(&old, b"old jpg").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(&new, b"new png").unwrap();

        let result = list_event_map_images(dir.to_string_lossy().to_string(), None).unwrap();
        let maps = result["maps"].as_array().unwrap();
        assert_eq!(maps.len(), 1, "同じmap番号が複数activeになりました");
        assert_eq!(maps[0]["name"].as_str(), Some("map_01.png"));
        assert!(maps[0]["modified_ms"].as_u64().is_some());

        let preferred = list_event_map_images(
            dir.to_string_lossy().to_string(),
            Some(vec!["maps/map_01.jpg".to_string()]),
        )
        .unwrap();
        assert_eq!(
            preferred["maps"][0]["name"].as_str(),
            Some("map_01.jpg"),
            "明示preferred refがmtime選択より優先されませんでした"
        );
        assert!(old.exists(), "旧jpg孤児を物理削除しました");
        assert!(new.exists(), "新active pngが存在しません");

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
    fn received_import_stage_is_invisible_until_current_lease_publish() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eventtrail-staged-import-test-{}-{suffix}",
            std::process::id()
        ));
        let original = root.join("events/same_event_original");
        let duplicate = root.join("events/same_event_mobile");
        write_test_event(&original, "Same Event", "2026-05-24", "desktop_created");
        write_test_event(&duplicate, "Same Event", "2026-05-24", "mobile_import");
        let zip = root.join("received.zip");
        write_mobile_result_zip(&zip, "Same Event", "2026-05-24");

        let cancelled_id = format!("{}_{}", std::process::id(), suffix);
        let _cancelled_receiver = register_received_upload(&cancelled_id, zip.clone()).unwrap();
        claim_received_upload(cancelled_id.clone()).unwrap();
        let plan =
            plan_received_result_import(cancelled_id.clone(), root.to_string_lossy().to_string())
                .unwrap();
        assert_eq!(plan["affectedEvents"].as_array().unwrap().len(), 2);
        stage_received_result_import(
            cancelled_id.clone(),
            root.to_string_lossy().to_string(),
            "same_event_original".to_string(),
        )
        .unwrap();
        let before_publish = fs::read_to_string(original.join("event.json")).unwrap();
        assert!(duplicate.exists(), "stage中に重複live eventを削除しました");
        terminal_cancel_received_upload(&cancelled_id, "timeout");
        assert!(publish_received_result_import(cancelled_id).is_err());
        assert_eq!(
            fs::read_to_string(original.join("event.json")).unwrap(),
            before_publish,
            "timeout後のstageがlive eventを書き換えました"
        );
        assert!(
            duplicate.exists(),
            "timeout後に重複live eventを削除しました"
        );

        let cas_zip = root.join("received-cas.zip");
        fs::copy(&zip, &cas_zip).unwrap();
        let cas_id = format!("{}_{}_1", std::process::id(), suffix);
        let _cas_receiver = register_received_upload(&cas_id, cas_zip).unwrap();
        claim_received_upload(cas_id.clone()).unwrap();
        stage_received_result_import(
            cas_id.clone(),
            root.to_string_lossy().to_string(),
            "same_event_original".to_string(),
        )
        .unwrap();
        fs::write(original.join("concurrent-edit.txt"), b"newer").unwrap();
        assert!(publish_received_result_import(cas_id.clone()).is_err());
        assert_eq!(
            fs::read(original.join("concurrent-edit.txt")).unwrap(),
            b"newer",
            "preimage CAS不一致時に新しいlive編集をrollbackしました"
        );
        terminal_cancel_received_upload(&cas_id, "cas mismatch");
        fs::remove_file(original.join("concurrent-edit.txt")).unwrap();

        let retry_zip = root.join("received-retry.zip");
        fs::copy(&zip, &retry_zip).unwrap();
        let retry_id = format!("{}_{}_2", std::process::id(), suffix);
        let retry_receiver = register_received_upload(&retry_id, retry_zip.clone()).unwrap();
        claim_received_upload(retry_id.clone()).unwrap();
        stage_received_result_import(
            retry_id.clone(),
            root.to_string_lossy().to_string(),
            "same_event_original".to_string(),
        )
        .unwrap();
        publish_received_result_import(retry_id.clone()).unwrap();
        terminal_cancel_all_received_uploads("frontend reload failed then server stopped");
        assert!(
            cancel_received_upload(retry_id.clone(), Some("late UI failure".to_string()),).is_err()
        );
        ack_received_upload(retry_id.clone(), true, None).unwrap();
        ack_received_upload(retry_id.clone(), true, None).unwrap();
        assert!(wait_for_received_upload_ack(
            &retry_id,
            &retry_receiver,
            &AtomicBool::new(true),
            true,
        )
        .is_ok());
        let published: Value =
            serde_json::from_str(&fs::read_to_string(original.join("event.json")).unwrap())
                .unwrap();
        assert_eq!(published["metadata"]["source"], "mobile_import");
        assert!(!duplicate.exists(), "publish後も重複eventが残っています");
        assert!(
            !retry_zip.exists(),
            "success ack後もretry ZIPが残っています"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_rejects_parent_traversal_and_casefold_destination_collision() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eventtrail-malicious-import-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("circle_master.json"), b"live-master").unwrap();
        let event_json = json!({
            "event": {"name": "Malicious", "date": "2026-05-25"},
            "circles": [],
            "metadata": {}
        });
        let options = zip::write::FileOptions::default();

        let traversal = root.join("traversal.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&traversal).unwrap());
            zip.start_file("event.json", options).unwrap();
            zip.write_all(serde_json::to_string(&event_json).unwrap().as_bytes())
                .unwrap();
            zip.start_file("default_cuts/../circle_master.json", options)
                .unwrap();
            zip.write_all(b"attacker").unwrap();
            zip.finish().unwrap();
        }
        assert!(import_result_zip(
            traversal.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .is_err());
        assert_eq!(
            fs::read(root.join("circle_master.json")).unwrap(),
            b"live-master"
        );

        let collision = root.join("collision.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&collision).unwrap());
            zip.start_file("event.json", options).unwrap();
            zip.write_all(serde_json::to_string(&event_json).unwrap().as_bytes())
                .unwrap();
            zip.start_file("items/A.jpg", options).unwrap();
            zip.write_all(b"first").unwrap();
            zip.start_file("items/a.jpg", options).unwrap();
            zip.write_all(b"second").unwrap();
            zip.finish().unwrap();
        }
        assert!(import_result_zip(
            collision.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_failure_is_reported_instead_of_silently_succeeding() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eventtrail-rollback-fault-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("event");
        let backup = root.join("backup");
        fs::create_dir_all(&backup).unwrap();
        let mut journal = vec![PublishedImportPath {
            destination: destination.clone(),
            backup: Some(backup.clone()),
            installed: false,
        }];
        let error = rollback_published_paths_with(&mut journal, |_source, _destination| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "fault injection",
            ))
        })
        .unwrap_err();
        assert!(error.contains("backup復元失敗") && error.contains("fault injection"));
        assert!(
            backup.exists(),
            "rollback失敗時に唯一のbackupを削除しました"
        );
        let stage = root.join("stage");
        let recovery = root.join("recovery/tx");
        fs::create_dir_all(stage.join("publish-backup")).unwrap();
        fs::write(stage.join("publish-backup/sole-backup"), b"sole").unwrap();
        let manifest = PersistentPublishManifest {
            version: 1,
            phase: "publishing".to_string(),
            completed_operations: 1,
            operations: vec![PersistentPublishOperation {
                source: None,
                destination: PathBuf::from("events/live"),
                backup: PathBuf::from("publish-backup/sole-backup"),
                had_destination: true,
            }],
        };
        persist_publish_manifest(&stage.join("transaction.json"), &manifest).unwrap();
        let (preserved, mark_error) = preserve_failed_transaction_with(
            &stage,
            &recovery,
            |_path, _manifest| Err("fault injected manifest persist failure".to_string()),
            |_source, _destination| panic!("persist失敗後にrecovery moveしてはいけません"),
        );
        assert_eq!(preserved, stage);
        assert!(mark_error.unwrap().contains("fault injected"));
        assert_eq!(
            fs::read(stage.join("publish-backup/sole-backup")).unwrap(),
            b"sole",
            "double faultで唯一のbackupを削除しました"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn persistent_publish_manifest_recovers_crashes_at_each_rename_phase() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        for phase in ["prepared", "backed-up", "installed", "committed"] {
            let root = std::env::temp_dir().join(format!(
                "eventtrail-crash-recovery-test-{}-{suffix}-{phase}",
                std::process::id()
            ));
            let transaction = root.join(".eventtrail-import-stage/tx");
            let source = transaction.join("events/staged-event");
            let destination = root.join("events/live");
            let backup = transaction.join("publish-backup/live");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("event.json"), b"staged").unwrap();
            fs::create_dir_all(&destination).unwrap();
            fs::write(destination.join("event.json"), b"original").unwrap();
            let manifest = PersistentPublishManifest {
                version: 1,
                phase: if phase == "committed" {
                    "committed".to_string()
                } else {
                    "publishing".to_string()
                },
                completed_operations: 0,
                operations: vec![PersistentPublishOperation {
                    source: Some(PathBuf::from("events/staged-event")),
                    destination: PathBuf::from("events/live"),
                    backup: PathBuf::from("publish-backup/live"),
                    had_destination: true,
                }],
            };
            let manifest_path = transaction.join("transaction.json");
            persist_publish_manifest(&manifest_path, &manifest).unwrap();
            if phase != "prepared" {
                fs::create_dir_all(backup.parent().unwrap()).unwrap();
                fs::rename(&destination, &backup).unwrap();
            }
            if phase == "installed" || phase == "committed" {
                fs::create_dir_all(destination.parent().unwrap()).unwrap();
                fs::rename(&source, &destination).unwrap();
            }
            assert_eq!(recover_incomplete_import_transactions(&root).unwrap(), 1);
            assert_eq!(
                fs::read(destination.join("event.json")).unwrap(),
                if phase == "committed" {
                    b"staged".as_slice()
                } else {
                    b"original".as_slice()
                },
                "crash phase {phase}から決定的に復旧しませんでした"
            );
            assert!(
                !transaction.exists(),
                "復旧後もtransaction rootが残っています"
            );
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn relative_project_roots_work_for_mobile_import_and_recovery() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            absolute_project_root(".").unwrap(),
            fs::canonicalize(&cwd).unwrap()
        );
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = cwd.join("target").join(format!(
            "relative-project-root-test-{}-{suffix}",
            std::process::id()
        ));
        let relative_root = root
            .strip_prefix(&cwd)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let missing_relative = format!(
            "target/missing-project-root-{}-{suffix}",
            std::process::id()
        );
        let missing_absolute = absolute_project_root(&missing_relative).unwrap();
        assert!(missing_absolute.is_absolute() && !missing_absolute.exists());
        assert_eq!(
            list_event_dirs(missing_relative).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            0,
            "missing relative rootの従来empty behaviorを維持していません"
        );
        assert!(
            !missing_absolute.exists(),
            "listがmissing project rootを作成しました"
        );
        fs::create_dir_all(&root).unwrap();
        let zip = root.join("relative.zip");
        write_mobile_result_zip(&zip, "Relative Event", "2026-05-24");
        let upload_id = format!("{}_{}_7", std::process::id(), suffix);
        let receiver = register_received_upload(&upload_id, zip.clone()).unwrap();
        claim_received_upload(upload_id.clone()).unwrap();
        let plan = plan_received_result_import(upload_id.clone(), relative_root.clone()).unwrap();
        stage_received_result_import(
            upload_id.clone(),
            relative_root.clone(),
            plan["slug"].as_str().unwrap().to_string(),
        )
        .unwrap();
        let published = publish_received_result_import(upload_id.clone()).unwrap();
        assert!(Path::new(published["dir"].as_str().unwrap()).is_absolute());
        assert!(
            wait_for_received_upload_ack(&upload_id, &receiver, &AtomicBool::new(true), true,)
                .is_ok()
        );

        let transaction = root.join(".eventtrail-import-stage/recover-relative");
        let source = transaction.join("events/staged");
        let destination = root.join("events/recover-live");
        let backup = transaction.join("publish-backup/live");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("event.json"), b"staged").unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("event.json"), b"original").unwrap();
        let manifest = PersistentPublishManifest {
            version: 1,
            phase: "publishing".to_string(),
            completed_operations: 0,
            operations: vec![PersistentPublishOperation {
                source: Some(PathBuf::from("events/staged")),
                destination: PathBuf::from("events/recover-live"),
                backup: PathBuf::from("publish-backup/live"),
                had_destination: true,
            }],
        };
        persist_publish_manifest(&transaction.join("transaction.json"), &manifest).unwrap();
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        durable_rename(&destination, &backup).unwrap();
        durable_rename(&source, &destination).unwrap();
        list_event_dirs(relative_root).unwrap();
        assert_eq!(
            fs::read(destination.join("event.json")).unwrap(),
            b"original"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recovery_rejects_absolute_parent_and_project_escape_manifest_paths() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eventtrail-malicious-manifest-test-{}-{suffix}",
            std::process::id()
        ));
        let transaction = root.join(".eventtrail-import-stage/evil");
        fs::create_dir_all(&transaction).unwrap();
        let victim = root.with_extension("victim");
        fs::write(&victim, b"keep").unwrap();
        for (index, operation) in [
            PersistentPublishOperation {
                source: None,
                destination: victim.clone(),
                backup: PathBuf::from("publish-backup/victim"),
                had_destination: true,
            },
            PersistentPublishOperation {
                source: Some(PathBuf::from("../escape")),
                destination: PathBuf::from("events/live"),
                backup: PathBuf::from("../../victim"),
                had_destination: true,
            },
            PersistentPublishOperation {
                source: None,
                destination: PathBuf::from("settings.json"),
                backup: PathBuf::from("publish-backup/settings"),
                had_destination: true,
            },
        ]
        .into_iter()
        .enumerate()
        {
            let manifest = PersistentPublishManifest {
                version: 1,
                phase: "publishing".to_string(),
                completed_operations: 0,
                operations: vec![operation],
            };
            persist_publish_manifest(&transaction.join("transaction.json"), &manifest).unwrap();
            assert!(
                recover_incomplete_import_transactions(&root).is_err(),
                "malicious manifest #{index}を受理しました"
            );
            assert_eq!(fs::read(&victim).unwrap(), b"keep");
        }
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&victim);
    }

    #[test]
    fn default_cut_write_and_import_publish_share_circle_master_lock() {
        let guard = circle_master_write_lock().lock().unwrap();
        let entered = Arc::new(AtomicBool::new(false));
        let entered_worker = entered.clone();
        let worker = thread::spawn(move || {
            let _guard = circle_master_write_lock().lock().unwrap();
            entered_worker.store(true, Ordering::SeqCst);
        });
        thread::sleep(Duration::from_millis(20));
        assert!(
            !entered.load(Ordering::SeqCst),
            "circle master mutationがimport publish lockを迂回しました"
        );
        drop(guard);
        worker.join().unwrap();
        assert!(entered.load(Ordering::SeqCst));
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

    #[test]
    fn received_upload_payload_defers_import_to_frontend() {
        let payload = received_upload_payload("upload-1", "C:/temp/result.zip", 42);
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["uploadId"], "upload-1");
        assert_eq!(payload["zipPath"], "C:/temp/result.zip");
        assert_eq!(payload["size"], 42);
        assert!(payload.get("importResult").is_none());
        assert!(payload.get("projectRoot").is_none());
    }

    #[test]
    fn write_event_meta_does_not_recreate_missing_event_directory() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-missing-meta-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        assert!(write_event_meta(
            root.to_string_lossy().to_string(),
            json!({"name": "late blur"}),
        )
        .is_err());
        assert!(
            !root.exists(),
            "late metadata writeが削除済みdirを再作成しました"
        );
    }

    #[test]
    fn received_upload_ack_success_deletes_zip_and_failure_retains_it() {
        let root =
            std::env::temp_dir().join(format!("eventtrail-upload-ack-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let success_zip = root.join("success.zip");
        fs::write(&success_zip, b"zip").unwrap();
        let success_id = format!("ack-success-{}", std::process::id());
        let success_receiver = register_received_upload(&success_id, success_zip.clone()).unwrap();
        claim_received_upload(success_id.clone()).unwrap();
        heartbeat_received_upload(success_id.clone()).unwrap();
        ack_received_upload(success_id.clone(), true, None).unwrap();
        assert!(wait_for_received_upload_ack(
            &success_id,
            &success_receiver,
            &AtomicBool::new(true),
            true,
        )
        .is_ok());
        assert!(
            !success_zip.exists(),
            "success ack後もtemp ZIPが残っています"
        );

        let failure_zip = root.join("failure.zip");
        fs::write(&failure_zip, b"zip").unwrap();
        let failure_id = format!("ack-failure-{}", std::process::id());
        let failure_receiver = register_received_upload(&failure_id, failure_zip.clone()).unwrap();
        claim_received_upload(failure_id.clone()).unwrap();
        assert!(
            cancel_received_upload(failure_id.clone(), Some("import failed".to_string())).is_err()
        );
        let failure = wait_for_received_upload_ack(
            &failure_id,
            &failure_receiver,
            &AtomicBool::new(true),
            true,
        )
        .unwrap_err();
        assert!(!failure.1 && failure.0 == "import failed");
        assert!(
            failure_zip.exists(),
            "failure ackでretry用ZIPを削除しました"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn received_upload_without_listener_or_ack_times_out_and_retains_zip() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-upload-timeout-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let listener_zip = root.join("listener.zip");
        fs::write(&listener_zip, b"listener retry").unwrap();
        let listener_id = format!("ack-listener-{}", std::process::id());
        let listener_receiver = register_received_upload_with_timeout(
            &listener_id,
            listener_zip.clone(),
            Duration::from_millis(10),
        )
        .unwrap();
        let running = AtomicBool::new(true);
        let listener_error =
            wait_for_received_upload_ack(&listener_id, &listener_receiver, &running, false)
                .unwrap_err();
        assert!(!listener_error.1 && listener_error.0.contains("listener"));

        let zip = root.join("timeout.zip");
        fs::write(&zip, b"retry").unwrap();
        let upload_id = format!("ack-timeout-{}", std::process::id());
        let receiver = register_received_upload_with_timeout(
            &upload_id,
            zip.clone(),
            Duration::from_millis(10),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(12));
        let timeout_error =
            wait_for_received_upload_ack(&upload_id, &receiver, &running, true).unwrap_err();
        assert!(timeout_error.1 && timeout_error.0.contains("タイムアウト"));
        assert!(
            heartbeat_received_upload(upload_id.clone()).is_err(),
            "timeout後も旧upload leaseがcurrentです"
        );
        let retry_receiver = register_received_upload(&upload_id, zip.clone()).unwrap();
        claim_received_upload(upload_id.clone()).unwrap();
        assert!(cancel_received_upload(
            upload_id.clone(),
            Some("retry fixture cleanup".to_string()),
        )
        .is_err());
        let retry_error =
            wait_for_received_upload_ack(&upload_id, &retry_receiver, &running, true).unwrap_err();
        assert_eq!(retry_error.0, "retry fixture cleanup");
        assert!(
            zip.exists(),
            "listenerなし/timeoutでretry用ZIPを削除しました"
        );
        assert!(
            listener_zip.exists(),
            "listenerなしでretry用ZIPを削除しました"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn premature_or_expired_ack_keeps_pending_stage_for_terminal_cleanup() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eventtrail-invalid-ack-test-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let zip = root.join("pending.zip");
        fs::write(&zip, b"zip").unwrap();
        let stage_root = root.join("stage");
        fs::create_dir_all(&stage_root).unwrap();
        let id = format!("{}_{}_9", std::process::id(), suffix);
        let _receiver = register_received_upload(&id, zip).unwrap();
        claim_received_upload(id.clone()).unwrap();
        pending_received_uploads()
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .import_stage = Some(ReceivedImportStage {
            stage_root: stage_root.clone(),
            project_root: root.clone(),
            plan: ReceivedImportPlan {
                slug: "fixture".to_string(),
                event_dir: root.join("events/fixture"),
                event_name: "fixture".to_string(),
                event_date: None,
                redundant_events: Vec::new(),
            },
            live_preimages: Vec::new(),
        });
        assert!(ack_received_upload(id.clone(), true, None).is_err());
        assert!(pending_received_uploads().lock().unwrap().contains_key(&id));
        assert!(stage_root.exists(), "premature ackがstageを孤児化しました");
        pending_received_uploads()
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .lease_deadline = Instant::now();
        assert!(ack_received_upload(id.clone(), false, None).is_err());
        assert!(pending_received_uploads().lock().unwrap().contains_key(&id));
        terminal_cancel_received_upload(&id, "expired cleanup");
        assert!(
            !stage_root.exists(),
            "terminal cancelがinvalid ack後のstageをcleanupしませんでした"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_received_upload_cleanup_is_scoped_and_handles_multiple_files() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-upload-cleanup-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let stale_a = root.join("eventtrail_received_a.zip");
        let stale_b = root.join("eventtrail_received_b.zip");
        let unrelated = root.join("keep.zip");
        fs::write(&stale_a, b"a").unwrap();
        fs::write(&stale_b, b"b").unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        let removed_recent = cleanup_stale_received_uploads(&root, std::time::SystemTime::now());
        assert_eq!(removed_recent, 0, "期限前の受信ZIPを削除しました");
        let future =
            std::time::SystemTime::now() + RECEIVED_UPLOAD_STALE_AGE + Duration::from_secs(1);
        let removed = cleanup_stale_received_uploads(&root, future);
        assert_eq!(removed, 2, "複数stale ZIPを安全にcleanupできませんでした");
        assert!(!stale_a.exists() && !stale_b.exists());
        assert!(unrelated.exists(), "命名規則外のZIPを削除しました");
        let _ = fs::remove_dir_all(&root);
    }
}

#[tauri::command]
fn list_event_dirs(project_root: String) -> Result<Value, String> {
    let project_root = absolute_project_root(&project_root)?;
    let _recovery_guard = circle_master_write_lock()
        .lock()
        .map_err(|e| format!("import recoveryロック取得失敗: {e}"))?;
    recover_incomplete_import_transactions(&project_root)?;
    let events_dir = project_root.join("events");
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
    if !dir.is_dir() {
        return Err("イベントディレクトリが存在しません".to_string());
    }
    let ej_path = dir.join("event.json");
    if !ej_path.is_file() {
        return Err("event.jsonが存在しません".to_string());
    }

    let text = fs::read_to_string(&ej_path).map_err(|e| format!("event.json読み込み失敗: {e}"))?;
    let mut full: Value =
        serde_json::from_str(&text).map_err(|e| format!("event.json解析失敗: {e}"))?;

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
fn list_event_map_images(
    event_dir: String,
    preferred_refs: Option<Vec<String>>,
) -> Result<Value, String> {
    let dir = PathBuf::from(&event_dir);
    let preferred_names: HashSet<String> = preferred_refs
        .unwrap_or_default()
        .into_iter()
        .filter_map(|reference| {
            let components: Vec<String> = reference
                .replace('\\', "/")
                .split('/')
                .filter(|component| !component.is_empty() && *component != ".")
                .map(|component| component.to_ascii_lowercase())
                .collect();
            if components.is_empty() || components.iter().any(|component| component == "..") {
                None
            } else {
                Some(components.join("/"))
            }
        })
        .collect();
    // 同じmap番号の孤児ファイルが複数extensionで残っていても、最新mtimeの
    // 1件だけをactiveとして返す。明示preferredを最優先し、物理ファイル自体は保持する。
    let mut active_by_number: HashMap<u32, (bool, std::time::SystemTime, bool, String, PathBuf)> =
        HashMap::new();
    let mut scan_dir = |scan_path: PathBuf, preferred_dir: bool| {
        if scan_path.exists() {
            if let Ok(entries) = fs::read_dir(&scan_path) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lower = name.to_ascii_lowercase();
                    if !lower.starts_with("map_")
                        || !(lower.ends_with(".jpg")
                            || lower.ends_with(".jpeg")
                            || lower.ends_with(".png")
                            || lower.ends_with(".webp"))
                    {
                        continue;
                    }
                    let Some(number) = lower
                        .strip_prefix("map_")
                        .and_then(|tail| tail.split('.').next())
                        .and_then(|digits| digits.parse::<u32>().ok())
                    else {
                        continue;
                    };
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    let reference = if preferred_dir {
                        format!("maps/{lower}")
                    } else {
                        lower.clone()
                    };
                    let explicitly_preferred = preferred_names.contains(&reference);
                    let replace = active_by_number.get(&number).map_or(true, |current| {
                        explicitly_preferred > current.0
                            || (explicitly_preferred == current.0
                                && (modified > current.1
                                    || (modified == current.1
                                        && (preferred_dir > current.2
                                            || (preferred_dir == current.2
                                                && name.as_str() > current.3.as_str())))))
                    });
                    if replace {
                        active_by_number.insert(
                            number,
                            (
                                explicitly_preferred,
                                modified,
                                preferred_dir,
                                name,
                                entry.path(),
                            ),
                        );
                    }
                }
            }
        }
    };
    scan_dir(dir.clone(), false);
    scan_dir(dir.join("maps"), true);
    let mut active: Vec<(u32, std::time::SystemTime, String, PathBuf)> = active_by_number
        .into_iter()
        .map(|(number, (_, modified, _, name, path))| (number, modified, name, path))
        .collect();
    active.sort_by_key(|entry| entry.0);
    let maps: Vec<Value> = active
        .into_iter()
        .map(|(_, modified, name, path)| {
            let modified_ms = modified
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            json!({
                "name": name,
                "path": path.to_string_lossy().to_string().replace("\\", "/"),
                "modified_ms": modified_ms
            })
        })
        .collect();
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

fn redundant_mobile_import_dirs(
    project_root: &Path,
    event_name: &str,
    event_date: Option<&str>,
    keep_slug: &str,
) -> Vec<(String, PathBuf)> {
    let events_dir = project_root.join("events");
    let mut remove_targets: Vec<(String, PathBuf)> = Vec::new();
    let entries = match fs::read_dir(&events_dir) {
        Ok(entries) => entries,
        Err(_) => return remove_targets,
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
            remove_targets.push((slug, entry.path()));
        }
    }

    remove_targets
}

fn remove_redundant_mobile_import_dirs(
    project_root: &Path,
    event_name: &str,
    event_date: Option<&str>,
    keep_slug: &str,
) -> Result<usize, String> {
    let remove_targets =
        redundant_mobile_import_dirs(project_root, event_name, event_date, keep_slug);

    let removed = remove_targets.len();
    for (_, path) in remove_targets {
        fs::remove_dir_all(&path).map_err(|e| {
            format!(
                "重複モバイル受信イベントの削除失敗: {}: {e}",
                path.display()
            )
        })?;
    }
    Ok(removed)
}

fn strict_archive_relative_path(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.ends_with('/') {
        return None;
    }
    let mut output = PathBuf::new();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains(':')
        {
            return None;
        }
        output.push(component);
    }
    (!output.as_os_str().is_empty()).then_some(output)
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

#[derive(Clone, Debug)]
struct ReceivedImportPlan {
    slug: String,
    event_dir: PathBuf,
    event_name: String,
    event_date: Option<String>,
    redundant_events: Vec<(String, PathBuf)>,
}

fn read_import_event_data(zip_path: &Path) -> Result<Value, String> {
    let zip_file = fs::File::open(zip_path).map_err(|e| format!("ZIPファイル読み込み失敗: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP展開失敗: {e}"))?;
    let mut file = archive
        .by_name("event.json")
        .map_err(|e| format!("event.jsonが見つかりません: {e}"))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("event.json読み込み失敗: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("event.json解析失敗: {e}"))
}

fn plan_received_import(
    zip_path: &Path,
    project_root: &Path,
) -> Result<ReceivedImportPlan, String> {
    let event_data = read_import_event_data(zip_path)?;
    let event_obj = event_data.get("event").unwrap_or(&Value::Null);
    let event_name = event_field_string(event_obj, "name").unwrap_or_else(|| "unknown".to_string());
    let event_date = normalized_event_date(event_obj);
    let (slug, event_dir) = if let Some((slug, dir)) =
        find_existing_event_dir(project_root, &event_name, event_date.as_deref())
    {
        (slug, dir)
    } else {
        let now = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let safe_name = sanitize_event_slug_name(&event_name);
        let slug = format!("{}_{}", safe_name, now);
        let dir = project_root.join("events").join(&slug);
        (slug, dir)
    };
    let redundant_events =
        redundant_mobile_import_dirs(project_root, &event_name, event_date.as_deref(), &slug);
    Ok(ReceivedImportPlan {
        slug,
        event_dir,
        event_name,
        event_date,
        redundant_events,
    })
}

fn import_result_zip_into_root(
    zip_path: String,
    project_root: String,
    forced_slug: Option<String>,
) -> Result<Value, String> {
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
    let project_root_path = absolute_project_root(&project_root)?;
    let event_obj = event_data.get("event").unwrap_or(&Value::Null);
    let event_name = event_field_string(event_obj, "name").unwrap_or_else(|| "unknown".to_string());
    let event_date = normalized_event_date(event_obj);
    let (slug, event_dir) = if let Some(slug) = forced_slug {
        let dir = project_root_path.join("events").join(&slug);
        (slug, dir)
    } else if let Some((slug, dir)) =
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
    let mut extracted_destinations: HashSet<String> = HashSet::new();

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
        let enclosed_name = strict_archive_relative_path(&name)
            .ok_or_else(|| format!("安全でないZIP entry pathです: {name}"))?;
        let identity = enclosed_name
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        if !extracted_destinations.insert(identity) {
            return Err(format!("ZIP entryの保存先が重複しています: {name}"));
        }
        let is_default_cut =
            enclosed_name
                .components()
                .next()
                .and_then(|component| match component {
                    std::path::Component::Normal(part) => part.to_str(),
                    _ => None,
                })
                == Some("default_cuts");
        let dest_path = if is_default_cut {
            project_root_path.join(&enclosed_name)
        } else {
            event_dir.join(&enclosed_name)
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
        let enclosed_name = strict_archive_relative_path(&logical_name)
            .ok_or_else(|| format!("安全でないasset logical pathです: {logical_name}"))?;
        strict_archive_relative_path(&asset_name)
            .ok_or_else(|| format!("安全でないasset archive pathです: {asset_name}"))?;
        let identity = enclosed_name
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        if !extracted_destinations.insert(identity) {
            return Err(format!(
                "asset manifestの保存先が重複しています: {logical_name}"
            ));
        }
        let mut file = archive
            .by_name(&asset_name)
            .map_err(|e| format!("asset manifest entry読み込み失敗 {asset_name}: {e}"))?;
        if file.name().ends_with('/') {
            continue;
        }
        let is_default_cut =
            enclosed_name
                .components()
                .next()
                .and_then(|component| match component {
                    std::path::Component::Normal(part) => part.to_str(),
                    _ => None,
                })
                == Some("default_cuts");
        let dest_path = if is_default_cut {
            project_root_path.join(&enclosed_name)
        } else {
            event_dir.join(&enclosed_name)
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

#[cfg(test)]
fn import_result_zip(zip_path: String, project_root: String) -> Result<Value, String> {
    import_result_zip_into_root(zip_path, project_root, None)
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

#[derive(Debug)]
enum ReceivedUploadAck {
    Success,
    Failure(String),
}

struct PendingReceivedUpload {
    sender: std::sync::mpsc::SyncSender<ReceivedUploadAck>,
    zip_path: PathBuf,
    claimed: bool,
    lease_deadline: Instant,
    import_stage: Option<ReceivedImportStage>,
    recovery_required: bool,
    published: bool,
}

#[derive(Clone, Debug)]
struct ReceivedImportStage {
    stage_root: PathBuf,
    project_root: PathBuf,
    plan: ReceivedImportPlan,
    live_preimages: Vec<(PathBuf, Option<u64>)>,
}

struct RemoveDirOnDrop {
    path: PathBuf,
    armed: bool,
}

impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

const RECEIVED_UPLOAD_LEASE_DURATION: Duration = Duration::from_secs(120);

fn pending_received_uploads() -> &'static Mutex<HashMap<String, PendingReceivedUpload>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingReceivedUpload>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn published_received_uploads() -> &'static Mutex<HashSet<String>> {
    static PUBLISHED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PUBLISHED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn circle_master_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn register_received_upload_with_timeout(
    upload_id: &str,
    zip_path: PathBuf,
    timeout: Duration,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信ackロック取得失敗: {e}"))?;
    if pending.contains_key(upload_id) {
        return Err("同じuploadIdが既に待機中です".to_string());
    }
    pending.insert(
        upload_id.to_string(),
        PendingReceivedUpload {
            sender,
            zip_path,
            claimed: false,
            lease_deadline: Instant::now() + timeout,
            import_stage: None,
            recovery_required: false,
            published: false,
        },
    );
    Ok(receiver)
}

fn register_received_upload(
    upload_id: &str,
    zip_path: PathBuf,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout(upload_id, zip_path, RECEIVED_UPLOAD_LEASE_DURATION)
}

#[tauri::command]
fn claim_received_upload(upload_id: String) -> Result<Value, String> {
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信claimロック取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "claim対象のuploadIdは期限切れまたは取消済みです".to_string())?;
    if Instant::now() >= upload.lease_deadline {
        return Err("upload leaseは期限切れです".to_string());
    }
    if upload.claimed {
        return Err("uploadは既にclaim済みです".to_string());
    }
    upload.claimed = true;
    upload.lease_deadline = Instant::now() + RECEIVED_UPLOAD_LEASE_DURATION;
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn heartbeat_received_upload(upload_id: String) -> Result<Value, String> {
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信leaseロック取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    upload.lease_deadline = Instant::now() + RECEIVED_UPLOAD_LEASE_DURATION;
    Ok(json!({"status": "ok"}))
}

fn current_received_upload_zip(upload_id: &str) -> Result<PathBuf, String> {
    let pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信leaseロック取得失敗: {e}"))?;
    let upload = pending
        .get(upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    Ok(upload.zip_path.clone())
}

fn copy_directory_without_links(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("stage directory作成失敗: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("stage source読込失敗: {e}"))? {
        let entry = entry.map_err(|e| format!("stage entry読込失敗: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("stage entry種別取得失敗: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "stage対象にsymlinkを含められません: {}",
                entry.path().display()
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory_without_links(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|e| format!("stage file copy失敗: {e}"))?;
        }
    }
    Ok(())
}

fn path_content_fingerprint(path: &Path) -> Result<Option<u64>, String> {
    use std::hash::{Hash, Hasher};
    if !path.exists() {
        return Ok(None);
    }
    fn hash_path(
        path: &Path,
        relative: &Path,
        hasher: &mut std::collections::hash_map::DefaultHasher,
    ) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|e| format!("preimage metadata取得失敗 {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "preimageにsymlinkを含められません: {}",
                path.display()
            ));
        }
        relative.to_string_lossy().replace('\\', "/").hash(hasher);
        if metadata.is_dir() {
            1u8.hash(hasher);
            let mut entries = fs::read_dir(path)
                .map_err(|e| format!("preimage directory読込失敗 {}: {e}", path.display()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("preimage entry読込失敗: {e}"))?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                hash_path(&entry.path(), &relative.join(entry.file_name()), hasher)?;
            }
        } else if metadata.is_file() {
            2u8.hash(hasher);
            fs::read(path)
                .map_err(|e| format!("preimage file読込失敗 {}: {e}", path.display()))?
                .hash(hasher);
        } else {
            return Err(format!("preimage対象種別が不正です: {}", path.display()));
        }
        Ok(())
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hash_path(path, Path::new(""), &mut hasher)?;
    Ok(Some(hasher.finish()))
}

fn received_import_plan_value(plan: &ReceivedImportPlan) -> Value {
    let mut affected = vec![json!({
        "slug": plan.slug,
        "dir": plan.event_dir.to_string_lossy().to_string().replace("\\", "/"),
        "survives": true,
    })];
    affected.extend(plan.redundant_events.iter().map(|(slug, dir)| {
        json!({
            "slug": slug,
            "dir": dir.to_string_lossy().to_string().replace("\\", "/"),
            "survives": false,
        })
    }));
    json!({
        "status": "ok",
        "slug": plan.slug,
        "dir": plan.event_dir.to_string_lossy().to_string().replace("\\", "/"),
        "affectedEvents": affected,
    })
}

#[tauri::command]
fn plan_received_result_import(upload_id: String, project_root: String) -> Result<Value, String> {
    let zip_path = current_received_upload_zip(&upload_id)?;
    let project_root = absolute_project_root(&project_root)?;
    let plan = plan_received_import(&zip_path, &project_root)?;
    current_received_upload_zip(&upload_id)?;
    Ok(received_import_plan_value(&plan))
}

#[tauri::command]
fn stage_received_result_import(
    upload_id: String,
    project_root: String,
    expected_slug: String,
) -> Result<Value, String> {
    if !upload_id
        .chars()
        .all(|character| character.is_ascii_digit() || character == '_' || character == '-')
    {
        return Err("uploadIdが不正です".to_string());
    }
    let zip_path = current_received_upload_zip(&upload_id)?;
    let project_root_path = absolute_project_root(&project_root)?;
    let plan = plan_received_import(&zip_path, &project_root_path)?;
    if plan.slug != expected_slug {
        return Err("import planが変更されました".to_string());
    }
    let stage_root = project_root_path
        .join(".eventtrail-import-stage")
        .join(&upload_id);
    let _ = fs::remove_dir_all(&stage_root);
    let mut cleanup = RemoveDirOnDrop {
        path: stage_root.clone(),
        armed: true,
    };
    fs::create_dir_all(stage_root.join("events"))
        .map_err(|e| format!("import stage作成失敗: {e}"))?;
    let mut live_preimages = vec![
        (
            plan.event_dir.clone(),
            path_content_fingerprint(&plan.event_dir)?,
        ),
        (
            project_root_path.join("circle_master.json"),
            path_content_fingerprint(&project_root_path.join("circle_master.json"))?,
        ),
    ];
    for (_, redundant) in &plan.redundant_events {
        live_preimages.push((redundant.clone(), path_content_fingerprint(redundant)?));
    }
    if plan.event_dir.is_dir() {
        copy_directory_without_links(&plan.event_dir, &stage_root.join("events").join(&plan.slug))?;
    }
    let circle_master = project_root_path.join("circle_master.json");
    if circle_master.is_file() {
        fs::copy(&circle_master, stage_root.join("circle_master.json"))
            .map_err(|e| format!("circle_master stage copy失敗: {e}"))?;
    }
    let staged = import_result_zip_into_root(
        zip_path.to_string_lossy().to_string(),
        stage_root.to_string_lossy().to_string(),
        Some(plan.slug.clone()),
    );
    let result = staged?;
    let staged_cuts = stage_root.join("default_cuts");
    for relative in staged_files(&staged_cuts)? {
        let live = project_root_path.join("default_cuts").join(relative);
        live_preimages.push((live.clone(), path_content_fingerprint(&live)?));
    }
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信stageロック取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    upload.import_stage = Some(ReceivedImportStage {
        stage_root: stage_root.clone(),
        project_root: project_root_path,
        plan: plan.clone(),
        live_preimages,
    });
    cleanup.armed = false;
    let mut response = received_import_plan_value(&plan);
    response["meta"] = result.get("meta").cloned().unwrap_or(json!({}));
    response["circle_master_merged"] = result
        .get("circle_master_merged")
        .cloned()
        .unwrap_or(json!(false));
    Ok(response)
}

#[derive(Debug)]
struct PublishedImportPath {
    destination: PathBuf,
    backup: Option<PathBuf>,
    installed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistentPublishOperation {
    source: Option<PathBuf>,
    destination: PathBuf,
    backup: PathBuf,
    had_destination: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistentPublishManifest {
    version: u32,
    phase: String,
    completed_operations: usize,
    operations: Vec<PersistentPublishOperation>,
}

fn path_has_parent_or_curdir(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        )
    })
}

fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

fn validate_contained_path(path: &Path, root: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() || path_has_parent_or_curdir(path) || !path.starts_with(root) {
        return Err(format!("{label}が許可root外です: {}", path.display()));
    }
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|e| format!("{label} root metadata取得失敗 {}: {e}", root.display()))?;
    if metadata_is_link_or_reparse(&root_metadata) {
        return Err(format!(
            "{label} rootがlink/reparseです: {}",
            root.display()
        ));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("{label} root canonicalize失敗 {}: {e}", root.display()))?;
    let mut current = root.to_path_buf();
    for component in path
        .strip_prefix(root)
        .unwrap_or(Path::new(""))
        .components()
    {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata_is_link_or_reparse(&metadata) {
                    return Err(format!(
                        "{label}にlink/reparseを含みます: {}",
                        current.display()
                    ));
                }
                let canonical = fs::canonicalize(&current)
                    .map_err(|e| format!("{label} canonicalize失敗 {}: {e}", current.display()))?;
                if !canonical.starts_with(&canonical_root) {
                    return Err(format!(
                        "{label} canonical pathがroot外です: {}",
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("{label} metadata取得失敗: {error}")),
        }
    }
    Ok(())
}

fn validate_publish_manifest_paths(
    project_root: &Path,
    transaction_root: &Path,
    manifest: &PersistentPublishManifest,
) -> Result<(), String> {
    validate_contained_path(
        transaction_root,
        &project_root.join(".eventtrail-import-stage"),
        "transaction root",
    )
    .or_else(|_| {
        validate_contained_path(
            transaction_root,
            &project_root.join(".eventtrail-import-recovery"),
            "transaction recovery root",
        )
    })?;
    for operation in &manifest.operations {
        resolve_manifest_operation(project_root, transaction_root, operation)?;
    }
    Ok(())
}

fn safe_manifest_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn resolve_manifest_operation(
    project_root: &Path,
    transaction_root: &Path,
    operation: &PersistentPublishOperation,
) -> Result<(Option<PathBuf>, PathBuf, PathBuf), String> {
    if !safe_manifest_relative(&operation.destination)
        || !safe_manifest_relative(&operation.backup)
        || operation
            .source
            .as_deref()
            .is_some_and(|source| !safe_manifest_relative(source))
    {
        return Err("transaction manifestにunsafe/absolute pathが含まれます".to_string());
    }
    let first_destination = operation.destination.components().next();
    let destination_depth = operation.destination.components().count();
    let destination_allowed = operation.destination == Path::new("circle_master.json")
        || (destination_depth > 1
            && matches!(first_destination, Some(std::path::Component::Normal(part)) if part == "events" || part == "default_cuts"));
    if !destination_allowed {
        return Err(format!(
            "manifest destinationが許可対象外です: {}",
            operation.destination.display()
        ));
    }
    if !operation.backup.starts_with("publish-backup") || operation.backup.components().count() < 2
    {
        return Err("manifest backupがpublish-backup外です".to_string());
    }
    if let Some(source) = &operation.source {
        let first = source.components().next();
        let allowed = source == Path::new("circle_master.json")
            || (source.components().count() > 1
                && matches!(first, Some(std::path::Component::Normal(part)) if part == "events" || part == "default_cuts"));
        if !allowed {
            return Err("manifest sourceがstaged asset root外です".to_string());
        }
    }
    let source = operation
        .source
        .as_ref()
        .map(|path| transaction_root.join(path));
    let destination = project_root.join(&operation.destination);
    let backup = transaction_root.join(&operation.backup);
    if let Some(source) = &source {
        validate_contained_path(source, transaction_root, "manifest source")?;
    }
    validate_contained_path(&backup, transaction_root, "manifest backup")?;
    validate_contained_path(&destination, project_root, "manifest destination")?;
    Ok((source, destination, backup))
}

fn sync_path_tree(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("durable sync metadata失敗 {}: {e}", path.display()))?;
    if metadata_is_link_or_reparse(&metadata) {
        return Err(format!(
            "durable sync対象にlink/reparseを含みます: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| format!("durable sync dir失敗: {e}"))? {
            sync_path_tree(
                &entry
                    .map_err(|e| format!("durable sync entry失敗: {e}"))?
                    .path(),
            )?;
        }
        #[cfg(not(target_os = "windows"))]
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("durable sync directory失敗 {}: {e}", path.display()))?;
    } else if metadata.is_file() {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("durable sync file失敗 {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn durable_rename(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "durable rename失敗: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn durable_rename(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| format!("durable rename失敗: {e}"))?;
    if let Some(parent) = destination.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("durable rename parent sync失敗: {e}"))?;
    }
    Ok(())
}

fn persist_publish_manifest(
    path: &Path,
    manifest: &PersistentPublishManifest,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("transaction manifest directory作成失敗: {e}"))?;
    }
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("transaction manifest serialize失敗: {e}"))?;
    let mut file =
        fs::File::create(&temporary).map_err(|e| format!("transaction manifest作成失敗: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("transaction manifest書込失敗: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("transaction manifest fsync失敗: {e}"))?;
    durable_rename(&temporary, path)
        .map_err(|e| format!("transaction manifest publish失敗: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("transaction manifest directory fsync失敗: {e}"))?;
    }
    Ok(())
}

fn recover_publish_manifest(project_root: &Path, manifest_path: &Path) -> Result<(), String> {
    let text = fs::read_to_string(manifest_path)
        .map_err(|e| format!("recovery manifest読込失敗 {}: {e}", manifest_path.display()))?;
    let manifest: PersistentPublishManifest = serde_json::from_str(&text)
        .map_err(|e| format!("recovery manifest解析失敗 {}: {e}", manifest_path.display()))?;
    let transaction_root = manifest_path
        .parent()
        .ok_or_else(|| "recovery manifest parentがありません".to_string())?;
    validate_publish_manifest_paths(project_root, transaction_root, &manifest)?;
    if manifest.phase == "committed" {
        fs::remove_dir_all(transaction_root)
            .map_err(|e| format!("committed transaction cleanup失敗: {e}"))?;
        return Ok(());
    }
    for operation in manifest.operations.iter().rev() {
        let (source, destination, backup) =
            resolve_manifest_operation(project_root, transaction_root, operation)?;
        if backup.exists() {
            if destination.exists() {
                if destination.is_dir() {
                    fs::remove_dir_all(&destination)
                } else {
                    fs::remove_file(&destination)
                }
                .map_err(|e| format!("crash recovery destination除去失敗: {e}"))?;
            }
            sync_path_tree(&backup)?;
            durable_rename(&backup, &destination)?;
        } else if !operation.had_destination
            && source.is_some()
            && destination.exists()
            && source.as_ref().is_some_and(|source| !source.exists())
        {
            if destination.is_dir() {
                fs::remove_dir_all(&destination)
            } else {
                fs::remove_file(&destination)
            }
            .map_err(|e| format!("crash recovery新規install除去失敗: {e}"))?;
        }
    }
    fs::remove_dir_all(transaction_root)
        .map_err(|e| format!("recovery transaction cleanup失敗: {e}"))?;
    Ok(())
}

fn recover_incomplete_import_transactions(project_root: &Path) -> Result<usize, String> {
    let mut recovered = 0;
    for root_name in [".eventtrail-import-stage", ".eventtrail-import-recovery"] {
        let root = project_root.join(root_name);
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("import recovery scan失敗: {error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|e| format!("import recovery entry失敗: {e}"))?;
            let manifest = entry.path().join("transaction.json");
            if manifest.is_file() {
                recover_publish_manifest(project_root, &manifest)?;
                recovered += 1;
            }
        }
    }
    Ok(recovered)
}

fn preserve_failed_transaction_with(
    stage_root: &Path,
    recovery_root: &Path,
    mut persist: impl FnMut(&Path, &PersistentPublishManifest) -> Result<(), String>,
    mut rename: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> (PathBuf, Option<String>) {
    let manifest_path = stage_root.join("transaction.json");
    let marked = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("recovery-required manifest読込失敗: {e}"))
        .and_then(|text| {
            serde_json::from_str::<PersistentPublishManifest>(&text)
                .map_err(|e| format!("recovery-required manifest解析失敗: {e}"))
        })
        .and_then(|mut manifest| {
            manifest.phase = "recovery-required".to_string();
            persist(&manifest_path, &manifest)
        });
    if let Err(error) = marked {
        return (stage_root.to_path_buf(), Some(error));
    }
    if let Some(parent) = recovery_root.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return (
                stage_root.to_path_buf(),
                Some(format!("recovery directory作成失敗: {error}")),
            );
        }
    }
    match rename(stage_root, recovery_root) {
        Ok(()) => (recovery_root.to_path_buf(), None),
        Err(error) => (stage_root.to_path_buf(), Some(error)),
    }
}

fn install_staged_path(
    source: Option<&Path>,
    destination: &Path,
    backup: &Path,
    journal: &mut Vec<PublishedImportPath>,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("publish parent作成失敗: {e}"))?;
    }
    let saved_backup = if destination.exists() {
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("publish backup作成失敗: {e}"))?;
        }
        sync_path_tree(destination)?;
        durable_rename(destination, backup).map_err(|e| format!("publish backup失敗: {e}"))?;
        Some(backup.to_path_buf())
    } else {
        None
    };
    journal.push(PublishedImportPath {
        destination: destination.to_path_buf(),
        backup: saved_backup,
        installed: false,
    });
    if let Some(source) = source {
        sync_path_tree(source)?;
        durable_rename(source, destination)
            .map_err(|error| format!("staged import publish失敗: {error}"))?;
        journal.last_mut().unwrap().installed = true;
    }
    Ok(())
}

fn rollback_published_paths_with(
    paths: &mut Vec<PublishedImportPath>,
    mut rename_backup: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    while let Some(path) = paths.pop() {
        if path.installed {
            let result = if path.destination.is_dir() {
                fs::remove_dir_all(&path.destination)
            } else {
                fs::remove_file(&path.destination)
            };
            if let Err(error) = result {
                errors.push(format!(
                    "install除去失敗 {}: {error}",
                    path.destination.display()
                ));
            }
        }
        if let Some(backup) = path.backup {
            if let Err(error) = rename_backup(&backup, &path.destination) {
                errors.push(format!(
                    "backup復元失敗 {} -> {}: {error}",
                    backup.display(),
                    path.destination.display()
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn rollback_published_paths(paths: &mut Vec<PublishedImportPath>) -> Result<(), String> {
    rollback_published_paths_with(paths, |source, destination| {
        durable_rename(source, destination).map_err(std::io::Error::other)
    })
}

fn staged_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn collect(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        if !current.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(current).map_err(|e| format!("staged files読込失敗: {e}"))? {
            let entry = entry.map_err(|e| format!("staged file読込失敗: {e}"))?;
            let file_type = entry
                .file_type()
                .map_err(|e| format!("staged file種別失敗: {e}"))?;
            if file_type.is_symlink() {
                return Err("staged default_cutにsymlinkを含められません".to_string());
            }
            if file_type.is_dir() {
                collect(root, &entry.path(), output)?;
            } else if file_type.is_file() {
                output.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap_or(&entry.path())
                        .to_path_buf(),
                );
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    collect(root, root, &mut output)?;
    Ok(output)
}

#[tauri::command]
fn publish_received_result_import(upload_id: String) -> Result<Value, String> {
    let _circle_master_guard = circle_master_write_lock()
        .lock()
        .map_err(|e| format!("circle master publishロック取得失敗: {e}"))?;
    // pending registry lockがpublishのlinearization point。timeout/stopが先ならentryは消え、
    // publishが先ならcurrent lease確認直後からtransaction完了までcancel側を待たせる。
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信publishロック取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    let stage = upload
        .import_stage
        .take()
        .ok_or_else(|| "publish対象のimport stageがありません".to_string())?;
    let manifest_path = stage.stage_root.join("transaction.json");
    let mut published = Vec::new();
    let publish_result = (|| -> Result<(), String> {
        for (path, expected) in &stage.live_preimages {
            let current = path_content_fingerprint(path)?;
            if &current != expected {
                return Err(format!(
                    "import stage作成後にlive pathが変更されました: {}",
                    path.display()
                ));
            }
        }
        let staged_event = stage.stage_root.join("events").join(&stage.plan.slug);
        let mut operations = vec![PersistentPublishOperation {
            source: Some(
                staged_event
                    .strip_prefix(&stage.stage_root)
                    .unwrap()
                    .to_path_buf(),
            ),
            destination: stage
                .plan
                .event_dir
                .strip_prefix(&stage.project_root)
                .map_err(|_| "event destinationがproject root外です".to_string())?
                .to_path_buf(),
            backup: PathBuf::from("publish-backup/target-event"),
            had_destination: stage.plan.event_dir.exists(),
        }];
        for (slug, redundant) in &stage.plan.redundant_events {
            if redundant.exists() {
                operations.push(PersistentPublishOperation {
                    source: None,
                    destination: redundant
                        .strip_prefix(&stage.project_root)
                        .map_err(|_| "redundant destinationがproject root外です".to_string())?
                        .to_path_buf(),
                    backup: PathBuf::from("publish-backup/redundant-events").join(slug),
                    had_destination: true,
                });
            }
        }
        let staged_master = stage.stage_root.join("circle_master.json");
        if staged_master.is_file() {
            let staged_master_value: Value = serde_json::from_str(
                &fs::read_to_string(&staged_master)
                    .map_err(|e| format!("staged circle_master読込失敗: {e}"))?,
            )
            .map_err(|e| format!("staged circle_master解析失敗: {e}"))?;
            if !staged_master_value.is_object()
                || !staged_master_value
                    .get("circles")
                    .is_some_and(Value::is_object)
            {
                return Err("staged circle_masterのcirclesが不正です".to_string());
            }
            let destination = stage.project_root.join("circle_master.json");
            operations.push(PersistentPublishOperation {
                source: Some(PathBuf::from("circle_master.json")),
                destination: PathBuf::from("circle_master.json"),
                backup: PathBuf::from("publish-backup/circle_master.json"),
                had_destination: destination.exists(),
            });
        }
        let staged_cuts = stage.stage_root.join("default_cuts");
        for relative in staged_files(&staged_cuts)? {
            let destination = stage.project_root.join("default_cuts").join(&relative);
            operations.push(PersistentPublishOperation {
                source: Some(PathBuf::from("default_cuts").join(&relative)),
                destination: PathBuf::from("default_cuts").join(&relative),
                backup: PathBuf::from("publish-backup/default_cuts").join(&relative),
                had_destination: destination.exists(),
            });
        }
        let mut manifest = PersistentPublishManifest {
            version: 1,
            phase: "publishing".to_string(),
            completed_operations: 0,
            operations,
        };
        persist_publish_manifest(&manifest_path, &manifest)?;
        for (index, operation) in manifest.operations.iter().enumerate() {
            let (source, destination, backup) =
                resolve_manifest_operation(&stage.project_root, &stage.stage_root, operation)?;
            install_staged_path(source.as_deref(), &destination, &backup, &mut published)?;
            manifest.completed_operations = index + 1;
            persist_publish_manifest(&manifest_path, &manifest)?;
        }
        manifest.phase = "committed".to_string();
        persist_publish_manifest(&manifest_path, &manifest)?;
        Ok(())
    })();
    if let Err(error) = publish_result {
        let rollback = rollback_published_paths(&mut published);
        return match rollback {
            Ok(()) => {
                upload.import_stage = Some(stage);
                Err(error)
            }
            Err(rollback_error) => {
                upload.recovery_required = true;
                let recovery_root = stage
                    .project_root
                    .join(".eventtrail-import-recovery")
                    .join(&upload_id);
                let (preserved_root, preserve_error) = preserve_failed_transaction_with(
                    &stage.stage_root,
                    &recovery_root,
                    persist_publish_manifest,
                    durable_rename,
                );
                upload.import_stage = Some(ReceivedImportStage {
                    stage_root: preserved_root.clone(),
                    ..stage
                });
                Err(format!(
                    "publish失敗: {error}; rollback失敗（手動復旧が必要）: {rollback_error}; recovery={}; recovery-mark={}",
                    preserved_root.display(),
                    preserve_error.unwrap_or_else(|| "ok".to_string())
                ))
            }
        };
    }
    upload.lease_deadline = Instant::now() + RECEIVED_UPLOAD_LEASE_DURATION;
    let _ = fs::remove_dir_all(&stage.stage_root);
    upload.published = true;
    published_received_uploads()
        .lock()
        .map_err(|e| format!("published uploadロック取得失敗: {e}"))?
        .insert(upload_id.clone());
    // live mutation commitとmobile成功通知を同じregistry critical sectionで確定する。
    // この後のUI reload/select失敗やserver stopは成功結果を上書きできない。
    let _ = fs::remove_file(&upload.zip_path);
    let _ = upload.sender.try_send(ReceivedUploadAck::Success);
    Ok(json!({
        "status": "ok",
        "slug": stage.plan.slug,
        "dir": stage.plan.event_dir.to_string_lossy().to_string().replace("\\", "/"),
        "event_name": stage.plan.event_name,
        "event_date": stage.plan.event_date,
        "duplicate_mobile_imports_removed": stage.plan.redundant_events.len(),
    }))
}

fn remove_pending_received_upload(upload_id: &str) {
    let removed = pending_received_uploads()
        .lock()
        .ok()
        .and_then(|mut pending| {
            if pending
                .get(upload_id)
                .map(|upload| upload.recovery_required)
                .unwrap_or(false)
            {
                return None;
            }
            pending.remove(upload_id)
        });
    if let Some(stage) = removed.and_then(|upload| upload.import_stage) {
        let _ = fs::remove_dir_all(stage.stage_root);
    }
}

fn terminal_cancel_received_upload(upload_id: &str, error: &str) {
    let upload = pending_received_uploads()
        .lock()
        .ok()
        .and_then(|mut pending| {
            if pending
                .get(upload_id)
                .map(|upload| upload.recovery_required || upload.published)
                .unwrap_or(false)
            {
                return None;
            }
            pending.remove(upload_id)
        });
    if let Some(upload) = upload {
        if let Some(stage) = &upload.import_stage {
            let _ = fs::remove_dir_all(&stage.stage_root);
        }
        let _ = upload
            .sender
            .try_send(ReceivedUploadAck::Failure(error.to_string()));
    }
}

fn terminal_cancel_all_received_uploads(error: &str) {
    let uploads = pending_received_uploads()
        .lock()
        .map(|mut pending| {
            let cancellable = pending
                .iter()
                .filter_map(|(id, upload)| {
                    (!upload.recovery_required && !upload.published).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            cancellable
                .into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect()
        })
        .unwrap_or_else(|_| Vec::<PendingReceivedUpload>::new());
    for upload in uploads {
        if let Some(stage) = &upload.import_stage {
            let _ = fs::remove_dir_all(&stage.stage_root);
        }
        let _ = upload
            .sender
            .try_send(ReceivedUploadAck::Failure(error.to_string()));
    }
}

fn wait_for_received_upload_ack(
    upload_id: &str,
    receiver: &std::sync::mpsc::Receiver<ReceivedUploadAck>,
    running: &AtomicBool,
    listener_emitted: bool,
) -> Result<(), (String, bool)> {
    if !listener_emitted {
        let error = "frontend listenerへ通知できませんでした";
        terminal_cancel_received_upload(upload_id, error);
        return Err((error.to_string(), false));
    }
    loop {
        match receiver.try_recv() {
            Ok(ReceivedUploadAck::Success) => return Ok(()),
            Ok(ReceivedUploadAck::Failure(error)) => return Err((error, false)),
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                remove_pending_received_upload(upload_id);
                return Err((
                    "frontend import応答channelが切断されました".to_string(),
                    false,
                ));
            }
        }
        if !running.load(Ordering::Relaxed) {
            let error = "受信サーバーが停止されました";
            terminal_cancel_received_upload(upload_id, error);
            return Err((error.to_string(), false));
        }
        let deadline = pending_received_uploads()
            .lock()
            .ok()
            .and_then(|pending| pending.get(upload_id).map(|upload| upload.lease_deadline))
            .ok_or_else(|| ("upload leaseは取消済みです".to_string(), false))?;
        let now = Instant::now();
        if now >= deadline {
            let error = "frontend import応答がタイムアウトしました";
            terminal_cancel_received_upload(upload_id, error);
            return Err((error.to_string(), true));
        }
        let wait = std::cmp::min(
            Duration::from_millis(500),
            deadline.saturating_duration_since(now),
        );
        match receiver.recv_timeout(wait) {
            Ok(ReceivedUploadAck::Success) => return Ok(()),
            Ok(ReceivedUploadAck::Failure(error)) => return Err((error, false)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err((
                    "frontend import応答channelが切断されました".to_string(),
                    false,
                ))
            }
        }
    }
}

#[tauri::command]
fn ack_received_upload(
    upload_id: String,
    success: bool,
    error: Option<String>,
) -> Result<Value, String> {
    let mut registry = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信ackロック取得失敗: {e}"))?;
    if registry
        .get(&upload_id)
        .map(|upload| upload.published)
        .unwrap_or(false)
        || published_received_uploads()
            .lock()
            .map_err(|e| format!("published uploadロック取得失敗: {e}"))?
            .contains(&upload_id)
    {
        return if success {
            Ok(json!({"status": "ok", "published": true}))
        } else {
            Err("uploadは既にpublish済みのためfailureへ変更できません".to_string())
        };
    }
    {
        let pending = registry
            .get(&upload_id)
            .ok_or_else(|| "ack対象のuploadIdが見つかりません".to_string())?;
        if pending.recovery_required {
            return Err("手動復旧が必要なためack/cancelできません".to_string());
        }
        if !pending.claimed || Instant::now() >= pending.lease_deadline {
            return Err("upload leaseはcurrentではありません".to_string());
        }
        if success && pending.import_stage.is_some() {
            return Err("staged importがpublishされていません".to_string());
        }
    }
    let pending = registry
        .remove(&upload_id)
        .ok_or_else(|| "ack対象のuploadIdが見つかりません".to_string())?;
    drop(registry);
    if !success {
        if let Some(stage) = &pending.import_stage {
            let _ = fs::remove_dir_all(&stage.stage_root);
        }
    }

    let ack = if success {
        match fs::remove_file(&pending.zip_path) {
            Ok(()) => ReceivedUploadAck::Success,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReceivedUploadAck::Success,
            Err(e) => ReceivedUploadAck::Failure(format!("受信ZIP削除失敗: {e}")),
        }
    } else {
        ReceivedUploadAck::Failure(error.unwrap_or_else(|| "frontend import失敗".to_string()))
    };
    let failed_message = match &ack {
        ReceivedUploadAck::Failure(message) => Some(message.clone()),
        ReceivedUploadAck::Success => None,
    };
    pending
        .sender
        .send(ack)
        .map_err(|_| "upload response待機が終了しています".to_string())?;
    if let Some(message) = failed_message {
        return Err(message);
    }
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn cancel_received_upload(upload_id: String, error: Option<String>) -> Result<Value, String> {
    ack_received_upload(upload_id, false, error)
}

const RECEIVED_UPLOAD_STALE_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn cleanup_stale_received_uploads(temp_dir: &Path, now: std::time::SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(temp_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("eventtrail_received_") || !name.ends_with(".zip") {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= RECEIVED_UPLOAD_STALE_AGE && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn received_upload_payload(upload_id: &str, zip_path: &str, size: usize) -> Value {
    json!({
        "status": "ok",
        "uploadId": upload_id,
        "zipPath": zip_path,
        "size": size
    })
}

#[tauri::command]
fn start_receive_server(window: tauri::Window, project_root: String) -> Result<Value, String> {
    let project_root = absolute_project_root(&project_root)?;
    {
        let _recovery_guard = circle_master_write_lock()
            .lock()
            .map_err(|e| format!("import recoveryロック取得失敗: {e}"))?;
        recover_incomplete_import_transactions(&project_root)?;
    }
    cleanup_stale_received_uploads(&std::env::temp_dir(), std::time::SystemTime::now());
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
                    let upload_id = format!(
                        "{}_{}",
                        std::process::id(),
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
                    );
                    let tmp_path =
                        std::env::temp_dir().join(format!("eventtrail_received_{upload_id}.zip"));
                    if let Err(e) = fs::write(&tmp_path, &body) {
                        let resp = tiny_http::Response::from_string(format!("保存エラー: {e}"))
                            .with_status_code(tiny_http::StatusCode(500));
                        let _ = request.respond(resp);
                        continue;
                    }

                    let zip_path = tmp_path.to_string_lossy().to_string().replace("\\", "/");
                    let size = body.len();
                    let ack_receiver = match register_received_upload(&upload_id, tmp_path.clone())
                    {
                        Ok(receiver) => receiver,
                        Err(e) => {
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": e}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(500));
                            let _ = request.respond(resp);
                            continue;
                        }
                    };
                    let _ = window.emit(
                        "result-uploaded",
                        json!({
                            "uploadId": upload_id.clone(),
                            "zipPath": zip_path.clone(),
                            "size": size
                        }),
                    );

                    // receive threadはtemp ZIPの保存と通知だけを担当する。
                    // event.jsonへのimportはfrontendのdocument排他区間で実行する。
                    let payload = received_upload_payload(&upload_id, &zip_path, size);
                    let emitted = window.emit("result-received", payload.clone()).is_ok();
                    let ack = wait_for_received_upload_ack(
                        &upload_id,
                        &ack_receiver,
                        &running_clone,
                        emitted,
                    );
                    remove_pending_received_upload(&upload_id);
                    let (status, response_payload) = match ack {
                        Ok(()) => (200, json!({"status": "ok", "uploadId": upload_id})),
                        Err((error, timed_out)) => (
                            if timed_out { 504 } else { 500 },
                            json!({"status": "error", "uploadId": upload_id, "error": error}),
                        ),
                    };
                    let resp = tiny_http::Response::from_string(response_payload.to_string())
                        .with_status_code(tiny_http::StatusCode(status))
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
    terminal_cancel_all_received_uploads("受信サーバーが停止されました");
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
    "https://raw.githubusercontent.com/ttttdiva/Event-AutoPin-Publish/main/latest.json";

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
        r#"# Event AutoPin 自動更新スクリプト
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
            plan_received_result_import,
            stage_received_result_import,
            publish_received_result_import,
            start_receive_server,
            stop_receive_server,
            ack_received_upload,
            claim_received_upload,
            heartbeat_received_upload,
            cancel_received_upload,
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

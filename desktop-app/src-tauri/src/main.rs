#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod history_search;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::Write;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn is_usable_advertised_ipv4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_unspecified() && !ip.is_loopback() && !ip.is_link_local()
}

/// Restrict sync HTTP peers to the advertised RFC1918 /24.  The QR advertises
/// one interface, so a conservative /24 avoids accepting a routed private
/// network or VPN peer while still working on the common home LAN.  Loopback
/// is accepted only when both ends explicitly use loopback (unit tests and
/// local development); production QR addresses are never loopback.
fn peer_is_on_advertised_subnet(
    remote: Option<&std::net::SocketAddr>,
    advertised: std::net::Ipv4Addr,
) -> bool {
    let Some(std::net::SocketAddr::V4(remote)) = remote else {
        return false;
    };
    let peer = *remote.ip();
    if peer.is_loopback() || advertised.is_loopback() {
        return peer.is_loopback() && advertised.is_loopback();
    }
    if !peer.is_private() || !advertised.is_private() {
        return false;
    }
    let peer_octets = peer.octets();
    let advertised_octets = advertised.octets();
    peer_octets[..3] == advertised_octets[..3]
}

fn peer_is_loopback(remote: Option<&std::net::SocketAddr>) -> bool {
    match remote {
        Some(std::net::SocketAddr::V4(address)) => address.ip().is_loopback(),
        _ => false,
    }
}

/// Resolve the IPv4 address that a phone on the local network should use.
///
/// Connecting an unbound UDP socket to an external address lets the OS select
/// the source address for the default route without sending a packet.  The
/// local-ip-address crate remains a fallback (and a private address is always
/// preferred) so this continues to work on machines where the route probe is
/// unavailable.
fn resolve_advertised_ipv4() -> Result<std::net::Ipv4Addr, String> {
    let route_ip = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((std::net::Ipv4Addr::new(8, 8, 8, 8), 80))?;
            socket.local_addr()
        })
        .ok()
        .and_then(|address| match address {
            std::net::SocketAddr::V4(address) => Some(*address.ip()),
            std::net::SocketAddr::V6(_) => None,
        })
        .filter(|ip| is_usable_advertised_ipv4(*ip));

    let local_ip = local_ip_address::local_ip()
        .ok()
        .and_then(|address| match address {
            std::net::IpAddr::V4(address) => Some(address),
            std::net::IpAddr::V6(_) => None,
        })
        .filter(|ip| is_usable_advertised_ipv4(*ip));

    route_ip
        .filter(|ip| ip.is_private())
        .or_else(|| local_ip.filter(|ip| ip.is_private()))
        .ok_or_else(|| {
            "LAN IPv4アドレスを取得できません（private IPv4以外を除外しました）".to_string()
        })
}

use history_search::search_past_participations;
// Native event I/O is intentionally kept independent from the Python bridge.  The
// counters are cheap atomics so development builds can expose enough evidence for
// switch/save profiling without writing verbose production logs.
static PYTHON_BRIDGE_SPAWN_COUNT: AtomicU64 = AtomicU64::new(0);
static TAURI_EVENT_IO_IPC_COUNT: AtomicU64 = AtomicU64::new(0);
static EVENT_JSON_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static COOKIE_STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);
static EVENT_JSON_REPLACE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static EVENT_JSON_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn event_json_replace_lock() -> &'static Mutex<()> {
    EVENT_JSON_REPLACE_LOCK.get_or_init(|| Mutex::new(()))
}

fn event_json_mutation_lock() -> &'static Mutex<()> {
    EVENT_JSON_MUTATION_LOCK.get_or_init(|| Mutex::new(()))
}

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

const DEFAULT_DESKTOP_TIMEOUT_MS: u64 = 36_000_000;

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
            timeout_ms: DEFAULT_DESKTOP_TIMEOUT_MS,
            foam_dir: String::new(),
            unlimited_ocr_model: "baidu/Unlimited-OCR".to_string(),
            unlimited_ocr_model_path: String::new(),
            unlimited_ocr_venv: String::new(),
            unlimited_ocr_hf_home: String::new(),
            unlimited_ocr_revision: "ee63731b6461c8afcdcc7b15352e7d2ffecc2ead".to_string(),
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
    let mut config: DesktopConfig =
        serde_json::from_str(&text).map_err(|e| format!("Invalid desktop config JSON: {e}"))?;
    // 旧版で保存された短いtimeoutでも、全サークル再処理が途中終了しないよう
    // 現行の最低値（10時間）へ自動的に引き上げる。
    if config.timeout_ms < DEFAULT_DESKTOP_TIMEOUT_MS {
        config.timeout_ms = DEFAULT_DESKTOP_TIMEOUT_MS;
    }
    Ok(config)
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
    let mut where_command = Command::new("where.exe");
    where_command
        .arg(&bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_hidden_command(&mut where_command);
    where_command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
        || {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "where", bin])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_hidden_command(&mut cmd);
            cmd.status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
}

#[cfg(target_os = "windows")]
fn configure_hidden_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn configure_hidden_command(_command: &mut Command) {}

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

fn resolve_agy_bin(dotenv: &HashMap<String, String>) -> String {
    if let Some(bin) = env_value(dotenv, &["AGY_BIN", "ANTIGRAVITY_BIN", "ANTIGRAVITY_CLI_BIN"]) {
        return bin;
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local_app_data)
            .join("agy")
            .join("bin")
            .join("agy.exe");
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "agy".to_string()
}

fn parse_agy_models_text(text: &str) -> Vec<(String, String)> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("Fetching") {
            continue;
        }
        let (slug, label) = if let Some((slug, label)) = line.split_once('\t') {
            (slug.trim(), label.trim())
        } else if let Some((slug, label)) = line.split_once("  ") {
            (slug.trim(), label.trim())
        } else {
            continue;
        };
        if slug.is_empty() || !seen.insert(slug.to_string()) {
            continue;
        }
        models.push((
            slug.to_string(),
            if label.is_empty() {
                slug.to_string()
            } else {
                label.to_string()
            },
        ));
    }
    models
}

fn fetch_antigravity_cli_models(dotenv: &HashMap<String, String>) -> (Vec<Value>, &'static str) {
    let bin = resolve_agy_bin(dotenv);
    let fallback = || (Vec::new(), "fetch-failed");

    let output = Command::new(&bin).arg("models").output();
    let Ok(output) = output else {
        return fallback();
    };
    if !output.status.success() {
        return fallback();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_agy_models_text(&text);
    if parsed.is_empty() {
        return fallback();
    }
    (
        parsed
            .into_iter()
            .map(|(id, label)| model_json(&id, &label, "antigravity", "cli-live", "CLI"))
            .collect(),
        "cli-live",
    )
}

fn resolve_grok_build_bin(dotenv: &HashMap<String, String>) -> String {
    if let Some(bin) = env_value(dotenv, &["GROK_BIN"]) {
        return bin;
    }
    if let Some(profile) = env::var_os("USERPROFILE") {
        let candidate = PathBuf::from(profile)
            .join(".grok")
            .join("bin")
            .join("grok.exe");
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "grok".to_string()
}

fn grok_acp_advertises_image(bin: &str) -> bool {
    let mut command = Command::new(bin);
    command
        .args(["--no-auto-update", "--tools", "", "agent", "stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return false;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return false;
    };
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"readTextFile": false, "writeTextFile": false},
                "terminal": false
            }
        }
    });
    if writeln!(stdin, "{request}").is_err() || stdin.flush().is_err() {
        let _ = child.kill();
        return false;
    }
    drop(stdin);

    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let mut reader = BufReader::new(stdout);
        let result = reader.read_line(&mut line).ok().filter(|count| *count > 0).map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(4))
        .ok()
        .flatten();
    let _ = child.kill();
    let _ = child.wait();
    let Some(line) = line else {
        return false;
    };
    let Ok(message) = serde_json::from_str::<Value>(&line) else {
        return false;
    };
    let image = message
        .get("result")
        .and_then(|result| result.get("agentCapabilities"))
        .and_then(|capabilities| capabilities.get("promptCapabilities"))
        .and_then(|capabilities| capabilities.get("image"));
    image.is_some_and(|value| value.as_bool() == Some(true) || value.is_object())
}

fn fetch_grok_build_models(dotenv: &HashMap<String, String>) -> (Vec<Value>, &'static str, &'static str, bool) {
    let bin = resolve_grok_build_bin(dotenv);
    let mut command = Command::new(&bin);
    command
        .args(["--no-auto-update", "models"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let Ok(output) = command.output() else {
        return (Vec::new(), "fetch-failed", "unknown", false);
    };
    if !output.status.success() {
        return (Vec::new(), "fetch-failed", "unknown", false);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let unauthenticated = text.contains("not authenticated");
    let image_supported = grok_acp_advertises_image(&bin);
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let candidate = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("");
        if !candidate.starts_with("grok-") || !seen.insert(candidate.to_string()) {
            continue;
        }
        let mut model = model_json(candidate, candidate, "grok", "cli-live", "Grok Build");
        models.push(model_with_capabilities(
            model.take(),
            "verified",
            if image_supported { "verified" } else { "unknown" },
            if image_supported {
                "Grok Build ACP initialize promptCapabilities.image"
            } else {
                "Grok Build ACP image capability was not confirmed"
            },
            "available",
        ));
    }
    let source = if models.is_empty() { "fetch-failed" } else { "cli-live" };
    let auth = if unauthenticated { "unauthenticated" } else if models.is_empty() { "unknown" } else { "available" };
    (models, source, auth, image_supported)
}

#[tauri::command]
async fn list_model_catalog(
    project_root: String,
    force_refresh: Option<bool>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        if force_refresh.unwrap_or(false) {
            list_model_catalog_sync_with_refresh(project_root, true)
        } else {
            list_model_catalog_sync(project_root)
        }
    })
        .await
        .map_err(|e| format!("モデル一覧取得タスクが失敗しました: {e}"))?
}

#[derive(Clone)]
struct ModelCatalogCacheEntry {
    stored_at: Instant,
    value: Value,
}

fn model_catalog_cache() -> &'static Mutex<HashMap<String, ModelCatalogCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ModelCatalogCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalidate_model_catalog_cache(project_root: &str) {
    if let Ok(mut cache) = model_catalog_cache().lock() {
        cache.remove(project_root);
    }
}

fn list_model_catalog_sync(project_root: String) -> Result<Value, String> {
    list_model_catalog_sync_with_refresh(project_root, false)
}

fn append_stale_cached_models(
    current_models: &mut Vec<Value>,
    cached_catalog: &Value,
    failed_providers: &HashSet<String>,
) -> usize {
    let Some(cached_models) = cached_catalog.get("apiModels").and_then(Value::as_array) else {
        return 0;
    };
    let mut stale_count = 0usize;
    for cached_model in cached_models {
        let provider = cached_model
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !failed_providers.contains(provider) {
            continue;
        }
        let id = cached_model.get("id").and_then(Value::as_str).unwrap_or("");
        if current_models.iter().any(|model| {
            model.get("provider").and_then(Value::as_str) == Some(provider)
                && model.get("id").and_then(Value::as_str) == Some(id)
        }) {
            continue;
        }
        let mut stale = cached_model.clone();
        stale["source"] = Value::String("stale-cache".to_string());
        stale["source_label"] = Value::String("保存済み候補（更新失敗）".to_string());
        stale["stale"] = Value::Bool(true);
        current_models.push(stale);
        stale_count += 1;
    }
    stale_count
}

fn list_model_catalog_sync_with_refresh(
    project_root: String,
    force_refresh: bool,
) -> Result<Value, String> {
    const CACHE_TTL: Duration = Duration::from_secs(300);
    if !force_refresh {
        if let Ok(cache) = model_catalog_cache().lock() {
            if let Some(entry) = cache.get(&project_root) {
                if entry.stored_at.elapsed() < CACHE_TTL {
                    let mut value = entry.value.clone();
                    if value.get("cache_state").and_then(Value::as_str) == Some("fresh") {
                        value["cache_state"] = Value::String("fresh".to_string());
                    }
                    return Ok(value);
                }
            }
        }
    }

    let dotenv = read_dotenv(&project_root);
    let config_text =
        fs::read_to_string(PathBuf::from(&project_root).join("config.yaml")).unwrap_or_default();
    let configured_api_models = parse_yaml_list(&config_text, "models");
    let text_model_config = parse_yaml_map(&config_text, "text_llm_cli_models");

    let (mut api_models, api_errors) = build_api_model_catalog(&dotenv, &configured_api_models);
    let (grok_models, grok_source, grok_auth, grok_image_capability) =
        fetch_grok_build_models(&dotenv);
    let codex_candidates = codex_candidate_models();
    let codex_models = configured_models(
        cli_candidate_models(
            "codex",
            codex_candidates
                .iter()
                .map(|(id, label)| (id.as_str(), label.as_str()))
                .collect(),
        ),
        &[text_model_config.get("codex").cloned()],
        "codex",
    );
    let (mut antigravity_cli_models, antigravity_source) =
        fetch_antigravity_cli_models(&dotenv);
    antigravity_cli_models = configured_models(
        antigravity_cli_models,
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

    let api_error_providers: HashSet<String> = api_errors
        .iter()
        .filter_map(|error| error.get("provider").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let previous = model_catalog_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&project_root).cloned());
    let mut stale_count = 0usize;
    if !api_error_providers.is_empty() {
        if let Some(cached) = previous.as_ref() {
            stale_count = append_stale_cached_models(
                &mut api_models,
                &cached.value,
                &api_error_providers,
            );
        }
    }
    let provider_status = |id: &str, label: &str, keys: &[&str]| {
        let error = api_errors
            .iter()
            .find(|error| error.get("provider").and_then(Value::as_str) == Some(id));
        let credential_configured = env_value(&dotenv, keys).is_some();
        let status = if let Some(error) = error {
            error.get("status").and_then(Value::as_str).unwrap_or("error")
        } else if credential_configured {
            "available"
        } else {
            "credential_not_configured"
        };
        json!({
            "id": id,
            "label": label,
            "status": status,
            "credential_configured": credential_configured,
            "stale_model_count": api_models
                .iter()
                .filter(|model| {
                    model.get("provider").and_then(Value::as_str) == Some(id)
                        && model.get("stale").and_then(Value::as_bool) == Some(true)
                })
                .count()
        })
    };
    let api_provider_statuses = vec![
        provider_status("openai", "OpenAI API", &["OPENAI_API_KEY"]),
        provider_status("gemini", "Gemini API", &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        provider_status("anthropic", "Anthropic API", &["ANTHROPIC_API_KEY"]),
        provider_status("xai", "xAI API", &["XAI_API_KEY"]),
    ];
    let catalog = json!({
        "providers": [
            {
                "id": "codex",
                "label": "Codex CLI",
                "kind": "cli",
                "available": command_available(&dotenv, "CODEX_BIN", "codex"),
                "source": "cli-suggested",
                "authenticated": null,
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
                "source": antigravity_source,
                "authenticated": null,
                "models": antigravity_cli_models
            },
            {
                "id": "claude",
                "label": "Claude Code",
                "kind": "cli",
                "available": command_available(&dotenv, "CLAUDE_BIN", "claude"),
                "source": "cli-suggested",
                "authenticated": null,
                "models": claude_models
            },
            {
                "id": "grok",
                "label": "Grok Build",
                "kind": "cli",
                "available": command_available(&dotenv, "GROK_BIN", "grok")
                    || env::var_os("USERPROFILE").map(|profile| {
                        PathBuf::from(profile).join(".grok").join("bin").join("grok.exe").exists()
                    }).unwrap_or(false),
                "source": grok_source,
                "authenticated": if grok_auth == "unknown" { Value::Null } else { json!(grok_auth == "available") },
                "auth_status": grok_auth,
                "image_capability": if grok_image_capability { "verified" } else { "unknown" },
                "models": grok_models
            }
        ],
        "apiProviders": api_provider_statuses,
        "apiModels": api_models,
        "apiErrors": api_errors,
        "cache_state": if stale_count > 0 { "stale" } else if !api_error_providers.is_empty() { "partial" } else { "fresh" },
        "fetched_at": chrono::Utc::now().to_rfc3339()
    });
    if let Ok(mut cache) = model_catalog_cache().lock() {
        cache.insert(
            project_root,
            ModelCatalogCacheEntry {
                stored_at: Instant::now(),
                value: catalog.clone(),
            },
        );
    }
    Ok(catalog)
}

fn read_dotenv(project_root: &str) -> HashMap<String, String> {
    let path = PathBuf::from(project_root).join(".env");
    let mut values = HashMap::new();
    let Ok(text) = fs::read_to_string(path) else {
        return values;
    };
    for segment in split_env_lines(&text) {
        let (line, _) = split_env_line_ending(segment);
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
        "availability": "unknown",
        "capabilities": {"text": "unknown", "image": "unknown"},
        "capability_source": "unverified",
    })
}

fn model_with_capabilities(
    mut model: Value,
    text: &str,
    image: &str,
    source: &str,
    availability: &str,
) -> Value {
    model["capabilities"] = json!({"text": text, "image": image});
    model["capability_source"] = Value::String(source.to_string());
    model["availability"] = Value::String(availability.to_string());
    model
}

fn openai_documented_capabilities(id: &str) -> (&'static str, &'static str, &'static str) {
    let documented_models = [
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.5-2026-04-23",
        "gpt-5.5-pro-2026-04-23",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.4-nano-2026-03-17",
        "gpt-5.4-2026-03-05",
        "gpt-5.4-pro-2026-03-05",
        "gpt-5.4-mini-2026-03-17",
        "gpt-5.2",
        "gpt-5.2-pro",
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-mini-2025-08-07",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-2025-04-14",
        "gpt-4.1-mini-2025-04-14",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4o-2024-11-20",
        "gpt-4o-2024-08-06",
        "gpt-4o-mini-2024-07-18",
    ];
    if documented_models.contains(&id) {
        return (
            "verified",
            "verified",
            "OpenAI model and vision documentation (verified family/snapshot)",
        );
    }
    ("unknown", "unknown", "OpenAI models list has no modality metadata")
}

/// Codex CLI自身のモデルcache（`~/.codex/models_cache.json`）から、表示対象のモデルを読む。
/// 読めない場合は従来の固定候補へ戻る。
fn codex_candidate_models() -> Vec<(String, String)> {
    let mut models: Vec<(String, String)> = Vec::new();
    if let Some(profile) = env::var_os("USERPROFILE") {
        let path = PathBuf::from(profile).join(".codex").join("models_cache.json");
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(items) = value.get("models").and_then(Value::as_array) {
                    for item in items {
                        let visible = item.get("visibility").and_then(Value::as_str) == Some("list");
                        let slug = item.get("slug").and_then(Value::as_str).unwrap_or("");
                        if !visible || slug.is_empty() {
                            continue;
                        }
                        let label = item
                            .get("display_name")
                            .and_then(Value::as_str)
                            .unwrap_or(slug);
                        models.push((slug.to_string(), label.to_string()));
                    }
                }
            }
        }
    }
    if models.is_empty() {
        models = [
            ("gpt-6.1-sol", "GPT-6.1 Sol"),
            ("gpt-6-sol", "GPT-6 Sol"),
            ("gpt-6-luna", "GPT-6 Luna"),
            ("gpt-5.6-sol", "GPT-5.6 Sol"),
            ("gpt-5.6-luna", "GPT-5.6 Luna"),
            ("gpt-5.5", "GPT-5.5"),
            ("gpt-5.4", "GPT-5.4"),
        ]
        .iter()
        .map(|(id, label)| (id.to_string(), label.to_string()))
        .collect();
    }
    models
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
    // API key別の一覧やモデル文書を根拠にできない候補は追加しない。
    Vec::new()
}

fn provider_for_model_id(id: &str) -> &str {
    if id.starts_with("gemini-") {
        "gemini"
    } else if id.starts_with("claude-") {
        "anthropic"
    } else if id.starts_with("grok-") {
        "xai"
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
            Err(error) => errors.push(api_catalog_error("openai", &error)),
        }
    }
    if let Some(key) = env_value(dotenv, &["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
        match fetch_gemini_models(&key) {
            Ok(fetched) => models.extend(fetched),
            Err(error) => errors.push(api_catalog_error("gemini", &error)),
        }
    }
    if let Some(key) = env_value(dotenv, &["ANTHROPIC_API_KEY"]) {
        match fetch_anthropic_models(&key) {
            Ok(fetched) => models.extend(fetched),
            Err(error) => errors.push(api_catalog_error("anthropic", &error)),
        }
    }
    if let Some(key) = env_value(dotenv, &["XAI_API_KEY"]) {
        match fetch_xai_models(&key) {
            Ok(fetched) => models.extend(fetched),
            Err(error) => errors.push(api_catalog_error("xai", &error)),
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

fn api_catalog_error(provider: &str, error: &str) -> Value {
    let status = if error.contains("HTTP 401") || error.contains("HTTP 403") {
        "permission_denied"
    } else if error.contains("HTTP 429") {
        "rate_limited"
    } else if error.contains("timeout") {
        "timeout"
    } else {
        "transport_error"
    };
    json!({"provider": provider, "status": status, "message": error})
}

fn fetch_openai_models(api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    let response = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let data: Value = response
        .json()
        .map_err(|_| "invalid_response".to_string())?;
    let mut models = Vec::new();
    if let Some(items) = data.get("data").and_then(Value::as_array) {
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let (text_capability, image_capability, source) =
                openai_documented_capabilities(id);
            let shutdown_date = item.get("shutdown_date").and_then(Value::as_str);
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let availability = match shutdown_date {
                Some(date) if date <= today.as_str() => "retired",
                Some(_) => "scheduled_retirement",
                None => "available",
            };
            let mut model = model_json(id, id, "openai", "provider-api", "API取得");
            model["owned_by"] = item.get("owned_by").cloned().unwrap_or(Value::Null);
            model["created"] = item.get("created").cloned().unwrap_or(Value::Null);
            model["shutdown_date"] = item
                .get("shutdown_date")
                .cloned()
                .unwrap_or(Value::Null);
            models.push(model_with_capabilities(
                model,
                text_capability,
                image_capability,
                source,
                availability,
            ));
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
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    for page_index in 0..10 {
        let mut request = client
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .query(&[("key", api_key), ("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let data: Value = response
            .json()
            .map_err(|_| "invalid_response".to_string())?;
        if let Some(items) = data.get("models").and_then(Value::as_array) {
            for item in items {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let supports_generate = item
                    .get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_some_and(|methods| {
                        methods
                            .iter()
                            .any(|method| method.as_str() == Some("generateContent"))
                    });
                if !supports_generate {
                    continue;
                }
                let id = name.strip_prefix("models/").unwrap_or(name);
                let label = item
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                let mut model = model_json(id, label, "gemini", "provider-api", "API取得");
                model["supported_generation_methods"] = item
                    .get("supportedGenerationMethods")
                    .cloned()
                    .unwrap_or(Value::Null);
                let (text_capability, image_capability, capability_source, availability) =
                    gemini_documented_capabilities(id);
                models.push(model_with_capabilities(
                    model,
                    text_capability,
                    image_capability,
                    capability_source,
                    availability,
                ));
            }
        }
        page_token = next_gemini_page_token(&data);
        if page_token.is_none() {
            break;
        }
        if page_index == 9 {
            return Err("pagination_limit_reached".to_string());
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

fn next_gemini_page_token(data: &Value) -> Option<String> {
    data.get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn gemini_documented_capabilities(id: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    let generation_only_models = [
        "gemini-nano-banana-2.1",
        "gemini-nano-banana-2",
        "gemini-nano-banana-2-lite",
        "gemini-nano-banana-pro",
        "gemini-3.1-flash-lite-image",
        "gemini-3.1-flash-image",
        "gemini-3-pro-image",
        "gemini-2.5-flash-image",
    ];
    if generation_only_models.contains(&id) {
        return (
            "unsupported",
            "unsupported",
            "Google Gemini image-generation model documentation",
            "available",
        );
    }
    let non_text_tasks = [
        "gemini-3.8-flash-tts",
        "gemini-3.5-flash-lite-tts",
        "gemini-3.1-flash-tts",
        "gemini-3.5-transcribe",
        "gemini-3.5-transcribe-live",
        "gemini-3.8-live",
        "gemini-3.8-live-extended-thinking",
    ];
    if non_text_tasks.contains(&id) {
        return (
            "unsupported",
            "unsupported",
            "Google Gemini audio/live model documentation",
            "available",
        );
    }
    let multimodal_text_models = [
        "gemini-4-argon",
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
        "gemini-2.0-flash-001",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash-lite-001",
    ];
    if multimodal_text_models.contains(&id) {
        let availability = match id {
            "gemini-3.5-flash" | "gemini-3.7-flash" => "deprecated",
            "gemini-2.0-flash"
            | "gemini-2.0-flash-001"
            | "gemini-2.0-flash-lite"
            | "gemini-2.0-flash-lite-001" => "retired",
            _ => "available",
        };
        return (
            "verified",
            "verified",
            "Google Gemini model documentation: text/image input, text output",
            availability,
        );
    }
    (
        "verified",
        "unknown",
        "Gemini models.list generateContent; image modality not verified",
        "available",
    )
}

fn fetch_anthropic_models(api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    for page_index in 0..10 {
        let mut request = client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .query(&[("limit", "1000")]);
        if let Some(id) = after_id.as_deref() {
            request = request.query(&[("after_id", id)]);
        }
        let response = request
            .send()
            .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let data: Value = response
            .json()
            .map_err(|_| "invalid_response".to_string())?;
        if let Some(items) = data.get("data").and_then(Value::as_array) {
            for item in items {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let lifecycle = item
                    .get("lifecycle")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let image_supported = item
                    .get("capabilities")
                    .and_then(|caps| caps.get("image_input"))
                    .and_then(|image| image.get("supported"))
                    .and_then(Value::as_bool);
                let image = match image_supported {
                    Some(true) => "verified",
                    Some(false) => "unsupported",
                    None => "unknown",
                };
                let text = if lifecycle == "retired" { "retired" } else { "verified" };
                let label = item
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                let mut model = model_json(id, label, "anthropic", "provider-api", "API取得");
                model["lifecycle"] = Value::String(lifecycle.to_string());
                model["capability_source"] = Value::String(
                    "Anthropic Models API lifecycle/capabilities.image_input".to_string(),
                );
                model = model_with_capabilities(
                    model,
                    text,
                    image,
                    "Anthropic Models API lifecycle/capabilities.image_input",
                    lifecycle,
                );
                models.push(model);
            }
        }
        after_id = next_anthropic_page_id(&data);
        if after_id.is_none() {
            break;
        }
        if page_index == 9 {
            return Err("pagination_limit_reached".to_string());
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

fn next_anthropic_page_id(data: &Value) -> Option<String> {
    if !data.get("has_more").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    data.get("last_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn fetch_xai_models(api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    let response = client
        .get("https://api.x.ai/v1/language-models")
        .bearer_auth(api_key)
        .send()
        .map_err(|e| if e.is_timeout() { "timeout" } else { "transport_error" }.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let data: Value = response
        .json()
        .map_err(|_| "invalid_response".to_string())?;
    let items = data
        .get("models")
        .or_else(|| data.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let inputs = item.get("input_modalities").and_then(Value::as_array);
        let outputs = item.get("output_modalities").and_then(Value::as_array);
        let input_has = |name: &str| {
            inputs.is_some_and(|values| values.iter().any(|value| value.as_str() == Some(name)))
        };
        let text = if input_has("text") { "verified" } else { "unsupported" };
        let image = if input_has("image") { "verified" } else { "unsupported" };
        let mut model = model_json(id, id, "xai", "provider-api", "API取得");
        model["input_modalities"] = inputs.cloned().map(Value::Array).unwrap_or(Value::Null);
        model["output_modalities"] = outputs.cloned().map(Value::Array).unwrap_or(Value::Null);
        if let Some(efforts) = item
            .get("capabilities")
            .and_then(|value| value.get("reasoning_effort"))
            .and_then(Value::as_array)
        {
            model["reasoning_efforts"] = Value::Array(efforts.clone());
        }
        models.push(model_with_capabilities(
            model,
            text,
            image,
            "xAI language-models input_modalities/output_modalities",
            "available",
        ));
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

const TWSCRAPE_REQUIRED_VERSION: &str = "0.20.1";
const TWSCRAPE_REQUIREMENT: &str = "twscrape==0.20.1";
const LEGACY_TWSCRAPE_PATCH_SIGNATURE: &str =
    "async def _patched_parse_anim_idx(text: str) -> list:";

fn twscrape_version_check_script() -> &'static str {
    r#"
import importlib.metadata as metadata
import sys

try:
    installed = metadata.version("twscrape")
except metadata.PackageNotFoundError:
    print("twscrape is not installed", file=sys.stderr)
    raise SystemExit(1)
except Exception as error:
    print(f"twscrape version lookup failed: {type(error).__name__}", file=sys.stderr)
    raise SystemExit(1)

if installed == "0.20.1":
    raise SystemExit(0)

print(
    f"twscrape version must be exactly 0.20.1; found {installed!r}",
    file=sys.stderr,
)
raise SystemExit(1)
"#
}

fn upgrade_legacy_twscrape_patch_source(source: &str) -> Option<String> {
    // The other replacements are only safe for the old local patch.  In
    // particular, do not rewrite a current twscrape source just because it
    // happens to contain one of the old call forms.
    if !source
        .lines()
        .any(|line| line.trim() == LEGACY_TWSCRAPE_PATCH_SIGNATURE)
    {
        return None;
    }

    let upgraded = source
        .replace(
            LEGACY_TWSCRAPE_PATCH_SIGNATURE,
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
    let version_check = twscrape_version_check_script();
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
                TWSCRAPE_REQUIREMENT,
            ])
            .current_dir(project_root)
            .output()
            .map_err(|e| format!("twscrape対応版の自動更新を開始できませんでした: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "twscrape=={TWSCRAPE_REQUIRED_VERSION}の自動更新に失敗しました。ネットワーク接続を確認して再実行してください。\n{}",
                truncate_log_value(&stderr, 4000)
            ));
        }
    }

    // v0.1.5以前のPythonソースが残るEXE自動更新環境でも、旧パッチだけを移行する。
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
    let mut killer = match Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(killer) => killer,
        Err(_) => {
            let _ = child.kill();
            return;
        }
    };
    let deadline = Instant::now() + Duration::from_millis(BRIDGE_CLEANUP_WAIT_MS);
    loop {
        match killer.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = killer.kill();
                let _ = killer.wait();
                break;
            }
        }
    }
    let _ = child.kill();
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

type PythonBridgeCancellationRegistry = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

const POST_REPROCESS_WORK_BUDGET_MS: u64 = 600_000;
const POST_REPROCESS_BRIDGE_GRACE_MS: u64 = 20_000;
const POST_REPROCESS_BRIDGE_TIMEOUT_MS: u64 =
    POST_REPROCESS_WORK_BUDGET_MS + POST_REPROCESS_BRIDGE_GRACE_MS;
const BRIDGE_CLEANUP_WAIT_MS: u64 = 5_000;

#[derive(Default)]
struct PythonBridgeCancellationState {
    active_runs: PythonBridgeCancellationRegistry,
}

struct PythonBridgeRunRegistration {
    active_runs: PythonBridgeCancellationRegistry,
    run_id: String,
    cancellation: Arc<AtomicBool>,
}

impl PythonBridgeRunRegistration {
    fn cancellation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancellation)
    }
}

impl Drop for PythonBridgeRunRegistration {
    fn drop(&mut self) {
        let mut active_runs = match self.active_runs.lock() {
            Ok(active_runs) => active_runs,
            Err(poisoned) => poisoned.into_inner(),
        };
        if active_runs
            .get(&self.run_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancellation))
        {
            active_runs.remove(&self.run_id);
        }
    }
}

impl PythonBridgeCancellationState {
    fn register(&self, run_id: &str) -> Result<PythonBridgeRunRegistration, String> {
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut active_runs = match self.active_runs.lock() {
            Ok(active_runs) => active_runs,
            Err(poisoned) => poisoned.into_inner(),
        };
        if active_runs.contains_key(run_id) {
            return Err("Python bridge run is already active".to_string());
        }
        active_runs.insert(run_id.to_string(), Arc::clone(&cancellation));
        Ok(PythonBridgeRunRegistration {
            active_runs: Arc::clone(&self.active_runs),
            run_id: run_id.to_string(),
            cancellation,
        })
    }

    fn cancel(&self, run_id: &str) -> Value {
        let cancellation = match self.active_runs.lock() {
            Ok(active_runs) => active_runs.get(run_id).cloned(),
            Err(poisoned) => poisoned.into_inner().get(run_id).cloned(),
        };
        let acknowledged = cancellation.is_some();
        if let Some(cancellation) = cancellation {
            cancellation.store(true, Ordering::SeqCst);
        }

        let mut response = if acknowledged {
            json!({
                "ok": true,
                "acknowledged": true,
                "status": "cancellation_requested",
            })
        } else {
            json!({
                "ok": false,
                "acknowledged": false,
                "status": "unknown_run",
            })
        };
        if let Some(run_id) = safe_bridge_run_id(run_id) {
            response["run_id"] = Value::String(run_id.to_string());
        }
        response
    }
}

fn safe_bridge_run_id(run_id: &str) -> Option<&str> {
    if run_id.is_empty() || run_id.len() > 128 {
        return None;
    }
    if run_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Some(run_id)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PythonBridgeTermination {
    TimedOut,
    Cancelled,
}

fn python_bridge_termination(
    cancellation_requested: bool,
    timeout_reached: bool,
) -> Option<PythonBridgeTermination> {
    if cancellation_requested {
        Some(PythonBridgeTermination::Cancelled)
    } else if timeout_reached {
        Some(PythonBridgeTermination::TimedOut)
    } else {
        None
    }
}

fn python_bridge_termination_response(
    termination: PythonBridgeTermination,
    timeout_ms: u64,
    stderr: String,
    run_id: Option<&str>,
) -> Value {
    match termination {
        PythonBridgeTermination::TimedOut => {
            let mut response = json!({
                "ok": false,
                "timedOut": true,
                "cancelled": false,
                "exit_code": null,
                "stderr": stderr,
                "bridge": {
                    "status": "error",
                    "code": "timeout",
                    "error": format!("Timed out after {} ms", timeout_ms)
                }
            });
            if let Some(run_id) = run_id.and_then(safe_bridge_run_id) {
                response["run_id"] = Value::String(run_id.to_string());
            }
            response
        }
        PythonBridgeTermination::Cancelled => {
            let mut response = json!({
                "ok": false,
                "cancelled": true,
                "timedOut": false,
                "exit_code": null,
                "stderr": stderr,
                "bridge": {"status": "error", "code": "cancelled"}
            });
            if let Some(run_id) = run_id.and_then(safe_bridge_run_id) {
                response["run_id"] = Value::String(run_id.to_string());
            }
            response
        }
    }
}

struct PythonBridgeCleanupGuard {
    child: Option<Child>,
    payload_file: Option<PathBuf>,
    stderr_thread: Option<thread::JoinHandle<String>>,
    stdout_thread: Option<thread::JoinHandle<String>>,
    #[cfg(target_os = "windows")]
    process_job: Option<windows_process_job::ProcessJob>,
}

impl PythonBridgeCleanupGuard {
    fn new(payload_file: Option<PathBuf>) -> Self {
        Self {
            child: None,
            payload_file,
            stderr_thread: None,
            stdout_thread: None,
            #[cfg(target_os = "windows")]
            process_job: None,
        }
    }

    fn finish(mut self) -> Result<(String, String), String> {
        if let Some(child) = self.child.as_mut() {
            reap_bridge_child(child);
        }
        self.child.take();
        #[cfg(target_os = "windows")]
        {
            self.process_job.take();
        }

        let stderr = self
            .stderr_thread
            .take()
            .map(join_bridge_reader)
            .unwrap_or_default();
        let stdout = self
            .stdout_thread
            .take()
            .map(join_bridge_reader)
            .unwrap_or_default();
        Ok((stderr, stdout))
    }
}

impl Drop for PythonBridgeCleanupGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            terminate_process_tree(child);
        }
        #[cfg(target_os = "windows")]
        {
            self.process_job.take();
        }
        if let Some(child) = self.child.as_mut() {
            reap_bridge_child(child);
        }
        if let Some(reader) = self.stderr_thread.take() {
            let _ = join_bridge_reader(reader);
        }
        if let Some(reader) = self.stdout_thread.take() {
            let _ = join_bridge_reader(reader);
        }
        if let Some(payload_file) = self.payload_file.take() {
            let _ = fs::remove_file(payload_file);
        }
    }
}

fn reap_bridge_child(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_millis(BRIDGE_CLEANUP_WAIT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            _ => break,
        }
    }
    terminate_process_tree(child);
    let reap_deadline = Instant::now() + Duration::from_millis(BRIDGE_CLEANUP_WAIT_MS);
    while Instant::now() < reap_deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn join_bridge_reader(reader: thread::JoinHandle<String>) -> String {
    let deadline = Instant::now() + Duration::from_millis(BRIDGE_CLEANUP_WAIT_MS);
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    if reader.is_finished() {
        reader.join().unwrap_or_default()
    } else {
        // Dropping JoinHandle detaches the reader.  The child/process-job
        // cleanup above has already closed the only process tree we own, so
        // cleanup itself cannot wait forever on a descendant-held pipe.
        String::new()
    }
}

fn run_python_bridge_sync(
    window: tauri::Window,
    python_exe: String,
    project_root: String,
    job: String,
    payload: Value,
    timeout_ms: u64,
    cancellation: Option<Arc<AtomicBool>>,
    run_id: Option<String>,
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

    let mut cleanup = PythonBridgeCleanupGuard::new(payload_file);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute Python bridge: {e}"))?;
    cleanup.child = Some(child);
    PYTHON_BRIDGE_SPAWN_COUNT.fetch_add(1, Ordering::Relaxed);
    #[cfg(target_os = "windows")]
    {
        cleanup.process_job = match windows_process_job::ProcessJob::for_child(
            cleanup
                .child
                .as_ref()
                .expect("bridge child was just assigned"),
        ) {
            Ok(job) => Some(job),
            Err(e) => {
                append_internal_log(
                    &project_root,
                    &format!("run_python_bridge process job setup failed: {e}"),
                );
                None
            }
        };
    }
    let run_id_log = run_id
        .as_deref()
        .and_then(safe_bridge_run_id)
        .map(|run_id| format!(", run_id={run_id}"))
        .unwrap_or_default();
    append_internal_log(
        &project_root,
        &format!(
            "run_python_bridge start: job={job}, python={}, timeout_ms={timeout_ms}{run_id_log}",
            resolved_python,
        ),
    );

    // stderrを別スレッドで1行ずつ読み、Tauriイベントとして送信
    let stderr_pipe = cleanup
        .child
        .as_mut()
        .and_then(|child| child.stderr.take())
        .ok_or_else(|| "Failed to capture stderr".to_string())?;
    let stderr_thread = {
        let win = window.clone();
        thread::Builder::new()
            .spawn(move || {
                let reader = BufReader::new(stderr_pipe);
                const MAX_CHARS: usize = 24_000;
                let head_limit = MAX_CHARS / 3;
                let tail_limit = MAX_CHARS - head_limit;
                let mut head = Vec::new();
                let mut tail = VecDeque::new();
                let mut head_chars = 0usize;
                let mut tail_chars = 0usize;
                let mut total_chars = 0usize;
                for line in reader.lines() {
                    if let Ok(line) = line {
                        let _ = win.emit("pipeline-log", &line);
                        let line_chars = line.chars().count() + 1;
                        total_chars += line_chars;
                        if head_chars < head_limit {
                            head_chars += line_chars;
                            head.push(line);
                        } else {
                            tail_chars += line_chars;
                            tail.push_back(line);
                            while tail_chars > tail_limit {
                                if let Some(removed) = tail.pop_front() {
                                    tail_chars = tail_chars.saturating_sub(removed.chars().count() + 1);
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                }
                if total_chars <= MAX_CHARS {
                    head.into_iter().chain(tail).collect::<Vec<_>>().join("\n")
                } else {
                    let marker = format!("…<middle truncated total_chars={total_chars}>…");
                    head.into_iter()
                        .chain(std::iter::once(marker))
                        .chain(tail)
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            })
            .map_err(|e| format!("Failed to start stderr reader: {e}"))?
    };
    cleanup.stderr_thread = Some(stderr_thread);

    // stdoutを別スレッドで読み取り（デッドロック防止）
    let stdout_pipe = cleanup
        .child
        .as_mut()
        .and_then(|child| child.stdout.take())
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stdout_thread = thread::Builder::new()
        .spawn(move || {
            let mut buf = String::new();
            let mut reader = BufReader::new(stdout_pipe);
            let _ = reader.read_to_string(&mut buf);
            buf
        })
        .map_err(|e| format!("Failed to start stdout reader: {e}"))?;
    cleanup.stdout_thread = Some(stdout_thread);

    // タイムアウト付きでプロセス完了を待つ
    let start = Instant::now();
    let mut bridge_process_exit_code: Option<i32> = None;
    let termination = loop {
        let cancellation_requested = cancellation
            .as_ref()
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false);
        let timeout_reached = start.elapsed() > Duration::from_millis(timeout_ms);

        if let Some(termination) =
            python_bridge_termination(cancellation_requested, timeout_reached)
        {
            terminate_process_tree(
                cleanup
                    .child
                    .as_mut()
                    .expect("bridge child was just assigned"),
            );
            break Some(termination);
        }

        match cleanup
            .child
            .as_mut()
            .expect("bridge child was just assigned")
            .try_wait()
        {
            Ok(Some(status)) => {
                bridge_process_exit_code = status.code();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Failed while waiting for Python bridge: {e}")),
        }
    };

    let (stderr, stdout) = cleanup.finish()?;
    let stdout = stdout.trim().to_string();
    let timed_out = termination == Some(PythonBridgeTermination::TimedOut);
    let cancelled = termination == Some(PythonBridgeTermination::Cancelled);
    let parsed_output = serde_json::from_str::<Value>(&stdout).ok();
    let pipeline_returncode = parsed_output
        .as_ref()
        .and_then(|value| value.get("returncode"))
        .and_then(Value::as_i64);
    let event_key = parsed_output
        .as_ref()
        .and_then(|value| value.get("diagnostic"))
        .and_then(|value| value.get("event"))
        .and_then(|value| value.get("event_key"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    append_internal_log(
        &project_root,
        &format!(
            "run_python_bridge finished: job={job}, timed_out={timed_out}, cancelled={cancelled}, bridge_exit_code={bridge_process_exit_code:?}, pipeline_returncode={pipeline_returncode:?}, event_key={event_key}{run_id_log}, stderr=\n{}\nstdout=\n{}",
            truncate_log_value(&stderr, 12000),
            truncate_log_value(&stdout, 12000)
        ),
    );

    if let Some(termination) = termination {
        return Ok(python_bridge_termination_response(
            termination,
            timeout_ms,
            stderr,
            run_id.as_deref(),
        ));
    }

    if stdout.is_empty() {
        return Err(format!(
            "Python bridge returned empty stdout. stderr: {stderr}"
        ));
    }

    let parsed = parsed_output.ok_or_else(|| {
        format!(
            "Invalid JSON from bridge; stdout={}",
            truncate_log_value(&stdout, 24000)
        )
    })?;

    Ok(json!({
        "ok": parsed.get("status").and_then(|s| s.as_str()) == Some("ok"),
        "timedOut": false,
        "cancelled": false,
        "exit_code": parsed.get("returncode"),
        "bridge": parsed,
        "stderr": stderr,
    }))
}

#[cfg(test)]
mod python_bridge_cancellation_tests {
    use super::*;

    #[test]
    fn registry_acknowledges_cancel_and_removes_run_on_drop() {
        let state = PythonBridgeCancellationState::default();
        let registration = state.register("run-1").unwrap();
        let cancellation = registration.cancellation_flag();

        assert!(!cancellation.load(Ordering::SeqCst));
        let acknowledgement = state.cancel("run-1");
        assert_eq!(acknowledgement["ok"], true);
        assert_eq!(acknowledgement["acknowledged"], true);
        assert_eq!(acknowledgement["status"], "cancellation_requested");
        assert!(cancellation.load(Ordering::SeqCst));

        drop(registration);
        let unknown = state.cancel("run-1");
        assert_eq!(unknown["ok"], false);
        assert_eq!(unknown["acknowledged"], false);
        assert_eq!(unknown["status"], "unknown_run");
    }

    #[test]
    fn unknown_run_cancel_is_safe() {
        let state = PythonBridgeCancellationState::default();

        let response = state.cancel("missing-run");

        assert_eq!(response["ok"], false);
        assert_eq!(response["acknowledged"], false);
        assert_eq!(response["status"], "unknown_run");
    }

    #[test]
    fn timeout_and_cancel_use_one_exclusive_termination_decision() {
        assert_eq!(
            python_bridge_termination(false, true),
            Some(PythonBridgeTermination::TimedOut)
        );
        assert_eq!(
            python_bridge_termination(true, false),
            Some(PythonBridgeTermination::Cancelled)
        );
        assert_eq!(
            python_bridge_termination(true, true),
            Some(PythonBridgeTermination::Cancelled)
        );
        assert_eq!(python_bridge_termination(false, false), None);

        let timeout = python_bridge_termination_response(
            PythonBridgeTermination::TimedOut,
            100,
            String::new(),
            Some("run-1"),
        );
        assert_eq!(timeout["ok"], false);
        assert_eq!(timeout["timedOut"], true);
        assert!(!timeout["cancelled"].as_bool().unwrap_or(false));
        assert_eq!(timeout["bridge"]["code"], "timeout");
        assert_eq!(timeout["run_id"], "run-1");

        let cancelled = python_bridge_termination_response(
            PythonBridgeTermination::Cancelled,
            100,
            String::new(),
            Some("run-1"),
        );
        assert_eq!(cancelled["ok"], false);
        assert_eq!(cancelled["cancelled"], true);
        assert_eq!(cancelled["timedOut"], false);
        assert_eq!(cancelled["bridge"]["status"], "error");
        assert_eq!(cancelled["bridge"]["code"], "cancelled");
        assert_eq!(cancelled["run_id"], "run-1");
    }
}

const COOKIE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const COOKIE_DOMAIN_SAMPLE_LIMIT: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CookieValidationCode {
    Missing,
    Directory,
    Unsupported,
    EmptyOrInvalid,
    TooLarge,
    Unreadable,
    StageUnavailable,
    StageNotAllowed,
}

impl CookieValidationCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "cookie_missing",
            Self::Directory => "cookie_directory",
            Self::Unsupported => "cookie_unsupported",
            Self::EmptyOrInvalid => "cookie_empty_or_invalid",
            Self::TooLarge => "cookie_too_large",
            Self::Unreadable => "cookie_unreadable",
            Self::StageUnavailable => "cookie_stage_unavailable",
            Self::StageNotAllowed => "cookie_stage_not_allowed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CookieExpiryStatus {
    Session,
    Expired,
    Future,
    Mixed,
}

impl CookieExpiryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Expired => "expired",
            Self::Future => "future",
            Self::Mixed => "mixed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CookieExpirySummary {
    status: CookieExpiryStatus,
    session_count: usize,
    expired_count: usize,
    future_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CookieValidationSummary {
    cookie_count: usize,
    domain_count: usize,
    domains: Vec<String>,
    expiry: CookieExpirySummary,
}

#[derive(Default)]
struct CookieStageRegistry {
    root: Option<PathBuf>,
    allowed_paths: HashSet<PathBuf>,
}

#[derive(Default)]
struct CookieStageState {
    registry: Mutex<CookieStageRegistry>,
}

#[cfg(target_os = "windows")]
mod windows_cookie_acl {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::mem;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS,
        ERROR_INSUFFICIENT_BUFFER, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, AddAccessAllowedAceEx, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
        InitializeAcl, InitializeSecurityDescriptor, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, TokenUser, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERITED_ACE, OBJECT_INHERIT_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
        SECURITY_DESCRIPTOR, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>, ()> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.iter().any(|value| *value == 0) {
            return Err(());
        }
        wide.push(0);
        Ok(wide)
    }

    fn current_user_sid() -> Result<Vec<u8>, ()> {
        let mut token: HANDLE = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(());
        }
        let token = OwnedHandle(token);
        let mut required = 0u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required);
        }
        if required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(());
        }
        let mut token_user_buffer = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_user_buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(());
        }
        let token_user = unsafe { &*(token_user_buffer.as_ptr().cast::<TOKEN_USER>()) };
        let sid_len = unsafe { GetLengthSid(token_user.User.Sid) };
        if sid_len == 0 {
            return Err(());
        }
        let mut sid = vec![0u8; sid_len as usize];
        unsafe {
            ptr::copy_nonoverlapping(
                token_user.User.Sid.cast::<u8>(),
                sid.as_mut_ptr(),
                sid_len as usize,
            );
        }
        Ok(sid)
    }

    struct PrivateSecurity {
        descriptor: Box<SECURITY_DESCRIPTOR>,
        _acl: Vec<u64>,
        user_sid: Vec<u8>,
    }

    impl PrivateSecurity {
        fn new(for_directory: bool) -> Result<Self, ()> {
            let mut user_sid = current_user_sid()?;
            let sid_len = user_sid.len();
            let acl_bytes = mem::size_of::<ACL>()
                .checked_add(mem::size_of::<
                    windows_sys::Win32::Security::ACCESS_ALLOWED_ACE,
                >())
                .and_then(|value| value.checked_sub(mem::size_of::<u32>()))
                .and_then(|value| value.checked_add(sid_len))
                .ok_or(())?;
            if acl_bytes > u16::MAX as usize {
                return Err(());
            }
            let acl_words =
                acl_bytes.checked_add(mem::size_of::<u64>() - 1).ok_or(())? / mem::size_of::<u64>();
            let mut acl = vec![0u64; acl_words];
            let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
            if unsafe { InitializeAcl(acl_ptr, acl_bytes as u32, ACL_REVISION) } == 0 {
                return Err(());
            }
            let inherit_flags = if for_directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            if unsafe {
                AddAccessAllowedAceEx(
                    acl_ptr,
                    ACL_REVISION,
                    inherit_flags,
                    FILE_ALL_ACCESS,
                    user_sid.as_mut_ptr().cast::<c_void>(),
                )
            } == 0
            {
                return Err(());
            }
            let mut descriptor = Box::new(SECURITY_DESCRIPTOR::default());
            if unsafe {
                InitializeSecurityDescriptor(
                    descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR,
                    1,
                )
            } == 0
            {
                return Err(());
            }
            if unsafe {
                SetSecurityDescriptorDacl(
                    descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR,
                    1,
                    acl_ptr,
                    0,
                )
            } == 0
            {
                return Err(());
            }
            if unsafe {
                SetSecurityDescriptorControl(
                    descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as PSECURITY_DESCRIPTOR,
                    SE_DACL_PROTECTED,
                    SE_DACL_PROTECTED,
                )
            } == 0
            {
                return Err(());
            }
            Ok(Self {
                descriptor,
                _acl: acl,
                user_sid,
            })
        }

        fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as _,
                bInheritHandle: 0,
            }
        }

        fn user_sid(&self) -> PSID {
            self.user_sid.as_ptr() as PSID
        }
    }

    fn verify_private_descriptor(
        descriptor: PSECURITY_DESCRIPTOR,
        expected_user_sid: PSID,
        expect_directory_inheritance: Option<bool>,
    ) -> Result<(), ()> {
        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) }
            == 0
            || present == 0
            || acl.is_null()
        {
            return Err(());
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                acl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || info.AceCount != 1
        {
            return Err(());
        }
        let mut ace: *mut c_void = ptr::null_mut();
        if unsafe { GetAce(acl, 0, &mut ace) } == 0 || ace.is_null() {
            return Err(());
        }
        let ace = ace.cast::<windows_sys::Win32::Security::ACCESS_ALLOWED_ACE>();
        let header = unsafe { (*ace).Header };
        if header.AceType != 0
            || u32::from(header.AceFlags) & INHERITED_ACE != 0
            || unsafe { (*ace).Mask } != FILE_ALL_ACCESS
        {
            return Err(());
        }
        if let Some(expect_directory_inheritance) = expect_directory_inheritance {
            let inheritance =
                u32::from(header.AceFlags) & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
            let expected = if expect_directory_inheritance {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            if inheritance != expected {
                return Err(());
            }
        }
        let sid = unsafe { &mut (*ace).SidStart as *mut u32 as PSID };
        let sid_len = unsafe { GetLengthSid(sid) };
        let expected_len = unsafe { GetLengthSid(expected_user_sid) };
        if sid_len == 0
            || sid_len != expected_len
            || unsafe {
                std::slice::from_raw_parts(sid.cast::<u8>(), sid_len as usize)
                    != std::slice::from_raw_parts(expected_user_sid.cast::<u8>(), sid_len as usize)
            }
        {
            return Err(());
        }
        Ok(())
    }

    fn verify_private_path(
        path: &Path,
        expected_user_sid: PSID,
        expect_directory_inheritance: Option<bool>,
    ) -> Result<(), ()> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};

        let wide = wide_path(path)?;
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let result = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if result != 0 || descriptor.is_null() {
            return Err(());
        }
        let verified =
            verify_private_descriptor(descriptor, expected_user_sid, expect_directory_inheritance);
        unsafe {
            LocalFree(descriptor as _);
        }
        verified
    }

    fn protect_path_dacl(path: &Path, acl: *const ACL) -> Result<(), ()> {
        use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};

        let wide = wide_path(path)?;
        let result = unsafe {
            SetNamedSecurityInfoW(
                wide.as_ptr() as *mut u16,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null_mut(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(())
        }
    }

    pub(super) fn create_private_directory(path: &Path) -> io::Result<()> {
        let mut security = PrivateSecurity::new(true).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("private ACL unavailable: {}", io::Error::last_os_error()),
            )
        })?;
        let mut attributes = security.attributes();
        let wide = wide_path(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        if unsafe { CreateDirectoryW(wide.as_ptr(), &mut attributes) } == 0 {
            let error = unsafe { GetLastError() };
            let kind = if error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS {
                io::ErrorKind::AlreadyExists
            } else {
                io::ErrorKind::Other
            };
            return Err(io::Error::new(
                kind,
                format!("CreateDirectoryW failed: {error}"),
            ));
        }
        if protect_path_dacl(path, security._acl.as_ptr().cast()).is_err()
            || verify_private_path(path, security.user_sid(), Some(true)).is_err()
        {
            let _ = std::fs::remove_dir(path);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private directory ACL verification failed",
            ));
        }
        Ok(())
    }

    pub(super) fn create_private_file(path: &Path) -> io::Result<File> {
        let mut security = PrivateSecurity::new(false).map_err(|_| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("private ACL unavailable: {}", io::Error::last_os_error()),
            )
        })?;
        let mut attributes = security.attributes();
        let wide = wide_path(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_ALL_ACCESS,
                0,
                &mut attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = unsafe { GetLastError() };
            let kind = if error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS {
                io::ErrorKind::AlreadyExists
            } else {
                io::ErrorKind::Other
            };
            return Err(io::Error::new(kind, format!("CreateFileW failed: {error}")));
        }
        let file = unsafe { File::from_raw_handle(handle) };
        if protect_path_dacl(path, security._acl.as_ptr().cast()).is_err()
            || verify_private_path(path, security.user_sid(), Some(false)).is_err()
        {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private file ACL verification failed",
            ));
        }
        Ok(file)
    }

    #[cfg(test)]
    pub(super) fn assert_private_path(path: &Path, is_directory: bool) {
        let sid = current_user_sid().expect("current user SID");
        verify_private_path(path, sid.as_ptr() as PSID, Some(is_directory))
            .expect("protected current-user-only DACL");
    }
}

impl CookieStageState {
    fn lock_registry(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, CookieStageRegistry>, CookieValidationCode> {
        self.registry
            .lock()
            .map_err(|_| CookieValidationCode::StageUnavailable)
    }

    fn stage(&self, contents: &[u8]) -> Result<PathBuf, CookieValidationCode> {
        let mut registry = self.lock_registry()?;
        let root = match registry.root.as_ref() {
            Some(root) => root.clone(),
            None => {
                let root = create_private_cookie_stage_root()?;
                registry.root = Some(root.clone());
                root
            }
        };

        for _ in 0..128 {
            let path = root.join(format!("cookie-{}.txt", next_cookie_stage_token()));
            #[cfg(target_os = "windows")]
            let mut file = match windows_cookie_acl::create_private_file(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    let _ = fs::remove_dir_all(&root);
                    registry.root = None;
                    registry.allowed_paths.clear();
                    return Err(CookieValidationCode::StageUnavailable);
                }
            };
            #[cfg(not(target_os = "windows"))]
            let mut file = {
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                match options.open(&path) {
                    Ok(file) => file,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => return Err(CookieValidationCode::StageUnavailable),
                }
            };
            if file
                .write_all(contents)
                .and_then(|_| file.sync_all())
                .is_err()
            {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(CookieValidationCode::StageUnavailable);
            }
            registry.allowed_paths.insert(path.clone());
            return Ok(path);
        }
        Err(CookieValidationCode::StageUnavailable)
    }

    fn cleanup_path(&self, path: &Path) -> Result<(), CookieValidationCode> {
        let mut registry = self.lock_registry()?;
        if !registry.allowed_paths.contains(path) {
            return Err(CookieValidationCode::StageNotAllowed);
        }
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(CookieValidationCode::StageUnavailable),
        }
        registry.allowed_paths.remove(path);
        Ok(())
    }

    fn cleanup_all(&self) -> Result<(), CookieValidationCode> {
        let mut registry = self.lock_registry()?;
        let Some(root) = registry.root.take() else {
            registry.allowed_paths.clear();
            return Ok(());
        };
        match fs::remove_dir_all(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                registry.root = Some(root);
                return Err(CookieValidationCode::StageUnavailable);
            }
        }
        registry.allowed_paths.clear();
        Ok(())
    }
}

impl Drop for CookieStageState {
    fn drop(&mut self) {
        let registry = match self.registry.get_mut() {
            Ok(registry) => registry,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(root) = registry.root.take() {
            let _ = fs::remove_dir_all(root);
        }
        registry.allowed_paths.clear();
    }
}

fn next_cookie_stage_token() -> String {
    let counter = COOKIE_STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, counter)
}

fn create_private_cookie_stage_root() -> Result<PathBuf, CookieValidationCode> {
    for _ in 0..128 {
        let root = env::temp_dir().join(format!(
            ".event-autopin-cookie-stage-{}",
            next_cookie_stage_token()
        ));
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(target_os = "windows")]
        let created = windows_cookie_acl::create_private_directory(&root);
        #[cfg(not(target_os = "windows"))]
        let created = builder.create(&root);
        match created {
            Ok(()) => return Ok(root),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(CookieValidationCode::StageUnavailable),
        }
    }
    Err(CookieValidationCode::StageUnavailable)
}

fn safe_cookie_basename(path: &Path) -> String {
    let value = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("選択済みCookieファイル"));
    let sanitized: String = value
        .chars()
        .filter(|ch| !ch.is_control() && *ch != '/' && *ch != '\\')
        .take(128)
        .collect();
    if sanitized.is_empty() {
        "選択済みCookieファイル".to_string()
    } else {
        sanitized
    }
}

fn current_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

fn normalize_cookie_domain(domain: &str) -> String {
    domain.trim_start_matches('.').to_lowercase()
}

fn validate_netscape_cookie_contents_at(
    content: &[u8],
    now_epoch_seconds: i64,
) -> Result<CookieValidationSummary, CookieValidationCode> {
    if content.is_empty() || content.len() as u64 > COOKIE_MAX_BYTES {
        return Err(if content.len() as u64 > COOKIE_MAX_BYTES {
            CookieValidationCode::TooLarge
        } else {
            CookieValidationCode::EmptyOrInvalid
        });
    }
    let text = std::str::from_utf8(content).map_err(|_| CookieValidationCode::EmptyOrInvalid)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut cookie_count = 0usize;
    let mut domain_set = HashSet::new();
    let mut domains = Vec::new();
    let mut session_count = 0usize;
    let mut expired_count = 0usize;
    let mut future_count = 0usize;
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let trimmed_start = line.trim_start();
        let candidate = if let Some(http_only) = line.strip_prefix("#HttpOnly_") {
            http_only
        } else if trimmed_start.starts_with('#') || trimmed_start.starts_with('$') {
            continue;
        } else {
            line
        };
        let fields: Vec<&str> = candidate.split('\t').collect();
        if fields.len() != 7 {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        let domain = fields[0].trim();
        if domain.is_empty() || domain != fields[0] || domain.chars().any(char::is_whitespace) {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        let include_subdomains = fields[1];
        if !matches!(include_subdomains, "TRUE" | "FALSE")
            || (include_subdomains == "TRUE") != domain.starts_with('.')
        {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        if !fields[2].starts_with('/') || fields[2].is_empty() {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        if !matches!(fields[3], "TRUE" | "FALSE") {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        let normalized_domain = normalize_cookie_domain(domain);
        if normalized_domain.is_empty()
            || normalized_domain.chars().count() > 253
            || normalized_domain
                .chars()
                .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        {
            return Err(CookieValidationCode::EmptyOrInvalid);
        }
        if domain_set.insert(normalized_domain.clone())
            && domains.len() < COOKIE_DOMAIN_SAMPLE_LIMIT
        {
            domains.push(normalized_domain);
        }
        // An empty expiry denotes a session cookie and is accepted by
        // MozillaCookieJar (the Python trust-boundary parser). Keep the
        // seven-column Netscape contract while preserving that compatibility;
        // the cookie name may likewise be empty, as MozillaCookieJar accepts
        // it and the existing loader historically did not reject it.
        if fields[4].is_empty() {
            session_count += 1;
        } else {
            let expiry = fields[4]
                .parse::<i64>()
                .map_err(|_| CookieValidationCode::EmptyOrInvalid)?;
            if expiry <= now_epoch_seconds {
                expired_count += 1;
            } else {
                future_count += 1;
            }
        }
        cookie_count += 1;
    }
    if cookie_count == 0 {
        return Err(CookieValidationCode::EmptyOrInvalid);
    }
    let non_empty_expiry_kinds = usize::from(session_count > 0)
        + usize::from(expired_count > 0)
        + usize::from(future_count > 0);
    let status = if non_empty_expiry_kinds > 1 {
        CookieExpiryStatus::Mixed
    } else if session_count > 0 {
        CookieExpiryStatus::Session
    } else if expired_count > 0 {
        CookieExpiryStatus::Expired
    } else {
        CookieExpiryStatus::Future
    };
    Ok(CookieValidationSummary {
        cookie_count,
        domain_count: domain_set.len(),
        domains,
        expiry: CookieExpirySummary {
            status,
            session_count,
            expired_count,
            future_count,
        },
    })
}

fn validate_netscape_cookie_contents(
    content: &[u8],
) -> Result<CookieValidationSummary, CookieValidationCode> {
    validate_netscape_cookie_contents_at(content, current_epoch_seconds())
}

fn validate_cookie_path(path: &Path) -> Result<CookieValidationSummary, CookieValidationCode> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CookieValidationCode::Missing)
        }
        Err(_) => return Err(CookieValidationCode::Unreadable),
    };
    if metadata.is_dir() {
        return Err(CookieValidationCode::Directory);
    }
    if !metadata.is_file() {
        return Err(CookieValidationCode::Unreadable);
    }
    if path
        .extension()
        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("txt"))
        != Some(true)
    {
        return Err(CookieValidationCode::Unsupported);
    }
    if metadata.len() == 0 {
        return Err(CookieValidationCode::EmptyOrInvalid);
    }
    if metadata.len() > COOKIE_MAX_BYTES {
        return Err(CookieValidationCode::TooLarge);
    }
    let file = fs::File::open(path).map_err(|_| CookieValidationCode::Unreadable)?;
    let mut content = Vec::new();
    file.take(COOKIE_MAX_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|_| CookieValidationCode::Unreadable)?;
    validate_netscape_cookie_contents(&content)
}

fn cookie_validation_response(basename: String, summary: &CookieValidationSummary) -> Value {
    json!({
        "ok": true,
        "basename": basename,
        "exists": true,
        "readable": true,
        "cookieCount": summary.cookie_count,
        "domainCount": summary.domain_count,
        "domains": summary.domains,
        "expiry": {
            "status": summary.expiry.status.as_str(),
            "sessionCount": summary.expiry.session_count,
            "expiredCount": summary.expiry.expired_count,
            "futureCount": summary.expiry.future_count,
        },
    })
}

#[tauri::command]
fn validate_cookie_file(file_path: String) -> Result<Value, String> {
    let path = PathBuf::from(file_path.trim());
    let summary = validate_cookie_path(&path).map_err(|code| code.as_str().to_string())?;
    Ok(cookie_validation_response(
        safe_cookie_basename(&path),
        &summary,
    ))
}

#[tauri::command]
fn stage_cookie_file(
    file_name: String,
    contents: Vec<u8>,
    state: tauri::State<'_, CookieStageState>,
) -> Result<Value, String> {
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err(CookieValidationCode::Missing.as_str().to_string());
    }
    let source_name = Path::new(file_name);
    if source_name
        .extension()
        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("txt"))
        != Some(true)
    {
        return Err(CookieValidationCode::Unsupported.as_str().to_string());
    }
    validate_netscape_cookie_contents(&contents).map_err(|code| code.as_str().to_string())?;
    let staged_path = state
        .stage(&contents)
        .map_err(|code| code.as_str().to_string())?;
    let summary = match validate_cookie_path(&staged_path) {
        Ok(summary) => summary,
        Err(code) => {
            let _ = state.cleanup_path(&staged_path);
            return Err(code.as_str().to_string());
        }
    };
    let mut response = cookie_validation_response(safe_cookie_basename(source_name), &summary);
    response["path"] = Value::String(staged_path.to_string_lossy().into_owned());
    Ok(response)
}

#[tauri::command]
fn cleanup_staged_cookie_file(
    staged_path: String,
    state: tauri::State<'_, CookieStageState>,
) -> Result<(), String> {
    state
        .cleanup_path(Path::new(&staged_path))
        .map_err(|code| code.as_str().to_string())
}

#[tauri::command]
fn cleanup_cookie_stages(state: tauri::State<'_, CookieStageState>) -> Result<(), String> {
    state
        .cleanup_all()
        .map_err(|code| code.as_str().to_string())
}

#[tauri::command]
async fn run_python_bridge(
    window: tauri::Window,
    python_exe: String,
    project_root: String,
    job: String,
    payload: Value,
    timeout_ms: u64,
    state: tauri::State<'_, PythonBridgeCancellationState>,
) -> Result<Value, String> {
    let run_id = payload
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .and_then(safe_bridge_run_id)
        .map(str::to_string);
    let effective_timeout_ms = if job == "reprocess_circle_from_post" {
        timeout_ms.min(POST_REPROCESS_BRIDGE_TIMEOUT_MS)
    } else {
        timeout_ms
    };
    let registration = match run_id.as_deref() {
        Some(run_id) => Some(state.register(run_id)?),
        None => None,
    };
    let cancellation = registration
        .as_ref()
        .map(PythonBridgeRunRegistration::cancellation_flag);

    tokio::task::spawn_blocking(move || {
        let _registration = registration;
        run_python_bridge_sync(
            window,
            python_exe,
            project_root,
            job,
            payload,
            effective_timeout_ms,
            cancellation,
            run_id,
        )
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

fn cancel_python_bridge_impl(
    run_id: String,
    state: tauri::State<'_, PythonBridgeCancellationState>,
) -> Result<Value, String> {
    Ok(state.cancel(&run_id))
}

#[tauri::command]
fn cancel_reprocess_bridge(
    run_id: String,
    state: tauri::State<'_, PythonBridgeCancellationState>,
) -> Result<Value, String> {
    cancel_python_bridge_impl(run_id, state)
}

#[tauri::command]
fn cancel_python_bridge(
    run_id: String,
    state: tauri::State<'_, PythonBridgeCancellationState>,
) -> Result<Value, String> {
    cancel_python_bridge_impl(run_id, state)
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
    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return value.to_string();
    }
    if max_chars <= 64 {
        return value.chars().take(max_chars).collect();
    }
    let marker = format!("\n…<truncated total_chars={total_chars}>…\n");
    let remaining = max_chars.saturating_sub(marker.chars().count());
    let head_chars = remaining / 3;
    let tail_chars = remaining.saturating_sub(head_chars);
    let head: String = value.chars().take(head_chars).collect();
    let tail: String = value
        .chars()
        .skip(total_chars.saturating_sub(tail_chars))
        .collect();
    format!("{head}{marker}{tail}")
}

#[cfg(test)]
mod bounded_diagnostic_log_tests {
    use super::truncate_log_value;

    #[test]
    fn bounded_log_keeps_both_start_and_exception_tail() {
        let value = format!("START:{}:Traceback (most recent call last): KeyError('tail')", "x".repeat(500));
        let bounded = truncate_log_value(&value, 180);
        assert!(bounded.starts_with("START:"));
        assert!(bounded.ends_with("KeyError('tail')"));
        assert!(bounded.contains("truncated total_chars="));
        assert!(bounded.chars().count() <= 180);
    }
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
enum EventMapReferenceInput {
    Legacy(String),
    Detailed {
        #[serde(alias = "filename")]
        reference: Option<String>,
        map_number: Option<u32>,
    },
}

fn normalize_event_map_reference(reference: &str) -> Option<String> {
    let normalized = reference
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.ends_with('/')
        || normalized.contains("://")
    {
        return None;
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let components: Vec<&str> = normalized.split('/').collect();
    if components.iter().any(|component| {
        component.is_empty()
            || *component == "."
            || *component == ".."
            || component.contains(':')
    }) {
        return None;
    }
    Some(components.join("/"))
}

fn legacy_map_number_from_name(name: &str) -> Option<u32> {
    let basename = name.replace('\\', "/");
    let basename = basename.rsplit('/').next().unwrap_or(&basename);
    let lowered = basename.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(relative) = lowered[search_from..].find("map_") {
        let start = search_from + relative;
        if start == 0 || !lowered.as_bytes()[start - 1].is_ascii_alphanumeric() {
            let digits_start = start + 4;
            let digit_count = lowered[digits_start..]
                .as_bytes()
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digit_count > 0 {
                if let Ok(number) = lowered[digits_start..digits_start + digit_count].parse() {
                    if number > 0 {
                        return Some(number);
                    }
                }
            }
        }
        search_from = start + 4;
        if search_from >= lowered.len() {
            break;
        }
    }
    None
}

fn event_map_reference_parts(
    input: &EventMapReferenceInput,
) -> Option<(String, Option<u32>)> {
    let (reference, explicit_number) = match input {
        EventMapReferenceInput::Legacy(reference) => (reference.clone(), None),
        EventMapReferenceInput::Detailed {
            reference,
            map_number,
        } => (reference.clone()?, *map_number),
    };
    let reference = normalize_event_map_reference(&reference)?;
    let number = explicit_number
        .filter(|number| *number > 0)
        .or_else(|| legacy_map_number_from_name(&reference));
    Some((reference, number))
}

/// Return event-level map references with their explicit numbers preserved.
/// Reading the raw `Value` keeps unknown event fields and legacy map shapes intact.
fn preferred_event_map_references_from_data(data: &Value) -> Vec<EventMapReferenceInput> {
    let Some(maps) = data
        .get("event")
        .and_then(|event| event.get("maps"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    maps.iter()
        .filter_map(|entry| {
            if let Some(reference) = entry.as_str() {
                return Some(EventMapReferenceInput::Legacy(reference.to_string()));
            }
            let object = entry.as_object()?;
            let reference = object
                .get("filename")
                .or_else(|| object.get("reference"))
                .and_then(Value::as_str)?;
            Some(EventMapReferenceInput::Detailed {
                reference: Some(reference.to_string()),
                map_number: object
                    .get("map_number")
                    .and_then(Value::as_u64)
                    .and_then(|number| u32::try_from(number).ok()),
            })
        })
        .collect()
}

fn event_meta_from_full_json(full: &Value, event_dir: &Path) -> Value {
    // Keep the same metadata projection used by list_event_dirs while returning
    // the complete raw document separately.  `metadata` itself is never
    // replaced or discarded, so source/purchase additions remain round-trippable.
    let mut meta = full.get("event").cloned().unwrap_or_else(|| json!({}));
    if let Some(metadata) = full.get("metadata") {
        if let Some(source) = metadata.get("source") {
            meta["source"] = source.clone();
        }
        if let Some(purchase_results) = metadata.get("purchase_results") {
            meta["purchase_results"] = purchase_results.clone();
        }
    }
    normalize_event_meta_for_dir(meta, event_dir)
}

// Keep this list in lockstep with the desktop event-meta projection.  Fields
// outside this list belong to the raw event document (maps, image references,
// provider-specific extensions, etc.) and must never be replaced by a metadata
// form write.
const EVENT_META_KEYS: &[&str] = &[
    "name",
    "date",
    "venue",
    "event_url",
    "event_urls",
    "url",
    "map_url",
    "map_config",
    "additional_prompt",
    "created_at",
    "source",
    "memo",
    "completed",
    "shopping_started_at",
    "shopping_ended_at",
    "event_image",
    "purchase_results",
];

fn merge_event_meta_preserving_unknown(existing: &mut Value, incoming: Value) {
    let incoming = normalize_event_meta_aliases(incoming);
    let Some(incoming_object) = incoming.as_object() else {
        return;
    };
    if !existing.is_object() {
        *existing = json!({});
    }
    let Some(existing_object) = existing.as_object_mut() else {
        return;
    };

    // Apply only keys present in the metadata patch.  Missing keys are not a
    // request to clear anything: callers may be editing a non-active event and
    // only have the projected metadata available.  A JSON null explicitly
    // clears a known key.  Unknown/raw keys in the existing event object remain
    // untouched in either case.
    for key in EVENT_META_KEYS {
        if let Some(value) = incoming_object.get(*key) {
            if value.is_null() {
                existing_object.remove(*key);
            } else {
                existing_object.insert((*key).to_string(), value.clone());
            }
        }
    }
}

fn event_content_hash(bytes: &[u8]) -> String {
    // FNV-1a is intentionally used as a fast change fingerprint, not as a
    // security digest.  Python bridge jobs use the same algorithm for their
    // base fingerprint, while native CAS always compares a freshly read file.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn event_document_fingerprint(path: &Path) -> Result<Value, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("event.json metadata取得失敗: {error}"))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("event.json modified time取得失敗: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("event.json modified timeが不正です: {error}"))?;
    let bytes = fs::read(path).map_err(|error| format!("event.json読み込み失敗: {error}"))?;
    Ok(json!({
        "modified_ms": modified.as_millis() as u64,
        "modified_ns": modified.as_nanos().min(u128::from(u64::MAX)) as u64,
        "file_size": metadata.len(),
        "content_hash": event_content_hash(&bytes),
    }))
}

fn fingerprint_matches(expected: &Value, actual: &Value) -> bool {
    let expected_hash = expected.get("content_hash").and_then(Value::as_str);
    let actual_hash = actual.get("content_hash").and_then(Value::as_str);
    if let (Some(expected_hash), Some(actual_hash)) = (expected_hash, actual_hash) {
        return expected_hash == actual_hash;
    }
    let expected_ns = expected.get("modified_ns").and_then(Value::as_u64);
    let actual_ns = actual.get("modified_ns").and_then(Value::as_u64);
    if let (Some(expected_ns), Some(actual_ns)) = (expected_ns, actual_ns) {
        return expected_ns == actual_ns
            && expected.get("file_size").and_then(Value::as_u64)
                == actual.get("file_size").and_then(Value::as_u64);
    }
    expected.get("modified_ms").and_then(Value::as_u64)
        == actual.get("modified_ms").and_then(Value::as_u64)
        && expected.get("file_size").and_then(Value::as_u64)
            == actual.get("file_size").and_then(Value::as_u64)
}

fn atomic_write_json_checked(
    path: &Path,
    data: &Value,
    label: &str,
    expected_fingerprint: Option<&Value>,
) -> Result<u64, String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "{label} parent directoryを解決できません: {}",
            path.display()
        )
    })?;
    // A save must never resurrect a deleted event.  In particular, do not call
    // create_dir_all here: deletion racing an autosave must fail closed.
    if !parent.is_dir() {
        return Err(format!(
            "{label} parent directoryが存在しません: {}",
            parent.display()
        ));
    }

    let bytes = {
        let mut bytes = serde_json::to_vec_pretty(data)
            .map_err(|error| format!("{label} JSONシリアライズ失敗: {error}"))?;
        bytes.push(b'\n');
        bytes
    };

    // create_new + a process-local counter gives every concurrent save its own
    // durable staging file.  The create_new retry also handles a stale temp left
    // by a crashed process with the same pid.
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("event.json");
    let mut opened = None;
    let mut last_collision = None;
    for _ in 0..64 {
        let counter = EVENT_JSON_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            counter
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                opened = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_collision = Some(error);
            }
            Err(error) => {
                return Err(format!("{label} 一時ファイル作成失敗: {error}"));
            }
        }
    }
    let (temporary, mut file) = opened.ok_or_else(|| {
        format!(
            "{label} 一時ファイル名を確保できません: {}",
            last_collision
                .map(|error| error.to_string())
                .unwrap_or_else(|| "collision limit exceeded".to_string())
        )
    })?;

    let result = (|| {
        file.write_all(&bytes)
            .map_err(|error| format!("{label} 一時ファイル書き込み失敗: {error}"))?;
        file.flush()
            .map_err(|error| format!("{label} flush失敗: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("{label} fsync失敗: {error}"))?;
        drop(file);
        // Keep fingerprint validation and replacement in one process-wide
        // mutation critical section.  All native event writers use this helper.
        let _mutation_guard = event_json_mutation_lock()
            .lock()
            .map_err(|error| format!("{label} mutation lock取得失敗: {error}"))?;
        if let Some(expected) = expected_fingerprint {
            let actual = event_document_fingerprint(path)?;
            if !fingerprint_matches(expected, &actual) {
                return Err(format!(
                    "{label} fingerprint conflict: reload latest event.json before saving"
                ));
            }
        }
        // Windows can report ERROR_ACCESS_DENIED when two MoveFileExW replace
        // operations target the same file at once.  Serializing only the final
        // replacement keeps preparation concurrent while preserving atomicity.
        let _replace_guard = event_json_replace_lock()
            .lock()
            .map_err(|error| format!("{label} replace lock取得失敗: {error}"))?;
        durable_replace_event_json(&temporary, path)
            .map_err(|error| format!("{label} atomic replace失敗: {error}"))?;
        Ok(bytes.len() as u64)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_write_json(path: &Path, data: &Value, label: &str) -> Result<u64, String> {
    atomic_write_json_checked(path, data, label, None)
}

#[cfg(target_os = "windows")]
fn durable_replace_event_json(source: &Path, destination: &Path) -> Result<(), String> {
    // Readers can briefly retain an event.json handle on Windows.  MoveFileExW
    // then reports ERROR_ACCESS_DENIED even though a retry is safe; bounded
    // retries preserve fail-closed behavior without turning an I/O stall into an
    // unbounded wait.
    let mut last_error = None;
    for _ in 0..20 {
        match durable_rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "durable replace failed".to_string()))
}

#[cfg(not(target_os = "windows"))]
fn durable_replace_event_json(source: &Path, destination: &Path) -> Result<(), String> {
    durable_rename(source, destination)
}

#[tauri::command]
fn load_event_bundle(
    event_json: String,
    event_dir: String,
    include_maps: Option<bool>,
) -> Result<Value, String> {
    TAURI_EVENT_IO_IPC_COUNT.fetch_add(1, Ordering::Relaxed);
    if event_json.trim().is_empty() {
        return Err("event.json pathが空です".to_string());
    }
    if event_dir.trim().is_empty() {
        return Err("イベントディレクトリ pathが空です".to_string());
    }
    let event_json_path = PathBuf::from(&event_json);
    let event_dir_path = PathBuf::from(&event_dir);
    if !event_json_path.is_file() {
        return Err(format!(
            "event.jsonが存在しません: {}",
            event_json_path.display()
        ));
    }
    if !event_dir_path.is_dir() {
        return Err(format!(
            "イベントディレクトリが存在しません: {}",
            event_dir_path.display()
        ));
    }

    let metadata = fs::metadata(&event_json_path)
        .map_err(|error| format!("event.json metadata取得失敗: {error}"))?;
    let bytes =
        fs::read(&event_json_path).map_err(|error| format!("event.json読み込み失敗: {error}"))?;
    let full: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("event.json解析失敗: {error}"))?;
    // Existing clients omitted this argument and expected map images in the
    // bundle, so omission retains that behavior.  The current desktop switch
    // path passes `false` and performs the map scan only when the map editor is
    // initialized, avoiding duplicate directory scans before first table paint.
    let map_images = if include_maps.unwrap_or(true) {
        let preferred_refs = preferred_event_map_references_from_data(&full);
        let maps_response = list_event_map_images(
            event_dir_path.to_string_lossy().to_string(),
            Some(preferred_refs),
        )?;
        maps_response
            .get("maps")
            .cloned()
            .unwrap_or_else(|| json!([]))
    } else {
        json!([])
    };
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);
    let file_size = metadata.len();
    let content_hash = event_content_hash(&bytes);
    let meta = event_meta_from_full_json(&full, &event_dir_path);
    Ok(json!({
        "status": "ok",
        "event_json": event_json_path.to_string_lossy().to_string().replace('\\', "/"),
        // Keep one serialized copy of the potentially large document.  The
        // bridge-compatible `data` field is the full, untouched JSON value.
        "data": full,
        "meta": meta,
        "map_images": map_images.clone(),
        "active_map_images": map_images,
        "modified_ms": modified_ms,
        "modified_ns": modified_ns,
        "file_size": file_size,
        "content_hash": content_hash
    }))
}

#[tauri::command]
fn save_event_json_native(event_json: String, data: Value) -> Result<Value, String> {
    TAURI_EVENT_IO_IPC_COUNT.fetch_add(1, Ordering::Relaxed);
    let path = PathBuf::from(&event_json);
    if !path.is_file() {
        return Err(format!("event.jsonが存在しません: {}", path.display()));
    }
    atomic_write_json(&path, &data, "event.json")?;
    let mut receipt = event_document_fingerprint(&path)?;
    receipt["status"] = json!("ok");
    receipt["event_json"] = json!(path.to_string_lossy().to_string().replace('\\', "/"));
    Ok(receipt)
}

#[tauri::command]
fn save_event_json_native_checked(
    event_json: String,
    data: Value,
    expected_fingerprint: Value,
) -> Result<Value, String> {
    TAURI_EVENT_IO_IPC_COUNT.fetch_add(1, Ordering::Relaxed);
    let path = PathBuf::from(&event_json);
    if !path.is_file() {
        return Err(format!("event.jsonが存在しません: {}", path.display()));
    }
    atomic_write_json_checked(&path, &data, "event.json", Some(&expected_fingerprint))?;
    let mut receipt = event_document_fingerprint(&path)?;
    receipt["status"] = json!("ok");
    receipt["event_json"] = json!(path.to_string_lossy().to_string().replace('\\', "/"));
    Ok(receipt)
}

/// Return only the cheap filesystem fingerprint for an event document.
///
/// This command deliberately does not read or parse JSON and does not scan the
/// event directory.  It is used by focus/idle external-change detection, where
/// a full bundle load (and its map discovery) would be unnecessarily expensive.
#[tauri::command]
fn event_file_fingerprint(event_json: String) -> Result<Value, String> {
    TAURI_EVENT_IO_IPC_COUNT.fetch_add(1, Ordering::Relaxed);
    if event_json.trim().is_empty() {
        return Err("event.json pathが空です".to_string());
    }
    let path = PathBuf::from(&event_json);
    if !path.is_file() {
        return Err(format!("event.jsonが存在しません: {}", path.display()));
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("event.json metadata取得失敗: {error}"))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("event.json modified time取得失敗: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("event.json modified timeが不正です: {error}"))?;
    Ok(json!({
        "status": "ok",
        "event_json": path.to_string_lossy().to_string().replace('\\', "/"),
        "modified_ms": modified.as_millis() as u64,
        "modified_ns": modified.as_nanos().min(u128::from(u64::MAX)) as u64,
        "file_size": metadata.len()
    }))
}

#[tauri::command]
fn get_desktop_performance_counters() -> Result<Value, String> {
    // Counters are observable in development for profiling.  Release builds
    // still return the same shape but avoid emitting any per-operation logs.
    Ok(json!({
        "python_bridge_spawn_count": PYTHON_BRIDGE_SPAWN_COUNT.load(Ordering::Relaxed),
        "tauri_event_io_ipc_count": TAURI_EVENT_IO_IPC_COUNT.load(Ordering::Relaxed),
        "debug": cfg!(debug_assertions)
    }))
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
    fn leaves_twscrape_0201_current_source_unchanged() {
        let current = r#"from twscrape import API, gather

async def parse_anim_idx(text: str, clt: HttpClient) -> list[int]:
    text = await get_tw_page_text(url, clt)
"#;
        assert!(upgrade_legacy_twscrape_patch_source(current).is_none());

        let current_with_legacy_call_shape = r#"async def _patched_parse_anim_idx(text: str, clt=None) -> list:
    js_text = await xclid.get_tw_page_text(url)
    return await _original_parse_anim_idx(text)
"#;
        assert!(upgrade_legacy_twscrape_patch_source(current_with_legacy_call_shape).is_none());
    }

    #[test]
    fn twscrape_runtime_check_requires_exact_release_without_integer_parsing() {
        let script = twscrape_version_check_script();

        assert!(script.contains("importlib.metadata"));
        assert!(script.contains("installed == \"0.20.1\""));
        assert!(!script.contains("int(x"));
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
            Some(vec![EventMapReferenceInput::Legacy(
                "maps/map_01.jpg".to_string(),
            )]),
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

    #[test]
    fn list_event_map_images_resolves_canonical_reference_before_legacy_scan() {
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-map-canonical-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("maps")).unwrap();
        fs::write(dir.join("ev02_map_01.jpg"), b"canonical").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(dir.join("maps/map_01.png"), b"legacy").unwrap();

        let result = list_event_map_images(
            dir.to_string_lossy().to_string(),
            Some(vec![EventMapReferenceInput::Detailed {
                reference: Some("ev02_map_01.jpg".to_string()),
                map_number: Some(1),
            }]),
        )
        .unwrap();
        let map = &result["maps"][0];
        assert_eq!(map["name"].as_str(), Some("ev02_map_01.jpg"));
        assert_eq!(map["reference"].as_str(), Some("ev02_map_01.jpg"));
        assert_eq!(map["map_number"].as_u64(), Some(1));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_event_map_images_uses_explicit_number_and_falls_back_safely() {
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-map-reference-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("maps")).unwrap();
        fs::write(dir.join("maps/custom_art.webp"), b"custom").unwrap();
        fs::write(dir.join("map_03.jpg"), b"fallback").unwrap();

        let explicit = list_event_map_images(
            dir.to_string_lossy().to_string(),
            Some(vec![EventMapReferenceInput::Detailed {
                reference: Some("maps/custom_art.webp".to_string()),
                map_number: Some(2),
            }]),
        )
        .unwrap();
        assert_eq!(explicit["maps"][0]["name"].as_str(), Some("custom_art.webp"));
        assert_eq!(explicit["maps"][0]["reference"].as_str(), Some("maps/custom_art.webp"));
        assert_eq!(explicit["maps"][0]["map_number"].as_u64(), Some(2));

        let unsafe_reference = list_event_map_images(
            dir.to_string_lossy().to_string(),
            Some(vec![EventMapReferenceInput::Detailed {
                reference: Some("../outside.jpg".to_string()),
                map_number: Some(4),
            }]),
        )
        .unwrap();
        assert_eq!(unsafe_reference["maps"][0]["name"].as_str(), Some("map_03.jpg"));
        assert_eq!(unsafe_reference["maps"][0]["map_number"].as_u64(), Some(3));

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

    fn file_server_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn file_server_runtime_is_initialized() -> bool {
        file_server_runtime()
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(true)
    }

    fn http_get_file(path: &str) -> String {
        let mut stream = None;
        for _ in 0..50 {
            match std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], FILE_SERVER_FIXED_PORT)),
                Duration::from_millis(100),
            ) {
                Ok(candidate) => {
                    stream = Some(candidate);
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(10)),
            }
        }
        let mut stream = stream.expect("固定ポート18721へ接続できません");
        std::io::Write::write_all(
            &mut stream,
            format!("GET /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    #[test]
    fn resolve_advertised_ipv4_rejects_non_lan_addresses() {
        assert!(!is_usable_advertised_ipv4(std::net::Ipv4Addr::UNSPECIFIED));
        assert!(!is_usable_advertised_ipv4(std::net::Ipv4Addr::LOCALHOST));
        assert!(!is_usable_advertised_ipv4(std::net::Ipv4Addr::new(
            169, 254, 10, 20
        )));
        assert!(is_usable_advertised_ipv4(std::net::Ipv4Addr::new(
            192, 168, 0, 1
        )));
        let advertised = std::net::Ipv4Addr::new(192, 168, 1, 20);
        assert!(peer_is_on_advertised_subnet(
            Some(&std::net::SocketAddr::from(([192, 168, 1, 42], 18722))),
            advertised,
        ));
        assert!(!peer_is_on_advertised_subnet(
            Some(&std::net::SocketAddr::from(([192, 168, 2, 42], 18722))),
            advertised,
        ));
        assert!(!peer_is_on_advertised_subnet(
            Some(&std::net::SocketAddr::from(([8, 8, 8, 8], 18722))),
            advertised,
        ));
        assert!(peer_is_on_advertised_subnet(
            Some(&std::net::SocketAddr::from(([127, 0, 0, 1], 18722))),
            std::net::Ipv4Addr::LOCALHOST,
        ));
    }

    #[test]
    fn start_file_server_removes_cleanup_file_on_stop() {
        let _test_guard = file_server_test_lock().lock().unwrap();
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
        assert!(!zip_path.exists(), "stop完了前にcleanupが返りました");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_server_serves_http_and_stop_deactivates_worker() {
        let _test_guard = file_server_test_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-file-server-http-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("mobile_export.zip");

        stop_file_server().unwrap();
        for index in 0..20 {
            let payload = format!("zip-http-body-{index}");
            fs::write(&zip_path, payload.as_bytes()).unwrap();
            let result =
                start_file_server(zip_path.to_string_lossy().to_string(), Some(false)).unwrap();
            assert_eq!(
                result["port"].as_u64(),
                Some(u64::from(FILE_SERVER_FIXED_PORT))
            );

            let response = http_get_file("mobile_export.zip");
            assert!(
                response.starts_with("HTTP/1.1 200"),
                "unexpected response: {response}"
            );
            assert!(response.ends_with(&payload), "unexpected body: {response}");

            stop_file_server().unwrap();
            let stopped = http_get_file("mobile_export.zip");
            assert!(
                stopped.starts_with("HTTP/1.1 404"),
                "unexpected stopped response: {stopped}"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn protected_event_sync_file_server_serves_only_authorized_url() {
        let _test_guard = file_server_test_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-protected-file-server-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("mobile sync.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
            let options = zip::write::FileOptions::default();
            let event = json!({
                "event_uid": "sync-file-event",
                "event": {"name": "Single Event", "date": "2026-06-01"},
                "circles": [],
                "metadata": {}
            });
            zip.start_file("event.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
            zip.start_file("event_image/event.png", options).unwrap();
            zip.write_all(b"zip image").unwrap();
            zip.finish().unwrap();
        }
        stop_file_server().unwrap();
        let result = start_event_sync_file_server(
            zip_path.to_string_lossy().to_string(),
            "sync-file-event".to_string(),
        )
        .unwrap();
        let url = result["url"].as_str().unwrap();
        let route = url.split_once("://").unwrap().1.split_once('/').unwrap().1;
        assert!(http_get_file(route).starts_with("HTTP/1.1 200"));
        let token = url.split("token=").nth(1).unwrap();
        assert!(http_get_file(&route.replace(token, "wrong-token")).starts_with("HTTP/1.1 401"));
        assert!(http_get_file(&route.replace("&token=", "&")).starts_with("HTTP/1.1 401"));
        assert!(
            http_get_file(&route.replace("sync-file-event", "wrong-event"))
                .starts_with("HTTP/1.1 401")
        );
        assert!(
            http_get_file(&route.replace("mobile_export.zip", "other.zip"))
                .starts_with("HTTP/1.1 404")
        );
        stop_file_server().unwrap();
        assert!(
            !zip_path.exists(),
            "protected sync ZIPがstop時にcleanupされませんでした"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_server_active_replacement_preserves_new_source_cleanup() {
        let _test_guard = file_server_test_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-file-server-replacement-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("mobile_export.zip");
        fs::write(&source, b"payload-a").unwrap();
        stop_file_server().unwrap();
        start_file_server(source.to_string_lossy().to_string(), Some(true)).unwrap();
        assert!(http_get_file("mobile_export.zip").ends_with("payload-a"));

        let replacement = dir.join("mobile_export.next.zip");
        fs::write(&replacement, b"payload-b").unwrap();
        fs::rename(&replacement, &source).unwrap();
        start_file_server(source.to_string_lossy().to_string(), Some(true)).unwrap();
        let response = http_get_file("mobile_export.zip");
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "unexpected response: {response}"
        );
        assert!(
            response.ends_with("payload-b"),
            "unexpected body: {response}"
        );
        assert!(
            source.exists(),
            "active replacementが新sourceを削除しました"
        );

        stop_file_server().unwrap();
        assert!(
            !source.exists(),
            "stop時のgeneration cleanupが実行されませんでした"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn served_file_cleanup_is_generation_safe_for_reused_source_path() {
        let _test_guard = file_server_test_lock().lock().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "eventtrail-file-server-generation-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("mobile_export.zip");
        fs::write(&source, b"payload-a").unwrap();
        let old =
            Arc::new(ServedFile::new(source.clone(), file_server_generation(), true).unwrap());
        old.deactivate();
        fs::write(&source, b"payload-b").unwrap();
        let new = ServedFile::new(source.clone(), file_server_generation(), true).unwrap();
        drop(old);
        assert!(source.exists(), "旧generationが新しいsourceを削除しました");
        drop(new);
        assert!(
            !source.exists(),
            "新generationのcleanupが実行されませんでした"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_server_returns_fixed_port_bind_error_without_fallback() {
        let _test_guard = file_server_test_lock().lock().unwrap();
        if file_server_runtime_is_initialized() {
            eprintln!("fixed port occupancy test skipped: runtime already initialized");
            return;
        }
        stop_file_server().unwrap();
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, FILE_SERVER_FIXED_PORT));

        let result = start_file_server(
            std::env::temp_dir()
                .join("eventtrail-fixed-port-bind-error.zip")
                .to_string_lossy()
                .to_string(),
            Some(false),
        );
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(
            error.contains("固定ポート18721"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("attempts="),
            "missing retry telemetry: {error}"
        );
        assert!(
            error.contains("elapsed_ms="),
            "missing elapsed telemetry: {error}"
        );
        assert!(
            error.contains("os_error="),
            "missing OS error telemetry: {error}"
        );
        drop(listener);
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
        let payload = received_upload_payload("upload-1", "C:/temp/result.zip", 42, None);
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["uploadId"], "upload-1");
        assert_eq!(payload["zipPath"], "C:/temp/result.zip");
        assert_eq!(payload["size"], 42);
        assert!(payload["targetEventUid"].is_null());
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
    fn write_event_meta_merges_known_fields_and_preserves_raw_event_fields() {
        let root = std::env::temp_dir().join(format!(
            "eventtrail-meta-merge-preserve-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let event_path = root.join("event.json");
        fs::write(
            &event_path,
            serde_json::to_vec_pretty(&json!({
                "event": {
                    "name": "before",
                    "maps": [{"filename": "maps/map_1.png", "crop": [1, 2]}],
                    "event_image": "event_image/event_image.png",
                    "future_field": {"keep": true}
                },
                "circles": [{"name": "Circle", "future_circle_field": 7}],
                "metadata": {"opaque": {"keep": true}}
            }))
            .unwrap(),
        )
        .unwrap();

        write_event_meta(root.to_string_lossy().to_string(), json!({"name": "after"})).unwrap();

        let saved: Value = serde_json::from_slice(&fs::read(&event_path).unwrap()).unwrap();
        assert_eq!(saved["event"]["name"], "after");
        assert_eq!(saved["event"]["maps"][0]["filename"], "maps/map_1.png");
        assert_eq!(saved["event"]["maps"][0]["crop"][1], 2);
        assert_eq!(saved["event"]["event_image"], "event_image/event_image.png");
        assert_eq!(saved["event"]["future_field"]["keep"], true);
        assert_eq!(saved["circles"][0]["future_circle_field"], 7);
        assert_eq!(saved["metadata"]["opaque"]["keep"], true);

        write_event_meta(
            root.to_string_lossy().to_string(),
            json!({"event_image": Value::Null}),
        )
        .unwrap();
        let cleared: Value = serde_json::from_slice(&fs::read(&event_path).unwrap()).unwrap();
        assert!(cleared["event"].get("event_image").is_none());
        assert_eq!(cleared["event"]["maps"][0]["filename"], "maps/map_1.png");
        let _ = fs::remove_dir_all(&root);
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
                target_exists: false,
                local_only: false,
                redundant_events: Vec::new(),
            },
            local_only: false,
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

    let mut existing_event = full.get("event").cloned().unwrap_or_else(|| json!({}));
    merge_event_meta_preserving_unknown(&mut existing_event, meta);
    full["event"] = existing_event;

    let _ = atomic_write_json(&ej_path, &full, "event.json")?;
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
        atomic_write_json(&ej_path, &data, "event.json")?;
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
    preferred_refs: Option<Vec<EventMapReferenceInput>>,
) -> Result<Value, String> {
    let dir = PathBuf::from(&event_dir);
    // Canonical event.maps references are resolved before any legacy directory scan.
    // This keeps an event-owned asset such as ev02_map_01.jpg ahead of an orphaned
    // maps/map_01.png, regardless of mtime.  All paths remain backend paths; only
    // the frontend WebView boundary normalizes recognized verbatim prefixes.
    let inputs = preferred_refs.unwrap_or_default();
    let mut preferred_names = HashSet::new();
    let mut active_by_number: HashMap<
        u32,
        (
            u8,
            std::time::SystemTime,
            bool,
            String,
            String,
            PathBuf,
        ),
    > = HashMap::new();
    let mut consider = |number: u32,
                        modified: std::time::SystemTime,
                        source_rank: u8,
                        preferred_dir: bool,
                        name: String,
                        reference: String,
                        path: PathBuf| {
        let replace = active_by_number.get(&number).map_or(true, |current| {
            source_rank > current.0
                || (source_rank == current.0
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
                    source_rank,
                    modified,
                    preferred_dir,
                    name,
                    reference,
                    path,
                ),
            );
        }
    };

    for input in &inputs {
        let Some((reference, number)) = event_map_reference_parts(input) else {
            continue;
        };
        let Some(number) = number else {
            continue;
        };
        preferred_names.insert(reference.to_ascii_lowercase());
        let candidate = dir.join(&reference);
        let Ok(metadata) = fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(canonical_dir) = fs::canonicalize(&dir).ok() else {
            continue;
        };
        let Some(canonical_candidate) = fs::canonicalize(&candidate).ok() else {
            continue;
        };
        if !canonical_candidate.starts_with(&canonical_dir) {
            continue;
        }
        let Some(name) = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let preferred_dir = reference
            .split('/')
            .next()
            .map(|component| component.eq_ignore_ascii_case("maps"))
            .unwrap_or(false);
        consider(
            number,
            modified,
            2,
            preferred_dir,
            name,
            reference,
            candidate,
        );
    }

    // Same-number orphan files across extensions remain physically untouched;
    // only one active candidate is returned.  Explicit frontend preferences are
    // lower priority than a resolved event.maps reference, but higher than mtime.
    let mut scan_dir = |scan_path: PathBuf, preferred_dir: bool| {
        if scan_path.exists() {
            if let Ok(entries) = fs::read_dir(&scan_path) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let lower = name.to_ascii_lowercase();
                    if !(lower.ends_with(".jpg")
                        || lower.ends_with(".jpeg")
                        || lower.ends_with(".png")
                        || lower.ends_with(".webp"))
                    {
                        continue;
                    }
                    let Some(number) = legacy_map_number_from_name(&name) else {
                        continue;
                    };
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    let reference = if preferred_dir {
                        format!("maps/{name}")
                    } else {
                        name.clone()
                    };
                    let explicitly_preferred = preferred_names
                        .contains(&reference.to_ascii_lowercase());
                    consider(
                        number,
                        modified,
                        u8::from(explicitly_preferred),
                        preferred_dir,
                        name,
                        reference,
                        entry.path(),
                    );
                }
            }
        }
    };
    scan_dir(dir.clone(), false);
    scan_dir(dir.join("maps"), true);
    let mut active: Vec<(u32, std::time::SystemTime, String, String, PathBuf)> = active_by_number
        .into_iter()
        .map(|(number, (_, modified, _, name, reference, path))| {
            (number, modified, name, reference, path)
        })
        .collect();
    active.sort_by_key(|entry| entry.0);
    let maps: Vec<Value> = active
        .into_iter()
        .map(|(number, modified, name, reference, path)| {
            let modified_ms = modified
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            json!({
                "name": name,
                "path": path.to_string_lossy().to_string().replace("\\", "/"),
                "reference": reference,
                "map_number": number,
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

fn strict_sync_archive_relative_path(name: &str) -> Option<PathBuf> {
    let relative = strict_archive_relative_path(name)?;
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return None;
        };
        let text = part.to_str()?;
        if text.is_empty()
            || text.chars().any(char::is_control)
            || text.ends_with('.')
            || text.ends_with(' ')
        {
            return None;
        }
        let device_stem = text
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(device_stem.as_str(), "con" | "prn" | "aux" | "nul")
            || ["com", "lpt"].iter().any(|prefix| {
                device_stem.strip_prefix(prefix).is_some_and(|suffix| {
                    suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
                })
            })
        {
            return None;
        }
    }
    Some(relative)
}

fn is_allowed_sync_asset_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let mut components = normalized.split('/');
    let prefix = components.next().unwrap_or_default().to_ascii_lowercase();
    let has_child = components.next().is_some();
    has_child
        && matches!(
            prefix.as_str(),
            "maps" | "event_image" | "circles" | "items"
        )
}

fn is_allowed_sync_archive_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let folded = normalized.to_ascii_lowercase();
    folded == "event.json"
        || folded == "asset_manifest.json"
        || (folded.starts_with("assets/") && folded.len() > "assets/".len())
        || is_allowed_sync_asset_path(path)
}

fn is_allowed_sync_directory_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let folded = normalized.to_ascii_lowercase();
    matches!(
        folded.as_str(),
        "assets" | "maps" | "event_image" | "circles" | "items"
    ) || folded.starts_with("assets/")
        || is_allowed_sync_asset_path(path)
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
    target_exists: bool,
    local_only: bool,
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

fn plan_received_import_with_scope(
    zip_path: &Path,
    project_root: &Path,
    local_only: bool,
) -> Result<ReceivedImportPlan, String> {
    if local_only {
        validate_local_import_zip(zip_path)?;
    }
    let event_data = read_import_event_data(zip_path)?;
    let event_obj = event_data.get("event").unwrap_or(&Value::Null);
    let event_name = event_field_string(event_obj, "name").unwrap_or_else(|| "unknown".to_string());
    let event_date = normalized_event_date(event_obj);
    let existing = find_existing_event_dir(project_root, &event_name, event_date.as_deref());
    let target_exists = existing.is_some();
    let (slug, event_dir) = if let Some((slug, dir)) = existing {
        if local_only {
            if let Some(incoming_uid) = event_uid_from_data(&event_data) {
                let existing_data = fs::read_to_string(dir.join("event.json"))
                    .map_err(|e| format!("local対象event.json読み込み失敗: {e}"))?;
                let existing_data: Value = serde_json::from_str(&existing_data)
                    .map_err(|e| format!("local対象event.json解析失敗: {e}"))?;
                if let Some(existing_uid) = event_uid_from_data(&existing_data) {
                    if existing_uid != incoming_uid {
                        return Err(
                            "local ZIPのUIDが既存name/date対象と異なるため上書きを拒否しました"
                                .to_string(),
                        );
                    }
                }
            }
        }
        (slug, dir)
    } else {
        let now = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let safe_name = sanitize_event_slug_name(&event_name);
        let slug = format!("{}_{}", safe_name, now);
        let dir = project_root.join("events").join(&slug);
        (slug, dir)
    };
    let redundant_events = if local_only {
        Vec::new()
    } else {
        redundant_mobile_import_dirs(project_root, &event_name, event_date.as_deref(), &slug)
    };
    Ok(ReceivedImportPlan {
        slug,
        event_dir,
        event_name,
        event_date,
        target_exists,
        local_only,
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
    atomic_write_json(&event_dir.join("event.json"), &data_to_save, "event.json")?;
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

fn receive_server_auth() -> &'static Mutex<Option<ReceiveServerAuth>> {
    static AUTH: OnceLock<Mutex<Option<ReceiveServerAuth>>> = OnceLock::new();
    AUTH.get_or_init(|| Mutex::new(None))
}

fn receive_sync_session() -> &'static Mutex<Option<ReceiveSyncSession>> {
    static SESSION: OnceLock<Mutex<Option<ReceiveSyncSession>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

fn receive_generation_is_current(
    running: &Option<Arc<AtomicBool>>,
    worker: &Arc<AtomicBool>,
) -> bool {
    running
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, worker) && worker.load(Ordering::Relaxed))
}

fn clear_receive_state_if_current(worker: &Arc<AtomicBool>) {
    let running = match receive_server_running().lock() {
        Ok(running) => running,
        Err(_) => return,
    };
    if !running
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, worker))
    {
        return;
    }
    // Keep the running generation guard until auth/session cleanup finishes;
    // start/stop cannot install a new generation in the gap.
    if let Ok(mut auth) = receive_server_auth().lock() {
        *auth = None;
    }
    if let Ok(mut session) = receive_sync_session().lock() {
        *session = None;
    }
}

const RECEIVE_BEARER_TOKEN_LIFETIME: Duration = Duration::from_secs(1200);
const MAX_RECEIVED_ZIP_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SYNC_ZIP_ENTRY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SYNC_ZIP_EXPANDED_BYTES: u64 = 768 * 1024 * 1024;
const MAX_SYNC_ZIP_ENTRIES: usize = 10_000;

#[derive(Debug)]
enum ReceivedUploadAck {
    Success(Option<String>),
    Failure(String),
}

struct PendingReceivedUpload {
    sender: std::sync::mpsc::SyncSender<ReceivedUploadAck>,
    zip_path: PathBuf,
    target_event_uid: Option<String>,
    receive_generation: Option<Arc<AtomicBool>>,
    local_only: bool,
    claimed: bool,
    lease_deadline: Instant,
    import_stage: Option<ReceivedImportStage>,
    event_sync_stage: Option<ReceivedEventSyncStage>,
    recovery_required: bool,
    published: bool,
}

#[derive(Clone, Debug)]
struct ReceivedImportStage {
    stage_root: PathBuf,
    project_root: PathBuf,
    plan: ReceivedImportPlan,
    local_only: bool,
    live_preimages: Vec<(PathBuf, Option<u64>)>,
}

#[derive(Clone, Debug)]
struct ReceivedEventSyncStage {
    stage_root: PathBuf,
    project_root: PathBuf,
    event_dir: PathBuf,
    slug: String,
    target_event_uid: String,
    fingerprint: String,
    live_preimage: Option<u64>,
    zip_preimage: Option<u64>,
}

struct ReceiveServerAuth {
    bearer_token: String,
    target_event_uid: String,
    expires_at: Instant,
}

#[derive(Clone, Debug)]
enum ReceiveSyncSessionState {
    Waiting,
    Pending { upload_id: String },
    PcReady { download_url: String },
    MobileApplied,
    Cancelled { message: String },
    Error { message: String },
}

#[derive(Clone, Debug)]
struct ReceiveSyncSession {
    target_event_uid: String,
    state: ReceiveSyncSessionState,
}

fn receive_sync_session_is_terminal(session: Option<&ReceiveSyncSession>) -> bool {
    session.is_some_and(|session| {
        matches!(
            &session.state,
            ReceiveSyncSessionState::MobileApplied
                | ReceiveSyncSessionState::Cancelled { .. }
                | ReceiveSyncSessionState::Error { .. }
        )
    })
}

/// Retire a terminal receive-server generation while the running registry is
/// locked. A cancelled/failed/completed session no longer owns mutable import
/// work, so a subsequent start may replace its listener immediately. Keeping
/// the registry lock across auth/session cleanup is important: an old worker
/// can only clear state when its Arc is still the current generation.
fn retire_terminal_receive_generation_locked(
    running: &mut Option<Arc<AtomicBool>>,
) -> Result<bool, String> {
    let terminal = receive_sync_session()
        .lock()
        .map_err(|e| format!("receive sync session lock取得失敗: {e}"))
        .map(|session| receive_sync_session_is_terminal(session.as_ref()))?;
    if !terminal {
        return Ok(false);
    }

    if let Some(worker) = running.take() {
        worker.store(false, Ordering::Relaxed);
    }
    *receive_server_auth()
        .lock()
        .map_err(|e| format!("receive auth lock取得失敗: {e}"))? = None;
    *receive_sync_session()
        .lock()
        .map_err(|e| format!("receive sync session lock取得失敗: {e}"))? = None;
    Ok(true)
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

fn register_received_upload_with_timeout_and_target_scope(
    upload_id: &str,
    zip_path: PathBuf,
    timeout: Duration,
    target_event_uid: Option<String>,
    local_only: bool,
    receive_generation: Option<Arc<AtomicBool>>,
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
            target_event_uid,
            receive_generation,
            local_only,
            claimed: false,
            lease_deadline: Instant::now() + timeout,
            import_stage: None,
            event_sync_stage: None,
            recovery_required: false,
            published: false,
        },
    );
    Ok(receiver)
}

#[cfg(test)]
fn register_received_upload_with_timeout_and_target(
    upload_id: &str,
    zip_path: PathBuf,
    timeout: Duration,
    target_event_uid: Option<String>,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout_and_target_scope(
        upload_id,
        zip_path,
        timeout,
        target_event_uid,
        false,
        None,
    )
}

fn register_local_received_upload(
    upload_id: &str,
    zip_path: PathBuf,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout_and_target_scope(
        upload_id,
        zip_path,
        RECEIVED_UPLOAD_LEASE_DURATION,
        None,
        true,
        Some(Arc::new(AtomicBool::new(true))),
    )
}

#[cfg(test)]
fn register_received_upload_with_timeout(
    upload_id: &str,
    zip_path: PathBuf,
    timeout: Duration,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout_and_target(upload_id, zip_path, timeout, None)
}

#[cfg(test)]
fn register_received_upload(
    upload_id: &str,
    zip_path: PathBuf,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout(upload_id, zip_path, RECEIVED_UPLOAD_LEASE_DURATION)
}

#[cfg(test)]
fn register_received_sync_upload(
    upload_id: &str,
    zip_path: PathBuf,
    target_event_uid: String,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    register_received_upload_with_timeout_and_target(
        upload_id,
        zip_path,
        RECEIVED_UPLOAD_LEASE_DURATION,
        Some(target_event_uid),
    )
}

fn register_received_upload_for_generation(
    worker: &Arc<AtomicBool>,
    upload_id: &str,
    zip_path: PathBuf,
    target_event_uid: Option<String>,
) -> Result<std::sync::mpsc::Receiver<ReceivedUploadAck>, String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Err("receive server generation is no longer active".to_string());
    }
    register_received_upload_with_timeout_and_target_scope(
        upload_id,
        zip_path,
        RECEIVED_UPLOAD_LEASE_DURATION,
        target_event_uid,
        false,
        Some(worker.clone()),
    )
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

fn received_upload_is_local_only(upload_id: &str) -> Result<bool, String> {
    let pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信scopeロック取得失敗: {e}"))?;
    let upload = pending
        .get(upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    Ok(upload.local_only)
}

fn ensure_received_upload_generation_current(
    upload_id: &str,
    running: &Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信generationロック取得失敗: {e}"))?;
    let upload = pending
        .get(upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if let Some(worker) = upload.receive_generation.as_ref() {
        if !receive_generation_is_current(running, worker) {
            return Err("receive server generation is no longer active".to_string());
        }
    }
    Ok(())
}

fn received_upload_target_uid(upload_id: &str) -> Result<String, String> {
    let pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("受信target UIDロック取得失敗: {e}"))?;
    let upload = pending
        .get(upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    upload
        .target_event_uid
        .clone()
        .ok_or_else(|| "単一イベント同期QRから受信したZIPではありません".to_string())
}

fn valid_event_uid(uid: &str) -> bool {
    !uid.is_empty()
        && uid.len() <= 256
        && uid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_received_upload_id(upload_id: &str) -> bool {
    !upload_id.is_empty()
        && upload_id.len() <= 128
        && upload_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn secure_random_bytes(bytes: &mut [u8]) -> Result<(), String> {
    #[cfg(windows)]
    {
        #[link(name = "advapi32")]
        extern "system" {
            fn SystemFunction036(buffer: *mut u8, length: u32) -> u8;
        }
        if bytes.len() > u32::MAX as usize {
            return Err("乱数要求サイズが大きすぎます".to_string());
        }
        let ok = unsafe { SystemFunction036(bytes.as_mut_ptr(), bytes.len() as u32) };
        if ok == 0 {
            return Err("暗号学的乱数の取得に失敗しました".to_string());
        }
        return Ok(());
    }
    #[cfg(unix)]
    {
        let mut random = fs::File::open("/dev/urandom")
            .map_err(|e| format!("暗号学的乱数sourceを開けません: {e}"))?;
        random
            .read_exact(bytes)
            .map_err(|e| format!("暗号学的乱数を取得できません: {e}"))?;
        return Ok(());
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = bytes;
        Err("このplatformでは暗号学的乱数を取得できません".to_string())
    }
}

fn random_bearer_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    secure_random_bytes(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn constant_time_token_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn decode_query_value(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let source = value.as_bytes();
    let mut index = 0;
    while index < source.len() {
        match source[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = source.get(index + 1..index + 3)?;
                let digits = std::str::from_utf8(hex).ok()?;
                bytes.push(u8::from_str_radix(digits, 16).ok()?);
                index += 3;
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(bytes).ok()
}

fn parse_query(query: Option<&str>) -> HashMap<String, String> {
    query
        .unwrap_or_default()
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((decode_query_value(key)?, decode_query_value(value)?))
        })
        .collect()
}

fn receive_request_target_uid_with_auth(
    url: &str,
    auth: &mut Option<ReceiveServerAuth>,
    clear_expired_auth: bool,
) -> Result<Option<String>, (u16, String)> {
    let query = parse_query(url.split_once('?').map(|(_, query)| query));
    let is_sync_url = query.get("mode").is_some()
        || query.get("target_uid").is_some()
        || query.get("token").is_some();
    let Some(current) = auth.as_ref() else {
        return if is_sync_url {
            Err((401, "pairing token is not active".to_string()))
        } else {
            Ok(None)
        };
    };
    if Instant::now() >= current.expires_at {
        if clear_expired_auth {
            *auth = None;
        }
        return Err((410, "pairing token expired".to_string()));
    }
    let token = query.get("token").map(String::as_str).unwrap_or("");
    let mode = query.get("mode").map(String::as_str).unwrap_or("");
    let target_uid = query.get("target_uid").map(String::as_str).unwrap_or("");
    if mode != "single-event-sync"
        || target_uid != current.target_event_uid
        || !constant_time_token_eq(token, &current.bearer_token)
    {
        return Err((401, "pairing token or target event is invalid".to_string()));
    }
    Ok(Some(current.target_event_uid.clone()))
}

#[cfg(test)]
fn receive_request_target_uid(url: &str) -> Result<Option<String>, (u16, String)> {
    let mut auth = receive_server_auth()
        .lock()
        .map_err(|error| (500, format!("receive auth lock error: {error}")))?;
    receive_request_target_uid_with_auth(url, &mut auth, true)
}

fn receive_request_target_uid_for_generation(
    url: &str,
    worker: &Arc<AtomicBool>,
) -> Result<Option<String>, (u16, String)> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| (500, format!("receive running lock error: {error}")))?;
    if !receive_generation_is_current(&running, worker) {
        return Err((409, "receive server generation is no longer active".to_string()));
    }
    let mut auth = receive_server_auth()
        .lock()
        .map_err(|error| (500, format!("receive auth lock error: {error}")))?;
    receive_request_target_uid_with_auth(url, &mut auth, false)
}

fn begin_receive_sync_upload(target_event_uid: &str, upload_id: &str) -> Result<(), String> {
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    let current = session
        .as_mut()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if current.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    if !matches!(current.state, ReceiveSyncSessionState::Waiting) {
        return Err("single-event sync upload is already active or terminal".to_string());
    }
    current.state = ReceiveSyncSessionState::Pending {
        upload_id: upload_id.to_string(),
    };
    Ok(())
}

fn begin_receive_sync_upload_for_generation(
    worker: &Arc<AtomicBool>,
    target_event_uid: &str,
    upload_id: &str,
) -> Result<(), String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Err("receive server generation is no longer active".to_string());
    }
    begin_receive_sync_upload(target_event_uid, upload_id)
}

fn receive_sync_upload_ack_state(
    target_event_uid: &str,
    upload_id: &str,
    state: ReceiveSyncSessionState,
) -> Result<bool, String> {
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    let current = session
        .as_mut()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if current.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    let ReceiveSyncSessionState::Pending {
        upload_id: current_upload_id,
    } = &current.state
    else {
        return Ok(false);
    };
    if current_upload_id != upload_id {
        return Ok(false);
    }
    current.state = state;
    Ok(true)
}

fn receive_sync_upload_ack_state_for_generation(
    worker: &Arc<AtomicBool>,
    target_event_uid: &str,
    upload_id: &str,
    state: ReceiveSyncSessionState,
) -> Result<bool, String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Ok(false);
    }
    receive_sync_upload_ack_state(target_event_uid, upload_id, state)
}

fn cancel_receive_sync_session(target_event_uid: &str, message: String) -> Result<bool, String> {
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    let current = session
        .as_mut()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if current.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    if matches!(
        current.state,
        ReceiveSyncSessionState::Waiting
            | ReceiveSyncSessionState::Pending { .. }
    ) {
        current.state = ReceiveSyncSessionState::Cancelled { message };
        return Ok(true);
    }
    Ok(false)
}

fn expire_receive_sync_session(target_event_uid: &str, message: String) -> Result<bool, String> {
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    let current = session
        .as_mut()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if current.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    if matches!(
        current.state,
        ReceiveSyncSessionState::Waiting
            | ReceiveSyncSessionState::Pending { .. }
            | ReceiveSyncSessionState::PcReady { .. }
    ) {
        current.state = ReceiveSyncSessionState::Cancelled { message };
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
fn apply_receive_sync_notification(
    target_event_uid: &str,
    state: ReceiveSyncSessionState,
) -> Result<(), String> {
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    apply_receive_sync_notification_locked(&mut *session, target_event_uid, state)
}

fn apply_receive_sync_notification_locked(
    session: &mut Option<ReceiveSyncSession>,
    target_event_uid: &str,
    state: ReceiveSyncSessionState,
) -> Result<(), String> {
    let current = session
        .as_mut()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if current.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    let allowed = match (&current.state, &state) {
        (ReceiveSyncSessionState::PcReady { .. }, ReceiveSyncSessionState::MobileApplied)
        | (ReceiveSyncSessionState::MobileApplied, ReceiveSyncSessionState::MobileApplied)
        | (
            ReceiveSyncSessionState::Waiting | ReceiveSyncSessionState::Pending { .. },
            ReceiveSyncSessionState::Cancelled { .. },
        )
        | (ReceiveSyncSessionState::PcReady { .. }, ReceiveSyncSessionState::Cancelled { .. })
        | (ReceiveSyncSessionState::Cancelled { .. }, ReceiveSyncSessionState::Cancelled { .. }) => true,
        _ => false,
    };
    if !allowed {
        return Err("mobile完了通知はPC-ready後にのみ受け付けます".to_string());
    }
    current.state = state;
    Ok(())
}

fn apply_receive_sync_notification_for_generation(
    worker: &Arc<AtomicBool>,
    target_event_uid: &str,
    state: ReceiveSyncSessionState,
) -> Result<(), String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Err("receive server generation is no longer active".to_string());
    }
    let mut session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?;
    if session
        .as_ref()
        .is_none_or(|current| current.target_event_uid != target_event_uid)
    {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    let pending_upload_id = match (&session.as_ref().map(|current| &current.state), &state) {
        (Some(ReceiveSyncSessionState::Pending { upload_id }), ReceiveSyncSessionState::Cancelled { .. }) => {
            Some(upload_id.clone())
        }
        _ => None,
    };
    if let Some(upload_id) = pending_upload_id {
        let cancelled = pending_received_uploads()
            .lock()
            .map_err(|error| format!("受信cancelロック取得失敗: {error}"))?
            .get(&upload_id)
            .map(|upload| upload.published || upload.recovery_required)
            .unwrap_or(false);
        if cancelled {
            return Err("反映確定済みの同期はキャンセルできません".to_string());
        }
        let committed_without_pending = pending_received_uploads()
            .lock()
            .map_err(|error| format!("受信cancelロック取得失敗: {error}"))?
            .get(&upload_id)
            .is_none()
            && published_received_uploads()
                .lock()
                .map_err(|error| format!("published uploadロック取得失敗: {error}"))?
                .contains(&upload_id);
        if committed_without_pending {
            return Err("反映確定済みの同期はキャンセルできません".to_string());
        }
        let removed = pending_received_uploads()
            .lock()
            .map_err(|error| format!("受信cancelロック取得失敗: {error}"))?
            .remove(&upload_id);
        if let Some(upload) = removed {
            if let Some(stage) = upload.import_stage {
                let _ = fs::remove_dir_all(stage.stage_root);
            }
            if let Some(stage) = upload.event_sync_stage {
                let _ = fs::remove_dir_all(stage.stage_root);
            }
            let _ = upload.sender.try_send(ReceivedUploadAck::Failure(
                "モバイル側で同期がキャンセルされました".to_string(),
            ));
        }
    }
    apply_receive_sync_notification_locked(&mut *session, target_event_uid, state)
}

fn receive_sync_session_response(
    target_event_uid: &str,
) -> Result<(u16, Value, bool), String> {
    let session_id = receive_server_auth()
        .lock()
        .ok()
        .and_then(|auth| {
            auth.as_ref()
                .filter(|auth| auth.target_event_uid == target_event_uid)
                .map(|auth| sha256_hex(auth.bearer_token.as_bytes()))
        });
    let session = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?
        .clone()
        .ok_or_else(|| "single-event sync session is not active".to_string())?;
    if session.target_event_uid != target_event_uid {
        return Err("single-event sync session target UID is invalid".to_string());
    }
    let mut payload = json!({
        "targetEventUid": target_event_uid,
        "target_uid": target_event_uid,
    });
    if let Some(session_id) = session_id {
        payload["sessionId"] = json!(session_id);
    }
    let (status, terminal) = match session.state {
        ReceiveSyncSessionState::Waiting => {
            payload["state"] = json!("pending");
            payload["status"] = json!("pending");
            (202, false)
        }
        ReceiveSyncSessionState::Pending { upload_id } => {
            payload["state"] = json!("pending");
            payload["status"] = json!("pending");
            payload["uploadId"] = json!(upload_id);
            (202, false)
        }
        ReceiveSyncSessionState::PcReady { download_url } => {
            payload["state"] = json!("pc-ready");
            payload["status"] = json!("pc-ready");
            payload["source"] = json!("pc");
            payload["downloadUrl"] = json!(download_url);
            payload["download_url"] = payload["downloadUrl"].clone();
            // Keep the receive listener alive until mobile posts its final
            // apply acknowledgement on the same URL.
            (200, false)
        }
        ReceiveSyncSessionState::MobileApplied => {
            payload["state"] = json!("mobile-applied");
            payload["status"] = json!("mobile-applied");
            payload["source"] = json!("mobile");
            (200, true)
        }
        ReceiveSyncSessionState::Cancelled { message } => {
            payload["state"] = json!("cancelled");
            payload["status"] = json!("cancelled");
            payload["error"] = json!(message);
            (200, true)
        }
        ReceiveSyncSessionState::Error { message } => {
            payload["state"] = json!("error");
            payload["status"] = json!("error");
            payload["error"] = json!(message);
            (200, true)
        }
    };
    Ok((status, payload, terminal))
}

fn receive_sync_session_response_for_generation(
    worker: &Arc<AtomicBool>,
    target_event_uid: &str,
) -> Result<(u16, Value, bool), String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Err("receive server generation is no longer active".to_string());
    }
    receive_sync_session_response(target_event_uid)
}

fn receive_sync_error_is_cancelled(error: &str) -> bool {
    ["中断", "停止", "期限切れ", "キャンセル", "cancel", "canceled", "cancelled"]
        .iter()
        .any(|marker| error.to_ascii_lowercase().contains(marker))
}

fn receive_sync_session_event_payload(
    target_event_uid: &str,
    delivered: bool,
) -> Result<Value, String> {
    let (_, mut payload, _) = receive_sync_session_response(target_event_uid)?;
    payload["delivered"] = json!(delivered);
    Ok(payload)
}

const RECEIVE_SYNC_EXPIRED_MESSAGE: &str = "QRの有効期限が切れました。もう一度QRを表示して同期を開始してください";

fn receive_sync_session_expired_payload(target_event_uid: &str) -> Result<Value, String> {
    let mut payload = receive_sync_session_event_payload(target_event_uid, false)?;
    payload["expired"] = json!(true);
    payload["message"] = json!(RECEIVE_SYNC_EXPIRED_MESSAGE);
    payload["error"] = json!(RECEIVE_SYNC_EXPIRED_MESSAGE);
    Ok(payload)
}

fn emit_receive_event_for_generation(
    window: &tauri::Window,
    worker: &Arc<AtomicBool>,
    event: &str,
    payload: Value,
) -> bool {
    let Ok(running) = receive_server_running().lock() else {
        return false;
    };
    if !receive_generation_is_current(&running, worker) {
        return false;
    }
    window.emit(event, payload).is_ok()
}

fn expire_receive_generation_if_needed(
    window: &tauri::Window,
    worker: &Arc<AtomicBool>,
) -> Result<bool, String> {
    let running = receive_server_running()
        .lock()
        .map_err(|error| format!("receive running lock error: {error}"))?;
    if !receive_generation_is_current(&running, worker) {
        return Ok(false);
    }
    let expired = receive_server_auth()
        .lock()
        .map_err(|error| format!("receive auth lock error: {error}"))?
        .as_ref()
        .is_some_and(|auth| Instant::now() >= auth.expires_at);
    if !expired {
        return Ok(true);
    }

    let target_event_uid = receive_sync_session()
        .lock()
        .map_err(|error| format!("receive sync session lock error: {error}"))?
        .as_ref()
        .map(|session| session.target_event_uid.clone());
    if let Some(target_event_uid) = target_event_uid {
        let transitioned = expire_receive_sync_session(
            &target_event_uid,
            RECEIVE_SYNC_EXPIRED_MESSAGE.to_string(),
        )
        .unwrap_or(false);
        if transitioned {
            if let Ok(payload) = receive_sync_session_expired_payload(&target_event_uid) {
                let _ = window.emit("event-sync-session-state", payload);
            }
        }
    }
    // Keep this cleanup under the same generation lock as the expiry
    // transition. A replacement generation cannot lose its upload here.
    terminal_cancel_all_received_uploads_for_generation(
        "QR pairingが期限切れです",
        Some(worker),
    );
    worker.store(false, Ordering::Relaxed);
    Ok(false)
}

fn emit_receive_sync_session_state_for_generation(
    window: &tauri::Window,
    worker: &Arc<AtomicBool>,
    target_event_uid: &str,
    delivered: bool,
) -> bool {
    let Ok(running) = receive_server_running().lock() else {
        return false;
    };
    if !receive_generation_is_current(&running, worker) {
        return false;
    }
    let Ok(payload) = receive_sync_session_event_payload(target_event_uid, delivered) else {
        return false;
    };
    window.emit("event-sync-session-state", payload).is_ok()
}

fn query_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn receive_sync_target_metadata(
    project_root: &Path,
    target_event_uid: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let (_, _, event_data) = find_unique_event_dir_by_uid(project_root, target_event_uid)?;
    let event = event_data.get("event").unwrap_or(&Value::Null);
    let name = event_field_string(event, "name");
    let date = normalized_event_date(event);
    Ok((name, date))
}

fn single_event_sync_receive_url(
    upload_url: &str,
    target_event_uid: &str,
    target_name: Option<&str>,
    target_date: Option<&str>,
    bearer_token: &str,
) -> String {
    let mut url = format!(
        "{upload_url}?mode=single-event-sync&target_uid={}",
        query_encode(target_event_uid)
    );
    if let Some(target_name) = target_name {
        url.push_str("&target_name=");
        url.push_str(&query_encode(target_name));
    }
    if let Some(target_date) = target_date {
        url.push_str("&target_date=");
        url.push_str(&query_encode(target_date));
    }
    url.push_str("&token=");
    url.push_str(bearer_token);
    url
}

fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut message = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in message.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, bytes) in chunk.chunks_exact(4).take(16).enumerate() {
            words[index] = u32::from_be_bytes(bytes.try_into().expect("4 byte word"));
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

#[derive(Clone, Debug)]
struct SyncZipAsset {
    key: String,
    archive_name: String,
    digest: String,
}

#[derive(Clone, Debug)]
struct ValidatedSyncZip {
    event_data: Value,
    assets: Vec<SyncZipAsset>,
}

fn is_shared_import_archive_path(path: &Path) -> bool {
    let folded = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    folded == "circle_master.json"
        || folded == "default_cuts"
        || folded.starts_with("default_cuts/")
}

fn parse_sync_zip_aliases_with_scope(
    archive: &mut zip::ZipArchive<fs::File>,
    allow_shared: bool,
) -> Result<HashMap<String, String>, String> {
    let mut file = match archive.by_name("asset_manifest.json") {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(HashMap::new()),
        Err(error) => return Err(format!("asset_manifest.jsonを読めません: {error}")),
    };
    if file.size() > 2 * 1024 * 1024 {
        return Err("asset_manifest.jsonが大きすぎます".to_string());
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| format!("asset_manifest.json読み込み失敗: {error}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("asset_manifest.json解析失敗: {error}"))?;
    if let Some(assets) = value.get("assets") {
        let assets = assets
            .as_object()
            .ok_or_else(|| "asset_manifest.json assetsが不正です".to_string())?;
        for entry in assets.values() {
            let entry = entry
                .as_object()
                .ok_or_else(|| "asset_manifest.json asset entryが不正です".to_string())?;
            for field in ["path", "paths", "original_names"] {
                let Some(paths) = entry.get(field) else {
                    continue;
                };
                let values: Vec<&str> = if let Some(single) = paths.as_str() {
                    vec![single]
                } else if let Some(array) = paths.as_array() {
                    array
                        .iter()
                        .map(|path| {
                            path.as_str().ok_or_else(|| {
                                format!("asset_manifest.json {field}に文字列以外があります")
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    return Err(format!("asset_manifest.json {field}が不正です"));
                };
                for path in values {
                    let path = strict_sync_archive_relative_path(path).ok_or_else(|| {
                        format!("asset_manifest.json {field} pathがunsafeです: {path}")
                    })?;
                    let normalized_path = path
                        .to_string_lossy()
                        .replace('\\', "/")
                        .to_ascii_lowercase();
                    let content_asset = normalized_path.starts_with("assets/");
                    let shared_path = is_shared_import_archive_path(&path);
                    if !(is_allowed_sync_asset_path(&path)
                        || (content_asset && field != "original_names")
                        || (allow_shared && shared_path))
                    {
                        return Err(format!(
                            "asset_manifest.json {field} pathが許可root外です: {}",
                            path.display()
                        ));
                    }
                }
            }
        }
    }
    let Some(aliases) = value.get("aliases") else {
        return Ok(HashMap::new());
    };
    let aliases = aliases
        .as_object()
        .ok_or_else(|| "asset_manifest.json aliasesが不正です".to_string())?;
    let mut result = HashMap::new();
    let mut destinations = HashSet::new();
    for (logical, source) in aliases {
        let source = source
            .as_str()
            .ok_or_else(|| "asset_manifest.json asset pathが文字列ではありません".to_string())?;
        let logical_path = strict_sync_archive_relative_path(logical)
            .ok_or_else(|| format!("asset manifest logical pathがunsafeです: {logical}"))?;
        let source_path = strict_sync_archive_relative_path(source)
            .ok_or_else(|| format!("asset manifest source pathがunsafeです: {source}"))?;
        let source_folded = source_path
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase();
        let source_is_content_asset =
            source_folded.starts_with("assets/") && source_folded.len() > "assets/".len();
        let logical_is_shared = is_shared_import_archive_path(&logical_path);
        let source_is_shared = is_shared_import_archive_path(&source_path);
        if !(is_allowed_sync_asset_path(&logical_path) || (allow_shared && logical_is_shared))
            || !(source_is_content_asset
                || is_allowed_sync_asset_path(&source_path)
                || (allow_shared && source_is_shared))
        {
            return Err(format!(
                "asset manifest pathが単一イベント同期の許可root外です: {logical} -> {source}"
            ));
        }
        let logical = logical_path.to_string_lossy().replace('\\', "/");
        let folded = logical.to_lowercase();
        if !destinations.insert(folded) {
            return Err(format!(
                "asset manifest logical pathが重複しています: {logical}"
            ));
        }
        result.insert(logical, source_path.to_string_lossy().replace('\\', "/"));
    }
    Ok(result)
}

fn is_image_asset_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "bmp" | "tif" | "tiff"
            )
        })
}

fn read_validated_sync_zip(
    zip_path: &Path,
    expected_uid: &str,
) -> Result<ValidatedSyncZip, String> {
    read_validated_sync_zip_with_scope(zip_path, Some(expected_uid), false)
}

fn read_validated_sync_zip_with_scope(
    zip_path: &Path,
    expected_uid: Option<&str>,
    allow_shared: bool,
) -> Result<ValidatedSyncZip, String> {
    let metadata = fs::metadata(zip_path).map_err(|e| format!("ZIP metadata取得失敗: {e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_RECEIVED_ZIP_BYTES {
        return Err("受信ZIPのサイズまたは種別が不正です".to_string());
    }
    let zip_file = fs::File::open(zip_path).map_err(|e| format!("ZIPを開けません: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP展開失敗: {e}"))?;
    if archive.len() == 0 || archive.len() > MAX_SYNC_ZIP_ENTRIES {
        return Err("ZIP entry数が許容範囲外です".to_string());
    }
    let mut members: HashMap<String, (String, u64)> = HashMap::new();
    let mut all_names = HashSet::new();
    let mut expanded_size = 0u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| format!("ZIP entry読み込み失敗: {e}"))?;
        let raw_name = file.name().to_string();
        let directory = raw_name.ends_with('/');
        let normalized_input = if directory {
            raw_name.trim_end_matches('/')
        } else {
            raw_name.as_str()
        };
        let relative = strict_sync_archive_relative_path(normalized_input)
            .ok_or_else(|| format!("unsafe ZIP entry pathです: {raw_name}"))?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if !all_names.insert(name.to_lowercase()) {
            return Err(format!(
                "ZIP entry pathがcase-insensitiveで重複しています: {name}"
            ));
        }
        if let Some(mode) = file.unix_mode() {
            let kind = mode & 0o170000;
            let allowed_kind = if directory { 0o040000 } else { 0o100000 };
            if kind == 0o120000 || (kind != 0 && kind != allowed_kind) {
                return Err(format!("ZIP entry typeがsymlinkまたは特殊fileです: {name}"));
            }
        }
        let name_folded = name.to_ascii_lowercase();
        let shared_path = is_shared_import_archive_path(&relative);
        if shared_path && !allow_shared {
            return Err(
                "単一イベント同期ZIPにcircle_master/default_cutsが含まれています".to_string(),
            );
        }
        if directory {
            if shared_path && allow_shared {
                continue;
            }
            if !is_allowed_sync_directory_path(&relative) {
                return Err(format!("ZIP directory pathが許可root外です: {name}"));
            }
            continue;
        }
        if (name_folded == "event.json" && name != "event.json")
            || (name_folded == "asset_manifest.json" && name != "asset_manifest.json")
        {
            return Err(format!(
                "reserved ZIP pathはcanonical表記が必要です: {name}"
            ));
        }
        if !is_allowed_sync_archive_path(&relative) && !(allow_shared && shared_path) {
            return Err(format!("ZIP file pathが許可root外です: {name}"));
        }
        if file.size() > MAX_SYNC_ZIP_ENTRY_BYTES {
            return Err(format!("ZIP entryが大きすぎます: {name}"));
        }
        expanded_size = expanded_size.saturating_add(file.size());
        if expanded_size > MAX_SYNC_ZIP_EXPANDED_BYTES {
            return Err("ZIP展開後サイズが許容上限を超えています".to_string());
        }
        if file.size() > 1_048_576
            && file.compressed_size() > 0
            && file.size() / file.compressed_size() > 1000
        {
            return Err(format!("ZIP entry圧縮率が許容範囲外です: {name}"));
        }
        members.insert(name.to_lowercase(), (name, file.size()));
    }
    let event_member = members
        .get("event.json")
        .ok_or_else(|| "ZIP rootにevent.jsonがありません".to_string())?;
    if event_member.1 > 20 * 1024 * 1024 {
        return Err("event.jsonが大きすぎます".to_string());
    }
    let mut event_file = archive
        .by_name("event.json")
        .map_err(|e| format!("event.jsonを読めません: {e}"))?;
    let mut event_text = String::new();
    event_file
        .read_to_string(&mut event_text)
        .map_err(|e| format!("event.json読み込み失敗: {e}"))?;
    drop(event_file);
    let event_data: Value =
        serde_json::from_str(&event_text).map_err(|e| format!("event.json解析失敗: {e}"))?;
    let mobile_uid = event_uid_from_data(&event_data);
    if let Some(expected_uid) = expected_uid {
        let mobile_uid = mobile_uid
            .ok_or_else(|| "mobile event.jsonにstable event_uidがありません".to_string())?;
        if mobile_uid != expected_uid {
            return Err("mobile event UIDが選択したdesktop eventと一致しません".to_string());
        }
    } else if let Some(raw_uid) = event_data.get("event_uid") {
        let uid = raw_uid
            .as_str()
            .map(str::trim)
            .filter(|uid| valid_event_uid(uid))
            .ok_or_else(|| "local event.jsonのevent_uid形式が不正です".to_string())?;
        let _ = uid;
    }

    let aliases = parse_sync_zip_aliases_with_scope(&mut archive, allow_shared)?;
    let mut logical_assets: HashMap<String, String> = HashMap::new();
    for (logical, source) in aliases {
        if !members.contains_key(&source.to_lowercase()) {
            return Err(format!(
                "asset manifest sourceがZIP内にありません: {source}"
            ));
        }
        logical_assets.insert(logical, source);
    }
    for (folded, (name, _)) in &members {
        if name == "event.json"
            || name == "asset_manifest.json"
            || name.starts_with("assets/")
            || (allow_shared && is_shared_import_archive_path(Path::new(name)))
        {
            continue;
        }
        logical_assets
            .entry(name.clone())
            .or_insert_with(|| name.clone());
        let _ = folded;
    }
    let mut assets = Vec::new();
    let mut logical_paths = HashSet::new();
    for (key, archive_name) in logical_assets {
        let relative = strict_sync_archive_relative_path(&key)
            .ok_or_else(|| format!("mobile asset pathがunsafeです: {key}"))?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let normalized_folded = normalized.to_lowercase();
        if normalized_folded == "event.json"
            || normalized_folded == "asset_manifest.json"
            || (!allow_shared && is_shared_import_archive_path(&relative))
        {
            return Err(format!("mobile asset pathが許可対象外です: {normalized}"));
        }
        if !logical_paths.insert(normalized.to_lowercase()) {
            return Err(format!(
                "mobile asset destinationが重複しています: {normalized}"
            ));
        }
        let mut file = archive
            .by_name(&archive_name)
            .map_err(|e| format!("mobile asset読み込み失敗 {archive_name}: {e}"))?;
        let mut bytes = Vec::with_capacity(file.size().min(8 * 1024 * 1024) as usize);
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("mobile asset読み込み失敗 {archive_name}: {e}"))?;
        if bytes.len() as u64 != file.size() {
            return Err(format!("mobile asset size不一致: {archive_name}"));
        }
        assets.push(SyncZipAsset {
            key: normalized,
            archive_name,
            digest: sha256_hex(&bytes),
        });
    }
    Ok(ValidatedSyncZip { event_data, assets })
}

fn validate_local_import_zip(zip_path: &Path) -> Result<(), String> {
    let zip_file = fs::File::open(zip_path).map_err(|e| format!("local ZIPを開けません: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("local ZIP展開失敗: {e}"))?;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| format!("local ZIP entry読み込み失敗: {e}"))?;
        let folded = file.name().replace('\\', "/").to_ascii_lowercase();
        if folded == "sync_bundle.json" || folded.starts_with("events/") {
            return Err("全イベントbundle ZIPはlocal importに対応していません".to_string());
        }
    }
    read_validated_sync_zip_with_scope(zip_path, None, true).map(|_| ())
}

fn sanitize_local_asset_manifest(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("local asset_manifest.json解析失敗: {e}"))?;
    let mut aliases = serde_json::Map::new();
    if let Some(entries) = value.get("aliases") {
        let entries = entries
            .as_object()
            .ok_or_else(|| "local asset_manifest.json aliasesが不正です".to_string())?;
        for (logical, source) in entries {
            let source = source
                .as_str()
                .ok_or_else(|| "local asset_manifest.json alias sourceが不正です".to_string())?;
            let logical_path = strict_sync_archive_relative_path(logical)
                .ok_or_else(|| format!("local alias pathがunsafeです: {logical}"))?;
            let source_path = strict_sync_archive_relative_path(source)
                .ok_or_else(|| format!("local alias sourceがunsafeです: {source}"))?;
            if is_shared_import_archive_path(&logical_path)
                || is_shared_import_archive_path(&source_path)
            {
                continue;
            }
            aliases.insert(logical.clone(), json!(source));
        }
    }
    serde_json::to_vec_pretty(&json!({
        "format": "eventtrail_asset_manifest",
        "format_version": 1,
        "aliases": aliases,
    }))
    .map_err(|e| format!("local asset_manifest.json生成失敗: {e}"))
}

fn sanitize_local_import_zip(source: &Path, destination: &Path) -> Result<(), String> {
    validate_local_import_zip(source)?;
    let source_file = fs::File::open(source).map_err(|e| format!("local ZIP再読込失敗: {e}"))?;
    let mut archive = zip::ZipArchive::new(source_file)
        .map_err(|e| format!("local ZIP再展開失敗: {e}"))?;
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| format!("sanitized local ZIP作成失敗: {e}"))?;
    let mut writer = zip::ZipWriter::new(output);
    let options = zip::write::FileOptions::default();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("local ZIP entry再読込失敗: {e}"))?;
        let raw_name = file.name().to_string();
        let directory = raw_name.ends_with('/');
        if directory {
            continue;
        }
        let relative = strict_sync_archive_relative_path(raw_name.trim_end_matches('/'))
            .ok_or_else(|| format!("local ZIP entry pathがunsafeです: {raw_name}"))?;
        if is_shared_import_archive_path(&relative) {
            continue;
        }
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let mut bytes = Vec::with_capacity(file.size().min(8 * 1024 * 1024) as usize);
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("local ZIP entry読み込み失敗: {raw_name}: {e}"))?;
        if bytes.len() as u64 != file.size() {
            return Err(format!("local ZIP entry size不一致: {raw_name}"));
        }
        if normalized.eq_ignore_ascii_case("asset_manifest.json") {
            bytes = sanitize_local_asset_manifest(&bytes)?;
        }
        writer
            .start_file(normalized, options)
            .map_err(|e| format!("sanitized ZIP entry作成失敗: {e}"))?;
        writer
            .write_all(&bytes)
            .map_err(|e| format!("sanitized ZIP entry書込失敗: {e}"))?;
    }
    writer
        .finish()
        .map_err(|e| format!("sanitized local ZIP完了失敗: {e}"))?;
    read_validated_sync_zip_with_scope(destination, None, false)
        .map(|_| ())
        .map_err(|error| format!("sanitized local ZIP再検証失敗: {error}"))
}

fn event_uid_from_data(value: &Value) -> Option<String> {
    let uid = value.get("event_uid")?.as_str()?.trim();
    valid_event_uid(uid).then(|| uid.to_string())
}

fn find_unique_event_dir_by_uid(
    project_root: &Path,
    target_uid: &str,
) -> Result<(String, PathBuf, Value), String> {
    if !valid_event_uid(target_uid) {
        return Err("target event UIDの形式が不正です".to_string());
    }
    let events_dir = project_root.join("events");
    let events_meta = fs::symlink_metadata(&events_dir)
        .map_err(|e| format!("events directoryを確認できません: {e}"))?;
    if !events_meta.is_dir() || metadata_is_link_or_reparse(&events_meta) {
        return Err("events directoryが通常のdirectoryではありません".to_string());
    }
    let mut found: Vec<(String, PathBuf, Value)> = Vec::new();
    for entry in fs::read_dir(&events_dir).map_err(|e| format!("events directory読込失敗: {e}"))?
    {
        let entry = entry.map_err(|e| format!("events entry読込失敗: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("event directory metadata失敗: {e}"))?;
        if metadata_is_link_or_reparse(&metadata) {
            return Err(format!(
                "events directory内にsymlink/reparseがあります: {}",
                entry.path().display()
            ));
        }
        if !metadata.is_dir() {
            continue;
        }
        let event_path = entry.path().join("event.json");
        let event_metadata = match fs::symlink_metadata(&event_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("event.json metadata取得失敗: {error}")),
        };
        if metadata_is_link_or_reparse(&event_metadata) || !event_metadata.is_file() {
            return Err(format!(
                "event.jsonが通常fileではありません: {}",
                event_path.display()
            ));
        }
        let text = fs::read_to_string(&event_path)
            .map_err(|e| format!("event.json読み込み失敗 {}: {e}", event_path.display()))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| format!("event.json解析失敗 {}: {e}", event_path.display()))?;
        if event_uid_from_data(&value).as_deref() == Some(target_uid) {
            found.push((
                entry.file_name().to_string_lossy().to_string(),
                entry.path(),
                value,
            ));
        }
    }
    match found.len() {
        0 => Err("選択UIDのdesktop eventが見つかりません".to_string()),
        1 => Ok(found.remove(0)),
        _ => Err("選択UIDに一致するdesktop eventが複数あります".to_string()),
    }
}

fn collect_local_image_digests(root: &Path) -> Result<HashMap<String, (String, String)>, String> {
    fn collect(
        root: &Path,
        current: &Path,
        output: &mut HashMap<String, (String, String)>,
    ) -> Result<(), String> {
        for entry in
            fs::read_dir(current).map_err(|e| format!("event asset directory読込失敗: {e}"))?
        {
            let entry = entry.map_err(|e| format!("event asset entry読込失敗: {e}"))?;
            let kind = entry
                .file_type()
                .map_err(|e| format!("event asset種別取得失敗: {e}"))?;
            if kind.is_symlink() {
                return Err(format!(
                    "event assetにsymlinkを含められません: {}",
                    entry.path().display()
                ));
            }
            if kind.is_dir() {
                collect(root, &entry.path(), output)?;
            } else if kind.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| "event asset pathがroot外です".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if is_image_asset_path(&relative) {
                    let bytes = fs::read(entry.path())
                        .map_err(|e| format!("event image読み込み失敗: {e}"))?;
                    let folded = relative.to_lowercase();
                    if output
                        .insert(folded, (relative.clone(), sha256_hex(&bytes)))
                        .is_some()
                    {
                        return Err(format!(
                            "local eventにcase-insensitive重複image pathがあります: {relative}"
                        ));
                    }
                }
            }
        }
        Ok(())
    }
    let mut output = HashMap::new();
    collect(root, root, &mut output)?;
    Ok(output)
}

fn sync_asset_diff(event_dir: &Path, mobile_assets: &[SyncZipAsset]) -> Result<Value, String> {
    let desktop = collect_local_image_digests(event_dir)?;
    let mobile: HashMap<String, &SyncZipAsset> = mobile_assets
        .iter()
        .filter(|asset| is_image_asset_path(&asset.key))
        .map(|asset| (asset.key.to_lowercase(), asset))
        .collect();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    let mut deleted = Vec::new();
    for (folded, asset) in &mobile {
        match desktop.get(folded) {
            None => added
                .push(json!({"key": asset.key, "path": asset.key, "mobileDigest": asset.digest})),
            Some((desktop_path, digest)) if digest != &asset.digest => changed.push(json!({
                "key": asset.key,
                "path": asset.key,
                "desktopPath": desktop_path,
                "desktopDigest": digest,
                "mobileDigest": asset.digest
            })),
            Some(_) => {}
        }
    }
    for (folded, (desktop_path, digest)) in &desktop {
        if !mobile.contains_key(folded) {
            deleted.push(json!({
                "key": desktop_path,
                "path": desktop_path,
                "desktopDigest": digest
            }));
        }
    }
    added.sort_by_key(|asset| asset["key"].as_str().unwrap_or_default().to_string());
    changed.sort_by_key(|asset| asset["key"].as_str().unwrap_or_default().to_string());
    deleted.sort_by_key(|asset| asset["key"].as_str().unwrap_or_default().to_string());
    Ok(json!({"added": added, "changed": changed, "deleted": deleted}))
}

fn received_sync_fingerprint(
    zip_path: &Path,
    event_dir: &Path,
) -> Result<(String, Option<u64>, Option<u64>), String> {
    let zip_preimage = path_content_fingerprint(zip_path)?;
    let live_preimage = path_content_fingerprint(event_dir)?;
    let zip = zip_preimage.ok_or_else(|| "受信ZIPが存在しません".to_string())?;
    let live = live_preimage.ok_or_else(|| "対象event directoryが存在しません".to_string())?;
    Ok((
        format!("event:{live:016x};zip:{zip:016x}"),
        live_preimage,
        zip_preimage,
    ))
}

fn preview_received_event_sync_value(
    upload_id: &str,
    project_root: &Path,
    target_event_uid: &str,
) -> Result<(Value, ReceivedEventSyncStage), String> {
    if received_upload_target_uid(upload_id)? != target_event_uid {
        return Err("target UIDがQR pairingのtargetと一致しません".to_string());
    }
    let zip_path = current_received_upload_zip(upload_id)?;
    let (slug, event_dir, _) = find_unique_event_dir_by_uid(project_root, target_event_uid)?;
    let (before_fingerprint, _, _) = received_sync_fingerprint(&zip_path, &event_dir)?;
    let desktop_event_path = event_dir.join("event.json");
    let desktop_event_metadata = fs::symlink_metadata(&desktop_event_path)
        .map_err(|e| format!("desktop event.json metadata取得失敗: {e}"))?;
    if !desktop_event_metadata.is_file() || metadata_is_link_or_reparse(&desktop_event_metadata) {
        return Err("desktop event.jsonが通常fileではありません".to_string());
    }
    let desktop_text = fs::read_to_string(&desktop_event_path)
        .map_err(|e| format!("desktop event.json読み込み失敗: {e}"))?;
    let desktop_data: Value = serde_json::from_str(&desktop_text)
        .map_err(|e| format!("desktop event.json解析失敗: {e}"))?;
    if event_uid_from_data(&desktop_data).as_deref() != Some(target_event_uid) {
        return Err("preview中にdesktop event UIDが変更されました".to_string());
    }
    let validated_zip = read_validated_sync_zip(&zip_path, target_event_uid)?;
    let asset_diff = sync_asset_diff(&event_dir, &validated_zip.assets)?;
    let (fingerprint, live_preimage, zip_preimage) =
        received_sync_fingerprint(&zip_path, &event_dir)?;
    if fingerprint != before_fingerprint {
        return Err(
            "preview中にdesktop eventまたは受信ZIPが変更されました。再読込してください".to_string(),
        );
    }
    let stage_root = project_root
        .join(".eventtrail-import-stage")
        .join(format!("event-sync-stage-{upload_id}"));
    let stage = ReceivedEventSyncStage {
        stage_root,
        project_root: project_root.to_path_buf(),
        event_dir: event_dir.clone(),
        slug: slug.clone(),
        target_event_uid: target_event_uid.to_string(),
        fingerprint: fingerprint.clone(),
        live_preimage,
        zip_preimage,
    };
    let value = json!({
        "targetSlug": slug,
        "targetEventUid": target_event_uid,
        "desktopData": desktop_data,
        "mobileData": validated_zip.event_data,
        "assetDiff": asset_diff,
        "fingerprint": fingerprint
    });
    Ok((value, stage))
}

fn extract_sync_zip_to_stage(
    zip_path: &Path,
    target_uid: &str,
    destination: &Path,
) -> Result<Value, String> {
    let validated = read_validated_sync_zip(zip_path, target_uid)?;
    fs::create_dir_all(destination)
        .map_err(|e| format!("event sync stage directory作成失敗: {e}"))?;
    let zip_file = fs::File::open(zip_path).map_err(|e| format!("ZIPを開けません: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP再読込失敗: {e}"))?;
    let event_bytes = serde_json::to_vec_pretty(&validated.event_data)
        .map_err(|e| format!("mobile event.json serialize失敗: {e}"))?;
    fs::write(destination.join("event.json"), event_bytes)
        .map_err(|e| format!("mobile event.json stage書込失敗: {e}"))?;
    for asset in &validated.assets {
        let relative = strict_sync_archive_relative_path(&asset.key)
            .ok_or_else(|| format!("unsafe stage asset path: {}", asset.key))?;
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("asset stage directory作成失敗: {e}"))?;
        }
        let mut source = archive
            .by_name(&asset.archive_name)
            .map_err(|e| format!("ZIP asset再読込失敗 {}: {e}", asset.archive_name))?;
        let mut output =
            fs::File::create(&target).map_err(|e| format!("asset stage作成失敗: {e}"))?;
        std::io::copy(&mut source, &mut output)
            .map_err(|e| format!("asset stage書込失敗 {}: {e}", target.display()))?;
        output
            .sync_all()
            .map_err(|e| format!("asset stage sync失敗: {e}"))?;
    }
    Ok(validated.event_data)
}

fn copy_directory_without_links(source: &Path, destination: &Path) -> Result<(), String> {
    let source_metadata =
        fs::symlink_metadata(source).map_err(|e| format!("stage source metadata取得失敗: {e}"))?;
    if !source_metadata.is_dir() || metadata_is_link_or_reparse(&source_metadata) {
        return Err(format!(
            "stage sourceが通常directoryではありません: {}",
            source.display()
        ));
    }
    fs::create_dir_all(destination).map_err(|e| format!("stage directory作成失敗: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("stage source読込失敗: {e}"))? {
        let entry = entry.map_err(|e| format!("stage entry読込失敗: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("stage entry metadata取得失敗: {e}"))?;
        let file_type = metadata.file_type();
        if metadata_is_link_or_reparse(&metadata) {
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
        "eventName": plan.event_name,
        "eventDate": plan.event_date,
        "targetExists": plan.target_exists,
        "localOnly": plan.local_only,
        "affectedEvents": affected,
    })
}

#[tauri::command]
fn plan_received_result_import(upload_id: String, project_root: String) -> Result<Value, String> {
    let zip_path = current_received_upload_zip(&upload_id)?;
    let local_only = received_upload_is_local_only(&upload_id)?;
    let project_root = absolute_project_root(&project_root)?;
    let plan = plan_received_import_with_scope(&zip_path, &project_root, local_only)?;
    current_received_upload_zip(&upload_id)?;
    Ok(received_import_plan_value(&plan))
}

#[tauri::command]
fn stage_received_result_import(
    upload_id: String,
    project_root: String,
    expected_slug: String,
) -> Result<Value, String> {
    if !valid_received_upload_id(&upload_id) {
        return Err("uploadIdが不正です".to_string());
    }
    let zip_path = current_received_upload_zip(&upload_id)?;
    let local_only = received_upload_is_local_only(&upload_id)?;
    let project_root_path = absolute_project_root(&project_root)?;
    let plan = plan_received_import_with_scope(&zip_path, &project_root_path, local_only)?;
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
    ];
    if !local_only {
        live_preimages.push((
            project_root_path.join("circle_master.json"),
            path_content_fingerprint(&project_root_path.join("circle_master.json"))?,
        ));
    }
    for (_, redundant) in &plan.redundant_events {
        live_preimages.push((redundant.clone(), path_content_fingerprint(redundant)?));
    }
    if plan.event_dir.is_dir() {
        copy_directory_without_links(&plan.event_dir, &stage_root.join("events").join(&plan.slug))?;
    }
    if !local_only {
        let circle_master = project_root_path.join("circle_master.json");
        if circle_master.is_file() {
            fs::copy(&circle_master, stage_root.join("circle_master.json"))
                .map_err(|e| format!("circle_master stage copy失敗: {e}"))?;
        }
    }
    let staged = import_result_zip_into_root(
        zip_path.to_string_lossy().to_string(),
        stage_root.to_string_lossy().to_string(),
        Some(plan.slug.clone()),
    );
    let result = staged?;
    if !local_only {
        let staged_cuts = stage_root.join("default_cuts");
        for relative in staged_files(&staged_cuts)? {
            let live = project_root_path.join("default_cuts").join(relative);
            live_preimages.push((live.clone(), path_content_fingerprint(&live)?));
        }
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
        local_only,
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

#[tauri::command]
fn preview_received_event_sync(
    upload_id: String,
    project_root: String,
    target_event_uid: String,
) -> Result<Value, String> {
    let project_root = absolute_project_root(&project_root)?;
    let (preview, _) =
        preview_received_event_sync_value(&upload_id, &project_root, &target_event_uid)?;
    current_received_upload_zip(&upload_id)?;
    Ok(preview)
}

#[tauri::command]
fn stage_received_event_sync(
    upload_id: String,
    project_root: String,
    target_event_uid: String,
    expected_fingerprint: String,
) -> Result<Value, String> {
    if !valid_received_upload_id(&upload_id) {
        return Err("uploadIdが不正です".to_string());
    }
    let receive_running = receive_server_running()
        .lock()
        .map_err(|e| format!("event sync stage generation lock取得失敗: {e}"))?;
    ensure_received_upload_generation_current(&upload_id, &receive_running)?;
    let _publish_guard = circle_master_write_lock()
        .lock()
        .map_err(|e| format!("event sync stage lock取得失敗: {e}"))?;
    let _event_mutation_guard = event_json_mutation_lock()
        .lock()
        .map_err(|e| format!("event sync stage mutation lock取得失敗: {e}"))?;
    let project_root_path = absolute_project_root(&project_root)?;
    let (preview, mut stage) =
        preview_received_event_sync_value(&upload_id, &project_root_path, &target_event_uid)?;
    if preview["fingerprint"].as_str() != Some(expected_fingerprint.as_str()) {
        return Err(
            "preview後にdesktop eventまたは受信ZIPが変更されました。差分を再読込してください"
                .to_string(),
        );
    }
    let zip_path = current_received_upload_zip(&upload_id)?;
    let _ = fs::remove_dir_all(&stage.stage_root);
    let mut cleanup = RemoveDirOnDrop {
        path: stage.stage_root.clone(),
        armed: true,
    };
    let staged_event = stage.stage_root.join("events").join(&stage.slug);
    extract_sync_zip_to_stage(&zip_path, &target_event_uid, &staged_event)?;
    let staged_text = fs::read_to_string(staged_event.join("event.json"))
        .map_err(|e| format!("staged event.json再読込失敗: {e}"))?;
    let staged_value: Value = serde_json::from_str(&staged_text)
        .map_err(|e| format!("staged event.json再解析失敗: {e}"))?;
    if event_uid_from_data(&staged_value).as_deref() != Some(target_event_uid.as_str()) {
        return Err("staged event UIDがtargetと一致しません".to_string());
    }
    let (current_fingerprint, live_preimage, zip_preimage) =
        received_sync_fingerprint(&zip_path, &stage.event_dir)?;
    if current_fingerprint != stage.fingerprint
        || Some(current_fingerprint.as_str()) != preview["fingerprint"].as_str()
    {
        return Err("stage作成中にdesktop eventまたは受信ZIPが変更されました".to_string());
    }
    stage.live_preimage = live_preimage;
    stage.zip_preimage = zip_preimage;
    ensure_received_upload_generation_current(&upload_id, &receive_running)?;
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("event sync pending lock取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed
        || Instant::now() >= upload.lease_deadline
        || upload.target_event_uid.as_deref() != Some(target_event_uid.as_str())
    {
        return Err("upload lease/targetがcurrentではありません".to_string());
    }
    if let Some(previous) = upload.event_sync_stage.replace(stage.clone()) {
        let _ = fs::remove_dir_all(previous.stage_root);
    }
    cleanup.armed = false;
    Ok(json!({
        "status": "ok",
        "targetSlug": stage.slug,
        "targetEventUid": stage.target_event_uid,
        "fingerprint": stage.fingerprint
    }))
}

#[tauri::command]
fn publish_received_event_sync(upload_id: String) -> Result<Value, String> {
    if !valid_received_upload_id(&upload_id) {
        return Err("uploadIdが不正です".to_string());
    }
    let receive_running = receive_server_running()
        .lock()
        .map_err(|e| format!("event sync publish generation lock取得失敗: {e}"))?;
    let _circle_master_guard = circle_master_write_lock()
        .lock()
        .map_err(|e| format!("event sync publish lock取得失敗: {e}"))?;
    let _event_mutation_guard = event_json_mutation_lock()
        .lock()
        .map_err(|e| format!("event sync mutation lock取得失敗: {e}"))?;
    let mut pending = pending_received_uploads()
        .lock()
        .map_err(|e| format!("event sync publish registry lock取得失敗: {e}"))?;
    let upload = pending
        .get_mut(&upload_id)
        .ok_or_else(|| "upload leaseは期限切れまたは取消済みです".to_string())?;
    if !upload.claimed || Instant::now() >= upload.lease_deadline {
        return Err("upload leaseはcurrentではありません".to_string());
    }
    if let Some(worker) = upload.receive_generation.as_ref() {
        if !receive_generation_is_current(&receive_running, worker) {
            return Err("event sync upload generation is no longer active".to_string());
        }
    }
    if upload.import_stage.is_some() {
        return Err("通常import stageとevent sync stageが同じuploadにあります".to_string());
    }
    let stage = upload
        .event_sync_stage
        .clone()
        .ok_or_else(|| "publish対象のevent sync stageがありません".to_string())?;
    if upload.target_event_uid.as_deref() != Some(stage.target_event_uid.as_str()) {
        return Err("sync stageのtarget UIDがupload targetと一致しません".to_string());
    }
    let zip_path = upload.zip_path.clone();
    let mut published = Vec::new();
    let mut manual_backup_path = None;
    let manifest_path = stage.stage_root.join("transaction.json");
    let publish_result = (|| -> Result<(), String> {
        let (slug, current_event_dir, event_data) =
            find_unique_event_dir_by_uid(&stage.project_root, &stage.target_event_uid)?;
        if slug != stage.slug || current_event_dir != stage.event_dir {
            return Err("stage後にUIDとevent directoryの対応が変更されました".to_string());
        }
        let (current_fingerprint, live_preimage, zip_preimage) =
            received_sync_fingerprint(&zip_path, &stage.event_dir)?;
        if current_fingerprint != stage.fingerprint
            || live_preimage != stage.live_preimage
            || zip_preimage != stage.zip_preimage
        {
            return Err(
                "stage後に対象eventまたは受信ZIPが変更されました。差分を再読込してください"
                    .to_string(),
            );
        }
        let staged_event = stage.stage_root.join("events").join(&stage.slug);
        let staged_text = fs::read_to_string(staged_event.join("event.json"))
            .map_err(|e| format!("staged event.json読込失敗: {e}"))?;
        let staged_data: Value = serde_json::from_str(&staged_text)
            .map_err(|e| format!("staged event.json解析失敗: {e}"))?;
        if event_uid_from_data(&staged_data).as_deref() != Some(stage.target_event_uid.as_str())
            || event_uid_from_data(&event_data).as_deref() != Some(stage.target_event_uid.as_str())
        {
            return Err("publish直前のevent UID確認に失敗しました".to_string());
        }

        let manual_backup = stage
            .project_root
            .join(".eventtrail-import-stage")
            .join("event-sync-backups")
            .join(&stage.slug)
            .join(&upload_id);
        if manual_backup.exists() {
            return Err("同じuploadIdのevent sync backupが既に存在します".to_string());
        }
        validate_contained_path(
            &manual_backup,
            &stage.project_root.join(".eventtrail-import-stage"),
            "event sync backup",
        )?;
        let backup_result = (|| -> Result<(), String> {
            copy_directory_without_links(&stage.event_dir, &manual_backup)?;
            sync_path_tree(&manual_backup)?;
            let backup_fingerprint = path_content_fingerprint(&manual_backup)?;
            if backup_fingerprint != stage.live_preimage {
                return Err("publish用event backupが対象eventと一致しません".to_string());
            }
            Ok(())
        })();
        if let Err(error) = backup_result {
            let _ = fs::remove_dir_all(&manual_backup);
            return Err(error);
        }
        manual_backup_path = Some(manual_backup.clone());

        let (_, final_event_dir, final_event_data) =
            find_unique_event_dir_by_uid(&stage.project_root, &stage.target_event_uid)?;
        let (_, final_live_preimage, final_zip_preimage) =
            received_sync_fingerprint(&zip_path, &stage.event_dir)?;
        if final_event_dir != stage.event_dir
            || event_uid_from_data(&final_event_data).as_deref()
                != Some(stage.target_event_uid.as_str())
            || final_live_preimage != stage.live_preimage
            || final_zip_preimage != stage.zip_preimage
        {
            return Err(
                "backup作成中に対象eventまたはZIPが変更されました。同期を再読込してください"
                    .to_string(),
            );
        }

        let source = staged_event
            .strip_prefix(&stage.stage_root)
            .map_err(|_| "staged event pathがtransaction root外です".to_string())?
            .to_path_buf();
        let destination = stage
            .event_dir
            .strip_prefix(&stage.project_root)
            .map_err(|_| "event destinationがproject root外です".to_string())?
            .to_path_buf();
        let mut manifest = PersistentPublishManifest {
            version: 1,
            phase: "publishing".to_string(),
            completed_operations: 0,
            operations: vec![PersistentPublishOperation {
                source: Some(source),
                destination,
                backup: PathBuf::from("publish-backup/target-event"),
                had_destination: true,
            }],
        };
        persist_publish_manifest(&manifest_path, &manifest)?;
        let operation = &manifest.operations[0];
        let (source, destination, backup) =
            resolve_manifest_operation(&stage.project_root, &stage.stage_root, operation)?;
        install_staged_path(source.as_deref(), &destination, &backup, &mut published)?;
        manifest.completed_operations = 1;
        persist_publish_manifest(&manifest_path, &manifest)?;
        manifest.phase = "committed".to_string();
        persist_publish_manifest(&manifest_path, &manifest)?;
        Ok(())
    })();
    if let Err(error) = publish_result {
        let rollback = rollback_published_paths(&mut published);
        if let Err(rollback_error) = rollback {
            upload.recovery_required = true;
            let recovery_root = stage
                .project_root
                .join(".eventtrail-import-recovery")
                .join(format!("event-sync-{upload_id}"));
            let (preserved_root, preserve_error) = preserve_failed_transaction_with(
                &stage.stage_root,
                &recovery_root,
                persist_publish_manifest,
                durable_rename,
            );
            upload.event_sync_stage = Some(ReceivedEventSyncStage {
                stage_root: preserved_root.clone(),
                ..stage
            });
            return Err(format!(
                "event sync publish失敗: {error}; rollback失敗: {rollback_error}; recovery={}; recovery-mark={}",
                preserved_root.display(),
                preserve_error.unwrap_or_else(|| "ok".to_string())
            ));
        }
        upload.event_sync_stage = Some(stage);
        return Err(error);
    }
    upload.lease_deadline = Instant::now() + RECEIVED_UPLOAD_LEASE_DURATION;
    let _ = fs::remove_dir_all(&stage.stage_root);
    upload.event_sync_stage = None;
    upload.published = true;
    published_received_uploads()
        .lock()
        .map_err(|e| format!("published uploadロック取得失敗: {e}"))?
        .insert(upload_id.clone());
    let _ = fs::remove_file(&upload.zip_path);
    let _ = upload.sender.try_send(ReceivedUploadAck::Success(None));
    let backup_path = manual_backup_path
        .map(|path| path.to_string_lossy().to_string().replace('\\', "/"))
        .ok_or_else(|| "event backup pathを確定できません".to_string())?;
    Ok(json!({
        "status": "ok",
        "slug": stage.slug,
        "targetSlug": stage.slug,
        "targetEventUid": stage.target_event_uid,
        "dir": stage.event_dir.to_string_lossy().to_string().replace('\\', "/"),
        "backupPath": backup_path,
        "fingerprint": stage.fingerprint
    }))
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
    let mut manual_backup_path = None;
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
        if stage.local_only && stage.plan.target_exists {
            let manual_backup = stage
                .project_root
                .join(".eventtrail-import-stage")
                .join("local-import-backups")
                .join(&stage.plan.slug)
                .join(&upload_id);
            if manual_backup.exists() {
                return Err("同じuploadIdのlocal import backupが既に存在します".to_string());
            }
            validate_contained_path(
                &manual_backup,
                &stage.project_root.join(".eventtrail-import-stage"),
                "local import backup",
            )?;
            copy_directory_without_links(&stage.plan.event_dir, &manual_backup)?;
            sync_path_tree(&manual_backup)?;
            let expected = stage
                .live_preimages
                .first()
                .and_then(|(_, fingerprint)| *fingerprint);
            if path_content_fingerprint(&manual_backup)? != expected {
                let _ = fs::remove_dir_all(&manual_backup);
                return Err("local import backupが対象eventと一致しません".to_string());
            }
            manual_backup_path = Some(manual_backup);
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
        if !stage.local_only {
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
        }
        let staged_master = stage.stage_root.join("circle_master.json");
        if !stage.local_only && staged_master.is_file() {
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
        if !stage.local_only {
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
    let _ = upload.sender.try_send(ReceivedUploadAck::Success(None));
    let backup_path = manual_backup_path
        .map(|path| path.to_string_lossy().to_string().replace('\\', "/"));
    Ok(json!({
        "status": "ok",
        "slug": stage.plan.slug,
        "dir": stage.plan.event_dir.to_string_lossy().to_string().replace("\\", "/"),
        "eventName": stage.plan.event_name,
        "eventDate": stage.plan.event_date,
        "targetExists": stage.plan.target_exists,
        "localOnly": stage.local_only,
        "backupPath": backup_path,
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
    if let Some(upload) = removed {
        if let Some(stage) = upload.import_stage {
            let _ = fs::remove_dir_all(stage.stage_root);
        }
        if let Some(stage) = upload.event_sync_stage {
            let _ = fs::remove_dir_all(stage.stage_root);
        }
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
        if let Some(stage) = &upload.event_sync_stage {
            let _ = fs::remove_dir_all(&stage.stage_root);
        }
        let _ = upload
            .sender
            .try_send(ReceivedUploadAck::Failure(error.to_string()));
    }
}

fn terminal_cancel_all_received_uploads_for_generation(
    error: &str,
    worker: Option<&Arc<AtomicBool>>,
) {
    let uploads = pending_received_uploads()
        .lock()
        .map(|mut pending| {
            let cancellable = pending
                .iter()
                .filter_map(|(id, upload)| {
                    let same_generation = match worker {
                        Some(worker) => upload
                            .receive_generation
                            .as_ref()
                            .is_none_or(|generation| Arc::ptr_eq(generation, worker)),
                        None => upload.receive_generation.is_none(),
                    };
                    (same_generation && !upload.recovery_required && !upload.published)
                        .then_some(id.clone())
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
        if let Some(stage) = &upload.event_sync_stage {
            let _ = fs::remove_dir_all(&stage.stage_root);
        }
        let _ = upload
            .sender
            .try_send(ReceivedUploadAck::Failure(error.to_string()));
    }
}

#[cfg(test)]
fn terminal_cancel_all_received_uploads(error: &str) {
    terminal_cancel_all_received_uploads_for_generation(error, None);
}

fn wait_for_received_upload_ack(
    upload_id: &str,
    receiver: &std::sync::mpsc::Receiver<ReceivedUploadAck>,
    running: &AtomicBool,
    listener_emitted: bool,
) -> Result<Option<String>, (String, bool)> {
    if !listener_emitted {
        let error = "frontend listenerへ通知できませんでした";
        terminal_cancel_received_upload(upload_id, error);
        return Err((error.to_string(), false));
    }
    loop {
        match receiver.try_recv() {
            Ok(ReceivedUploadAck::Success(download_url)) => return Ok(download_url),
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
            Ok(ReceivedUploadAck::Success(download_url)) => return Ok(download_url),
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

fn validate_event_sync_download_url(url: &str) -> Result<(), String> {
    if url.len() > 4096 || url.is_empty() || url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err("PC同期download URLの長さまたは文字が不正です".to_string());
    }
    let remainder = url
        .strip_prefix("http://")
        .ok_or_else(|| "PC同期download URLはHTTPである必要があります".to_string())?;
    let (authority, path_query) = remainder
        .split_once('/')
        .ok_or_else(|| "PC同期download URLのpathがありません".to_string())?;
    if authority.is_empty() || authority.contains('@') {
        return Err("PC同期download URLのhostが不正です".to_string());
    }
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "PC同期download URLのportがありません".to_string())?;
    let ip = host
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "PC同期download URLはIPv4 LANアドレスである必要があります".to_string())?;
    if !ip.is_private() || port.parse::<u16>().ok() != Some(FILE_SERVER_FIXED_PORT) {
        return Err("PC同期download URLは同一LANの固定portである必要があります".to_string());
    }
    let (path, query) = path_query
        .split_once('?')
        .ok_or_else(|| "PC同期download URLに認証queryがありません".to_string())?;
    if !path.starts_with('/')
        || path.len() <= 1
        || path[1..].contains('/')
        || path.contains("..")
        || path.chars().any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("PC同期download URLのpathが不正です".to_string());
    }
    let query = parse_query(Some(query));
    if query.get("mode").map(String::as_str) != Some("single-event-sync")
        || query
            .get("target_uid")
            .is_none_or(|uid| !valid_event_uid(uid))
        || query
            .get("token")
            .is_none_or(|token| {
                token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    {
        return Err("PC同期download URLのpairing queryが不正です".to_string());
    }

    let request_url = format!(
        "{path}?{query}",
        query = remainder
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default()
    );
    let active = file_server_runtime()
        .lock()
        .map_err(|error| format!("ファイルサーバーruntimeロック取得失敗: {error}"))?
        .as_ref()
        .and_then(|runtime| runtime.active.lock().ok().and_then(|slot| slot.clone()));
    let Some(active) = active else {
        return Err("PC同期download serverが起動していません".to_string());
    };
    authorize_protected_file_request(&active, &tiny_http::Method::Get, &request_url)
        .map_err(|status| format!("PC同期download URLがactive serverで認証できません ({status})"))
}

fn ack_received_upload_impl(
    upload_id: String,
    success: bool,
    error: Option<String>,
    download_url: Option<String>,
) -> Result<Value, String> {
    if let Some(url) = download_url.as_deref() {
        if !success {
            return Err("failure ackにdownload URLを指定できません".to_string());
        }
        validate_event_sync_download_url(url)?;
    }
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
        if success && (pending.import_stage.is_some() || pending.event_sync_stage.is_some()) {
            return Err("staged importがpublishされていません".to_string());
        }
        if download_url.is_some() && pending.target_event_uid.is_none() {
            return Err("download URLは単一イベント同期uploadでのみ指定できます".to_string());
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
            Ok(()) => ReceivedUploadAck::Success(download_url.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ReceivedUploadAck::Success(download_url.clone())
            }
            Err(e) => ReceivedUploadAck::Failure(format!("受信ZIP削除失敗: {e}")),
        }
    } else {
        ReceivedUploadAck::Failure(error.unwrap_or_else(|| "frontend import失敗".to_string()))
    };
    let failed_message = match &ack {
        ReceivedUploadAck::Failure(message) => Some(message.clone()),
        ReceivedUploadAck::Success(_) => None,
    };
    if failed_message.is_none()
        && download_url.is_some()
        && pending.target_event_uid.is_some()
    {
        published_received_uploads()
            .lock()
            .map_err(|e| format!("published uploadロック取得失敗: {e}"))?
            .insert(upload_id.clone());
    }
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
fn ack_received_upload(
    upload_id: String,
    success: bool,
    error: Option<String>,
) -> Result<Value, String> {
    ack_received_upload_impl(upload_id, success, error, None)
}

/// Complete the original mobile POST after the desktop side has prepared its
/// ZIP.  The response is delivered on the same HTTP connection, so mobile can
/// download without scanning another QR code.
#[tauri::command]
fn ack_received_upload_with_download(
    upload_id: String,
    download_url: String,
) -> Result<Value, String> {
    ack_received_upload_impl(upload_id, true, None, Some(download_url))
}

#[tauri::command]
fn cancel_received_upload(upload_id: String, error: Option<String>) -> Result<Value, String> {
    ack_received_upload_impl(upload_id, false, error, None)
}

fn local_import_upload_id() -> String {
    format!(
        "local_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

#[tauri::command]
fn register_local_zip_import(zip_path: String) -> Result<Value, String> {
    let source = PathBuf::from(&zip_path);
    let source_metadata = fs::symlink_metadata(&source)
        .map_err(|e| format!("local ZIP metadata取得失敗: {e}"))?;
    if metadata_is_link_or_reparse(&source_metadata) || !source_metadata.is_file() {
        return Err("local ZIPは通常のfileである必要があります".to_string());
    }
    if source_metadata.len() > MAX_RECEIVED_ZIP_BYTES {
        return Err("local ZIPが256 MiBの上限を超えています".to_string());
    }
    let upload_id = local_import_upload_id();
    let temp_dir = std::env::temp_dir();
    let raw_path = temp_dir.join(format!("eventtrail_received_{upload_id}_raw.zip"));
    let sanitized_path = temp_dir.join(format!("eventtrail_received_{upload_id}.zip"));
    let copy_result = (|| -> Result<(), String> {
        let mut input = fs::File::open(&source).map_err(|e| format!("local ZIP読込失敗: {e}"))?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&raw_path)
            .map_err(|e| format!("local ZIP private copy作成失敗: {e}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|e| format!("local ZIP private copy失敗: {e}"))?;
        output
            .sync_all()
            .map_err(|e| format!("local ZIP private copy fsync失敗: {e}"))?;
        drop(output);
        sanitize_local_import_zip(&raw_path, &sanitized_path)
    })();
    let _ = fs::remove_file(&raw_path);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&sanitized_path);
        return Err(error);
    }
    let size = fs::metadata(&sanitized_path)
        .map_err(|e| format!("sanitized local ZIP metadata取得失敗: {e}"))?
        .len();
    if let Err(error) = register_local_received_upload(&upload_id, sanitized_path.clone()) {
        let _ = fs::remove_file(&sanitized_path);
        return Err(error);
    }
    Ok(json!({
        "status": "ok",
        "uploadId": upload_id,
        "zipPath": sanitized_path.to_string_lossy().to_string().replace('\\', "/"),
        "size": size,
        "localOnly": true,
    }))
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

fn received_upload_payload(
    upload_id: &str,
    zip_path: &str,
    size: usize,
    target_event_uid: Option<&str>,
) -> Value {
    json!({
        "status": "ok",
        "uploadId": upload_id,
        "zipPath": zip_path,
        "size": size,
        "targetEventUid": target_event_uid
    })
}

fn stream_request_body_limited(
    request: &mut tiny_http::Request,
    path: &Path,
) -> Result<u64, (u16, String)> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| (500, format!("一時ZIP作成失敗: {error}")))?;
    let result = (|| -> Result<u64, (u16, String)> {
        let reader = request.as_reader();
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| (400, format!("request body読み込み失敗: {error}")))?;
            if count == 0 {
                break;
            }
            total = total.saturating_add(count as u64);
            if total > MAX_RECEIVED_ZIP_BYTES {
                return Err((413, "受信ZIPが256 MiBの上限を超えています".to_string()));
            }
            file.write_all(&buffer[..count])
                .map_err(|error| (500, format!("一時ZIP書込失敗: {error}")))?;
        }
        file.sync_all()
            .map_err(|error| (500, format!("一時ZIP fsync失敗: {error}")))?;
        Ok(total)
    })();
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

const MAX_SYNC_SESSION_NOTIFICATION_BYTES: u64 = 64 * 1024;

fn read_sync_session_notification(
    request: &mut tiny_http::Request,
) -> Result<Vec<u8>, (u16, String)> {
    let mut bytes = Vec::new();
    let mut reader = request.as_reader().take(MAX_SYNC_SESSION_NOTIFICATION_BYTES + 1);
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| (400, format!("同期session通知読み込み失敗: {error}")))?;
    if bytes.len() as u64 > MAX_SYNC_SESSION_NOTIFICATION_BYTES {
        return Err((413, "同期session通知が大きすぎます".to_string()));
    }
    Ok(bytes)
}

fn request_content_type_is_json(request: &tiny_http::Request) -> bool {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Content-Type"))
        .map(|header| {
            header
                .value
                .as_str()
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
        })
        .unwrap_or(false)
}

fn parse_sync_session_notification(
    bytes: &[u8],
    target_event_uid: &str,
) -> Result<ReceiveSyncSessionState, (u16, String)> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| (400, format!("同期session通知JSONが不正です: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| (400, "同期session通知JSONはobjectである必要があります".to_string()))?;
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target_uid = object
        .get("target_uid")
        .or_else(|| object.get("targetEventUid"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mode != "single-event-sync" || target_uid != target_event_uid {
        return Err((401, "同期session通知のmodeまたはtarget UIDが不正です".to_string()));
    }
    let state = object
        .get("state")
        .or_else(|| object.get("status"))
        .or_else(|| object.get("result"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match state.as_str() {
        "mobile-applied" | "mobile_complete" | "mobile-complete" | "applied" => {
            Ok(ReceiveSyncSessionState::MobileApplied)
        }
        "cancelled" | "canceled" => Ok(ReceiveSyncSessionState::Cancelled {
            message: object
                .get("error")
                .or_else(|| object.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("mobile側で同期がキャンセルされました")
                .to_string(),
        }),
        _ => Err((400, "同期session通知のstateが不正です".to_string())),
    }
}

#[tauri::command]
fn start_receive_server(
    window: tauri::Window,
    project_root: String,
    target_event_uid: Option<String>,
) -> Result<Value, String> {
    let project_root = absolute_project_root(&project_root)?;
    if target_event_uid
        .as_deref()
        .is_some_and(|uid| !valid_event_uid(uid))
    {
        return Err("targetEventUidの形式が不正です".to_string());
    }
    {
        let _recovery_guard = circle_master_write_lock()
            .lock()
            .map_err(|e| format!("import recoveryロック取得失敗: {e}"))?;
        recover_incomplete_import_transactions(&project_root)?;
    }
    let target_event_metadata = target_event_uid
        .as_deref()
        .map(|uid| receive_sync_target_metadata(&project_root, uid))
        .transpose()?;
    cleanup_stale_received_uploads(&std::env::temp_dir(), std::time::SystemTime::now());
    let mut guard = receive_server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    // A previous cancelled/failed/completed single-event session may keep the
    // listener alive until its terminal GET arrives. Retire only that terminal
    // generation here so a new sync can start immediately; active
    // Waiting/Pending/PcReady generations remain protected by the check below.
    let _retired_terminal_generation =
        retire_terminal_receive_generation_locked(&mut *guard)?;
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

    let ip = resolve_advertised_ipv4()?;
    let upload_url = format!("http://{}:{}/upload", ip, port);
    let bearer_token = target_event_uid
        .as_ref()
        .map(|_| random_bearer_token())
        .transpose()?;
    let qr_url = match (
        target_event_uid.as_deref(),
        target_event_metadata.as_ref(),
        bearer_token.as_deref(),
    ) {
        (Some(uid), Some((name, date)), Some(token)) => {
            single_event_sync_receive_url(
                &upload_url,
                uid,
                name.as_deref(),
                date.as_deref(),
                token,
            )
        }
        (None, None, None) => upload_url.clone(),
        _ => return Err("同期pairing metadataの生成に失敗しました".to_string()),
    };
    *receive_server_auth()
        .lock()
        .map_err(|e| format!("receive auth lock取得失敗: {e}"))? = target_event_uid
        .as_ref()
        .zip(bearer_token.clone())
        .map(|(target_event_uid, bearer_token)| ReceiveServerAuth {
            bearer_token,
            target_event_uid: target_event_uid.clone(),
            expires_at: Instant::now() + RECEIVE_BEARER_TOKEN_LIFETIME,
        });
    *receive_sync_session()
        .lock()
        .map_err(|e| format!("receive sync session lock取得失敗: {e}"))? = target_event_uid
        .as_ref()
        .map(|target_event_uid| ReceiveSyncSession {
            target_event_uid: target_event_uid.clone(),
            state: ReceiveSyncSessionState::Waiting,
        });

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    thread::spawn(move || {
        while running_clone.load(Ordering::Relaxed) {
            if !expire_receive_generation_if_needed(&window, &running_clone).unwrap_or(false) {
                break;
            }
            match server.recv_timeout(Duration::from_millis(500)) {
                Ok(Some(mut request)) => {
                    if !(cfg!(test) && peer_is_loopback(request.remote_addr()))
                        && !peer_is_on_advertised_subnet(request.remote_addr(), ip)
                    {
                        let resp = tiny_http::Response::from_string("LAN peer is not allowed")
                            .with_status_code(tiny_http::StatusCode(403));
                        let _ = request.respond(resp);
                        continue;
                    }
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
                                    &b"GET, POST, OPTIONS"[..],
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

                    // Single-event sync keeps the original QR URL alive as a
                    // short-lived GET session.  Mobile polls this endpoint
                    // after its upload POST and receives the desktop choice
                    // (including a protected download URL when PC won).
                    if *request.method() == tiny_http::Method::Get {
                        if request.url().split('?').next() != Some("/upload") {
                            let resp = tiny_http::Response::from_string("Not Found")
                                .with_status_code(tiny_http::StatusCode(404));
                            let _ = request.respond(resp);
                            continue;
                        }
                        let target_uid = match receive_request_target_uid_for_generation(
                            request.url(),
                            &running_clone,
                        ) {
                            Ok(Some(target_uid)) => target_uid,
                            Ok(None) => {
                                let resp = tiny_http::Response::from_string("Not Found")
                                    .with_status_code(tiny_http::StatusCode(404));
                                let _ = request.respond(resp);
                                continue;
                            }
                            Err((status, error)) => {
                                let resp = tiny_http::Response::from_string(
                                    json!({"status": "error", "error": error}).to_string(),
                                )
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
                                continue;
                            }
                        };
                        let (status, payload, terminal) =
                            match receive_sync_session_response_for_generation(
                                &running_clone,
                                &target_uid,
                            ) {
                            Ok(response) => response,
                            Err(error) => (
                                409,
                                json!({"status": "error", "error": error}),
                                false,
                            ),
                        };
                        let resp = tiny_http::Response::from_string(payload.to_string())
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
                        if terminal {
                            // Notify the renderer before the listener tears
                            // down the one-shot polling session.  This lets
                            // the desktop UI clean up its file server after
                            // mobile has consumed the terminal result.
                            let _ = emit_receive_sync_session_state_for_generation(
                                &window,
                                &running_clone,
                                &target_uid,
                                true,
                            );
                            running_clone.store(false, Ordering::Relaxed);
                            break;
                        }
                        continue;
                    }

                    // POST /upload のみ受け付け
                    if request.url().split('?').next() != Some("/upload")
                        || *request.method() != tiny_http::Method::Post
                    {
                        let resp = tiny_http::Response::from_string("Not Found")
                            .with_status_code(tiny_http::StatusCode(404));
                        let _ = request.respond(resp);
                        continue;
                    }

                    let upload_target_uid = match receive_request_target_uid_for_generation(
                        request.url(),
                        &running_clone,
                    ) {
                        Ok(target_uid) => target_uid,
                        Err((status, error)) => {
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": error}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(status))
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Access-Control-Allow-Origin"[..],
                                    &b"*"[..],
                                )
                                .unwrap(),
                            );
                            let _ = request.respond(resp);
                            continue;
                        }
                    };

                    // After downloading and applying a PC-selected ZIP,
                    // mobile posts a small state notification on the same
                    // authenticated URL.  It completes the session without
                    // opening another QR or exposing a second endpoint.
                    if upload_target_uid.is_some() && request_content_type_is_json(&request) {
                        let bytes = match read_sync_session_notification(&mut request) {
                            Ok(bytes) => bytes,
                            Err((status, error)) => {
                                let resp = tiny_http::Response::from_string(
                                    json!({"status": "error", "error": error}).to_string(),
                                )
                                .with_status_code(tiny_http::StatusCode(status))
                                .with_header(
                                    tiny_http::Header::from_bytes(
                                        &b"Access-Control-Allow-Origin"[..],
                                        &b"*"[..],
                                    )
                                    .unwrap(),
                                );
                                let _ = request.respond(resp);
                                continue;
                            }
                        };
                        // The authenticated URL was checked before reading the
                        // body. Revalidate after that I/O so a retired worker
                        // cannot apply its old notification to a replacement
                        // session with the same event UID.
                        let target_uid = match receive_request_target_uid_for_generation(
                            request.url(),
                            &running_clone,
                        ) {
                            Ok(Some(target_uid)) => target_uid,
                            Ok(None) => {
                                let resp = tiny_http::Response::from_string(
                                    json!({"status": "error", "error": "pairing token is not active"}).to_string(),
                                )
                                .with_status_code(tiny_http::StatusCode(409));
                                let _ = request.respond(resp);
                                continue;
                            }
                            Err((status, error)) => {
                                let resp = tiny_http::Response::from_string(
                                    json!({"status": "error", "error": error}).to_string(),
                                )
                                .with_status_code(tiny_http::StatusCode(status));
                                let _ = request.respond(resp);
                                continue;
                            }
                        };
                        let state = match parse_sync_session_notification(&bytes, &target_uid) {
                            Ok(state) => state,
                            Err((status, error)) => {
                                let resp = tiny_http::Response::from_string(
                                    json!({"status": "error", "error": error}).to_string(),
                                )
                                .with_status_code(tiny_http::StatusCode(status))
                                .with_header(
                                    tiny_http::Header::from_bytes(
                                        &b"Access-Control-Allow-Origin"[..],
                                        &b"*"[..],
                                    )
                                    .unwrap(),
                                );
                                let _ = request.respond(resp);
                                continue;
                            }
                        };
                        if let Err(error) = apply_receive_sync_notification_for_generation(
                            &running_clone,
                            &target_uid,
                            state,
                        ) {
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": error}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(409));
                            let _ = request.respond(resp);
                            continue;
                        }
                        let (_, response_payload, _) =
                            receive_sync_session_response_for_generation(
                                &running_clone,
                                &target_uid,
                            )
                            .unwrap_or((409, json!({"status": "error"}), false));
                        let resp = tiny_http::Response::from_string(response_payload.to_string())
                            .with_status_code(tiny_http::StatusCode(200))
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
                        // Keep the listener alive until mobile polls the same
                        // URL once more.  The GET response emits the terminal
                        // renderer event with `delivered: true` and performs
                        // the one-shot cleanup.
                        continue;
                    }

                    // Upload bytes are streamed to disk with a hard cap.
                    let upload_id = format!(
                        "{}_{}",
                        std::process::id(),
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
                    );
                    if let Some(target_uid) = upload_target_uid.as_deref() {
                        if let Err(error) = begin_receive_sync_upload_for_generation(
                            &running_clone,
                            target_uid,
                            &upload_id,
                        ) {
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": error}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(409));
                            let _ = request.respond(resp);
                            continue;
                        }
                    }
                    let tmp_path =
                        std::env::temp_dir().join(format!("eventtrail_received_{upload_id}.zip"));
                    let size = match stream_request_body_limited(&mut request, &tmp_path) {
                        Ok(size) => size,
                        Err((status, error)) => {
                            if let Some(target_uid) = upload_target_uid.as_deref() {
                                let _ = receive_sync_upload_ack_state_for_generation(
                                    &running_clone,
                                    target_uid,
                                    &upload_id,
                                    ReceiveSyncSessionState::Error {
                                        message: error.clone(),
                                    },
                                );
                            }
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": error}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(status));
                            let _ = request.respond(resp);
                            continue;
                        }
                    };
                    if let Some(uid) = upload_target_uid.as_deref() {
                        let still_valid = receive_request_target_uid_for_generation(
                            request.url(),
                            &running_clone,
                        )
                            .ok()
                            .flatten()
                            .as_deref()
                            == Some(uid);
                        if !still_valid {
                            let _ = fs::remove_file(&tmp_path);
                            let _ = receive_sync_upload_ack_state_for_generation(
                                &running_clone,
                                uid,
                                &upload_id,
                                ReceiveSyncSessionState::Cancelled {
                                    message: "pairing token expired during upload".to_string(),
                                },
                            );
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": "pairing token expired during upload"}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(410));
                            let _ = request.respond(resp);
                            continue;
                        }
                    }

                    let zip_path = tmp_path.to_string_lossy().to_string().replace("\\", "/");
                    let receiver_result = register_received_upload_for_generation(
                        &running_clone,
                        &upload_id,
                        tmp_path.clone(),
                        upload_target_uid.clone(),
                    );
                    let ack_receiver = match receiver_result {
                        Ok(receiver) => receiver,
                        Err(e) => {
                            let _ = fs::remove_file(&tmp_path);
                            if let Some(target_uid) = upload_target_uid.as_deref() {
                                let _ = receive_sync_upload_ack_state_for_generation(
                                    &running_clone,
                                    target_uid,
                                    &upload_id,
                                    ReceiveSyncSessionState::Error {
                                        message: e.clone(),
                                    },
                                );
                            }
                            let resp = tiny_http::Response::from_string(
                                json!({"status": "error", "error": e}).to_string(),
                            )
                            .with_status_code(tiny_http::StatusCode(500));
                            let _ = request.respond(resp);
                            continue;
                        }
                    };
                    let _ = emit_receive_event_for_generation(
                        &window,
                        &running_clone,
                        "result-uploaded",
                        json!({
                            "uploadId": upload_id.clone(),
                            "zipPath": zip_path.clone(),
                            "size": size,
                            "targetEventUid": upload_target_uid
                        }),
                    );

                    // receive threadはtemp ZIPの保存と通知だけを担当する。
                    // event.jsonへのimportはfrontendのdocument排他区間で実行する。
                    let payload = received_upload_payload(
                        &upload_id,
                        &zip_path,
                        size as usize,
                        upload_target_uid.as_deref(),
                    );
                    let emitted = emit_receive_event_for_generation(
                        &window,
                        &running_clone,
                        "result-received",
                        payload.clone(),
                    );
                    if let Some(target_uid) = upload_target_uid.clone() {
                        let waiter_upload_id = upload_id.clone();
                        let waiter_target_uid = target_uid.clone();
                        let waiter_running = running_clone.clone();
                        let waiter_window = window.clone();
                        let _ = emit_receive_sync_session_state_for_generation(
                            &window,
                            &running_clone,
                            &target_uid,
                            false,
                        );
                        thread::spawn(move || {
                            let ack = wait_for_received_upload_ack(
                                &waiter_upload_id,
                                &ack_receiver,
                                &waiter_running,
                                emitted,
                            );
                            let state = match ack {
                                Ok(Some(download_url)) => {
                                    ReceiveSyncSessionState::PcReady { download_url }
                                }
                                Ok(None) => ReceiveSyncSessionState::MobileApplied,
                                Err((error, _)) if receive_sync_error_is_cancelled(&error) => {
                                    ReceiveSyncSessionState::Cancelled { message: error }
                                }
                                Err((error, _)) => ReceiveSyncSessionState::Error { message: error },
                            };
                            let emit_state = !matches!(&state, ReceiveSyncSessionState::MobileApplied);
                            let transitioned = receive_sync_upload_ack_state_for_generation(
                                &waiter_running,
                                &waiter_target_uid,
                                &waiter_upload_id,
                                state,
                            )
                            .unwrap_or(false);
                            if emit_state && transitioned {
                                let _ = emit_receive_sync_session_state_for_generation(
                                    &waiter_window,
                                    &waiter_running,
                                    &waiter_target_uid,
                                    false,
                                );
                            }
                            remove_pending_received_upload(&waiter_upload_id);
                        });
                        let response_payload = json!({
                            "status": "pending",
                            "state": "pending",
                            "targetEventUid": target_uid.clone(),
                            "target_uid": target_uid,
                            "uploadId": upload_id,
                        });
                        let resp = tiny_http::Response::from_string(response_payload.to_string())
                            .with_status_code(tiny_http::StatusCode(202))
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
                        continue;
                    }

                    let ack = wait_for_received_upload_ack(
                        &upload_id,
                        &ack_receiver,
                        &running_clone,
                        emitted,
                    );
                    remove_pending_received_upload(&upload_id);
                    let (status, response_payload) = match ack {
                        Ok(download_url) => (
                            200,
                            json!({
                                "status": "ok",
                                "uploadId": upload_id,
                                "downloadUrl": download_url,
                            }),
                        ),
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
                    clear_receive_state_if_current(&running_clone);
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
        clear_receive_state_if_current(&running_clone);
    });

    *guard = Some(running);

    Ok(json!({
        "status": "ok",
        "ip": ip.to_string(),
        "port": port,
        "url": qr_url,
        "uploadUrl": upload_url,
        "targetEventUid": target_event_uid,
        "sessionId": bearer_token
            .as_deref()
            .map(|token| sha256_hex(token.as_bytes())),
        "expiresInSeconds": if bearer_token.is_some() { RECEIVE_BEARER_TOKEN_LIFETIME.as_secs() } else { 0 }
    }))
}

#[tauri::command]
fn stop_receive_server() -> Result<Value, String> {
    // Serialize stop's session transition and upload cancellation with a
    // subsequent start. Otherwise start could retire the newly-cancelled
    // generation between these two operations and the late cancellation
    // would remove uploads belonging to the replacement generation.
    let mut guard = receive_server_running()
        .lock()
        .map_err(|e| format!("ロック取得失敗: {e}"))?;
    // A single-event sync session may still be waiting for mobile to poll the
    // terminal result (or to post its final apply acknowledgement).  Do not
    // erase the token/session here; the normal GET/TTL path performs cleanup.
    let sync_state = receive_sync_session()
        .lock()
        .map_err(|e| format!("receive sync session lock取得失敗: {e}"))?
        .clone();
    if let Some(session) = sync_state {
        let pending_publish_in_progress = match &session.state {
            ReceiveSyncSessionState::Pending { upload_id } => pending_received_uploads()
                .lock()
                .ok()
                .and_then(|pending| pending.get(upload_id).map(|upload| upload.published))
                .unwrap_or(false),
            _ => false,
        };
        if matches!(session.state, ReceiveSyncSessionState::Waiting)
            || (matches!(session.state, ReceiveSyncSessionState::Pending { .. })
                && !pending_publish_in_progress)
        {
            let _ = cancel_receive_sync_session(
                &session.target_event_uid,
                "デスクトップ側で同期サーバーが停止されました".to_string(),
            );
            terminal_cancel_all_received_uploads_for_generation(
                "受信サーバーが停止されました",
                guard.as_ref(),
            );
        }
        return Ok(json!({"status": "ok", "deferred": true}));
    }
    let current_worker = guard.take();
    if let Some(flag) = current_worker.as_ref() {
        // Keep the running registry locked while clearing the matching
        // auth/session.  A new start cannot install a generation between
        // stop and cleanup, and an old worker's final cleanup is Arc-guarded.
        flag.store(false, Ordering::Relaxed);
        *receive_server_auth()
            .lock()
            .map_err(|e| format!("receive auth lock取得失敗: {e}"))? = None;
        *receive_sync_session()
            .lock()
            .map_err(|e| format!("receive sync session lock取得失敗: {e}"))? = None;
    }
    terminal_cancel_all_received_uploads_for_generation(
        "受信サーバーが停止されました",
        current_worker.as_ref(),
    );
    Ok(json!({"status": "ok"}))
}

#[cfg(test)]
mod received_event_sync_tests {
    use super::*;

    fn unique_test_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "eventtrail-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn unique_upload_id() -> String {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{}_{}", std::process::id(), suffix)
    }

    fn sync_session_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn stale_receive_worker_cannot_clear_new_session_state() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let old_worker = Arc::new(AtomicBool::new(false));
        let new_worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(new_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "new-token".to_string(),
            target_event_uid: "event_generation".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_generation".to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });

        clear_receive_state_if_current(&old_worker);
        assert!(receive_server_auth().lock().unwrap().is_some());
        assert!(receive_sync_session().lock().unwrap().is_some());

        clear_receive_state_if_current(&new_worker);
        assert!(receive_server_auth().lock().unwrap().is_none());
        assert!(receive_sync_session().lock().unwrap().is_none());
        *receive_server_running().lock().unwrap() = None;
    }

    #[test]
    fn receive_worker_cleanup_holds_generation_lock_until_state_clear() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let old_worker = Arc::new(AtomicBool::new(false));
        let new_worker = Arc::new(AtomicBool::new(true));
        let mut running = receive_server_running().lock().unwrap();
        *running = Some(new_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "new-token".to_string(),
            target_event_uid: "event_generation_lock".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_generation_lock".to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let old_for_thread = old_worker.clone();
        let cleanup_thread = thread::spawn(move || {
            clear_receive_state_if_current(&old_for_thread);
            done_sender.send(()).unwrap();
        });
        assert!(done_receiver.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(receive_server_auth().lock().unwrap().is_some());
        assert!(receive_sync_session().lock().unwrap().is_some());
        drop(running);
        done_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        cleanup_thread.join().unwrap();
        assert!(receive_server_auth().lock().unwrap().is_some());
        assert!(receive_sync_session().lock().unwrap().is_some());
        clear_receive_state_if_current(&new_worker);
        assert!(receive_server_auth().lock().unwrap().is_none());
        assert!(receive_sync_session().lock().unwrap().is_none());
        *receive_server_running().lock().unwrap() = None;
    }

    #[test]
    fn terminal_receive_generation_can_be_retired_before_new_start() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        *receive_server_running().lock().unwrap() = None;
        *receive_server_auth().lock().unwrap() = None;
        *receive_sync_session().lock().unwrap() = None;

        let old_worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(old_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "old-token".to_string(),
            target_event_uid: "event_retry".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_retry".to_string(),
            state: ReceiveSyncSessionState::Cancelled {
                message: "user cancelled".to_string(),
            },
        });

        {
            let mut running = receive_server_running().lock().unwrap();
            assert!(retire_terminal_receive_generation_locked(&mut *running).unwrap());
            assert!(running.is_none());
        }
        assert!(!old_worker.load(Ordering::Relaxed));
        assert!(receive_server_auth().lock().unwrap().is_none());
        assert!(receive_sync_session().lock().unwrap().is_none());

        // Install the replacement generation before the old worker gets its
        // final cleanup turn. Its Arc guard must keep the new state intact.
        let new_worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(new_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "new-token".to_string(),
            target_event_uid: "event_retry".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_retry".to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        clear_receive_state_if_current(&old_worker);
        assert_eq!(
            receive_server_auth()
                .lock()
                .unwrap()
                .as_ref()
                .map(|auth| auth.bearer_token.as_str()),
            Some("new-token")
        );
        assert!(receive_sync_session().lock().unwrap().is_some());

        // Active generations are deliberately not retired by the helper.
        {
            let mut running = receive_server_running().lock().unwrap();
            assert!(!retire_terminal_receive_generation_locked(&mut *running).unwrap());
            assert!(running
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &new_worker)));
        }
        clear_receive_state_if_current(&new_worker);
        *receive_server_running().lock().unwrap() = None;
    }

    #[test]
    fn stale_generation_cannot_update_replacement_same_uid_session() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let target_uid = "event_same_uid";
        let old_worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(old_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "old-token".to_string(),
            target_event_uid: target_uid.to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        let old_url = format!(
            "/upload?mode=single-event-sync&target_uid={target_uid}&token=old-token"
        );
        assert_eq!(
            receive_request_target_uid_for_generation(&old_url, &old_worker)
                .unwrap()
                .as_deref(),
            Some(target_uid)
        );

        // The old request has now entered its body-read/network wait. A new
        // same-UID generation replaces it before the old request resumes.
        old_worker.store(false, Ordering::Relaxed);
        let new_worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(new_worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "new-token".to_string(),
            target_event_uid: target_uid.to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });

        assert!(apply_receive_sync_notification_for_generation(
            &old_worker,
            target_uid,
            ReceiveSyncSessionState::MobileApplied,
        )
        .is_err());
        assert!(receive_sync_session_response_for_generation(&old_worker, target_uid).is_err());
        assert!(receive_request_target_uid_for_generation(&old_url, &old_worker).is_err());
        assert!(matches!(
            receive_sync_session()
                .lock()
                .unwrap()
                .as_ref()
                .map(|session| &session.state),
            Some(ReceiveSyncSessionState::Waiting)
        ));

        clear_receive_state_if_current(&new_worker);
        *receive_server_running().lock().unwrap() = None;
    }

    #[test]
    fn expired_sync_session_payload_is_terminal_and_user_actionable() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let target_uid = "event_expired";
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        assert!(cancel_receive_sync_session(
            target_uid,
            RECEIVE_SYNC_EXPIRED_MESSAGE.to_string(),
        )
        .unwrap());
        let payload = receive_sync_session_expired_payload(target_uid).unwrap();
        assert_eq!(payload["state"], "cancelled");
        assert_eq!(payload["targetEventUid"], target_uid);
        assert_eq!(payload["expired"], true);
        assert_eq!(payload["message"], RECEIVE_SYNC_EXPIRED_MESSAGE);
        *receive_sync_session().lock().unwrap() = None;

        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        begin_receive_sync_upload(target_uid, "expired-pc-ready").unwrap();
        assert!(receive_sync_upload_ack_state(
            target_uid,
            "expired-pc-ready",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_expired&token=token".to_string(),
            },
        )
        .unwrap());
        assert!(expire_receive_sync_session(
            target_uid,
            RECEIVE_SYNC_EXPIRED_MESSAGE.to_string(),
        )
        .unwrap());
        let pc_ready_expired = receive_sync_session_expired_payload(target_uid).unwrap();
        assert_eq!(pc_ready_expired["state"], "cancelled");
        assert_eq!(pc_ready_expired["expired"], true);
        *receive_sync_session().lock().unwrap() = None;
    }

    fn write_sync_event(event_dir: &Path, uid: &str, name: &str, circle_name: &str) {
        fs::create_dir_all(event_dir).unwrap();
        fs::create_dir_all(event_dir.join("event_image")).unwrap();
        fs::create_dir_all(event_dir.join("circles")).unwrap();
        fs::create_dir_all(event_dir.join("maps")).unwrap();
        fs::write(event_dir.join("event_image/event.png"), b"desktop image").unwrap();
        fs::write(event_dir.join("circles/cut.png"), b"desktop cut").unwrap();
        fs::write(event_dir.join("maps/deleted.jpg"), b"desktop map").unwrap();
        fs::write(
            event_dir.join("event.json"),
            serde_json::to_vec_pretty(&json!({
                "event_uid": uid,
                "event": {"name": name, "date": "2026-06-01", "event_image_filename": "event_image/event.png"},
                "circles": [{"name": circle_name, "checked": 0, "circle_cut_filename": "circles/cut.png"}],
                "metadata": {"source": "desktop"}
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn write_sync_zip(path: &Path, uid: &str, image_bytes: &[u8], unsafe_member: Option<&str>) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::FileOptions::default();
        let event = json!({
            "event_uid": uid,
            "event": {"name": "Mobile Event", "date": "2026-06-01", "event_image_filename": "event_image/event.png"},
            "circles": [{"name": "Mobile Circle", "checked": 1, "circle_cut_filename": "circles/cut.png"}],
            "metadata": {"source": "mobile"}
        });
        zip.start_file("event.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
        zip.start_file("event_image/event.png", options).unwrap();
        zip.write_all(image_bytes).unwrap();
        zip.start_file("circles/cut.png", options).unwrap();
        zip.write_all(b"mobile cut").unwrap();
        zip.start_file("maps/added.jpg", options).unwrap();
        zip.write_all(b"mobile map").unwrap();
        if let Some(name) = unsafe_member {
            zip.start_file(name, options).unwrap();
            zip.write_all(b"unsafe").unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_local_import_zip(path: &Path, uid: &str, include_shared: bool, unsafe_member: Option<&str>) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::FileOptions::default();
        let event = json!({
            "event_uid": uid,
            "event": {
                "name": "Mobile Event",
                "date": "2026-06-01",
                "event_image_filename": "event_image/event.png"
            },
            "circles": [],
            "metadata": {"source": "local_fixture"}
        });
        zip.start_file("event.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
        let manifest = json!({
            "format": "eventtrail_asset_manifest",
            "format_version": 1,
            "aliases": {
                "event_image/event.png": "assets/sha256/aa/event.png",
                "default_cuts/shared.png": "default_cuts/shared.png"
            }
        });
        zip.start_file("asset_manifest.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        zip.start_file("assets/sha256/aa/event.png", options).unwrap();
        zip.write_all(b"local event image").unwrap();
        if include_shared {
            zip.start_file("circle_master.json", options).unwrap();
            zip.write_all(br#"{"circles":{"shared":{"favorite":true}}}"#)
                .unwrap();
            zip.start_file("default_cuts/shared.png", options).unwrap();
            zip.write_all(b"shared cut").unwrap();
        }
        if let Some(name) = unsafe_member {
            zip.start_file(name, options).unwrap();
            zip.write_all(b"unsafe").unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn local_zip_import_sanitizes_shared_settings_and_preserves_other_events() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let root = unique_test_root("local-zip-import");
        let target_dir = root.join("events/a_target");
        let other_dir = root.join("events/z_other");
        write_sync_event(&target_dir, "event_local", "Mobile Event", "Target");
        write_sync_event(&other_dir, "event_other", "Mobile Event", "Other");
        fs::write(root.join("circle_master.json"), br#"{"circles":{"keep":{"favorite":true}}}"#)
            .unwrap();
        fs::create_dir_all(root.join("default_cuts")).unwrap();
        fs::write(root.join("default_cuts/live.png"), b"live cut").unwrap();
        let zip_path = root.join("local.zip");
        write_local_import_zip(&zip_path, "event_local", true, None);

        let registered = register_local_zip_import(zip_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(registered["status"], "ok");
        assert_eq!(registered["localOnly"], true);
        let upload_id = registered["uploadId"].as_str().unwrap().to_string();
        claim_received_upload(upload_id.clone()).unwrap();
        let plan = plan_received_result_import(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(plan["localOnly"], true);
        assert_eq!(plan["eventName"], "Mobile Event");
        assert_eq!(plan["eventDate"], "2026-06-01");
        assert_eq!(plan["targetExists"], true);
        assert!(plan["affectedEvents"].as_array().unwrap().len() == 1);
        let slug = plan["slug"].as_str().unwrap().to_string();
        let staged = stage_received_result_import(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
            slug,
        )
        .unwrap();
        assert_eq!(staged["localOnly"], true);
        let published = publish_received_result_import(upload_id.clone()).unwrap();
        assert_eq!(published["localOnly"], true);
        assert!(published["backupPath"].as_str().unwrap().len() > 0);
        assert!(Path::new(published["backupPath"].as_str().unwrap()).is_dir());

        let master_after = fs::read(root.join("circle_master.json")).unwrap();
        assert_eq!(master_after, br#"{"circles":{"keep":{"favorite":true}}}"#);
        assert_eq!(fs::read(root.join("default_cuts/live.png")).unwrap(), b"live cut");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(other_dir.join("event.json")).unwrap())
                .unwrap()["event_uid"],
            "event_other"
        );
        assert_eq!(fs::read(target_dir.join("event_image/event.png")).unwrap(), b"local event image");
        remove_pending_received_upload(&upload_id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_zip_import_rejects_unsafe_member_before_registration() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let root = unique_test_root("local-zip-unsafe");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("unsafe.zip");
        write_local_import_zip(&zip_path, "event_local", true, Some("../escape.txt"));
        assert!(register_local_zip_import(zip_path.to_string_lossy().to_string()).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_zip_import_accepts_legacy_event_without_uid() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let root = unique_test_root("local-zip-legacy");
        fs::create_dir_all(root.join("events")).unwrap();
        let zip_path = root.join("legacy.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let options = zip::write::FileOptions::default();
        zip.start_file("event.json", options).unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!({
                "event": {"name": "Legacy Event", "date": "2026-06-02"},
                "circles": [],
                "metadata": {"source": "legacy"}
            }))
            .unwrap(),
        )
        .unwrap();
        zip.finish().unwrap();
        let registered = register_local_zip_import(zip_path.to_string_lossy().to_string()).unwrap();
        let upload_id = registered["uploadId"].as_str().unwrap().to_string();
        claim_received_upload(upload_id.clone()).unwrap();
        let plan = plan_received_result_import(upload_id.clone(), root.to_string_lossy().to_string())
            .unwrap();
        assert_eq!(plan["eventName"], "Legacy Event");
        assert_eq!(plan["targetExists"], false);
        remove_pending_received_upload(&upload_id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mobile_cancel_removes_pending_sync_upload_before_publish() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        *receive_server_running().lock().unwrap() = None;
        *receive_server_auth().lock().unwrap() = None;
        *receive_sync_session().lock().unwrap() = None;
        let root = unique_test_root("sync-cancel-linearization");
        fs::create_dir_all(&root).unwrap();
        let upload_id = unique_upload_id();
        let zip_path = root.join("pending.zip");
        write_sync_zip(&zip_path, "event_cancel", b"cancel image", None);
        let receiver = register_received_sync_upload(&upload_id, zip_path, "event_cancel".to_string()).unwrap();
        claim_received_upload(upload_id.clone()).unwrap();
        let worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "cancel-token".to_string(),
            target_event_uid: "event_cancel".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_cancel".to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        begin_receive_sync_upload("event_cancel", &upload_id).unwrap();
        apply_receive_sync_notification_for_generation(
            &worker,
            "event_cancel",
            ReceiveSyncSessionState::Cancelled {
                message: "mobile cancelled".to_string(),
            },
        )
        .unwrap();
        assert!(!pending_received_uploads().lock().unwrap().contains_key(&upload_id));
        let cancel_ack = receiver.try_recv();
        assert!(
            matches!(cancel_ack, Ok(ReceivedUploadAck::Failure(_))),
            "cancel ack={cancel_ack:?}"
        );
        assert!(publish_received_event_sync(upload_id.clone()).is_err());
        *receive_sync_session().lock().unwrap() = None;
        *receive_server_auth().lock().unwrap() = None;
        *receive_server_running().lock().unwrap() = None;
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expired_generation_request_keeps_auth_for_worker_terminal_cleanup() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let worker = Arc::new(AtomicBool::new(true));
        *receive_server_running().lock().unwrap() = Some(worker.clone());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: "expired-token".to_string(),
            target_event_uid: "event_expired_generation".to_string(),
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: "event_expired_generation".to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        let url = "/upload?mode=single-event-sync&target_uid=event_expired_generation&token=expired-token";
        assert_eq!(
            receive_request_target_uid_for_generation(url, &worker)
                .unwrap_err()
                .0,
            410
        );
        assert!(receive_server_auth().lock().unwrap().is_some());
        *receive_sync_session().lock().unwrap() = None;
        *receive_server_auth().lock().unwrap() = None;
        *receive_server_running().lock().unwrap() = None;
    }

    fn register_sync(
        root: &Path,
        upload_id: &str,
        uid: &str,
    ) -> std::sync::mpsc::Receiver<ReceivedUploadAck> {
        let zip_path = root.join(format!("{upload_id}.zip"));
        write_sync_zip(&zip_path, uid, b"mobile image", None);
        let receiver = register_received_sync_upload(upload_id, zip_path, uid.to_string()).unwrap();
        claim_received_upload(upload_id.to_string()).unwrap();
        receiver
    }

    #[test]
    fn same_session_poll_response_exposes_pending_and_pc_download_states() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let target_uid = "event_poll";
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        let (status, waiting, terminal) = receive_sync_session_response(target_uid).unwrap();
        assert_eq!(status, 202);
        assert!(!terminal);
        assert_eq!(waiting["state"], "pending");
        assert_eq!(waiting["target_uid"], target_uid);

        begin_receive_sync_upload(target_uid, "upload-poll").unwrap();
        assert!(receive_sync_upload_ack_state(
            target_uid,
            "upload-poll",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_poll&token=token".to_string(),
            },
        )
        .unwrap());
        let (status, ready, terminal) = receive_sync_session_response(target_uid).unwrap();
        assert_eq!(status, 200);
        assert!(!terminal, "PC-ready後はmobileの同一session完了通知を待ちます");
        assert_eq!(ready["state"], "pc-ready");
        assert_eq!(ready["source"], "pc");
        assert_eq!(ready["downloadUrl"], ready["download_url"]);
        assert_eq!(ready["targetEventUid"], target_uid);
        let ready_event = receive_sync_session_event_payload(target_uid, false).unwrap();
        assert_eq!(ready_event["delivered"], false);

        apply_receive_sync_notification(target_uid, ReceiveSyncSessionState::MobileApplied)
            .unwrap();
        let terminal_event = receive_sync_session_event_payload(target_uid, true).unwrap();
        assert_eq!(terminal_event["state"], "mobile-applied");
        assert_eq!(terminal_event["delivered"], true);

        *receive_sync_session().lock().unwrap() = None;
    }

    #[test]
    fn sync_download_ack_url_rejects_non_lan_or_unprotected_values() {
        assert!(validate_event_sync_download_url(
            "https://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_poll&token=abc"
        )
        .is_err());
        assert!(validate_event_sync_download_url(
            "http://8.8.8.8:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_poll&token=abc"
        )
        .is_err());
        assert!(validate_event_sync_download_url(
            "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_poll"
        )
        .is_err());
    }

    #[test]
    fn sync_session_cas_rejects_duplicate_uploads_and_stale_waiters() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let target_uid = "event_cas";
        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        begin_receive_sync_upload(target_uid, "upload-current").unwrap();
        assert!(begin_receive_sync_upload(target_uid, "upload-duplicate").is_err());
        assert!(!receive_sync_upload_ack_state(
            target_uid,
            "upload-stale",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_cas&token=token".to_string(),
            },
        )
        .unwrap());
        assert!(receive_sync_upload_ack_state(
            target_uid,
            "upload-current",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_cas&token=token".to_string(),
            },
        )
        .unwrap());
        assert!(!receive_sync_upload_ack_state(
            target_uid,
            "upload-current",
            ReceiveSyncSessionState::Error {
                message: "late waiter".to_string(),
            },
        )
        .unwrap());
        apply_receive_sync_notification(target_uid, ReceiveSyncSessionState::MobileApplied)
            .unwrap();
        assert!(!receive_sync_upload_ack_state(
            target_uid,
            "upload-current",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_cas&token=token".to_string(),
            },
        )
        .unwrap());
        *receive_sync_session().lock().unwrap() = None;
    }

    #[test]
    fn mobile_completion_notification_is_same_target_and_terminal() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        let target_uid = "event_notify";
        let notification = br#"{"mode":"single-event-sync","target_uid":"event_notify","state":"mobile-applied","result":"mobile-applied"}"#;
        assert!(matches!(
            parse_sync_session_notification(notification, target_uid),
            Ok(ReceiveSyncSessionState::MobileApplied)
        ));
        assert!(parse_sync_session_notification(notification, "other").is_err());
        let cancelled = br#"{"mode":"single-event-sync","target_uid":"event_notify","state":"cancelled","message":"user cancelled"}"#;
        assert!(matches!(
            parse_sync_session_notification(cancelled, target_uid),
            Ok(ReceiveSyncSessionState::Cancelled { .. })
        ));

        *receive_sync_session().lock().unwrap() = Some(ReceiveSyncSession {
            target_event_uid: target_uid.to_string(),
            state: ReceiveSyncSessionState::Waiting,
        });
        assert!(apply_receive_sync_notification(
            target_uid,
            ReceiveSyncSessionState::MobileApplied,
        )
        .is_err());
        begin_receive_sync_upload(target_uid, "upload-notify").unwrap();
        assert!(receive_sync_upload_ack_state(
            target_uid,
            "upload-notify",
            ReceiveSyncSessionState::PcReady {
                download_url: "http://192.168.1.2:18721/mobile_export.zip?mode=single-event-sync&target_uid=event_notify&token=token".to_string(),
            },
        )
        .unwrap());
        apply_receive_sync_notification(target_uid, ReceiveSyncSessionState::MobileApplied)
            .unwrap();
        assert!(matches!(
            receive_sync_session_response(target_uid),
            Ok((200, _, true))
        ));
        *receive_sync_session().lock().unwrap() = None;
    }

    #[test]
    fn sha256_matches_standard_digest_and_bearer_token_is_one_time_scoped() {
        let _test_guard = sync_session_test_lock().lock().unwrap();
        assert_eq!(RECEIVE_BEARER_TOKEN_LIFETIME.as_secs(), 1_200);
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let token = random_bearer_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let root = unique_test_root("single-event-sync-pair-url");
        let event_dir = root.join("events/selected");
        write_sync_event(&event_dir, "event_1", "夏コミ 2026", "Desktop Circle");
        let (target_name, target_date) = receive_sync_target_metadata(&root, "event_1").unwrap();
        assert_eq!(target_name.as_deref(), Some("夏コミ 2026"));
        assert_eq!(target_date.as_deref(), Some("2026-06-01"));
        assert!(receive_sync_target_metadata(&root, "event_2").is_err());
        let url = single_event_sync_receive_url(
            "http://192.168.1.2:18722/upload",
            "event_1",
            target_name.as_deref(),
            target_date.as_deref(),
            &token,
        );
        assert!(url.contains("target_name=%E5%A4%8F%E3%82%B3%E3%83%9F%202026"));
        assert!(url.contains("target_date=2026-06-01"));
        let parsed_query = parse_query(url.split_once('?').map(|(_, query)| query));
        assert_eq!(parsed_query.get("target_name").map(String::as_str), Some("夏コミ 2026"));
        assert_eq!(parsed_query.get("target_date").map(String::as_str), Some("2026-06-01"));
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: token.clone(),
            target_event_uid: "event_1".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        assert_eq!(
            receive_request_target_uid(&url).unwrap().as_deref(),
            Some("event_1")
        );
        assert!(receive_request_target_uid(
            &url.replace("target_uid=event_1", "target_uid=event_2")
        )
        .is_err());
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: token.clone(),
            target_event_uid: "event_1".to_string(),
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        assert!(receive_request_target_uid(&url).is_err());
        assert!(receive_server_auth().lock().unwrap().is_none());
        // Stop invalidation uses the same registry; a stale QR is rejected after clearing it.
        *receive_server_auth().lock().unwrap() = None;
        assert!(receive_request_target_uid(&url).is_err());

        let no_date_dir = root.join("events/no_date");
        fs::create_dir_all(&no_date_dir).unwrap();
        fs::write(
            no_date_dir.join("event.json"),
            serde_json::to_vec(&json!({
                "event_uid": "event_2",
                "event": {"name": "日付なしイベント"},
                "circles": [],
                "metadata": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let (no_date_name, no_date) = receive_sync_target_metadata(&root, "event_2").unwrap();
        assert_eq!(no_date_name.as_deref(), Some("日付なしイベント"));
        assert!(no_date.is_none(), "日付なしイベントがpairingを拒否されました");
        let no_date_url = single_event_sync_receive_url(
            "http://192.168.1.2:18722/upload",
            "event_2",
            no_date_name.as_deref(),
            no_date.as_deref(),
            &token,
        );
        assert!(!no_date_url.contains("target_date="));
        *receive_server_auth().lock().unwrap() = Some(ReceiveServerAuth {
            bearer_token: token.clone(),
            target_event_uid: "event_2".to_string(),
            expires_at: Instant::now() + Duration::from_secs(30),
        });
        assert_eq!(
            receive_request_target_uid(&no_date_url).unwrap().as_deref(),
            Some("event_2")
        );
        assert!(receive_request_target_uid(
            &no_date_url.replace("target_uid=event_2", "target_uid=event_1")
        )
        .is_err());
        *receive_server_auth().lock().unwrap() = None;
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn protected_file_download_checks_token_path_uid_and_expiry() {
        let root = unique_test_root("single-event-sync-file-auth");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("mobile export.zip");
        write_sync_zip(&zip_path, "event_selected", b"image", None);
        let token = random_bearer_token().unwrap();
        let mut served = ServedFile::new_event_sync(
            zip_path.clone(),
            file_server_generation(),
            "event_selected".to_string(),
            token.clone(),
            None,
        )
        .unwrap();
        let get = tiny_http::Method::Get;
        let url = format!(
            "/{}?mode=single-event-sync&target_uid=event_selected&token={token}",
            query_encode("mobile_export.zip")
        );
        assert_eq!(
            authorize_protected_file_request(&served, &get, &url),
            Ok(())
        );
        assert_eq!(
            authorize_protected_file_request(&served, &get, &url.replace(&token, "bad")),
            Err(401)
        );
        assert_eq!(
            authorize_protected_file_request(&served, &get, &url.replace("&token=", "&")),
            Err(401)
        );
        assert_eq!(
            authorize_protected_file_request(
                &served,
                &get,
                &url.replace("event_selected", "event_other")
            ),
            Err(401)
        );
        assert_eq!(
            authorize_protected_file_request(
                &served,
                &get,
                &url.replace("mobile_export.zip", "other.zip")
            ),
            Err(404)
        );
        served.auth.as_mut().unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            authorize_protected_file_request(&served, &get, &url),
            Err(410)
        );
        drop(served);
        assert!(
            !zip_path.exists(),
            "同期QR cleanup時にsource ZIPが残りました"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preview_and_stage_are_read_only_and_publish_replaces_only_the_uid_target_with_backup() {
        let root = unique_test_root("single-event-sync-publish");
        let target = root.join("events/selected");
        let other = root.join("events/other");
        write_sync_event(&target, "event_selected", "Desktop Event", "Desktop Circle");
        write_sync_event(&other, "event_other", "Other Event", "Other Circle");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("circle_master.json"),
            b"leave this file unchanged",
        )
        .unwrap();
        let other_before = path_content_fingerprint(&other).unwrap();
        let master_before = fs::read(root.join("circle_master.json")).unwrap();
        let target_before = path_content_fingerprint(&target).unwrap();
        let upload_id = unique_upload_id();
        let _receiver = register_sync(&root, &upload_id, "event_selected");
        let preview = preview_received_event_sync(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
        )
        .unwrap();
        assert_eq!(preview["targetSlug"], "selected");
        assert_eq!(preview["targetEventUid"], "event_selected");
        assert_eq!(
            preview["desktopData"]["circles"][0]["name"],
            "Desktop Circle"
        );
        assert_eq!(preview["mobileData"]["circles"][0]["name"], "Mobile Circle");
        assert_eq!(preview["assetDiff"]["added"].as_array().unwrap().len(), 1);
        assert_eq!(preview["assetDiff"]["changed"].as_array().unwrap().len(), 2);
        assert_eq!(preview["assetDiff"]["deleted"].as_array().unwrap().len(), 1);
        assert_eq!(path_content_fingerprint(&target).unwrap(), target_before);

        stage_received_event_sync(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
            preview["fingerprint"].as_str().unwrap().to_string(),
        )
        .unwrap();
        assert_eq!(path_content_fingerprint(&target).unwrap(), target_before);
        assert_eq!(path_content_fingerprint(&other).unwrap(), other_before);
        assert_eq!(
            fs::read(root.join("circle_master.json")).unwrap(),
            master_before
        );

        let result = publish_received_event_sync(upload_id.clone()).unwrap();
        assert_eq!(result["targetSlug"], "selected");
        let backup = PathBuf::from(result["backupPath"].as_str().unwrap());
        assert!(backup.join("event.json").is_file());
        assert_eq!(
            path_content_fingerprint(&backup).unwrap(),
            target_before,
            "永続backupはpublish前の対象eventそのものを保持します"
        );
        assert_eq!(path_content_fingerprint(&other).unwrap(), other_before);
        assert_eq!(
            fs::read(root.join("circle_master.json")).unwrap(),
            master_before
        );
        let published: Value =
            serde_json::from_slice(&fs::read(target.join("event.json")).unwrap()).unwrap();
        assert_eq!(published["event_uid"], "event_selected");
        assert_eq!(published["circles"][0]["name"], "Mobile Circle");
        assert_eq!(
            fs::read(target.join("event_image/event.png")).unwrap(),
            b"mobile image"
        );
        assert!(target.join("maps/added.jpg").is_file());
        assert!(!target.join("maps/deleted.jpg").exists());
        remove_pending_received_upload(&upload_id);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_stage_rejects_stale_live_event_or_zip_and_cancel_removes_stage() {
        let root = unique_test_root("single-event-sync-cas");
        let target = root.join("events/selected");
        write_sync_event(&target, "event_selected", "Desktop Event", "Desktop Circle");

        let upload_id = unique_upload_id();
        let _receiver = register_sync(&root, &upload_id, "event_selected");
        let preview = preview_received_event_sync(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
        )
        .unwrap();
        stage_received_event_sync(
            upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
            preview["fingerprint"].as_str().unwrap().to_string(),
        )
        .unwrap();
        fs::write(target.join("concurrent-edit.txt"), b"newer desktop edit").unwrap();
        assert!(publish_received_event_sync(upload_id.clone()).is_err());
        assert_eq!(
            fs::read(target.join("concurrent-edit.txt")).unwrap(),
            b"newer desktop edit"
        );
        let stage_path = root
            .join(".eventtrail-import-stage")
            .join(format!("event-sync-stage-{upload_id}"));
        terminal_cancel_received_upload(&upload_id, "cancel after stale conflict");
        assert!(!stage_path.exists());

        let zip_upload_id = unique_upload_id();
        let _zip_receiver = register_sync(&root, &zip_upload_id, "event_selected");
        let zip_preview = preview_received_event_sync(
            zip_upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
        )
        .unwrap();
        stage_received_event_sync(
            zip_upload_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
            zip_preview["fingerprint"].as_str().unwrap().to_string(),
        )
        .unwrap();
        let zip_path = current_received_upload_zip(&zip_upload_id).unwrap();
        write_sync_zip(&zip_path, "event_selected", b"changed zip", None);
        assert!(publish_received_event_sync(zip_upload_id.clone()).is_err());
        assert_eq!(
            fs::read(target.join("concurrent-edit.txt")).unwrap(),
            b"newer desktop edit"
        );
        terminal_cancel_received_upload(&zip_upload_id, "cancel after zip conflict");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_uid_mismatch_duplicate_uid_and_unsafe_zip_fail_closed() {
        let root = unique_test_root("single-event-sync-validation");
        let target = root.join("events/selected");
        write_sync_event(&target, "event_selected", "Desktop Event", "Desktop Circle");
        let other = root.join("events/duplicate");
        write_sync_event(
            &other,
            "event_selected",
            "Duplicate Event",
            "Duplicate Circle",
        );
        let zip_path = root.join("mismatch.zip");
        fs::create_dir_all(&root).unwrap();
        write_sync_zip(&zip_path, "event_other", b"image", None);
        let nested_uid_zip = root.join("nested-uid.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&nested_uid_zip).unwrap());
            let options = zip::write::FileOptions::default();
            let event = json!({
                "event": {"event_uid": "event_selected", "name": "Nested UID"},
                "circles": []
            });
            zip.start_file("event.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
            zip.finish().unwrap();
        }
        assert!(read_validated_sync_zip(&nested_uid_zip, "event_selected").is_err());
        let mismatch_id = format!("{}_sync_mismatch", std::process::id());
        let _receiver =
            register_received_sync_upload(&mismatch_id, zip_path, "event_selected".to_string())
                .unwrap();
        claim_received_upload(mismatch_id.clone()).unwrap();
        assert!(preview_received_event_sync(
            mismatch_id.clone(),
            root.to_string_lossy().to_string(),
            "event_selected".to_string(),
        )
        .is_err());
        terminal_cancel_received_upload(&mismatch_id, "uid mismatch");
        assert!(find_unique_event_dir_by_uid(&root, "event_selected").is_err());

        let safe_root = unique_test_root("single-event-sync-unsafe");
        let safe_target = safe_root.join("events/selected");
        write_sync_event(
            &safe_target,
            "event_selected",
            "Desktop Event",
            "Desktop Circle",
        );
        let unsafe_zip = safe_root.join("unsafe.zip");
        fs::create_dir_all(&safe_root).unwrap();
        write_sync_zip(
            &unsafe_zip,
            "event_selected",
            b"image",
            Some("../circle_master.json"),
        );
        assert!(read_validated_sync_zip(&unsafe_zip, "event_selected").is_err());
        assert!(!safe_root.join("circle_master.json").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(safe_root);
    }

    #[test]
    fn sync_zip_accepts_safe_manifest_asset_aliases_and_rejects_unrelated_roots() {
        let root = unique_test_root("single-event-sync-manifest");
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("manifest.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
            let options = zip::write::FileOptions::default();
            let event = json!({
                "event_uid": "event_selected",
                "event": {"name": "Mobile Event", "date": "2026-06-01"},
                "circles": [],
                "metadata": {}
            });
            let manifest = json!({
                "format": "eventtrail_asset_manifest",
                "format_version": 1,
                "assets": {
                    "sample": {
                        "algorithm": "sha256",
                        "hash": "placeholder",
                        "path": "assets/sha256/aa/image.png",
                        "size": 11,
                        "original_names": ["event_image/event.png"]
                    }
                },
                "aliases": {"event_image/event.png": "assets/sha256/aa/image.png"}
            });
            zip.start_file("event.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
            zip.start_file("asset_manifest.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&manifest).unwrap())
                .unwrap();
            zip.add_directory("assets/", options).unwrap();
            zip.add_directory("assets/sha256/", options).unwrap();
            zip.add_directory("assets/sha256/aa/", options).unwrap();
            zip.start_file("assets/sha256/aa/image.png", options)
                .unwrap();
            zip.write_all(b"manifest png").unwrap();
            zip.finish().unwrap();
        }
        let validated = read_validated_sync_zip(&zip_path, "event_selected").unwrap();
        assert_eq!(validated.assets.len(), 1);
        assert_eq!(validated.assets[0].key, "event_image/event.png");
        assert_eq!(validated.assets[0].digest, sha256_hex(b"manifest png"));

        let unrelated_path = root.join("unrelated.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&unrelated_path).unwrap());
            let options = zip::write::FileOptions::default();
            let event = json!({"event_uid": "event_selected", "event": {}, "circles": []});
            zip.start_file("event.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&event).unwrap()).unwrap();
            zip.start_file("notes.txt", options).unwrap();
            zip.write_all(b"outside approved event asset roots")
                .unwrap();
            zip.finish().unwrap();
        }
        assert!(read_validated_sync_zip(&unrelated_path, "event_selected").is_err());
        let _ = fs::remove_dir_all(root);
    }
}

// ── ファイル配信HTTPサーバー ──

const FILE_SERVER_FIXED_PORT: u16 = 18721;

struct ServedFileAuth {
    bearer_token: String,
    target_event_uid: String,
    advertised_ip: Option<std::net::Ipv4Addr>,
    expires_at: Instant,
}

struct ServedFile {
    source_path: PathBuf,
    serve_path: PathBuf,
    display_name: String,
    cleanup_source_on_deactivate: bool,
    source_cleanup_done: std::sync::atomic::AtomicBool,
    auth: Option<ServedFileAuth>,
}

impl ServedFile {
    fn new(
        source_path: PathBuf,
        generation: u64,
        cleanup_source_on_deactivate: bool,
    ) -> Result<Self, String> {
        Self::new_with_display_name(
            source_path,
            generation,
            cleanup_source_on_deactivate,
            None,
        )
    }

    fn new_with_display_name(
        source_path: PathBuf,
        generation: u64,
        cleanup_source_on_deactivate: bool,
        display_name_override: Option<&str>,
    ) -> Result<Self, String> {
        let display_name = display_name_override
            .map(str::to_string)
            .unwrap_or_else(|| {
                source_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });
        let internal_name = format!(
            ".eventtrail_mobile_server_{}_{}_{}",
            std::process::id(),
            generation,
            display_name
        );
        let serve_path = source_path.with_file_name(internal_name);

        let _ = fs::remove_file(&serve_path);
        if let Err(link_error) = fs::hard_link(&source_path, &serve_path) {
            if let Err(copy_error) = fs::copy(&source_path, &serve_path) {
                return Err(format!(
                    "配信用ZIP staging失敗 {}: hard_link={link_error}; copy={copy_error}",
                    source_path.display()
                ));
            }
        }

        Ok(Self {
            source_path,
            serve_path,
            display_name,
            cleanup_source_on_deactivate,
            source_cleanup_done: std::sync::atomic::AtomicBool::new(false),
            auth: None,
        })
    }

    fn new_event_sync(
        source_path: PathBuf,
        generation: u64,
        target_event_uid: String,
        bearer_token: String,
        advertised_ip: Option<std::net::Ipv4Addr>,
    ) -> Result<Self, String> {
        // Keep the mobile-facing route stable while allowing the actual
        // source ZIP to live at a unique temporary path per session.
        let mut served = Self::new_with_display_name(
            source_path,
            generation,
            true,
            Some("mobile_export.zip"),
        )?;
        served.auth = Some(ServedFileAuth {
            bearer_token,
            target_event_uid,
            advertised_ip,
            expires_at: Instant::now() + RECEIVE_BEARER_TOKEN_LIFETIME,
        });
        Ok(served)
    }

    fn auth_expired(&self) -> bool {
        self.auth
            .as_ref()
            .is_some_and(|auth| Instant::now() >= auth.expires_at)
    }

    fn cleanup_source(&self) {
        if self.cleanup_source_on_deactivate
            && !self.source_cleanup_done.swap(true, Ordering::AcqRel)
        {
            let _ = fs::remove_file(&self.source_path);
        }
    }

    fn deactivate(&self) {
        self.cleanup_source();
    }

    fn deactivate_for_replacement(&self, replacement_source: &Path) {
        if self.cleanup_source_on_deactivate && self.source_path == replacement_source {
            // The replacement generation owns this source path now.  Mark the
            // old generation as cleaned without deleting the new source file.
            self.source_cleanup_done.store(true, Ordering::Release);
        } else {
            self.cleanup_source();
        }
    }
}

impl Drop for ServedFile {
    fn drop(&mut self) {
        self.cleanup_source();
        let _ = fs::remove_file(&self.serve_path);
    }
}

// The fixed-port listener is intentionally process-lifetime.  stop_file_server
// deactivates the current generation (and returns 404 for new requests) but
// does not drop the listener; dropping tiny_http on every QR hand-off can leave
// Windows TIME_WAIT/accept state and make the next fixed-port bind fail.
struct FileServerRuntime {
    active: Arc<Mutex<Option<Arc<ServedFile>>>>,
    _server: Arc<tiny_http::Server>,
}

fn file_server_runtime() -> &'static Mutex<Option<FileServerRuntime>> {
    static RUNTIME: OnceLock<Mutex<Option<FileServerRuntime>>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(None))
}

fn file_server_lifecycle() -> &'static Mutex<()> {
    static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

fn file_server_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    GENERATION.fetch_add(1, Ordering::Relaxed) + 1
}

fn bind_file_server_once() -> Result<Arc<tiny_http::Server>, String> {
    let started_at = Instant::now();
    match tiny_http::Server::http(format!("0.0.0.0:{FILE_SERVER_FIXED_PORT}")) {
        Ok(server) => Ok(Arc::new(server)),
        Err(error) => {
            let os_error = error
                .downcast_ref::<std::io::Error>()
                .and_then(|io_error| io_error.raw_os_error());
            Err(format!(
                "HTTPサーバー起動失敗: 固定ポート{FILE_SERVER_FIXED_PORT}のbindに失敗しました: reason={error}; attempts=1; elapsed_ms={}; os_error={os_error:?}",
                started_at.elapsed().as_millis()
            ))
        }
    }
}

fn authorize_protected_file_request(
    served: &ServedFile,
    method: &tiny_http::Method,
    url: &str,
) -> Result<(), u16> {
    if *method != tiny_http::Method::Get {
        return Err(404);
    }
    let expected_path = format!("/{}", query_encode(&served.display_name));
    let (path, query) = url
        .split_once('?')
        .map(|(path, query)| (path, Some(query)))
        .unwrap_or((url, None));
    if path != expected_path {
        return Err(404);
    }
    let Some(auth) = served.auth.as_ref() else {
        return Err(401);
    };
    if Instant::now() >= auth.expires_at {
        return Err(410);
    }
    let query = parse_query(query);
    let mode = query.get("mode").map(String::as_str).unwrap_or("");
    let target_uid = query.get("target_uid").map(String::as_str).unwrap_or("");
    let token = query.get("token").map(String::as_str).unwrap_or("");
    if mode != "single-event-sync"
        || target_uid != auth.target_event_uid
        || !constant_time_token_eq(token, &auth.bearer_token)
    {
        return Err(401);
    }
    Ok(())
}

fn deactivate_expired_sync_file(active: &Arc<Mutex<Option<Arc<ServedFile>>>>) {
    let expired = active.lock().ok().and_then(|mut slot| {
        if slot.as_ref().is_some_and(|served| served.auth_expired()) {
            slot.take()
        } else {
            None
        }
    });
    if let Some(served) = expired {
        served.deactivate();
    }
}

fn respond_file_request(request: tiny_http::Request, served: &ServedFile) {
    if served.auth.is_some() {
        if let Err(status) =
            authorize_protected_file_request(served, request.method(), request.url())
        {
            let message = match status {
                410 => "Pairing expired",
                404 => "Not found",
                _ => "Unauthorized",
            };
            let response = tiny_http::Response::from_string(message)
                .with_status_code(tiny_http::StatusCode(status));
            let _ = request.respond(response);
            return;
        }
        if !cfg!(test)
            && served
            .auth
            .as_ref()
            .and_then(|auth| auth.advertised_ip)
            .is_some_and(|advertised| {
                !peer_is_on_advertised_subnet(request.remote_addr(), advertised)
            })
        {
            let response = tiny_http::Response::from_string("Unauthorized")
                .with_status_code(tiny_http::StatusCode(401));
            let _ = request.respond(response);
            return;
        }
    }
    let file = match fs::File::open(&served.serve_path) {
        Ok(file) => file,
        Err(_) => {
            let response = tiny_http::Response::from_string("File not found")
                .with_status_code(tiny_http::StatusCode(404));
            let _ = request.respond(response);
            return;
        }
    };
    let len = file
        .metadata()
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(0);
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        Vec::new(),
        file,
        Some(len),
        None,
    )
    .with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/zip"[..]).unwrap(),
    )
    .with_header(
        tiny_http::Header::from_bytes(
            &b"Content-Disposition"[..],
            format!("attachment; filename=\"{}\"", served.display_name).as_bytes(),
        )
        .unwrap(),
    )
    .with_header(
        tiny_http::Header::from_bytes(&b"Content-Length"[..], len.to_string().as_bytes()).unwrap(),
    );
    let _ = request.respond(response);
}

fn start_file_server_worker(
    server: Arc<tiny_http::Server>,
    active: Arc<Mutex<Option<Arc<ServedFile>>>>,
) {
    thread::spawn(move || loop {
        match server.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(request)) => {
                deactivate_expired_sync_file(&active);
                let served = active.lock().ok().and_then(|guard| guard.clone());
                if let Some(served) = served {
                    respond_file_request(request, &served);
                } else {
                    let response = tiny_http::Response::from_string("File server is stopped")
                        .with_status_code(tiny_http::StatusCode(404));
                    let _ = request.respond(response);
                }
            }
            Ok(None) => deactivate_expired_sync_file(&active),
            Err(_) => break,
        }
    });
}

fn ensure_file_server_runtime() -> Result<Arc<Mutex<Option<Arc<ServedFile>>>>, String> {
    let mut guard = file_server_runtime()
        .lock()
        .map_err(|error| format!("ファイルサーバーruntimeロック取得失敗: {error}"))?;
    if let Some(runtime) = guard.as_ref() {
        return Ok(runtime.active.clone());
    }

    let server = bind_file_server_once()?;
    let active = Arc::new(Mutex::new(None));
    start_file_server_worker(server.clone(), active.clone());
    *guard = Some(FileServerRuntime {
        active: active.clone(),
        _server: server,
    });
    Ok(active)
}

#[tauri::command]
fn start_file_server(file_path: String, cleanup_on_stop: Option<bool>) -> Result<Value, String> {
    let _lifecycle_guard = file_server_lifecycle()
        .lock()
        .map_err(|error| format!("ファイルサーバーlifecycleロック取得失敗: {error}"))?;
    let active = ensure_file_server_runtime()?;
    let ip = resolve_advertised_ipv4()?;

    // Stage the replacement before touching the active slot.  If staging
    // fails, the previous generation remains downloadable and its source is
    // not accidentally removed.
    let source_path = PathBuf::from(&file_path);
    let served = Arc::new(ServedFile::new(
        source_path.clone(),
        file_server_generation(),
        cleanup_on_stop.unwrap_or(false),
    )?);
    let file_name = served.display_name.clone();
    let mut slot = active
        .lock()
        .map_err(|error| format!("ファイルサーバーactiveロック取得失敗: {error}"))?;
    let old = slot.replace(served);
    drop(slot);
    if let Some(old) = old {
        old.deactivate_for_replacement(&source_path);
    }

    Ok(json!({
        "status": "ok",
        "ip": ip.to_string(),
        "port": FILE_SERVER_FIXED_PORT,
        "url": format!("http://{}:{}/{}", ip, FILE_SERVER_FIXED_PORT, file_name)
    }))
}

#[tauri::command]
fn start_event_sync_file_server(
    file_path: String,
    target_event_uid: String,
) -> Result<Value, String> {
    if !valid_event_uid(&target_event_uid) {
        return Err("targetEventUidの形式が不正です".to_string());
    }
    let source_path = PathBuf::from(&file_path);
    let source_metadata = fs::symlink_metadata(&source_path)
        .map_err(|e| format!("event sync ZIP metadata取得失敗: {e}"))?;
    if !source_metadata.is_file() || metadata_is_link_or_reparse(&source_metadata) {
        return Err("event sync ZIPは通常fileである必要があります".to_string());
    }
    let before = path_content_fingerprint(&source_path)?
        .ok_or_else(|| "event sync ZIPが存在しません".to_string())?;
    read_validated_sync_zip(&source_path, &target_event_uid)?;
    if path_content_fingerprint(&source_path)? != Some(before) {
        return Err("検証中にevent sync ZIPが変更されました".to_string());
    }

    let _lifecycle_guard = file_server_lifecycle()
        .lock()
        .map_err(|error| format!("ファイルサーバーlifecycleロック取得失敗: {error}"))?;
    let active = ensure_file_server_runtime()?;
    let ip = resolve_advertised_ipv4()?;
    let bearer_token = random_bearer_token()?;
    let served = Arc::new(ServedFile::new_event_sync(
        source_path.clone(),
        file_server_generation(),
        target_event_uid.clone(),
        bearer_token.clone(),
        Some(ip),
    )?);
    if path_content_fingerprint(&served.serve_path)? != Some(before) {
        return Err("配信用event sync ZIP staging後に内容が変わりました".to_string());
    }
    let route_path = format!("/{}", query_encode(&served.display_name));
    let url = format!(
        "http://{}:{}{}?mode=single-event-sync&target_uid={}&token={}",
        ip,
        FILE_SERVER_FIXED_PORT,
        route_path,
        query_encode(&target_event_uid),
        bearer_token
    );
    let file_name = served.display_name.clone();
    let mut slot = active
        .lock()
        .map_err(|error| format!("ファイルサーバーactiveロック取得失敗: {error}"))?;
    let old = slot.replace(served);
    drop(slot);
    if let Some(old) = old {
        old.deactivate_for_replacement(&source_path);
    }

    Ok(json!({
        "status": "ok",
        "ip": ip.to_string(),
        "port": FILE_SERVER_FIXED_PORT,
        "url": url,
        "fileName": file_name,
        "targetEventUid": target_event_uid,
        "expiresInSeconds": RECEIVE_BEARER_TOKEN_LIFETIME.as_secs()
    }))
}

#[tauri::command]
fn stop_file_server() -> Result<Value, String> {
    let _lifecycle_guard = file_server_lifecycle()
        .lock()
        .map_err(|error| format!("ファイルサーバーlifecycleロック取得失敗: {error}"))?;
    let active = file_server_runtime()
        .lock()
        .map_err(|error| format!("ファイルサーバーruntimeロック取得失敗: {error}"))?
        .as_ref()
        .map(|runtime| runtime.active.clone());
    if let Some(active) = active {
        let old = active
            .lock()
            .map_err(|error| format!("ファイルサーバーactiveロック取得失敗: {error}"))?
            .take();
        if let Some(old) = old {
            old.deactivate();
        }
    }
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn get_local_ip() -> Result<Value, String> {
    let ip = resolve_advertised_ipv4()?;
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
    for segment in split_env_lines(&text) {
        let (line, _) = split_env_line_ending(segment);
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

fn split_env_lines(existing: &str) -> Vec<&str> {
    let bytes = existing.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                index += 1;
                segments.push(&existing[start..index]);
                start = index;
            }
            b'\r' => {
                index += 1;
                if index < bytes.len() && bytes[index] == b'\n' {
                    index += 1;
                }
                segments.push(&existing[start..index]);
                start = index;
            }
            _ => index += 1,
        }
    }

    if start < existing.len() {
        segments.push(&existing[start..]);
    }
    segments
}

fn split_env_line_ending(segment: &str) -> (&str, &str) {
    if let Some(line) = segment.strip_suffix("\r\n") {
        (line, "\r\n")
    } else if let Some(line) = segment.strip_suffix('\n') {
        (line, "\n")
    } else if let Some(line) = segment.strip_suffix('\r') {
        (line, "\r")
    } else {
        (segment, "")
    }
}

/// .env ファイルにAPIキーを保存する（既存の未知キーは保持）
///
/// 管理対象キーの値が空白だけの場合は行を出力しない。既存の行を更新するときは
/// 値が変わっていない限り行全体をそのまま残すため、既存の値のバイト列・コメント・
/// 改行形式を保つ。管理対象キーの重複行は最初の1行だけを採用し、空にされたキーは
/// すべての既存行を削除する。
fn update_env_contents(existing: &str, keys: &EnvKeys) -> String {
    const KNOWN: [&str; 3] = ["OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"];

    let values = [
        keys.openai_api_key.as_str(),
        keys.gemini_api_key.as_str(),
        keys.xai_api_key.as_str(),
    ];
    let configured = values.map(|value| !value.trim().is_empty());

    // 既存ファイルの改行形式を、新規行を追加するときにも使う。ファイルが空、または
    // 改行を含まない場合は、従来の出力と同じLFを既定値にする。
    let line_ending = if existing.contains("\r\n") {
        "\r\n"
    } else if existing.contains('\n') {
        "\n"
    } else if existing.contains('\r') {
        "\r"
    } else {
        "\n"
    };

    let mut output = String::with_capacity(existing.len() + 128);
    let mut seen = [false; 3];

    // 行末のバイト列を含めたまま走査する。これにより未知キー、コメント、空行、
    // CRLF/LF/CRなどを再構成せず、そのまま保存できる。
    for segment in split_env_lines(existing) {
        let (line, ending) = split_env_line_ending(segment);
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            output.push_str(segment);
            continue;
        }

        let managed_index = line
            .split_once('=')
            .and_then(|(key, _)| KNOWN.iter().position(|known| *known == key.trim()));

        let Some(index) = managed_index else {
            output.push_str(segment);
            continue;
        };

        // 空白だけの値は既存の行も含めて削除する。空の値を新しい代入として書き出す
        // ことはなく、以後の保存でも同じ結果になる。
        if !configured[index] {
            continue;
        }

        // 重複した管理対象キーは1行に正規化する。
        if seen[index] {
            continue;
        }
        seen[index] = true;

        let existing_value = line
            .split_once('=')
            .map(|(_, value)| value)
            .unwrap_or_default();
        if existing_value == values[index] {
            // 値が同じなら、キー周辺の空白やインラインコメントなども含めて元の
            // バイト列を保持する（load→saveの無変更サイクルを完全に冪等化）。
            output.push_str(segment);
        } else {
            output.push_str(KNOWN[index]);
            output.push('=');
            output.push_str(values[index]);
            output.push_str(ending);
        }
    }

    // 既存に無かった非空キーだけを末尾へ追加する。既存の末尾に改行がなければ、
    // 追加前に1つだけ改行を挿入して、既存行のバイト列を変えない。
    for (index, key) in KNOWN.iter().enumerate() {
        if !configured[index] || seen[index] {
            continue;
        }
        if !output.is_empty() && !output.ends_with('\n') && !output.ends_with('\r') {
            output.push_str(line_ending);
        }
        output.push_str(key);
        output.push('=');
        output.push_str(values[index]);
        output.push_str(line_ending);
        seen[index] = true;
    }

    output
}

#[tauri::command]
fn save_env_keys(project_root: String, keys: EnvKeys) -> Result<Value, String> {
    let path = PathBuf::from(&project_root).join(".env");
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!(".env読み込み失敗: {e}"))?
    } else {
        String::new()
    };
    let output = update_env_contents(&existing, &keys);

    // 内容が同一なら書き換えない。値が未変更の保存操作でmtimeまで変えず、外部
    // watcherを不要に起こさない。
    if output != existing {
        fs::write(&path, output).map_err(|e| format!(".env書き込み失敗: {e}"))?;
        invalidate_model_catalog_cache(&project_root);
    }
    Ok(json!({"status": "ok"}))
}

#[cfg(test)]
mod env_key_tests {
    use super::{load_env_keys, read_dotenv, save_env_keys, update_env_contents, EnvKeys};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "event-autopin-env-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn keys(openai: &str, gemini: &str, xai: &str) -> EnvKeys {
        EnvKeys {
            openai_api_key: openai.to_string(),
            gemini_api_key: gemini.to_string(),
            xai_api_key: xai.to_string(),
        }
    }

    #[test]
    fn absent_file_with_empty_values_stays_empty() {
        assert_eq!(update_env_contents("", &keys("", "", "")), "");
    }

    #[test]
    fn clearing_existing_nonempty_assignment_removes_it() {
        let existing = "# keep this comment\nOPENAI_API_KEY=old-value\nOTHER=value\n";
        let updated = update_env_contents(existing, &keys("", "", ""));
        assert_eq!(updated, "# keep this comment\nOTHER=value\n");
    }

    #[test]
    fn whitespace_only_values_are_not_serialized() {
        let existing = "OPENAI_API_KEY=old\nGEMINI_API_KEY=\t\nXAI_API_KEY=   \n";
        let updated = update_env_contents(existing, &keys(" \t ", "\t", "\n"));
        assert_eq!(updated, "");
        assert!(!updated.contains("OPENAI_API_KEY="));
        assert!(!updated.contains("GEMINI_API_KEY="));
        assert!(!updated.contains("XAI_API_KEY="));
    }

    #[test]
    fn nonempty_values_are_written_once_and_keep_input_bytes() {
        let existing = "OPENAI_API_KEY=old\nOPENAI_API_KEY=duplicate\n# marker\n";
        let updated = update_env_contents(existing, &keys("  new-value  ", "", ""));
        assert_eq!(updated.matches("OPENAI_API_KEY=").count(), 1);
        assert!(updated.contains("OPENAI_API_KEY=  new-value  \n"));
        assert!(updated.contains("# marker\n"));
    }

    #[test]
    fn comments_unknown_lines_and_original_nonempty_bytes_are_preserved() {
        let existing = "# heading\r\nOTHER = keep-me\r\nOPENAI_API_KEY =  old-value  \r\n";
        let updated = update_env_contents(existing, &keys("  old-value  ", "", ""));
        assert_eq!(updated, existing);
    }

    #[test]
    fn nonempty_payload_rewrites_when_original_value_bytes_differ() {
        let existing = "OPENAI_API_KEY= old-value \n";
        let updated = update_env_contents(existing, &keys("old-value", "", ""));
        assert_eq!(updated, "OPENAI_API_KEY=old-value\n");
    }

    #[test]
    fn lone_cr_update_preserves_unknown_and_comment_bytes() {
        let existing = "# heading\rUNKNOWN=keep\rOPENAI_API_KEY=old\r";
        let updated = update_env_contents(existing, &keys("new", "", ""));
        assert_eq!(updated, "# heading\rUNKNOWN=keep\rOPENAI_API_KEY=new\r");
    }

    #[test]
    fn lone_cr_clear_removes_only_managed_assignment() {
        let existing = "# heading\rOPENAI_API_KEY=old\rUNKNOWN=keep\r";
        let updated = update_env_contents(existing, &keys("", "", ""));
        assert_eq!(updated, "# heading\rUNKNOWN=keep\r");
    }

    #[test]
    fn lone_cr_repeated_save_cycles_are_idempotent() {
        let existing = "# heading\rUNKNOWN=keep\r";
        let configured = keys("new", "new-gemini", "");
        let first = update_env_contents(existing, &configured);
        let second = update_env_contents(&first, &configured);
        assert_eq!(second, first);
    }

    #[test]
    fn lone_cr_load_and_save_round_trip_uses_each_line_without_corruption() {
        let root = temp_root("round-trip");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(".env");
        fs::write(
            &path,
            "# heading\rOPENAI_API_KEY=old\rUNKNOWN=keep\rGEMINI_API_KEY=\r",
        )
        .unwrap();

        let root_text = root.to_string_lossy().to_string();
        let loaded = load_env_keys(root_text.clone()).unwrap();
        assert_eq!(loaded.openai_api_key, "old");
        assert_eq!(loaded.gemini_api_key, "");
        assert_eq!(
            read_dotenv(&root_text).get("UNKNOWN").map(String::as_str),
            Some("keep")
        );

        save_env_keys(root_text.clone(), keys("new", "", "")).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# heading\rOPENAI_API_KEY=new\rUNKNOWN=keep\r"
        );
        let repeated = fs::read_to_string(&path).unwrap();
        save_env_keys(root_text, keys("new", "", "")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), repeated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_save_cycles_are_idempotent() {
        let existing = "# heading\nOTHER=keep\n";
        let configured = keys("new-openai", "new-gemini", "");
        let first = update_env_contents(existing, &configured);
        let second = update_env_contents(&first, &configured);
        let third = update_env_contents(&second, &configured);
        assert_eq!(second, first);
        assert_eq!(third, second);
    }
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
    "https://raw.githubusercontent.com/ttttdiva/Event-AutoPin/main/latest.json";

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

#[cfg(test)]
mod native_event_io_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "eventtrail-native-io-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_save_is_atomic_and_preserves_unknown_fields() {
        let root = temp_root("unknown");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("event.json");
        fs::write(&path, br#"{"event":{"name":"before"},"raw_json":{"x":1}}"#).unwrap();

        let value = json!({
            "event": {"name": "after"},
            "circles": [{"name": "circle", "future_field": [1, 2, 3]}],
            "raw_json": {"x": 1, "preserve": true},
            "metadata": {"source": "fixture", "opaque": {"k": "v"}}
        });
        let receipt = save_event_json_native(path.to_string_lossy().to_string(), value).unwrap();
        assert_eq!(receipt["status"], "ok");
        assert!(receipt["file_size"].as_u64().unwrap_or(0) > 0);

        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["raw_json"]["preserve"], true);
        assert_eq!(saved["metadata"]["opaque"]["k"], "v");
        assert_eq!(saved["circles"][0]["future_field"][2], 3);
        let temporary_files = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0, "atomic save left a staging file");
        cleanup(&root);
    }

    #[test]
    fn native_load_bundle_reports_meta_maps_fingerprint_and_full_json() {
        let root = temp_root("bundle");
        let maps_dir = root.join("maps");
        fs::create_dir_all(&maps_dir).unwrap();
        let path = root.join("event.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "event": {
                    "name": "Bundle",
                    "url": "https://example.test/event",
                    "date": "2026-05-24T00:00:00",
                    "maps": [{"filename": "maps/map_1.png"}]
                },
                "circles": [{"name": "Circle"}],
                "metadata": {"source": "fixture", "opaque": {"keep": true}},
                "raw_json": {"keep": "all"}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(maps_dir.join("map_1.png"), b"png").unwrap();
        fs::write(root.join("map_1.jpg"), b"orphan").unwrap();

        let bundle = load_event_bundle(
            path.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            Some(true),
        )
        .unwrap();
        assert_eq!(bundle["data"]["raw_json"]["keep"], "all");
        assert_eq!(bundle["data"]["metadata"]["opaque"]["keep"], true);
        assert_eq!(bundle["meta"]["event_url"], "https://example.test/event");
        assert_eq!(bundle["meta"]["date"], "2026-05-24");
        assert_eq!(bundle["meta"]["source"], "fixture");
        assert_eq!(bundle["map_images"][0]["name"], "map_1.png");
        assert!(bundle["modified_ms"].as_u64().unwrap_or(0) > 0);
        assert!(bundle["modified_ns"].as_u64().unwrap_or(0) > 0);
        assert_eq!(bundle["content_hash"].as_str().map(str::len), Some(16));
        assert_eq!(
            bundle["file_size"].as_u64(),
            Some(fs::metadata(&path).unwrap().len())
        );

        let bundle_without_maps = load_event_bundle(
            path.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            Some(false),
        )
        .unwrap();
        assert!(bundle_without_maps["map_images"]
            .as_array()
            .is_some_and(Vec::is_empty));
        assert_eq!(bundle_without_maps["data"]["raw_json"]["keep"], "all");
        cleanup(&root);
    }

    #[test]
    fn checked_save_rejects_stale_snapshot_and_preserves_concurrent_metadata() {
        let root = temp_root("checked-conflict");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("event.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "event": {"name": "base"},
                "circles": [{"name": "A", "pin_x": 0.1}],
                "metadata": {"memo": "base"}
            }))
            .unwrap(),
        )
        .unwrap();
        let base = event_document_fingerprint(&path).unwrap();

        save_event_json_native(
            path.to_string_lossy().to_string(),
            json!({
                "event": {"name": "base"},
                "circles": [{"name": "A", "pin_x": 0.1}],
                "metadata": {"memo": "concurrent"}
            }),
        )
        .unwrap();

        let error = save_event_json_native_checked(
            path.to_string_lossy().to_string(),
            json!({
                "event": {"name": "base"},
                "circles": [{"name": "A", "pin_x": 0.9}],
                "metadata": {"memo": "base"}
            }),
            base,
        )
        .unwrap_err();
        assert!(error.contains("fingerprint conflict"));
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["metadata"]["memo"], "concurrent");
        assert_eq!(saved["circles"][0]["pin_x"], 0.1);
        cleanup(&root);
    }

    #[test]
    fn native_load_reports_missing_and_invalid_json() {
        let root = temp_root("errors");
        fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.json");
        let missing_error = load_event_bundle(
            missing.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(missing_error.contains("存在しません"));
        let save_missing_error = save_event_json_native(
            missing.to_string_lossy().to_string(),
            json!({"event": {"name": "missing"}}),
        )
        .unwrap_err();
        assert!(save_missing_error.contains("存在しません"));

        let invalid = root.join("invalid.json");
        fs::write(&invalid, b"{invalid").unwrap();
        let invalid_error = load_event_bundle(
            invalid.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(invalid_error.contains("解析失敗"));
        cleanup(&root);
    }

    #[test]
    fn event_file_fingerprint_is_metadata_only_and_reports_missing_paths() {
        let root = temp_root("fingerprint");
        fs::create_dir_all(&root).unwrap();

        let empty_error = event_file_fingerprint("  ".to_string()).unwrap_err();
        assert!(empty_error.contains("pathが空"));

        let missing = root.join("missing.json");
        let missing_error =
            event_file_fingerprint(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(missing_error.contains("存在しません"));

        // Invalid JSON is intentional: fingerprinting must not parse the file or
        // trigger any event/map directory work.
        let invalid = root.join("invalid.json");
        fs::write(&invalid, b"{not json").unwrap();
        let expected_size = fs::metadata(&invalid).unwrap().len();
        let fingerprint = event_file_fingerprint(invalid.to_string_lossy().to_string()).unwrap();
        assert_eq!(fingerprint["status"], "ok");
        assert_eq!(fingerprint["file_size"].as_u64(), Some(expected_size));
        assert!(fingerprint["modified_ms"].as_u64().unwrap_or(0) > 0);
        cleanup(&root);
    }

    #[test]
    fn concurrent_native_saves_leave_one_valid_complete_document() {
        let root = temp_root("concurrent");
        fs::create_dir_all(&root).unwrap();
        let path = Arc::new(root.join("event.json"));
        fs::write(path.as_ref(), br#"{"event":{"name":"initial"}}"#).unwrap();

        let mut workers = Vec::new();
        for index in 0..12u32 {
            let path = Arc::clone(&path);
            workers.push(std::thread::spawn(move || {
                save_event_json_native(
                    path.to_string_lossy().to_string(),
                    json!({
                        "event": {"name": format!("event-{index}")},
                        "unknown": {"writer": index, "array": [index, index + 1]}
                    }),
                )
                .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let saved: Value = serde_json::from_slice(&fs::read(path.as_ref()).unwrap()).unwrap();
        assert!(saved["event"]["name"]
            .as_str()
            .unwrap()
            .starts_with("event-"));
        assert!(saved["unknown"]["array"].as_array().is_some());
        let temporary_files = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0, "concurrent save left staging files");
        cleanup(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_save_replaces_existing_file_on_windows() {
        let root = temp_root("windows-replace");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("event.json");
        fs::write(&path, br#"{"old":true}"#).unwrap();
        save_event_json_native(path.to_string_lossy().to_string(), json!({"new": true})).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["new"], true);
        cleanup(&root);
    }
}

#[cfg(test)]
mod agy_model_catalog_tests {
    use super::parse_agy_models_text;

    #[test]
    fn parse_agy_models_text_reads_tab_separated_output() {
        let text = "Fetching available models...\n\
gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)\n\
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        let parsed = parse_agy_models_text(text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "gemini-3.5-flash-medium");
        assert_eq!(parsed[0].1, "Gemini 3.5 Flash (Medium)");
    }

    #[test]
    fn parse_agy_models_text_reads_whitespace_separated_output() {
        let text = "gemini-3.5-flash-medium  Gemini 3.5 Flash (Medium)\n";
        let parsed = parse_agy_models_text(text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "gemini-3.5-flash-medium");
    }
}

#[cfg(test)]
mod provider_model_catalog_tests {
    use super::{
        api_catalog_error, append_stale_cached_models, gemini_documented_capabilities,
        model_catalog_cache, save_env_keys, EnvKeys, ModelCatalogCacheEntry,
        next_anthropic_page_id, next_gemini_page_token, openai_documented_capabilities,
    };
    use serde_json::{json, Value};
    use std::collections::HashSet;
    use std::fs;
    use std::time::Instant;

    #[test]
    fn saving_changed_credentials_invalidates_cached_provider_status() {
        let project_root = std::env::temp_dir().join(format!(
            "provider-cache-test-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        fs::create_dir_all(&project_root).unwrap();
        fs::write(project_root.join(".env"), "OPENAI_API_KEY=old-fixture\n").unwrap();
        let project_root_text = project_root.to_string_lossy().into_owned();
        model_catalog_cache().lock().unwrap().insert(
            project_root_text.clone(),
            ModelCatalogCacheEntry {
                stored_at: Instant::now(),
                value: json!({"apiProviders":[{"id":"openai","status":"credential_not_configured"}]}),
            },
        );

        save_env_keys(
            project_root_text.clone(),
            EnvKeys {
                openai_api_key: "new-fixture".to_string(),
                gemini_api_key: String::new(),
                xai_api_key: String::new(),
            },
        )
        .unwrap();

        assert!(!model_catalog_cache()
            .lock()
            .unwrap()
            .contains_key(&project_root_text));
        let _ = fs::remove_dir_all(project_root);
    }

    #[test]
    fn documented_provider_capabilities_do_not_guess_unknown_openai_models() {
        assert_eq!(
            openai_documented_capabilities("gpt-5.6-luna"),
            ("verified", "verified", "OpenAI model and vision documentation (verified family/snapshot)")
        );
        assert_eq!(
            openai_documented_capabilities("gpt-live-transcribe"),
            ("unknown", "unknown", "OpenAI models list has no modality metadata")
        );
    }

    #[test]
    fn gemini_generation_and_audio_only_models_do_not_enter_text_or_vision_roles() {
        assert_eq!(
            gemini_documented_capabilities("gemini-3.8-flash"),
            (
                "verified",
                "verified",
                "Google Gemini model documentation: text/image input, text output",
                "available"
            )
        );
        let (text, image, _, _) = gemini_documented_capabilities("gemini-3.1-flash-image");
        assert_eq!((text, image), ("unsupported", "unsupported"));
        let (text, image, _, _) = gemini_documented_capabilities("gemini-3.8-flash-tts");
        assert_eq!((text, image), ("unsupported", "unsupported"));
        assert_eq!(
            gemini_documented_capabilities("gemini-2.0-flash").3,
            "retired"
        );
    }

    #[test]
    fn provider_pagination_uses_documented_cursor_fields() {
        assert_eq!(
            next_gemini_page_token(&json!({"nextPageToken":"page-2"})),
            Some("page-2".to_string())
        );
        assert_eq!(next_gemini_page_token(&json!({"models":[]})), None);
        assert_eq!(
            next_anthropic_page_id(&json!({"has_more":true,"last_id":"claude-2"})),
            Some("claude-2".to_string())
        );
        assert_eq!(
            next_anthropic_page_id(&json!({"has_more":false,"last_id":"claude-2"})),
            None
        );
    }

    #[test]
    fn refresh_failure_keeps_only_models_for_failed_provider_as_stale() {
        let cached = json!({"apiModels":[
            {"id":"gpt-5.6-luna","provider":"openai","capabilities":{"text":"verified"}},
            {"id":"claude-sonnet","provider":"anthropic","capabilities":{"text":"verified"}}
        ]});
        let mut current = vec![json!({"id":"gpt-6-luna","provider":"openai"})];
        let failed: HashSet<String> = ["anthropic".to_string()].into_iter().collect();

        let added = append_stale_cached_models(&mut current, &cached, &failed);

        assert_eq!(added, 1);
        assert_eq!(current.len(), 2);
        let stale = current
            .iter()
            .find(|model| model.get("provider").and_then(Value::as_str) == Some("anthropic"))
            .unwrap();
        assert_eq!(stale["source"], "stale-cache");
        assert_eq!(stale["stale"], true);
    }

    #[test]
    fn api_permission_and_rate_limit_errors_remain_distinct() {
        assert_eq!(api_catalog_error("openai", "HTTP 403")["status"], "permission_denied");
        assert_eq!(api_catalog_error("xai", "HTTP 429")["status"], "rate_limited");
    }
}

fn main() {
    tauri::Builder::default()
        .manage(CookieStageState::default())
        .manage(PythonBridgeCancellationState::default())
        .invoke_handler(tauri::generate_handler![
            run_python_bridge,
            cancel_reprocess_bridge,
            cancel_python_bridge,
            validate_cookie_file,
            stage_cookie_file,
            cleanup_staged_cookie_file,
            cleanup_cookie_stages,
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
            start_event_sync_file_server,
            stop_file_server,
            get_local_ip,
            search_past_participations,
            list_event_dirs,
            load_event_bundle,
            save_event_json_native,
            save_event_json_native_checked,
            event_file_fingerprint,
            get_desktop_performance_counters,
            read_event_meta,
            write_event_meta,
            create_event_dir,
            delete_event_dir,
            rename_event_dir,
            plan_received_result_import,
            stage_received_result_import,
            publish_received_result_import,
            preview_received_event_sync,
            stage_received_event_sync,
            publish_received_event_sync,
            start_receive_server,
            stop_receive_server,
            ack_received_upload,
            ack_received_upload_with_download,
            claim_received_upload,
            heartbeat_received_upload,
            cancel_received_upload,
            register_local_zip_import,
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

#[cfg(test)]
mod cookie_validation_tests {
    use super::*;

    fn temp_cookie_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "event-autopin-cookie-test-{}-{}-{}.txt",
            label,
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ))
    }

    #[test]
    fn valid_netscape_cookie_and_http_only_row_are_accepted() {
        let body = b"# Netscape HTTP Cookie File\nexample.com\tFALSE\t/\tFALSE\t0\thost\tvalue\n.example.com\tTRUE\t/\tFALSE\t0\ta\tb\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tc\td\n";
        let summary = validate_netscape_cookie_contents_at(body, 1).unwrap();
        assert_eq!(summary.cookie_count, 3);
        assert_eq!(summary.domain_count, 1);
        assert_eq!(summary.domains, vec!["example.com"]);
        assert_eq!(summary.expiry.status, CookieExpiryStatus::Expired);

        let bom = validate_netscape_cookie_contents_at(
            b"\xEF\xBB\xBF# Netscape HTTP Cookie File\nexample.com\tFALSE\t/\tFALSE\t0\thost\tvalue\n",
            1,
        )
        .unwrap();
        assert_eq!(bom.cookie_count, 1);

        let session =
            validate_netscape_cookie_contents_at(b"example.com\tFALSE\t/\tFALSE\t\t\tvalue\n", 1)
                .unwrap();
        assert_eq!(session.cookie_count, 1);
        assert_eq!(session.expiry.status, CookieExpiryStatus::Session);

        let comments = validate_netscape_cookie_contents_at(
            b"# Netscape HTTP Cookie File\n $ generated comment\n  # another comment\nexample.com\tFALSE\t/\tFALSE\t\tname\tvalue\n",
            1,
        )
        .unwrap();
        assert_eq!(comments.cookie_count, 1);
    }

    #[test]
    fn expiry_summary_distinguishes_session_expired_future_and_mixed() {
        let session = validate_netscape_cookie_contents_at(
            b"example.com\tFALSE\t/\tFALSE\t\tname\tvalue\n",
            1_000,
        )
        .unwrap();
        assert_eq!(session.expiry.status, CookieExpiryStatus::Session);
        assert_eq!(
            (
                session.expiry.session_count,
                session.expiry.expired_count,
                session.expiry.future_count
            ),
            (1, 0, 0)
        );

        let expired = validate_netscape_cookie_contents_at(
            b"example.com\tFALSE\t/\tFALSE\t999\tname\tvalue\n",
            1_000,
        )
        .unwrap();
        assert_eq!(expired.expiry.status, CookieExpiryStatus::Expired);
        assert_eq!(
            (
                expired.expiry.session_count,
                expired.expiry.expired_count,
                expired.expiry.future_count
            ),
            (0, 1, 0)
        );

        let future = validate_netscape_cookie_contents_at(
            b"example.com\tFALSE\t/\tFALSE\t1001\tname\tvalue\n",
            1_000,
        )
        .unwrap();
        assert_eq!(future.expiry.status, CookieExpiryStatus::Future);
        assert_eq!(
            (
                future.expiry.session_count,
                future.expiry.expired_count,
                future.expiry.future_count
            ),
            (0, 0, 1)
        );

        let mixed = validate_netscape_cookie_contents_at(
            b"one.example\tFALSE\t/\tFALSE\t\tsession-name\tsession-value\ntwo.example\tFALSE\t/\tFALSE\t999\texpired-name\texpired-value\nthree.example\tFALSE\t/\tFALSE\t1001\tfuture-name\tfuture-value\n",
            1_000,
        )
        .unwrap();
        assert_eq!(mixed.expiry.status, CookieExpiryStatus::Mixed);
        assert_eq!(
            (
                mixed.expiry.session_count,
                mixed.expiry.expired_count,
                mixed.expiry.future_count
            ),
            (1, 1, 1)
        );
    }

    #[test]
    fn domain_summary_is_normalized_deduplicated_and_bounded() {
        let summary = validate_netscape_cookie_contents_at(
            b".Example.COM\tTRUE\t/\tFALSE\t\tn1\tv1\nexample.com\tFALSE\t/\tFALSE\t\tn2\tv2\nA.test\tFALSE\t/\tFALSE\t\tn3\tv3\nb.test\tFALSE\t/\tFALSE\t\tn4\tv4\nc.test\tFALSE\t/\tFALSE\t\tn5\tv5\nd.test\tFALSE\t/\tFALSE\t\tn6\tv6\ne.test\tFALSE\t/\tFALSE\t\tn7\tv7\n",
            1_000,
        )
        .unwrap();
        assert_eq!(summary.cookie_count, 7);
        assert_eq!(summary.domain_count, 6);
        assert_eq!(summary.domains.len(), COOKIE_DOMAIN_SAMPLE_LIMIT);
        assert_eq!(
            summary.domains,
            vec!["example.com", "a.test", "b.test", "c.test", "d.test"]
        );
    }

    #[test]
    fn validator_response_excludes_cookie_secrets_and_full_path() {
        let root = std::env::temp_dir().join(format!(
            "event-autopin-cookie-private-parent-{}",
            next_cookie_stage_token()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("visible-cookie.txt");
        fs::write(
            &path,
            b"Secret.Example\tFALSE\t/\tFALSE\t\tSECRET_COOKIE_NAME\tSECRET_COOKIE_VALUE\n",
        )
        .unwrap();

        let response = validate_cookie_file(path.to_string_lossy().into_owned()).unwrap();
        let object = response.as_object().unwrap();
        let keys: HashSet<&str> = object.keys().map(String::as_str).collect();
        let expected: HashSet<&str> = [
            "ok",
            "basename",
            "exists",
            "readable",
            "cookieCount",
            "domainCount",
            "domains",
            "expiry",
        ]
        .into_iter()
        .collect();
        assert_eq!(keys, expected);
        assert_eq!(response["basename"], "visible-cookie.txt");
        assert_eq!(response["domains"], json!(["secret.example"]));
        let serialized = response.to_string();
        assert!(!serialized.contains("SECRET_COOKIE_NAME"));
        assert!(!serialized.contains("SECRET_COOKIE_VALUE"));
        assert!(!serialized.contains("event-autopin-cookie-private-parent"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_empty_content_is_rejected() {
        assert_eq!(
            validate_netscape_cookie_contents(b"{}\n"),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
        assert_eq!(
            validate_netscape_cookie_contents(b"example.com\tTRUE\t/\tFALSE\t0\tname\tvalue\n"),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
        assert_eq!(
            validate_netscape_cookie_contents(b".example.com\tFALSE\t/\tFALSE\t0\tname\tvalue\n"),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
        assert_eq!(
            validate_netscape_cookie_contents(b" example.com\tFALSE\t/\tFALSE\t0\tname\tvalue\n"),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
        assert_eq!(
            validate_netscape_cookie_contents(b"# Netscape HTTP Cookie File\n"),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
    }

    #[test]
    fn path_classifier_rejects_missing_directory_unsupported_empty_and_oversize() {
        let missing = temp_cookie_path("missing");
        assert_eq!(
            validate_cookie_path(&missing),
            Err(CookieValidationCode::Missing)
        );

        let directory = std::env::temp_dir().join(format!(
            "event-autopin-cookie-test-dir-{}.txt",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        assert_eq!(
            validate_cookie_path(&directory),
            Err(CookieValidationCode::Directory)
        );
        fs::remove_dir_all(&directory).unwrap();

        let unsupported = std::env::temp_dir().join(format!(
            "event-autopin-cookie-test-unsupported-{}.har",
            std::process::id()
        ));
        fs::write(&unsupported, b"{}").unwrap();
        assert_eq!(
            validate_cookie_path(&unsupported),
            Err(CookieValidationCode::Unsupported)
        );
        fs::remove_file(&unsupported).unwrap();

        let empty = temp_cookie_path("empty");
        fs::write(&empty, b"").unwrap();
        assert_eq!(
            validate_cookie_path(&empty),
            Err(CookieValidationCode::EmptyOrInvalid)
        );
        fs::remove_file(&empty).unwrap();

        let oversize = temp_cookie_path("oversize");
        let file = fs::File::create(&oversize).unwrap();
        file.set_len(COOKIE_MAX_BYTES + 1).unwrap();
        assert_eq!(
            validate_cookie_path(&oversize),
            Err(CookieValidationCode::TooLarge)
        );
        fs::remove_file(&oversize).unwrap();
    }

    #[test]
    fn staged_cookie_is_unique_allowlisted_and_removed_without_arbitrary_delete() {
        let state = CookieStageState::default();
        let contents = b"example.com\tFALSE\t/\tFALSE\t0\tname\tvalue\n";
        assert_eq!(
            validate_netscape_cookie_contents(contents)
                .unwrap()
                .cookie_count,
            1
        );

        let first = state.stage(contents).unwrap();
        let second = state.stage(contents).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            first.extension().and_then(|value| value.to_str()),
            Some("txt")
        );
        assert_eq!(fs::read(&first).unwrap(), contents);
        assert_eq!(fs::read(&second).unwrap(), contents);

        let unrelated = temp_cookie_path("unrelated");
        fs::write(&unrelated, contents).unwrap();
        assert_eq!(
            state.cleanup_path(&unrelated),
            Err(CookieValidationCode::StageNotAllowed)
        );
        assert!(unrelated.exists());

        state.cleanup_path(&first).unwrap();
        assert!(!first.exists());
        assert_eq!(
            state.cleanup_path(&first),
            Err(CookieValidationCode::StageNotAllowed)
        );
        let root = second.parent().unwrap().to_path_buf();
        state.cleanup_all().unwrap();
        assert!(!root.exists());
        fs::remove_file(unrelated).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn staged_cookie_directory_and_files_have_protected_current_user_only_dacls() {
        let state = CookieStageState::default();
        let contents = b"example.com\tFALSE\t/\tFALSE\t0\tname\tvalue\n";
        let first = state.stage(contents).unwrap();
        let second = state.stage(contents).unwrap();
        let root = first.parent().unwrap().to_path_buf();

        windows_cookie_acl::assert_private_path(&root, true);
        windows_cookie_acl::assert_private_path(&first, false);
        windows_cookie_acl::assert_private_path(&second, false);

        state.cleanup_all().unwrap();
        assert!(!root.exists());
    }
}

mod ai;
mod certs;
mod models;
mod proxy;
mod replay;
mod system_proxy;

use ai::AiService;
use certs::CertificateService;
use models::{
    AgentAttachment, AgentChatMessage, AiConfigUpdate, AppConfig, BreakpointDecision,
    CaptureBodyContent, CaptureFlow, ProxyRule, RequestDraft, WeakNetworkProfile,
};
use proxy::ProxyService;
use replay::{replay_flow, send_request_draft};
use rustls::crypto::{self, CryptoProvider};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use system_proxy::SystemProxyManager;
use tauri::{Emitter, Manager};

struct AppState {
    config: Mutex<AppConfig>,
    proxy: Mutex<ProxyService>,
    system_proxy: Mutex<SystemProxyManager>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAppConfig {
    qwen: Option<StoredQwenConfig>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredQwenConfig {
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    vision_model: Option<String>,
}

fn find_workspace_root(start: &Path) -> PathBuf {
    let mut current = start.to_path_buf();
    loop {
        if has_workspace_marker(&current) {
            return current;
        }
        if !current.pop() {
            return start.to_path_buf();
        }
    }
}

fn has_workspace_marker(path: &Path) -> bool {
    path.join("package.json").exists()
        || path.join(".env.local").exists()
        || path.join("src-tauri").join("tauri.conf.json").exists()
}

fn workspace_root() -> Option<PathBuf> {
    let current = env::current_dir().ok()?;
    let root = find_workspace_root(&current);
    has_workspace_marker(&root).then_some(root)
}

fn load_dotenv_files() {
    let mut roots = Vec::new();
    if let Some(workspace) = workspace_root() {
        roots.push(workspace);
    }
    roots.push(user_data_dir());

    for root in roots {
        for file_name in [".env", ".env.local"] {
            let file_path = root.join(file_name);
            if file_path.exists() {
                let _ = dotenvy::from_path(file_path);
            }
        }
    }
}

fn parse_list(value: String) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn env_or_default(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn user_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library")
            .join("Application Support")
            .join("HeavenEye Agent")
    } else if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .or_else(|| env::var_os("LOCALAPPDATA"))
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("HeavenEye Agent")
    } else {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".heaveneye-agent")
    }
}

fn default_cert_dir() -> String {
    workspace_root()
        .map(|root| root.join(".local-certs"))
        .unwrap_or_else(|| user_data_dir().join("certs"))
        .display()
        .to_string()
}

fn system_proxy_snapshot_path() -> PathBuf {
    user_data_dir().join("system-proxy-snapshot.json")
}

fn user_config_path() -> PathBuf {
    user_data_dir().join("config.json")
}

fn load_user_config() -> StoredAppConfig {
    let path = user_config_path();
    if !path.exists() {
        return StoredAppConfig::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<StoredAppConfig>(&content).ok())
        .unwrap_or_default()
}

fn save_user_config(config: &AppConfig) -> Result<(), String> {
    let path = user_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let stored = StoredAppConfig {
        qwen: Some(StoredQwenConfig {
            provider: Some(config.qwen.provider.clone()),
            api_key: Some(config.qwen.api_key.clone()),
            base_url: Some(config.qwen.base_url.clone()),
            model: Some(config.qwen.model.clone()),
            vision_model: Some(config.qwen.vision_model.clone()),
        }),
    };
    let content = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(user_config_path(), fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_user_config(mut config: AppConfig, stored: StoredAppConfig) -> AppConfig {
    if let Some(qwen) = stored.qwen {
        if let Some(provider) = qwen.provider.filter(|value| !value.trim().is_empty()) {
            config.qwen.provider = provider.trim().to_string();
        }
        if let Some(api_key) = qwen.api_key {
            config.qwen.api_key = api_key.trim().to_string();
        }
        if let Some(base_url) = qwen.base_url.filter(|value| !value.trim().is_empty()) {
            config.qwen.base_url = base_url.trim().to_string();
        }
        if let Some(model) = qwen.model.filter(|value| !value.trim().is_empty()) {
            config.qwen.model = model.trim().to_string();
        }
        if let Some(vision_model) = qwen.vision_model.filter(|value| !value.trim().is_empty()) {
            config.qwen.vision_model = vision_model.trim().to_string();
        }
    }
    config.qwen.has_api_key = !config.qwen.api_key.trim().is_empty();
    config
}

fn load_config() -> AppConfig {
    load_dotenv_files();
    let cert_dir = env::var("CERT_DIR").unwrap_or_else(|_| default_cert_dir());
    let ssl_proxy_hosts = parse_list(env::var("SSL_PROXY_HOSTS").unwrap_or_default());
    let capture_hosts = {
        let direct = parse_list(
            env::var("CAPTURE_HOSTS")
                .unwrap_or_else(|_| env::var("SSL_PROXY_HOSTS").unwrap_or_default()),
        );
        if direct.is_empty() {
            ssl_proxy_hosts.clone()
        } else {
            direct
        }
    };

    apply_user_config(
        AppConfig {
            proxy_port: env::var("APP_PROXY_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(9090),
            cert_dir,
            capture_hosts,
            ssl_proxy_hosts,
            qwen: models::QwenConfig {
                provider: env::var("AI_PROVIDER").unwrap_or_else(|_| "qwen".into()),
                api_key: env::var("AI_API_KEY")
                    .or_else(|_| env::var("QWEN_API_KEY"))
                    .unwrap_or_default(),
                base_url: env::var("AI_BASE_URL").unwrap_or_else(|_| {
                    env_or_default(
                        "QWEN_BASE_URL",
                        "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    )
                }),
                model: env::var("AI_MODEL")
                    .unwrap_or_else(|_| env_or_default("QWEN_MODEL", "qwen3.7-max")),
                vision_model: env::var("AI_VISION_MODEL")
                    .unwrap_or_else(|_| env_or_default("QWEN_VISION_MODEL", "qwen3-vl-plus")),
                has_api_key: env::var("AI_API_KEY")
                    .or_else(|_| env::var("QWEN_API_KEY"))
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false),
            },
        },
        load_user_config(),
    )
}

fn ensure_rustls_crypto_provider() {
    if CryptoProvider::get_default().is_none() {
        let _ = crypto::aws_lc_rs::default_provider().install_default();
    }
}

fn restore_system_proxy_on_exit(app_handle: &tauri::AppHandle) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let config = state.config.lock().expect("config mutex poisoned").clone();

    let target_port = {
        let mut proxy = state.proxy.lock().expect("proxy mutex poisoned");
        let port = proxy.status(&config).port;
        let _ = proxy.stop();
        port
    };

    let _ = state
        .system_proxy
        .lock()
        .expect("system proxy mutex poisoned")
        .restore(target_port);
}

fn config_snapshot(state: &tauri::State<AppState>) -> AppConfig {
    state.config.lock().expect("config mutex poisoned").clone()
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    config_snapshot(&state)
}

#[tauri::command]
fn proxy_start(
    port: Option<u16>,
    state: tauri::State<AppState>,
) -> Result<models::ProxyStatus, String> {
    let config = config_snapshot(&state);
    let mut proxy = state.proxy.lock().expect("proxy mutex poisoned");
    proxy.start(port, &config)?;
    Ok(proxy.status(&config))
}

#[tauri::command]
fn proxy_stop(state: tauri::State<AppState>) -> Result<models::ProxyStatus, String> {
    let config = config_snapshot(&state);
    let mut proxy = state.proxy.lock().expect("proxy mutex poisoned");
    let target_port = proxy.status(&config).port;
    proxy.stop()?;
    let status = proxy.status(&config);
    drop(proxy);
    let _ = state
        .system_proxy
        .lock()
        .expect("system proxy mutex poisoned")
        .restore(target_port);
    Ok(status)
}

#[tauri::command]
fn proxy_status(state: tauri::State<AppState>) -> models::ProxyStatus {
    let config = config_snapshot(&state);
    let proxy = state.proxy.lock().expect("proxy mutex poisoned");
    proxy.status(&config)
}

#[tauri::command]
fn proxy_set_capture_hosts(hosts: String, state: tauri::State<AppState>) -> models::ProxyStatus {
    let config = config_snapshot(&state);
    let mut proxy = state.proxy.lock().expect("proxy mutex poisoned");
    proxy.set_capture_hosts(&hosts);
    proxy.status(&config)
}

#[tauri::command]
fn proxy_flows(state: tauri::State<AppState>) -> Vec<CaptureFlow> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .list_flows()
}

#[tauri::command]
fn proxy_body(
    flow_id: String,
    direction: String,
    state: tauri::State<AppState>,
) -> Result<CaptureBodyContent, String> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .body_content(&flow_id, &direction)
}

#[tauri::command]
fn proxy_clear(state: tauri::State<AppState>) -> Vec<CaptureFlow> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .clear_flows()
}

#[tauri::command]
async fn proxy_replay_flow(
    flow: CaptureFlow,
    state: tauri::State<'_, AppState>,
) -> Result<models::ReplayResult, String> {
    let replay_target = state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .get_flow(&flow.id)
        .unwrap_or(flow);
    replay_flow(replay_target).await
}

#[tauri::command]
async fn proxy_send_request_draft(draft: RequestDraft) -> Result<models::ReplayResult, String> {
    send_request_draft(draft).await
}

#[tauri::command]
fn proxy_import_flows(flows: Vec<CaptureFlow>, state: tauri::State<AppState>) -> Vec<CaptureFlow> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .replace_flows(flows)
}

#[tauri::command]
fn proxy_rules(state: tauri::State<AppState>) -> Vec<ProxyRule> {
    state.proxy.lock().expect("proxy mutex poisoned").rules()
}

#[tauri::command]
fn proxy_set_rules(rules: Vec<ProxyRule>, state: tauri::State<AppState>) -> Vec<ProxyRule> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .set_rules(rules)
}

#[tauri::command]
fn proxy_weak_network(state: tauri::State<AppState>) -> WeakNetworkProfile {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .weak_network()
}

#[tauri::command]
fn proxy_set_weak_network(
    profile: WeakNetworkProfile,
    state: tauri::State<AppState>,
) -> WeakNetworkProfile {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .set_weak_network(profile)
}

#[tauri::command]
fn proxy_breakpoints(state: tauri::State<AppState>) -> Vec<models::BreakpointRequest> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .breakpoints()
}

#[tauri::command]
fn proxy_resolve_breakpoint(
    decision: BreakpointDecision,
    state: tauri::State<AppState>,
) -> Vec<models::BreakpointRequest> {
    state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .resolve_breakpoint(decision)
}

#[tauri::command]
fn cert_info(state: tauri::State<AppState>) -> Result<models::CertInfo, String> {
    CertificateService::new(&config_snapshot(&state)).cert_info()
}

#[tauri::command]
fn cert_install_root(state: tauri::State<AppState>) -> Result<models::CertInfo, String> {
    CertificateService::new(&config_snapshot(&state)).install_root_certificate()
}

#[tauri::command]
fn cert_uninstall_root(state: tauri::State<AppState>) -> Result<models::CertInfo, String> {
    CertificateService::new(&config_snapshot(&state)).uninstall_root_certificate()
}

#[tauri::command]
fn cert_open_root(state: tauri::State<AppState>) -> Result<HashMap<String, String>, String> {
    let cert_service = CertificateService::new(&config_snapshot(&state));
    let root = cert_service.ensure_root_certificate()?;
    open::that(&root.cert_path).map_err(|error| error.to_string())?;

    Ok(HashMap::from([
        ("certPath".into(), root.cert_path.display().to_string()),
        ("keyPath".into(), root.key_path.display().to_string()),
    ]))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    match parsed.scheme() {
        "http" | "https" => open::that(url).map_err(|error| error.to_string()),
        _ => Err("Only http and https URLs can be opened.".into()),
    }
}

#[tauri::command]
fn system_proxy_status(state: tauri::State<AppState>) -> Result<models::SystemProxyStatus, String> {
    let config = config_snapshot(&state);
    let target_port = state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .status(&config)
        .port;
    state
        .system_proxy
        .lock()
        .expect("system proxy mutex poisoned")
        .status(target_port)
}

#[tauri::command]
fn system_proxy_apply(state: tauri::State<AppState>) -> Result<models::SystemProxyStatus, String> {
    let config = config_snapshot(&state);
    let proxy_status = state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .status(&config);
    state
        .system_proxy
        .lock()
        .expect("system proxy mutex poisoned")
        .apply(proxy_status.port, &proxy_status.capture_hosts)
}

#[tauri::command]
fn system_proxy_restore(
    state: tauri::State<AppState>,
) -> Result<models::SystemProxyStatus, String> {
    let config = config_snapshot(&state);
    let target_port = state
        .proxy
        .lock()
        .expect("proxy mutex poisoned")
        .status(&config)
        .port;
    state
        .system_proxy
        .lock()
        .expect("system proxy mutex poisoned")
        .restore(target_port)
}

#[tauri::command]
async fn ai_test_connection(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    AiService::new(&config_snapshot(&state))?
        .test_connection()
        .await
}

#[tauri::command]
fn ai_update_config(
    settings: AiConfigUpdate,
    state: tauri::State<AppState>,
) -> Result<AppConfig, String> {
    let base_url = settings.base_url.trim();
    let model = settings.model.trim();
    let vision_model = settings.vision_model.trim();
    if base_url.is_empty() {
        return Err("AI base URL cannot be empty.".into());
    }
    if model.is_empty() {
        return Err("AI text model cannot be empty.".into());
    }
    if vision_model.is_empty() {
        return Err("AI vision model cannot be empty.".into());
    }

    let mut config = state.config.lock().expect("config mutex poisoned");
    config.qwen.provider = if settings.provider.trim().is_empty() {
        "custom".into()
    } else {
        settings.provider.trim().to_string()
    };
    config.qwen.base_url = base_url.to_string();
    config.qwen.model = model.to_string();
    config.qwen.vision_model = vision_model.to_string();
    if settings.clear_api_key {
        config.qwen.api_key.clear();
    } else if let Some(api_key) = settings.api_key {
        config.qwen.api_key = api_key.trim().to_string();
    }
    config.qwen.has_api_key = !config.qwen.api_key.trim().is_empty();
    save_user_config(&config)?;
    Ok(config.clone())
}

#[tauri::command]
async fn ai_analyze_failures(
    flows: Option<Vec<CaptureFlow>>,
    state: tauri::State<'_, AppState>,
) -> Result<models::AiResult, String> {
    AiService::new(&config_snapshot(&state))?
        .analyze_failures(flows.unwrap_or_else(|| {
            state
                .proxy
                .lock()
                .expect("proxy mutex poisoned")
                .list_flows()
        }))
        .await
}

#[tauri::command]
async fn ai_compare_flows(
    left: CaptureFlow,
    right: CaptureFlow,
    state: tauri::State<'_, AppState>,
) -> Result<models::AiResult, String> {
    AiService::new(&config_snapshot(&state))?
        .compare_flows(left, right)
        .await
}

#[tauri::command]
async fn ai_generate_bug_report(
    flows: Option<Vec<CaptureFlow>>,
    note: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<models::AiResult, String> {
    AiService::new(&config_snapshot(&state))?
        .generate_bug_report(
            flows.unwrap_or_else(|| {
                state
                    .proxy
                    .lock()
                    .expect("proxy mutex poisoned")
                    .list_flows()
            }),
            note,
        )
        .await
}

#[tauri::command]
async fn ai_ask_agent(
    question: String,
    flows: Option<Vec<CaptureFlow>>,
    history: Option<Vec<AgentChatMessage>>,
    attachments: Option<Vec<AgentAttachment>>,
    state: tauri::State<'_, AppState>,
) -> Result<models::AiResult, String> {
    AiService::new(&config_snapshot(&state))?
        .ask_agent(
            question,
            flows.unwrap_or_else(|| {
                state
                    .proxy
                    .lock()
                    .expect("proxy mutex poisoned")
                    .list_flows()
            }),
            history.unwrap_or_default(),
            attachments.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
async fn ai_ask_agent_stream(
    stream_id: String,
    question: String,
    flows: Option<Vec<CaptureFlow>>,
    history: Option<Vec<AgentChatMessage>>,
    attachments: Option<Vec<AgentAttachment>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<models::AiResult, String> {
    AiService::new(&config_snapshot(&state))?
        .ask_agent_stream(
            stream_id,
            question,
            flows.unwrap_or_else(|| {
                state
                    .proxy
                    .lock()
                    .expect("proxy mutex poisoned")
                    .list_flows()
            }),
            history.unwrap_or_default(),
            attachments.unwrap_or_default(),
            move |event| {
                let _ = app.emit("agent-answer-stream", event);
            },
        )
        .await
}

fn main() {
    ensure_rustls_crypto_provider();
    let config = load_config();
    let system_proxy = SystemProxyManager::new(system_proxy_snapshot_path());
    let _ = system_proxy.cleanup_stale(config.proxy_port);
    let proxy = ProxyService::new(&config);

    let app = tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(config),
            proxy: Mutex::new(proxy),
            system_proxy: Mutex::new(system_proxy),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            proxy_start,
            proxy_stop,
            proxy_status,
            proxy_set_capture_hosts,
            proxy_flows,
            proxy_body,
            proxy_clear,
            proxy_replay_flow,
            proxy_send_request_draft,
            proxy_import_flows,
            proxy_rules,
            proxy_set_rules,
            proxy_weak_network,
            proxy_set_weak_network,
            proxy_breakpoints,
            proxy_resolve_breakpoint,
            system_proxy_status,
            system_proxy_apply,
            system_proxy_restore,
            cert_info,
            cert_install_root,
            cert_uninstall_root,
            cert_open_root,
            open_url,
            ai_test_connection,
            ai_update_config,
            ai_analyze_failures,
            ai_compare_flows,
            ai_generate_bug_report,
            ai_ask_agent,
            ai_ask_agent_stream,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            restore_system_proxy_on_exit(app_handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{ensure_rustls_crypto_provider, find_workspace_root};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("heaveneye-agent-{name}-{nanos}"))
    }

    #[test]
    fn finds_repo_root_from_src_tauri_directory() {
        let root = unique_temp_dir("workspace-root");
        let src_tauri = root.join("src-tauri");
        fs::create_dir_all(&src_tauri).expect("create src-tauri directory");
        fs::write(root.join("package.json"), "{}").expect("write package.json");

        let resolved = find_workspace_root(&src_tauri);

        assert_eq!(resolved, root);

        let _ = fs::remove_dir_all(resolved);
    }

    #[test]
    fn keeps_start_directory_when_workspace_markers_are_missing() {
        let root = unique_temp_dir("cwd-fallback");
        fs::create_dir_all(&root).expect("create fallback directory");

        let resolved = find_workspace_root(&root);

        assert_eq!(resolved, root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installs_default_rustls_crypto_provider() {
        ensure_rustls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}

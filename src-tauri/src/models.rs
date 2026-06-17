use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenConfig {
    #[serde(default = "default_ai_provider")]
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
    pub has_api_key: bool,
    #[serde(skip_serializing, default)]
    pub api_key: String,
}

fn default_ai_provider() -> String {
    "qwen".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub proxy_port: u16,
    pub cert_dir: String,
    pub capture_hosts: Vec<String>,
    pub ssl_proxy_hosts: Vec<String>,
    pub qwen: QwenConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigUpdate {
    #[serde(default = "default_ai_provider")]
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub bind_host: String,
    pub lan_ip: Option<String>,
    pub proxy_address: String,
    pub mobile_setup_url: Option<String>,
    pub cert_download_url: Option<String>,
    pub ios_profile_url: Option<String>,
    pub pac_url: Option<String>,
    pub mode: String,
    pub https_mitm: bool,
    pub capture_hosts: Vec<String>,
    pub ssl_proxy_hosts: Vec<String>,
    pub root_certificate_path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub trusted: bool,
    pub platform: String,
    pub cert_path: String,
    pub can_install: bool,
    pub can_uninstall: bool,
    pub needs_admin: bool,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxySetting {
    pub enabled: bool,
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyUrlSetting {
    pub enabled: bool,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyStatus {
    pub supported: bool,
    pub service: Option<String>,
    pub target_host: String,
    pub target_port: u16,
    pub http: SystemProxySetting,
    pub https: SystemProxySetting,
    pub socks: SystemProxySetting,
    pub auto_proxy: SystemProxyUrlSetting,
    pub auto_discovery_enabled: bool,
    pub matches_proxy: bool,
    pub managed_proxy_active: bool,
    pub can_restore: bool,
    pub restore_recommended: bool,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseEventCapture {
    pub event: String,
    pub id: String,
    pub retry: String,
    pub data: String,
    pub raw: String,
    pub arrived_at: u64,
    pub complete: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFlow {
    pub id: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
    pub query: String,
    pub status_code: Option<u16>,
    pub protocol: String,
    pub source: String,
    #[serde(default)]
    pub client_address: Option<String>,
    pub duration_ms: Option<u64>,
    pub request_headers: HashMap<String, String>,
    pub response_headers: HashMap<String, String>,
    pub request_body_preview: String,
    #[serde(skip, default)]
    pub request_body_path: Option<String>,
    #[serde(skip, default)]
    pub request_body_text_path: Option<String>,
    #[serde(default)]
    pub request_body_preview_truncated: bool,
    #[serde(default)]
    pub request_body_decoded_size: u64,
    #[serde(default)]
    pub request_body_replay_size: u64,
    pub response_body_preview: String,
    #[serde(skip, default)]
    pub response_body_text_path: Option<String>,
    #[serde(default)]
    pub response_body_preview_truncated: bool,
    #[serde(default)]
    pub response_body_decoded_size: u64,
    pub request_size: u64,
    pub response_size: u64,
    pub error_type: String,
    #[serde(default)]
    pub sse_events: Vec<SseEventCapture>,
    pub tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBodyContent {
    pub flow_id: String,
    pub direction: String,
    pub content: String,
    pub content_type: String,
    pub size: u64,
    pub decoded_size: u64,
    pub from_preview: bool,
    pub complete: bool,
    pub omitted_reason: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResult {
    pub started_at: u64,
    pub completed_at: u64,
    pub method: String,
    pub url: String,
    pub status_code: Option<u16>,
    pub duration_ms: u64,
    pub request_headers: HashMap<String, String>,
    pub response_headers: HashMap<String, String>,
    pub response_body_preview: String,
    #[serde(default)]
    pub response_body_preview_truncated: bool,
    #[serde(default)]
    pub response_body_decoded_size: u64,
    pub response_size: u64,
    pub error_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDraft {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRule {
    pub id: String,
    pub enabled: bool,
    pub kind: String,
    #[serde(default = "default_rule_direction")]
    pub direction: String,
    pub pattern: String,
    pub status_code: Option<u16>,
    pub headers: HashMap<String, String>,
    pub body: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub replace: String,
    pub local_path: String,
    pub delay_ms: Option<u64>,
}

fn default_rule_direction() -> String {
    "request".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeakNetworkProfile {
    pub enabled: bool,
    pub delay_ms: u64,
    pub downstream_kbps: u64,
    pub error_rate: f64,
}

impl Default for WeakNetworkProfile {
    fn default() -> Self {
        Self {
            enabled: false,
            delay_ms: 0,
            downstream_kbps: 0,
            error_rate: 0.0,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointRequest {
    pub id: String,
    pub flow_id: String,
    pub rule_id: String,
    pub created_at: u64,
    #[serde(default = "default_breakpoint_direction")]
    pub direction: String,
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
    pub body_preview: String,
    #[serde(default)]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub response_headers: HashMap<String, String>,
    #[serde(default)]
    pub response_body_preview: String,
}

fn default_breakpoint_direction() -> String {
    "request".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointDecision {
    pub id: String,
    pub action: String,
    pub status_code: Option<u16>,
    pub headers: HashMap<String, String>,
    pub body: String,
    #[serde(default)]
    pub request_method: Option<String>,
    #[serde(default)]
    pub request_url: Option<String>,
    #[serde(default)]
    pub request_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub request_body: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentAttachment {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub content_type: String,
    #[serde(rename = "dataUrl")]
    pub data_url: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub attachments: Option<Vec<AgentAttachment>>,
    pub model: Option<String>,
    pub structured: Option<AgentStructuredAnswer>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentHighlight {
    pub label: String,
    pub value: String,
    pub kind: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentEvidenceField {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentEvidence {
    pub title: Option<String>,
    pub time: Option<String>,
    pub method: Option<String>,
    pub status: Option<serde_json::Value>,
    pub host: Option<String>,
    pub path: Option<String>,
    pub fields: Option<Vec<AgentEvidenceField>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentTestCase {
    pub name: String,
    pub purpose: Option<String>,
    pub method: Option<String>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub query: Option<HashMap<String, serde_json::Value>>,
    pub body: Option<serde_json::Value>,
    pub expected: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentStructuredAnswer {
    pub summary: Option<String>,
    pub highlights: Option<Vec<AgentHighlight>>,
    pub evidence: Option<Vec<AgentEvidence>>,
    pub analysis: Option<Vec<String>>,
    #[serde(rename = "testCases")]
    pub test_cases: Option<Vec<AgentTestCase>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AiUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AiResult {
    pub model: String,
    pub content: String,
    pub structured: Option<AgentStructuredAnswer>,
    pub usage: Option<AiUsage>,
}

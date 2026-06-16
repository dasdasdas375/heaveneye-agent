use crate::models::{CaptureFlow, ReplayResult, RequestDraft};
use reqwest::{Client, Method};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

const BODY_PREVIEW_LIMIT: usize = 256 * 1024;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn default_port_for_scheme(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    }
}

fn build_replay_url(flow: &CaptureFlow) -> Result<String, String> {
    let scheme = if flow.scheme.is_empty() {
        "https"
    } else {
        &flow.scheme
    };
    let path = if flow.path.starts_with('/') {
        flow.path.clone()
    } else {
        format!("/{}", flow.path)
    };
    let mut url =
        Url::parse(&format!("{scheme}://{}", flow.host)).map_err(|error| error.to_string())?;
    if let Some(port) = flow.port {
        if port != default_port_for_scheme(scheme) {
            url.set_port(Some(port))
                .map_err(|_| format!("invalid replay port: {port}"))?;
        }
    }
    url.set_path(&path);
    if !flow.query.is_empty() {
        url.set_query(Some(flow.query.trim_start_matches('?')));
    }
    Ok(url.to_string())
}

fn replay_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let skipped = HashSet::from([
        "host",
        "content-length",
        "connection",
        "proxy-connection",
        "accept-encoding",
    ]);

    headers
        .iter()
        .filter(|(key, value)| {
            let normalized = key.to_ascii_lowercase();
            !value.is_empty()
                && !normalized.starts_with(':')
                && !skipped.contains(normalized.as_str())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn headers_to_map(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| {
            (
                key.as_str().to_string(),
                value.to_str().unwrap_or("<non-utf8 header>").to_string(),
            )
        })
        .collect()
}

fn preview_body(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    String::from_utf8_lossy(&bytes[..bytes.len().min(BODY_PREVIEW_LIMIT)]).to_string()
}

fn replay_body(flow: &CaptureFlow) -> Result<Vec<u8>, String> {
    if let Some(path) = &flow.request_body_path {
        return fs::read(path).map_err(|error| format!("failed to read replay body: {error}"));
    }

    Ok(flow.request_body_preview.as_bytes().to_vec())
}

pub async fn replay_flow(flow: CaptureFlow) -> Result<ReplayResult, String> {
    if flow.method.eq_ignore_ascii_case("CONNECT") {
        return Err("CONNECT tunnel requests cannot be replayed directly.".into());
    }

    let url = build_replay_url(&flow)?;
    let method = Method::from_bytes(flow.method.as_bytes()).map_err(|error| error.to_string())?;
    let started_at = now_millis();
    let started = Instant::now();
    let request_headers = replay_headers(&flow.request_headers);
    let body = replay_body(&flow)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = client.request(method, &url);
    for (key, value) in &request_headers {
        request = request.header(key, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let response_headers = headers_to_map(response.headers());
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            let completed_at = now_millis();
            Ok(ReplayResult {
                started_at,
                completed_at,
                method: flow.method,
                url,
                status_code: Some(status),
                duration_ms: started.elapsed().as_millis() as u64,
                request_headers,
                response_headers,
                response_body_preview: preview_body(&bytes),
                response_body_preview_truncated: bytes.len() > BODY_PREVIEW_LIMIT,
                response_body_decoded_size: bytes.len() as u64,
                response_size: bytes.len() as u64,
                error_type: String::new(),
            })
        }
        Err(error) => {
            let completed_at = now_millis();
            Ok(ReplayResult {
                started_at,
                completed_at,
                method: flow.method,
                url,
                status_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                request_headers,
                response_headers: HashMap::new(),
                response_body_preview: String::new(),
                response_body_preview_truncated: false,
                response_body_decoded_size: 0,
                response_size: 0,
                error_type: error.to_string(),
            })
        }
    }
}

pub async fn send_request_draft(draft: RequestDraft) -> Result<ReplayResult, String> {
    let url = Url::parse(&draft.url).map_err(|error| format!("invalid request URL: {error}"))?;
    let method = Method::from_bytes(draft.method.as_bytes()).map_err(|error| error.to_string())?;
    let started_at = now_millis();
    let started = Instant::now();
    let request_headers = replay_headers(&draft.headers);
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = client.request(method, url);
    for (key, value) in &request_headers {
        request = request.header(key, value);
    }
    if !draft.body.is_empty() {
        request = request.body(draft.body.into_bytes());
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let response_headers = headers_to_map(response.headers());
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            let completed_at = now_millis();
            Ok(ReplayResult {
                started_at,
                completed_at,
                method: draft.method,
                url: draft.url,
                status_code: Some(status),
                duration_ms: started.elapsed().as_millis() as u64,
                request_headers,
                response_headers,
                response_body_preview: preview_body(&bytes),
                response_body_preview_truncated: bytes.len() > BODY_PREVIEW_LIMIT,
                response_body_decoded_size: bytes.len() as u64,
                response_size: bytes.len() as u64,
                error_type: String::new(),
            })
        }
        Err(error) => {
            let completed_at = now_millis();
            Ok(ReplayResult {
                started_at,
                completed_at,
                method: draft.method,
                url: draft.url,
                status_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                request_headers,
                response_headers: HashMap::new(),
                response_body_preview: String::new(),
                response_body_preview_truncated: false,
                response_body_decoded_size: 0,
                response_size: 0,
                error_type: error.to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_replay_url, replay_body, replay_headers};
    use crate::models::CaptureFlow;
    use std::collections::HashMap;
    use std::fs;

    fn flow() -> CaptureFlow {
        CaptureFlow {
            id: "flow-1".into(),
            started_at: 1,
            completed_at: None,
            method: "POST".into(),
            scheme: "http".into(),
            host: "127.0.0.1".into(),
            port: Some(8080),
            path: "api/login".into(),
            query: "?debug=true".into(),
            status_code: None,
            protocol: "HTTP/1.1".into(),
            source: "test".into(),
            client_address: None,
            duration_ms: None,
            request_headers: HashMap::new(),
            response_headers: HashMap::new(),
            request_body_preview: String::new(),
            request_body_path: None,
            request_body_text_path: None,
            request_body_preview_truncated: false,
            request_body_decoded_size: 0,
            request_body_replay_size: 0,
            response_body_preview: String::new(),
            response_body_text_path: None,
            response_body_preview_truncated: false,
            response_body_decoded_size: 0,
            request_size: 0,
            response_size: 0,
            error_type: String::new(),
            sse_events: Vec::new(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn builds_url_with_non_default_port_and_query() {
        assert_eq!(
            build_replay_url(&flow()).unwrap(),
            "http://127.0.0.1:8080/api/login?debug=true"
        );
    }

    #[test]
    fn filters_transport_headers_for_replay() {
        let headers = HashMap::from([
            ("content-length".into(), "100".into()),
            ("accept".into(), "application/json".into()),
            (":authority".into(), "example.com".into()),
        ]);

        let filtered = replay_headers(&headers);

        assert_eq!(filtered.get("accept"), Some(&"application/json".into()));
        assert!(!filtered.contains_key("content-length"));
        assert!(!filtered.contains_key(":authority"));
    }

    #[test]
    fn reads_replay_body_from_stored_file_before_preview() {
        let path = std::env::temp_dir().join("heaveneye-agent-replay-test.body");
        fs::write(&path, b"\x00raw-binary-body").unwrap();
        let mut flow = flow();
        flow.request_body_preview = "preview-body".into();
        flow.request_body_path = Some(path.display().to_string());
        flow.request_body_replay_size = 16;

        assert_eq!(replay_body(&flow).unwrap(), b"\x00raw-binary-body");

        let _ = fs::remove_file(path);
    }
}

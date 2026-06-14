use crate::certs::CertificateService;
use crate::models::{
    AppConfig, BreakpointDecision, BreakpointRequest, CaptureBodyContent, CaptureFlow, ProxyRule,
    ProxyStatus, WeakNetworkProfile,
};
use bytes::Bytes;
use flate2::read::{GzDecoder, ZlibDecoder};
use h2::server;
use rustls::pki_types::ServerName;
use rustls::{
    ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, Cursor, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use url::Url;
use webpki_roots::TLS_SERVER_ROOTS;

const BODY_PREVIEW_LIMIT: usize = 128 * 1024;
const DEFAULT_MITM_BYPASS_HOSTS: &[&str] = &[
    "apple-cloudkit.com",
    "google.com",
    "gstatic.com",
    "googleusercontent.com",
    "googlevideo.com",
    "icloud.com",
    "icloud-content.com",
    "push.apple.com",
    "ess.apple.com",
    "mzstatic.com",
    "itunes.apple.com",
];
static FLOW_COUNTER: AtomicU64 = AtomicU64::new(1);

pub struct ProxyService {
    default_port: u16,
    port: Option<u16>,
    running: bool,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    controller: Option<ProxyController>,
}

struct ProxyController {
    stop_tx: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

#[derive(Clone)]
struct ParsedRequest {
    method: String,
    target: String,
    version: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct ParsedResponse {
    status_code: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Clone)]
struct BreakpointRegistry {
    pending: Arc<Mutex<Vec<BreakpointRequest>>>,
    waiters: Arc<Mutex<HashMap<String, mpsc::Sender<BreakpointDecision>>>>,
}

struct InterceptedResponse {
    response_bytes: Vec<u8>,
    tags: Vec<String>,
    error_type: String,
}

struct RequestControlForward {
    request: ParsedRequest,
    target_url: Url,
    tags: Vec<String>,
}

enum RequestControlOutcome {
    Forward(RequestControlForward),
    Respond(InterceptedResponse),
}

struct ResponseControlOutcome {
    response_bytes: Vec<u8>,
    tags: Vec<String>,
    error_type: String,
}

struct WebSocketCapture {
    status_code: u16,
    response_headers: HashMap<String, String>,
    response_body_preview: String,
    response_size: u64,
    client_to_server_bytes: u64,
    server_to_client_bytes: u64,
    tags: Vec<String>,
    error_type: String,
}

impl BreakpointRegistry {
    fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(Vec::new())),
            waiters: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn pending(&self) -> Vec<BreakpointRequest> {
        self.pending
            .lock()
            .expect("breakpoint pending mutex poisoned")
            .clone()
    }

    fn resolve(&self, decision: BreakpointDecision) {
        let waiter = self
            .waiters
            .lock()
            .expect("breakpoint waiters mutex poisoned")
            .remove(&decision.id);
        self.pending
            .lock()
            .expect("breakpoint pending mutex poisoned")
            .retain(|request| request.id != decision.id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(decision);
        }
    }

    fn wait_for_decision(
        &self,
        request: BreakpointRequest,
        timeout: Duration,
    ) -> Option<BreakpointDecision> {
        let (tx, rx) = mpsc::channel();
        let id = request.id.clone();
        self.waiters
            .lock()
            .expect("breakpoint waiters mutex poisoned")
            .insert(id.clone(), tx);
        self.pending
            .lock()
            .expect("breakpoint pending mutex poisoned")
            .push(request);
        let result = rx.recv_timeout(timeout).ok();
        self.waiters
            .lock()
            .expect("breakpoint waiters mutex poisoned")
            .remove(&id);
        self.pending
            .lock()
            .expect("breakpoint pending mutex poisoned")
            .retain(|request| request.id != id);
        result
    }
}

struct BlockingTlsStream {
    inner: StreamOwned<ServerConnection, TcpStream>,
}

impl BlockingTlsStream {
    fn new(inner: StreamOwned<ServerConnection, TcpStream>) -> Self {
        Self { inner }
    }
}

fn poll_blocking_result<T>(result: std::io::Result<T>) -> std::task::Poll<std::io::Result<T>> {
    match result {
        Ok(value) => std::task::Poll::Ready(Ok(value)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::task::Poll::Pending,
        Err(error) => std::task::Poll::Ready(Err(error)),
    }
}

impl AsyncRead for BlockingTlsStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let remaining = buf.remaining();
        if remaining == 0 {
            return std::task::Poll::Ready(Ok(()));
        }
        let mut temp = vec![0u8; remaining.min(16 * 1024)];
        match poll_blocking_result(self.inner.read(&mut temp)) {
            std::task::Poll::Ready(Ok(read)) => {
                buf.put_slice(&temp[..read]);
                std::task::Poll::Ready(Ok(()))
            }
            std::task::Poll::Ready(Err(error)) => std::task::Poll::Ready(Err(error)),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

impl AsyncWrite for BlockingTlsStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        poll_blocking_result(self.inner.write(buf))
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        poll_blocking_result(self.inner.flush())
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let _ = self.inner.sock.shutdown(Shutdown::Both);
        std::task::Poll::Ready(Ok(()))
    }
}

impl ProxyService {
    pub fn new(config: &AppConfig) -> Self {
        Self {
            default_port: config.proxy_port,
            port: None,
            running: false,
            capture_hosts: Arc::new(Mutex::new(normalize_capture_hosts(
                if config.capture_hosts.is_empty() {
                    config.ssl_proxy_hosts.clone()
                } else {
                    config.capture_hosts.clone()
                }
                .as_slice(),
            ))),
            flows: Arc::new(Mutex::new(Vec::new())),
            rules: Arc::new(Mutex::new(Vec::new())),
            weak_network: Arc::new(Mutex::new(WeakNetworkProfile::default())),
            breakpoints: BreakpointRegistry::new(),
            controller: None,
        }
    }

    pub fn start(&mut self, port: Option<u16>, config: &AppConfig) -> Result<(), String> {
        if self.running {
            return Ok(());
        }

        let bind_port = port.unwrap_or(self.default_port);
        let bind_host = "0.0.0.0";
        let listener =
            TcpListener::bind((bind_host, bind_port)).map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();

        let (stop_tx, stop_rx) = mpsc::channel();
        let flows = Arc::clone(&self.flows);
        let capture_hosts = Arc::clone(&self.capture_hosts);
        let rules = Arc::clone(&self.rules);
        let weak_network = Arc::clone(&self.weak_network);
        let breakpoints = self.breakpoints.clone();
        let config = config.clone();

        let thread = thread::spawn(move || {
            run_proxy_loop(
                listener,
                stop_rx,
                flows,
                capture_hosts,
                rules,
                weak_network,
                breakpoints,
                config,
                actual_port,
            );
        });

        self.port = Some(actual_port);
        self.running = true;
        self.controller = Some(ProxyController { stop_tx, thread });
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(controller) = self.controller.take() {
            let _ = controller.stop_tx.send(());
            controller
                .thread
                .join()
                .map_err(|_| "proxy thread panicked".to_string())?;
        }
        self.port = None;
        self.running = false;
        Ok(())
    }

    pub fn status(&self, config: &AppConfig) -> ProxyStatus {
        let cert_service = CertificateService::new(config);
        let root_certificate_path = cert_service
            .ensure_root_certificate()
            .ok()
            .map(|info| info.cert_path.display().to_string());
        let capture_hosts = self
            .capture_hosts
            .lock()
            .expect("capture hosts mutex poisoned")
            .clone();
        let port = self.port.unwrap_or(self.default_port);
        let lan_ip = local_lan_ip();
        let proxy_address = lan_ip
            .as_ref()
            .map(|ip| format!("{ip}:{port}"))
            .unwrap_or_else(|| format!("127.0.0.1:{port}"));
        let mobile_base_url = if self.running {
            lan_ip.as_ref().map(|ip| format!("http://{ip}:{port}"))
        } else {
            None
        };
        ProxyStatus {
            running: self.running,
            port,
            bind_host: "0.0.0.0".into(),
            lan_ip: lan_ip.clone(),
            proxy_address,
            mobile_setup_url: mobile_base_url
                .as_ref()
                .map(|base_url| format!("{base_url}/mobile-setup")),
            cert_download_url: mobile_base_url
                .as_ref()
                .map(|base_url| format!("{base_url}/cert/ca.crt")),
            ios_profile_url: mobile_base_url
                .as_ref()
                .map(|base_url| format!("{base_url}/ios.mobileconfig")),
            pac_url: mobile_base_url
                .as_ref()
                .map(|base_url| format!("{base_url}/proxy.pac")),
            mode: "rust-http-proxy".into(),
            https_mitm: !capture_hosts.is_empty(),
            capture_hosts: capture_hosts.clone(),
            ssl_proxy_hosts: capture_hosts,
            root_certificate_path,
        }
    }

    pub fn set_capture_hosts(&mut self, hosts: &str) {
        *self
            .capture_hosts
            .lock()
            .expect("capture hosts mutex poisoned") = normalize_capture_hosts(&[hosts.to_string()]);
    }

    pub fn list_flows(&self) -> Vec<CaptureFlow> {
        self.flows.lock().expect("flows mutex poisoned").clone()
    }

    pub fn get_flow(&self, id: &str) -> Option<CaptureFlow> {
        self.flows
            .lock()
            .expect("flows mutex poisoned")
            .iter()
            .find(|flow| flow.id == id)
            .cloned()
    }

    pub fn body_content(
        &self,
        flow_id: &str,
        direction: &str,
    ) -> Result<CaptureBodyContent, String> {
        let flow = self
            .get_flow(flow_id)
            .ok_or_else(|| "Flow not found".to_string())?;
        let is_request = direction == "request";
        let (text_path, preview, headers, size, decoded_size, preview_truncated) = if is_request {
            (
                flow.request_body_text_path.clone(),
                flow.request_body_preview.clone(),
                flow.request_headers.clone(),
                flow.request_size,
                flow.request_body_decoded_size,
                flow.request_body_preview_truncated,
            )
        } else {
            (
                flow.response_body_text_path.clone(),
                flow.response_body_preview.clone(),
                flow.response_headers.clone(),
                flow.response_size,
                flow.response_body_decoded_size,
                flow.response_body_preview_truncated,
            )
        };
        let content_type = header_value(&headers, "content-type");
        if let Some(path) = text_path {
            if let Ok(content) = fs::read_to_string(path) {
                return Ok(CaptureBodyContent {
                    flow_id: flow_id.to_string(),
                    direction: if is_request {
                        "request".into()
                    } else {
                        "response".into()
                    },
                    content,
                    content_type,
                    size,
                    decoded_size,
                    from_preview: false,
                    complete: true,
                    omitted_reason: String::new(),
                });
            }
        }

        let binary_omitted = preview.starts_with("[binary body omitted]");
        Ok(CaptureBodyContent {
            flow_id: flow_id.to_string(),
            direction: if is_request {
                "request".into()
            } else {
                "response".into()
            },
            content: preview,
            content_type,
            size,
            decoded_size,
            from_preview: true,
            complete: !preview_truncated && !binary_omitted,
            omitted_reason: if binary_omitted {
                "Binary body is not stored as text.".into()
            } else if preview_truncated {
                "Full body cache is unavailable; showing captured preview.".into()
            } else {
                String::new()
            },
        })
    }

    pub fn clear_flows(&self) -> Vec<CaptureFlow> {
        let mut flows = self.flows.lock().expect("flows mutex poisoned");
        for flow in flows.iter() {
            delete_replay_body(flow);
        }
        flows.clear();
        flows.clone()
    }

    pub fn replace_flows(&self, mut next_flows: Vec<CaptureFlow>) -> Vec<CaptureFlow> {
        let mut flows = self.flows.lock().expect("flows mutex poisoned");
        for flow in flows.iter() {
            delete_replay_body(flow);
        }
        next_flows.truncate(500);
        for flow in next_flows.iter_mut() {
            flow.request_body_path = None;
            flow.request_body_text_path = None;
            flow.request_body_replay_size = 0;
            flow.response_body_text_path = None;
        }
        *flows = next_flows;
        flows.clone()
    }

    pub fn rules(&self) -> Vec<ProxyRule> {
        self.rules.lock().expect("rules mutex poisoned").clone()
    }

    pub fn set_rules(&self, rules: Vec<ProxyRule>) -> Vec<ProxyRule> {
        let mut current = self.rules.lock().expect("rules mutex poisoned");
        *current = rules;
        current.clone()
    }

    pub fn weak_network(&self) -> WeakNetworkProfile {
        self.weak_network
            .lock()
            .expect("weak network mutex poisoned")
            .clone()
    }

    pub fn set_weak_network(&self, profile: WeakNetworkProfile) -> WeakNetworkProfile {
        let mut current = self
            .weak_network
            .lock()
            .expect("weak network mutex poisoned");
        *current = WeakNetworkProfile {
            error_rate: profile.error_rate.clamp(0.0, 1.0),
            ..profile
        };
        current.clone()
    }

    pub fn breakpoints(&self) -> Vec<BreakpointRequest> {
        self.breakpoints.pending()
    }

    pub fn resolve_breakpoint(&self, decision: BreakpointDecision) -> Vec<BreakpointRequest> {
        self.breakpoints.resolve(decision);
        self.breakpoints.pending()
    }
}

fn run_proxy_loop(
    listener: TcpListener,
    stop_rx: mpsc::Receiver<()>,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    config: AppConfig,
    proxy_port: u16,
) {
    loop {
        match stop_rx.try_recv() {
            Ok(_) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        match listener.accept() {
            Ok((stream, _addr)) => {
                let flows = Arc::clone(&flows);
                let capture_hosts = Arc::clone(&capture_hosts);
                let rules = Arc::clone(&rules);
                let weak_network = Arc::clone(&weak_network);
                let breakpoints = breakpoints.clone();
                let config = config.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_client(
                        stream,
                        flows,
                        capture_hosts,
                        rules,
                        weak_network,
                        breakpoints,
                        config,
                        proxy_port,
                    ) {
                        eprintln!("proxy client error: {error}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn handle_client(
    mut client_stream: TcpStream,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    config: AppConfig,
    proxy_port: u16,
) -> Result<(), String> {
    configure_client_stream(&client_stream)?;
    let client_addr = client_stream.peer_addr().ok();

    let request = read_http_request(&mut client_stream)?;
    if try_serve_mobile_setup(&request, &mut client_stream, &config, proxy_port)? {
        return Ok(());
    }
    if request.method.eq_ignore_ascii_case("CONNECT") {
        handle_connect(
            request,
            client_stream,
            flows,
            capture_hosts,
            rules,
            weak_network,
            breakpoints,
            config,
            client_addr,
        )
    } else {
        handle_forward_http(
            request,
            client_stream,
            flows,
            capture_hosts,
            rules,
            weak_network,
            breakpoints,
            client_addr,
        )
    }
}

fn configure_client_stream(client_stream: &TcpStream) -> Result<(), String> {
    client_stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    client_stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    client_stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn try_serve_mobile_setup(
    request: &ParsedRequest,
    client_stream: &mut TcpStream,
    config: &AppConfig,
    proxy_port: u16,
) -> Result<bool, String> {
    let Some(path) = mobile_control_path(request, proxy_port) else {
        return Ok(false);
    };

    let lan_ip = local_lan_ip().unwrap_or_else(|| "127.0.0.1".into());
    let base_url = format!("http://{lan_ip}:{proxy_port}");
    let (status_code, headers, body) = match path.as_str() {
        "/" | "/mobile-setup" => (
            200,
            HashMap::from([("content-type".into(), "text/html; charset=utf-8".into())]),
            mobile_setup_html(&lan_ip, proxy_port, &base_url).into_bytes(),
        ),
        "/proxy.pac" => (
            200,
            HashMap::from([(
                "content-type".into(),
                "application/x-ns-proxy-autoconfig; charset=utf-8".into(),
            )]),
            format!(
                "function FindProxyForURL(url, host) {{\n  return \"PROXY {lan_ip}:{proxy_port}; DIRECT\";\n}}\n"
            )
            .into_bytes(),
        ),
        "/cert" | "/cert/" | "/ssl" | "/cert/ca.crt" | "/android-ca.crt" => {
            let cert = mobile_cert_bytes(config)?;
            (
                200,
                HashMap::from([
                    ("content-type".into(), "application/x-x509-ca-cert".into()),
                    (
                        "content-disposition".into(),
                        "attachment; filename=\"heaveneye-agent-ca.crt\"".into(),
                    ),
                ]),
                cert,
            )
        }
        "/ios.mobileconfig" => (
            200,
            HashMap::from([
                (
                    "content-type".into(),
                    "application/x-apple-aspen-config; charset=utf-8".into(),
                ),
                (
                    "content-disposition".into(),
                    "attachment; filename=\"heaveneye-agent.mobileconfig\"".into(),
                ),
            ]),
            ios_mobileconfig(config)?.into_bytes(),
        ),
        "/favicon.ico" => (
            204,
            HashMap::from([("content-type".into(), "image/x-icon".into())]),
            Vec::new(),
        ),
        _ => (
            404,
            HashMap::from([("content-type".into(), "text/plain; charset=utf-8".into())]),
            b"HeavenEye Agent mobile setup endpoint not found.".to_vec(),
        ),
    };

    let response_body = if request.method.eq_ignore_ascii_case("HEAD") {
        Vec::new()
    } else {
        body
    };
    client_stream
        .write_all(&build_http_response_bytes(
            status_code,
            &headers,
            &response_body,
        ))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn mobile_control_path(request: &ParsedRequest, proxy_port: u16) -> Option<String> {
    if !request.method.eq_ignore_ascii_case("GET") && !request.method.eq_ignore_ascii_case("HEAD") {
        return None;
    }

    if request.target.starts_with('/') {
        let host = request
            .headers
            .get("host")
            .map(String::as_str)
            .unwrap_or("");
        if host.is_empty() || host_points_to_proxy(host, proxy_port) {
            return Some(path_without_query(&request.target));
        }
        return None;
    }

    let url = Url::parse(&request.target).ok()?;
    let port = url.port_or_known_default().unwrap_or(80);
    if port != proxy_port {
        return None;
    }
    let host = url.host_str().unwrap_or_default();
    if is_local_setup_host(host) {
        return Some(path_without_query(url.path()));
    }
    None
}

fn host_points_to_proxy(host_header: &str, proxy_port: u16) -> bool {
    let trimmed = host_header.trim();
    let (host, port) = split_authority_host_port(trimmed);
    if let Some(port) = port {
        if port != proxy_port {
            return false;
        }
    }
    is_local_setup_host(host)
}

fn split_authority_host_port(value: &str) -> (&str, Option<u16>) {
    if let Some(stripped) = value.strip_prefix('[') {
        if let Some((host, rest)) = stripped.split_once(']') {
            let port = rest
                .strip_prefix(':')
                .and_then(|text| text.parse::<u16>().ok());
            return (host, port);
        }
    }

    if let Some((host, port)) = value.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return (host, Some(port));
        }
    }
    (value, None)
}

fn is_local_setup_host(host: &str) -> bool {
    let host = host.trim().trim_matches('.');
    if host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" {
        return true;
    }
    local_lan_ip().map(|ip| host == ip).unwrap_or(false)
}

fn path_without_query(value: &str) -> String {
    value.split('?').next().unwrap_or("/").to_string()
}

fn mobile_setup_html(lan_ip: &str, proxy_port: u16, base_url: &str) -> String {
    let cert_url = format!("{base_url}/cert/ca.crt");
    let ios_profile_url = format!("{base_url}/ios.mobileconfig");
    let pac_url = format!("{base_url}/proxy.pac");
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HeavenEye Agent Mobile Setup</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; background: #f5f8fb; color: #172233; }}
    main {{ max-width: 760px; margin: 0 auto; padding: 24px 18px 40px; }}
    h1 {{ margin: 0 0 8px; font-size: 28px; line-height: 1.2; }}
    h2 {{ margin: 22px 0 10px; font-size: 18px; }}
    p, li {{ color: #526173; font-size: 15px; line-height: 1.65; }}
    .hero, section {{ border: 1px solid #d8e2ed; border-radius: 10px; background: #fff; padding: 18px; }}
    .hero {{ border-color: #8fd4c2; }}
    code {{ display: inline-block; padding: 2px 6px; border-radius: 6px; background: #edf3f8; color: #0f1724; font-weight: 700; }}
    a.button {{ display: inline-flex; margin: 6px 8px 6px 0; padding: 10px 12px; border-radius: 8px; background: #078663; color: #fff; text-decoration: none; font-weight: 800; }}
    a.secondary {{ background: #eaf1f7; color: #182335; border: 1px solid #d8e2ed; }}
    .warn {{ border-color: #f1c36d; background: #fff8e8; }}
  </style>
</head>
<body>
  <main>
    <div class="hero">
      <h1>手机抓包配置</h1>
      <p>电脑和手机需要在同一个 Wi-Fi。把手机 Wi-Fi 的 HTTP 代理设为手动，服务器填 <code>{lan_ip}</code>，端口填 <code>{proxy_port}</code>。</p>
      <a class="button" href="{cert_url}">下载 CA 证书</a>
      <a class="button secondary" href="{ios_profile_url}">iOS 描述文件</a>
      <a class="button secondary" href="{pac_url}">PAC 地址</a>
    </div>

    <section>
      <h2>iOS</h2>
      <ol>
        <li>点“iOS 描述文件”安装 CA 证书配置。</li>
        <li>到设置里完成描述文件安装，并在“关于本机 > 证书信任设置”里信任 HeavenEye Agent CA。</li>
        <li>打开当前 Wi-Fi，HTTP 代理选择“手动”，服务器 <code>{lan_ip}</code>，端口 <code>{proxy_port}</code>。</li>
      </ol>
    </section>

    <section>
      <h2>Android</h2>
      <ol>
        <li>点“下载 CA 证书”，按系统提示安装为 CA 证书。</li>
        <li>编辑当前 Wi-Fi，代理选择“手动”，主机 <code>{lan_ip}</code>，端口 <code>{proxy_port}</code>。</li>
        <li>Android 7+ App 默认可能不信任用户安装的 CA；这与 Charles 一致，需要 App 显式信任用户证书或使用测试包。</li>
      </ol>
    </section>

    <section class="warn">
      <h2>边界</h2>
      <p>这里对齐 Charles 的显式 HTTP/HTTPS 代理能力。QUIC/HTTP3、UDP、强证书 pinning、系统代理绕过的 App 不在当前模式覆盖范围内。</p>
    </section>
  </main>
</body>
</html>"#
    )
}

fn mobile_cert_bytes(config: &AppConfig) -> Result<Vec<u8>, String> {
    let cert_service = CertificateService::new(config);
    let cert_info = cert_service.ensure_root_certificate()?;
    fs::read(cert_info.cert_path).map_err(|error| error.to_string())
}

fn ios_mobileconfig(config: &AppConfig) -> Result<String, String> {
    let cert_pem =
        String::from_utf8(mobile_cert_bytes(config)?).map_err(|error| error.to_string())?;
    let cert_base64 = cert_pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .map(str::trim)
        .collect::<String>();
    let stamp = now_millis();
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>heaveneye-agent-ca.crt</string>
      <key>PayloadContent</key>
      <data>{cert_base64}</data>
      <key>PayloadDescription</key>
      <string>Installs the HeavenEye Agent root CA for HTTPS debugging.</string>
      <key>PayloadDisplayName</key>
      <string>HeavenEye Agent CA</string>
      <key>PayloadIdentifier</key>
      <string>dev.heaveneye.agent.ca.{stamp}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>DPA-CA-{stamp}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>HeavenEye Agent certificate profile. Configure Wi-Fi HTTP proxy manually to this Mac.</string>
  <key>PayloadDisplayName</key>
  <string>HeavenEye Agent Proxy Certificate</string>
  <key>PayloadIdentifier</key>
  <string>dev.heaveneye.agent.mobile.{stamp}</string>
  <key>PayloadOrganization</key>
  <string>HeavenEye Agent</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>DPA-MOBILE-{stamp}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"#
    ))
}

fn local_lan_ip() -> Option<String> {
    if let Some(ip) = platform_lan_ip() {
        return Some(ip);
    }

    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if is_usable_ipv4(ip.octets()) => Some(ip.to_string()),
        IpAddr::V6(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn platform_lan_ip() -> Option<String> {
    let mut interfaces = Vec::new();
    if let Some(default_interface) = macos_default_interface() {
        interfaces.push(default_interface);
    }
    for iface in ["en0", "en1", "en2", "en3", "bridge100"] {
        if !interfaces.iter().any(|item| item == iface) {
            interfaces.push(iface.to_string());
        }
    }

    let mut fallback = None;
    for iface in interfaces {
        let output = Command::new("ipconfig")
            .args(["getifaddr", iface.as_str()])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if is_private_lan_ip(&ip) {
            return Some(ip);
        }
        if fallback.is_none() && is_usable_ip_text(&ip) {
            fallback = Some(ip);
        }
    }
    fallback
}

#[cfg(not(target_os = "macos"))]
fn platform_lan_ip() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn macos_default_interface() -> Option<String> {
    let output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("interface:")
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn is_private_lan_ip(value: &str) -> bool {
    let Ok(IpAddr::V4(ip)) = value.parse::<IpAddr>() else {
        return false;
    };
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn is_usable_ip_text(value: &str) -> bool {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_usable_ipv4(ip.octets()),
        Ok(IpAddr::V6(ip)) => !ip.is_loopback() && !ip.is_unspecified(),
        Err(_) => false,
    }
}

fn is_usable_ipv4(octets: [u8; 4]) -> bool {
    if octets[0] == 0 || octets[0] == 127 || (octets[0] == 169 && octets[1] == 254) {
        return false;
    }
    if octets[0] == 198 && (octets[1] == 18 || octets[1] == 19) {
        return false;
    }
    true
}

fn capture_source(client_addr: Option<SocketAddr>) -> String {
    match client_addr.map(|addr| addr.ip()) {
        Some(ip) if ip.is_loopback() => "proxy".into(),
        Some(ip) => format!("mobile:{ip}"),
        None => "proxy".into(),
    }
}

fn client_address(client_addr: Option<SocketAddr>) -> Option<String> {
    client_addr.map(|addr| addr.to_string())
}

fn handle_connect(
    request: ParsedRequest,
    mut client_stream: TcpStream,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    config: AppConfig,
    client_addr: Option<SocketAddr>,
) -> Result<(), String> {
    let started_at = now_millis();
    let (host, port) = split_host_port(&request.target, 443)?;
    let capture_hosts_snapshot = capture_hosts
        .lock()
        .expect("capture hosts mutex poisoned")
        .clone();
    let should_capture = should_capture_host(&host, &capture_hosts_snapshot);
    let should_mitm = should_mitm_host(&host, &capture_hosts_snapshot);
    let mut tags = vec!["encrypted-tunnel".to_string()];
    if should_capture && !should_mitm && should_bypass_mitm_host(&host) {
        tags.push("mitm-bypass".into());
    }

    if should_mitm {
        let cert_service = CertificateService::new(&config);
        match cert_service.ensure_host_certificate(&host) {
            Ok(host_cert) => {
                tags.push("mitm-ready".into());
                client_stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .map_err(|error| error.to_string())?;
                return handle_tls_mitm_connection(
                    request,
                    client_stream,
                    flows,
                    capture_hosts,
                    rules,
                    weak_network,
                    breakpoints,
                    host,
                    port,
                    started_at,
                    tags,
                    host_cert,
                    client_addr,
                );
            }
            Err(error) => {
                tags.push("mitm-cert-error".into());
                if should_capture {
                    push_flow(
                        &flows,
                        CaptureFlow {
                            id: next_flow_id(),
                            started_at,
                            completed_at: Some(now_millis()),
                            method: "CONNECT".into(),
                            scheme: "https".into(),
                            host: host.clone(),
                            port: Some(port),
                            path: "/".into(),
                            query: String::new(),
                            status_code: Some(502),
                            protocol: "CONNECT".into(),
                            source: capture_source(client_addr),
                            client_address: client_address(client_addr),
                            duration_ms: Some(now_millis().saturating_sub(started_at)),
                            request_headers: request.headers.clone(),
                            response_headers: HashMap::new(),
                            request_body_preview: String::new(),
                            request_body_path: None,
                            request_body_text_path: None,
                            request_body_preview_truncated: false,
                            request_body_decoded_size: 0,
                            request_body_replay_size: 0,
                            response_body_preview: error.clone(),
                            response_body_text_path: None,
                            response_body_preview_truncated: false,
                            response_body_decoded_size: 0,
                            request_size: 0,
                            response_size: 0,
                            error_type: "mitm_setup_error".into(),
                            tags: tags.clone(),
                        },
                    );
                }
                let _ = client_stream.write_all(
                    format!(
                        "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n{error}"
                    )
                    .as_bytes(),
                );
                return Err(error);
            }
        }
    }

    match TcpStream::connect((host.as_str(), port)) {
        Ok(upstream_stream) => {
            client_stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .map_err(|error| error.to_string())?;

            let mut client_reader = client_stream
                .try_clone()
                .map_err(|error| error.to_string())?;
            let mut client_writer = client_stream;
            let mut upstream_reader = upstream_stream
                .try_clone()
                .map_err(|error| error.to_string())?;
            let mut upstream_writer = upstream_stream;

            let upstream_to_client = thread::spawn(move || {
                let _ = std::io::copy(&mut upstream_reader, &mut client_writer);
                let _ = client_writer.shutdown(Shutdown::Write);
            });
            let client_to_upstream = thread::spawn(move || {
                let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
                let _ = upstream_writer.shutdown(Shutdown::Write);
            });

            let _ = upstream_to_client.join();
            let _ = client_to_upstream.join();

            if should_capture {
                push_flow(
                    &flows,
                    CaptureFlow {
                        id: next_flow_id(),
                        started_at,
                        completed_at: Some(now_millis()),
                        method: "CONNECT".into(),
                        scheme: "https".into(),
                        host,
                        port: Some(port),
                        path: "/".into(),
                        query: String::new(),
                        status_code: Some(200),
                        protocol: "CONNECT".into(),
                        source: capture_source(client_addr),
                        client_address: client_address(client_addr),
                        duration_ms: Some(now_millis().saturating_sub(started_at)),
                        request_headers: request.headers,
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
                        tags: tags.clone(),
                    },
                );
            }
            Ok(())
        }
        Err(error) => {
            let _ = client_stream.write_all(
                format!(
                    "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n{}",
                    error
                )
                .as_bytes(),
            );
            if should_capture {
                push_flow(
                    &flows,
                    CaptureFlow {
                        id: next_flow_id(),
                        started_at,
                        completed_at: Some(now_millis()),
                        method: "CONNECT".into(),
                        scheme: "https".into(),
                        host,
                        port: Some(port),
                        path: "/".into(),
                        query: String::new(),
                        status_code: Some(502),
                        protocol: "CONNECT".into(),
                        source: capture_source(client_addr),
                        client_address: client_address(client_addr),
                        duration_ms: Some(now_millis().saturating_sub(started_at)),
                        request_headers: request.headers,
                        response_headers: HashMap::new(),
                        request_body_preview: String::new(),
                        request_body_path: None,
                        request_body_text_path: None,
                        request_body_preview_truncated: false,
                        request_body_decoded_size: 0,
                        request_body_replay_size: 0,
                        response_body_preview: error.to_string(),
                        response_body_text_path: None,
                        response_body_preview_truncated: false,
                        response_body_decoded_size: error.to_string().len() as u64,
                        request_size: 0,
                        response_size: 0,
                        error_type: "connect_error".into(),
                        tags,
                    },
                );
            }
            Err(error.to_string())
        }
    }
}

fn handle_forward_http(
    request: ParsedRequest,
    mut client_stream: TcpStream,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    client_addr: Option<SocketAddr>,
) -> Result<(), String> {
    let started_at = now_millis();
    let flow_id = next_flow_id();
    let target_url = build_target_url(&request)?;
    let host = target_url
        .host_str()
        .ok_or_else(|| "missing target host".to_string())?
        .to_string();
    let port = target_url.port_or_known_default().unwrap_or(80);
    let should_capture = should_capture_host(
        &host,
        &capture_hosts
            .lock()
            .expect("capture hosts mutex poisoned")
            .clone(),
    );
    let request_headers = normalize_headers(&request.headers);
    let request_preview = buffer_preview(
        &request.body,
        &request_headers,
        request_body_encoding_from_url(&target_url),
    );
    let request_body_path = store_replay_body(&request.body);
    let request_body_replay_size = if request_body_path.is_some() {
        request.body.len() as u64
    } else {
        0
    };
    if is_websocket_upgrade(&request_headers) {
        match proxy_websocket_plain(request.clone(), &mut client_stream, &target_url) {
            Ok(capture) => {
                if should_capture {
                    let mut response_headers = capture.response_headers.clone();
                    response_headers.insert(
                        "x-heaveneye-websocket-bytes".into(),
                        format!(
                            "client={} server={}",
                            capture.client_to_server_bytes, capture.server_to_client_bytes
                        ),
                    );
                    push_flow(
                        &flows,
                        CaptureFlow {
                            id: flow_id,
                            started_at,
                            completed_at: Some(now_millis()),
                            method: "WS".into(),
                            scheme: target_url.scheme().to_string(),
                            host,
                            port: Some(port),
                            path: target_url.path().to_string(),
                            query: target_url
                                .query()
                                .map(|query| format!("?{query}"))
                                .unwrap_or_default(),
                            status_code: Some(capture.status_code),
                            protocol: "WebSocket".into(),
                            source: capture_source(client_addr),
                            client_address: client_address(client_addr),
                            duration_ms: Some(now_millis().saturating_sub(started_at)),
                            request_headers,
                            response_headers,
                            request_body_preview: request_preview.preview,
                            request_body_path,
                            request_body_text_path: request_preview.text_body_path,
                            request_body_preview_truncated: request_preview.preview_truncated,
                            request_body_decoded_size: request_preview.decoded_size as u64,
                            request_body_replay_size,
                            response_body_preview: capture.response_body_preview,
                            response_body_text_path: None,
                            response_body_preview_truncated: false,
                            response_body_decoded_size: capture.response_size,
                            request_size: request_preview.size as u64,
                            response_size: capture.response_size,
                            error_type: capture.error_type,
                            tags: capture.tags,
                        },
                    );
                }
                return Ok(());
            }
            Err(error) => {
                let _ = client_stream.write_all(
                    format!("HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n{error}")
                        .as_bytes(),
                );
                return Err(error);
            }
        }
    }

    let mut base_tags = Vec::new();
    let mut intercepted_error_type = String::new();

    let control = match apply_request_controls(
        &request,
        &target_url,
        &request_headers,
        &request_preview.preview,
        &flow_id,
        &rules,
        &weak_network,
        &breakpoints,
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            base_tags.push("weak-network".into());
            base_tags.push("drop".into());
            RequestControlOutcome::Respond(InterceptedResponse {
                response_bytes: build_http_response_bytes(
                    599,
                    &HashMap::from([("content-type".into(), "text/plain; charset=utf-8".into())]),
                    error.as_bytes(),
                ),
                tags: Vec::new(),
                error_type: "weak_network_drop".into(),
            })
        }
    };

    let upstream_result = match control {
        RequestControlOutcome::Respond(intercepted) => {
            intercepted_error_type = intercepted.error_type;
            base_tags.extend(intercepted.tags);
            Ok(intercepted.response_bytes)
        }
        RequestControlOutcome::Forward(forward) => {
            base_tags.extend(forward.tags);
            apply_weak_network_before_upstream(&weak_network);
            forward_http_request(&forward.request, &forward.target_url)
        }
    };
    match upstream_result {
        Ok(response_bytes) => {
            let response_control = apply_response_controls(
                &target_url,
                &request.method,
                &flow_id,
                response_bytes,
                &rules,
                &breakpoints,
            )?;
            base_tags.extend(response_control.tags);
            if !response_control.error_type.is_empty() {
                intercepted_error_type = response_control.error_type;
            }
            apply_weak_network_after_response(
                &weak_network,
                response_control.response_bytes.len() as u64,
            );
            client_stream
                .write_all(&response_control.response_bytes)
                .map_err(|error| error.to_string())?;
            let parsed_response = parse_http_response(&response_control.response_bytes)?;
            let response_preview = buffer_preview(
                &parsed_response.body,
                &parsed_response.headers,
                parsed_response
                    .headers
                    .get("content-encoding")
                    .cloned()
                    .unwrap_or_default(),
            );
            base_tags.extend(body_storage_tags(&request_preview, "request"));
            base_tags.extend(body_storage_tags(&response_preview, "response"));

            if should_capture {
                push_flow(
                    &flows,
                    CaptureFlow {
                        id: flow_id,
                        started_at,
                        completed_at: Some(now_millis()),
                        method: request.method.clone(),
                        scheme: target_url.scheme().to_string(),
                        host,
                        port: Some(port),
                        path: target_url.path().to_string(),
                        query: target_url
                            .query()
                            .map(|query| format!("?{query}"))
                            .unwrap_or_default(),
                        status_code: Some(parsed_response.status_code),
                        protocol: request.version.clone(),
                        source: capture_source(client_addr),
                        client_address: client_address(client_addr),
                        duration_ms: Some(now_millis().saturating_sub(started_at)),
                        request_headers,
                        response_headers: parsed_response.headers.clone(),
                        request_body_preview: request_preview.preview,
                        request_body_path: request_body_path.clone(),
                        request_body_text_path: request_preview.text_body_path.clone(),
                        request_body_preview_truncated: request_preview.preview_truncated,
                        request_body_decoded_size: request_preview.decoded_size as u64,
                        request_body_replay_size,
                        response_body_preview: response_preview.preview,
                        response_body_text_path: response_preview.text_body_path,
                        response_body_preview_truncated: response_preview.preview_truncated,
                        response_body_decoded_size: response_preview.decoded_size as u64,
                        request_size: request_preview.size as u64,
                        response_size: response_preview.size as u64,
                        error_type: if !intercepted_error_type.is_empty() {
                            intercepted_error_type
                        } else if parsed_response.status_code >= 400 {
                            "http_error".into()
                        } else {
                            String::new()
                        },
                        tags: base_tags,
                    },
                );
            }
            Ok(())
        }
        Err(error) => {
            let _ = client_stream.write_all(
                format!("HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n{error}")
                    .as_bytes(),
            );
            if should_capture {
                push_flow(
                    &flows,
                    CaptureFlow {
                        id: flow_id,
                        started_at,
                        completed_at: Some(now_millis()),
                        method: request.method.clone(),
                        scheme: target_url.scheme().to_string(),
                        host,
                        port: Some(port),
                        path: target_url.path().to_string(),
                        query: target_url
                            .query()
                            .map(|query| format!("?{query}"))
                            .unwrap_or_default(),
                        status_code: Some(502),
                        protocol: request.version.clone(),
                        source: capture_source(client_addr),
                        client_address: client_address(client_addr),
                        duration_ms: Some(now_millis().saturating_sub(started_at)),
                        request_headers,
                        response_headers: HashMap::new(),
                        request_body_preview: request_preview.preview,
                        request_body_path,
                        request_body_text_path: request_preview.text_body_path,
                        request_body_preview_truncated: request_preview.preview_truncated,
                        request_body_decoded_size: request_preview.decoded_size as u64,
                        request_body_replay_size,
                        response_body_preview: error.clone(),
                        response_body_text_path: None,
                        response_body_preview_truncated: false,
                        response_body_decoded_size: error.len() as u64,
                        request_size: request_preview.size as u64,
                        response_size: 0,
                        error_type: "proxy_error".into(),
                        tags: base_tags,
                    },
                );
            }
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_mitm_failure_flow_if_needed(
    flows: &Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: &Arc<Mutex<Vec<String>>>,
    connect_request: &ParsedRequest,
    host: &str,
    port: u16,
    started_at: u64,
    error_type: &str,
    error: &str,
    mut tags: Vec<String>,
    client_addr: Option<SocketAddr>,
) {
    if !should_capture_host(
        host,
        &capture_hosts.lock().expect("capture hosts mutex poisoned"),
    ) {
        return;
    }

    tags.push(error_type.replace('_', "-"));
    let hint = format!(
        "{error}\n\nHTTPS MITM failed before decrypted request headers were available.\n\
         常见原因：手机没有完整信任 HeavenEye Agent CA；Android 7+ App 默认不信任用户安装的 CA；App 做了证书 pinning；或 App 使用 QUIC/HTTP3/UDP 绕过显式 HTTP 代理。"
    );
    push_flow(
        flows,
        CaptureFlow {
            id: next_flow_id(),
            started_at,
            completed_at: Some(now_millis()),
            method: "CONNECT".into(),
            scheme: "https".into(),
            host: host.to_string(),
            port: Some(port),
            path: "/".into(),
            query: String::new(),
            status_code: Some(495),
            protocol: "CONNECT".into(),
            source: capture_source(client_addr),
            client_address: client_address(client_addr),
            duration_ms: Some(now_millis().saturating_sub(started_at)),
            request_headers: connect_request.headers.clone(),
            response_headers: HashMap::new(),
            request_body_preview: String::new(),
            request_body_path: None,
            request_body_text_path: None,
            request_body_preview_truncated: false,
            request_body_decoded_size: 0,
            request_body_replay_size: 0,
            response_body_preview: hint.clone(),
            response_body_text_path: None,
            response_body_preview_truncated: false,
            response_body_decoded_size: hint.len() as u64,
            request_size: 0,
            response_size: 0,
            error_type: error_type.into(),
            tags,
        },
    );
}

fn handle_tls_mitm_connection(
    connect_request: ParsedRequest,
    client_stream: TcpStream,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    host: String,
    port: u16,
    started_at: u64,
    tags: Vec<String>,
    host_cert: crate::certs::HostCertificateInfo,
    client_addr: Option<SocketAddr>,
) -> Result<(), String> {
    let server_config = match load_server_config(&host_cert) {
        Ok(config) => Arc::new(config),
        Err(error) => {
            push_mitm_failure_flow_if_needed(
                &flows,
                &capture_hosts,
                &connect_request,
                &host,
                port,
                started_at,
                "mitm_config_error",
                error.as_str(),
                tags.clone(),
                client_addr,
            );
            return Err(error);
        }
    };
    let server_connection =
        ServerConnection::new(server_config).map_err(|error| error.to_string())?;
    let mut tls_stream = StreamOwned::new(server_connection, client_stream);
    if let Err(error) = complete_tls_handshake(&mut tls_stream) {
        let _ = tls_stream.sock.shutdown(Shutdown::Both);
        push_mitm_failure_flow_if_needed(
            &flows,
            &capture_hosts,
            &connect_request,
            &host,
            port,
            started_at,
            "tls_handshake_error",
            error.as_str(),
            tags.clone(),
            client_addr,
        );
        return Err(error);
    }
    let negotiated_protocol = tls_stream
        .conn
        .alpn_protocol()
        .map(|value| String::from_utf8_lossy(value).to_string())
        .unwrap_or_else(|| "http/1.1".to_string());
    if negotiated_protocol == "h2" {
        return handle_h2_mitm_connection(
            tls_stream,
            flows,
            capture_hosts,
            rules,
            weak_network,
            breakpoints,
            host,
            port,
            tags,
            client_addr,
        );
    }
    let _ = (&host_cert.cert_path, &host_cert.key_path);
    let tunnel_started_at = started_at;
    let mut saw_request = false;

    loop {
        let request_started_at = if saw_request {
            now_millis()
        } else {
            tunnel_started_at
        };
        let request = match read_http_request(&mut tls_stream) {
            Ok(request) => {
                saw_request = true;
                request
            }
            Err(error) if saw_request && is_connection_closed_error(&error) => break,
            Err(error) => {
                let _ = tls_stream.sock.shutdown(Shutdown::Both);
                return Err(error);
            }
        };

        let target_url = build_target_url_for_scheme(&request, "https", &host)?;
        let request_headers = normalize_headers(&request.headers);
        let request_preview = buffer_preview(
            &request.body,
            &request_headers,
            request_body_encoding_from_url(&target_url),
        );
        let request_body_path = store_replay_body(&request.body);
        let request_body_replay_size = if request_body_path.is_some() {
            request.body.len() as u64
        } else {
            0
        };
        let flow_id = next_flow_id();

        if is_websocket_upgrade(&request_headers) {
            let capture = proxy_websocket_tls(&request, &mut tls_stream, &target_url)?;
            let mut flow_tags = tags.clone();
            flow_tags.extend(capture.tags);
            flow_tags.push("ssl-decrypted".into());
            if should_capture_host(
                &host,
                &capture_hosts.lock().expect("capture hosts mutex poisoned"),
            ) {
                let mut response_headers = capture.response_headers.clone();
                response_headers.insert(
                    "x-heaveneye-websocket-bytes".into(),
                    format!(
                        "client={} server={}",
                        capture.client_to_server_bytes, capture.server_to_client_bytes
                    ),
                );
                push_flow(
                    &flows,
                    CaptureFlow {
                        id: flow_id,
                        started_at: request_started_at,
                        completed_at: Some(now_millis()),
                        method: "WSS".into(),
                        scheme: "https".into(),
                        host: host.clone(),
                        port: Some(port),
                        path: target_url.path().to_string(),
                        query: target_url
                            .query()
                            .map(|query| format!("?{query}"))
                            .unwrap_or_default(),
                        status_code: Some(capture.status_code),
                        protocol: "WebSocket".into(),
                        source: capture_source(client_addr),
                        client_address: client_address(client_addr),
                        duration_ms: Some(now_millis().saturating_sub(request_started_at)),
                        request_headers,
                        response_headers,
                        request_body_preview: request_preview.preview,
                        request_body_path,
                        request_body_text_path: request_preview.text_body_path,
                        request_body_preview_truncated: request_preview.preview_truncated,
                        request_body_decoded_size: request_preview.decoded_size as u64,
                        request_body_replay_size,
                        response_body_preview: capture.response_body_preview,
                        response_body_text_path: None,
                        response_body_preview_truncated: false,
                        response_body_decoded_size: capture.response_size,
                        request_size: request_preview.size as u64,
                        response_size: capture.response_size,
                        error_type: capture.error_type,
                        tags: flow_tags,
                    },
                );
            }
            break;
        }

        let mut flow_tags = tags.clone();
        let mut intercepted_error_type = String::new();
        let control = match apply_request_controls(
            &request,
            &target_url,
            &request_headers,
            &request_preview.preview,
            &flow_id,
            &rules,
            &weak_network,
            &breakpoints,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                flow_tags.push("weak-network".into());
                flow_tags.push("drop".into());
                intercepted_error_type = "weak_network_drop".into();
                RequestControlOutcome::Respond(InterceptedResponse {
                    response_bytes: build_http_response_bytes(
                        599,
                        &HashMap::from([(
                            "content-type".into(),
                            "text/plain; charset=utf-8".into(),
                        )]),
                        error.as_bytes(),
                    ),
                    tags: Vec::new(),
                    error_type: String::new(),
                })
            }
        };
        let response_bytes = match control {
            RequestControlOutcome::Respond(intercepted) => {
                intercepted_error_type = intercepted.error_type;
                flow_tags.extend(intercepted.tags);
                intercepted.response_bytes
            }
            RequestControlOutcome::Forward(forward) => {
                flow_tags.extend(forward.tags);
                apply_weak_network_before_upstream(&weak_network);
                forward_https_request(&forward.request, &forward.target_url)?
            }
        };
        let response_control = apply_response_controls(
            &target_url,
            &request.method,
            &flow_id,
            response_bytes,
            &rules,
            &breakpoints,
        )?;
        flow_tags.extend(response_control.tags);
        if !response_control.error_type.is_empty() {
            intercepted_error_type = response_control.error_type;
        }
        apply_weak_network_after_response(
            &weak_network,
            response_control.response_bytes.len() as u64,
        );
        let parsed_response = parse_http_response(&response_control.response_bytes)?;
        let response_preview = buffer_preview(
            &parsed_response.body,
            &parsed_response.headers,
            parsed_response
                .headers
                .get("content-encoding")
                .cloned()
                .unwrap_or_default(),
        );
        flow_tags.extend(body_storage_tags(&request_preview, "request"));
        flow_tags.extend(body_storage_tags(&response_preview, "response"));

        tls_stream
            .write_all(&response_control.response_bytes)
            .map_err(|error| error.to_string())?;
        let _ = tls_stream.flush();

        flow_tags.push("ssl-decrypted".into());
        if request_wants_close(&request) {
            flow_tags.push("client-close".into());
        }
        if should_capture_host(
            &host,
            &capture_hosts.lock().expect("capture hosts mutex poisoned"),
        ) {
            push_flow(
                &flows,
                CaptureFlow {
                    id: flow_id,
                    started_at: request_started_at,
                    completed_at: Some(now_millis()),
                    method: request.method.clone(),
                    scheme: "https".into(),
                    host: host.clone(),
                    port: Some(port),
                    path: target_url.path().to_string(),
                    query: target_url
                        .query()
                        .map(|query| format!("?{query}"))
                        .unwrap_or_default(),
                    status_code: Some(parsed_response.status_code),
                    protocol: request.version.clone(),
                    source: capture_source(client_addr),
                    client_address: client_address(client_addr),
                    duration_ms: Some(now_millis().saturating_sub(request_started_at)),
                    request_headers,
                    response_headers: parsed_response.headers.clone(),
                    request_body_preview: request_preview.preview,
                    request_body_path,
                    request_body_text_path: request_preview.text_body_path,
                    request_body_preview_truncated: request_preview.preview_truncated,
                    request_body_decoded_size: request_preview.decoded_size as u64,
                    request_body_replay_size,
                    response_body_preview: response_preview.preview,
                    response_body_text_path: response_preview.text_body_path,
                    response_body_preview_truncated: response_preview.preview_truncated,
                    response_body_decoded_size: response_preview.decoded_size as u64,
                    request_size: request_preview.size as u64,
                    response_size: response_preview.size as u64,
                    error_type: if !intercepted_error_type.is_empty() {
                        intercepted_error_type
                    } else if parsed_response.status_code >= 400 {
                        "http_error".into()
                    } else {
                        String::new()
                    },
                    tags: flow_tags,
                },
            );
        }

        if request_wants_close(&request) {
            break;
        }
    }

    let _ = tls_stream.sock.shutdown(Shutdown::Both);
    Ok(())
}

fn handle_h2_mitm_connection(
    tls_stream: StreamOwned<ServerConnection, TcpStream>,
    flows: Arc<Mutex<Vec<CaptureFlow>>>,
    capture_hosts: Arc<Mutex<Vec<String>>>,
    rules: Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: BreakpointRegistry,
    host: String,
    port: u16,
    tags: Vec<String>,
    client_addr: Option<SocketAddr>,
) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(|error| error.to_string())?;

    runtime.block_on(async move {
        let io = BlockingTlsStream::new(tls_stream);
        let mut connection = server::handshake(io)
            .await
            .map_err(|error| error.to_string())?;

        while let Some(result) = connection.accept().await {
            let (request, mut respond) = result.map_err(|error| error.to_string())?;
            let stream_started_at = now_millis();
            let method = request.method().as_str().to_string();
            let target_url = build_h2_target_url(&request, &host, port)?;
            let request_headers = normalize_http_header_map(request.headers());
            let request_body_chunks = read_h2_body(request.into_body()).await?;
            let request_body_bytes = request_body_chunks.concat();
            let request_body = buffer_preview(
                &request_body_bytes,
                &request_headers,
                request_body_encoding_from_url(&target_url),
            );
            let request_body_path = store_replay_body(&request_body_bytes);
            let request_body_replay_size = if request_body_path.is_some() {
                request_body_bytes.len() as u64
            } else {
                0
            };
            let flow_id = next_flow_id();
            let control_request = ParsedRequest {
                method: method.clone(),
                target: target_url.to_string(),
                version: "HTTP/2".into(),
                headers: strip_http2_request_headers(&request_headers),
                body: request_body_bytes.clone(),
            };
            let mut base_tags = tags.clone();
            let mut intercepted_error_type = String::new();

            let control = match apply_request_controls(
                &control_request,
                &target_url,
                &request_headers,
                &request_body.preview,
                &flow_id,
                &rules,
                &weak_network,
                &breakpoints,
            ) {
                Ok(outcome) => outcome,
                Err(error) => {
                    base_tags.push("weak-network".into());
                    base_tags.push("drop".into());
                    intercepted_error_type = "weak_network_drop".into();
                    RequestControlOutcome::Respond(InterceptedResponse {
                        response_bytes: build_http_response_bytes(
                            599,
                            &HashMap::from([(
                                "content-type".into(),
                                "text/plain; charset=utf-8".into(),
                            )]),
                            error.as_bytes(),
                        ),
                        tags: Vec::new(),
                        error_type: String::new(),
                    })
                }
            };

            let upstream_result = match control {
                RequestControlOutcome::Respond(intercepted) => {
                    intercepted_error_type = intercepted.error_type;
                    base_tags.extend(intercepted.tags);
                    Ok(intercepted.response_bytes)
                }
                RequestControlOutcome::Forward(forward) => {
                    base_tags.extend(forward.tags);
                    apply_weak_network_before_upstream(&weak_network);
                    if forward.request.version == "HTTP/2" {
                        forward_h2_upstream(
                            &method,
                            &target_url,
                            &request_headers,
                            &request_body_chunks,
                        )
                    } else if forward.target_url.scheme() == "https" {
                        forward_https_request(&forward.request, &forward.target_url)
                    } else {
                        forward_http_request(&forward.request, &forward.target_url)
                    }
                }
            };

            match upstream_result {
                Ok(response) => {
                    let response_control = apply_response_controls(
                        &target_url,
                        &method,
                        &flow_id,
                        response,
                        &rules,
                        &breakpoints,
                    )?;
                    base_tags.extend(response_control.tags);
                    if !response_control.error_type.is_empty() {
                        intercepted_error_type = response_control.error_type;
                    }
                    apply_weak_network_after_response(
                        &weak_network,
                        response_control.response_bytes.len() as u64,
                    );
                    let parsed_response = parse_http_response(&response_control.response_bytes)?;
                    let response_preview = buffer_preview(
                        &parsed_response.body,
                        &parsed_response.headers,
                        parsed_response
                            .headers
                            .get("content-encoding")
                            .cloned()
                            .unwrap_or_default(),
                    );
                    base_tags.extend(body_storage_tags(&request_body, "request"));
                    base_tags.extend(body_storage_tags(&response_preview, "response"));

                    let response_head = build_h2_response_head(
                        parsed_response.status_code,
                        &parsed_response.headers,
                    )?;
                    let end_stream = parsed_response.body.is_empty();
                    let mut send_stream = respond
                        .send_response(response_head, end_stream)
                        .map_err(|error| error.to_string())?;
                    if !end_stream {
                        send_stream
                            .send_data(Bytes::from(parsed_response.body.clone()), true)
                            .map_err(|error| error.to_string())?;
                    }

                    let mut flow_tags = base_tags;
                    flow_tags.push("ssl-decrypted".into());
                    flow_tags.push("h2".into());
                    let flow_host = target_url.host_str().unwrap_or(&host).to_string();
                    if should_capture_host(
                        &flow_host,
                        &capture_hosts.lock().expect("capture hosts mutex poisoned"),
                    ) {
                        push_flow(
                            &flows,
                            CaptureFlow {
                                id: flow_id,
                                started_at: stream_started_at,
                                completed_at: Some(now_millis()),
                                method: method.clone(),
                                scheme: "https".into(),
                                host: flow_host,
                                port: Some(target_url.port_or_known_default().unwrap_or(443)),
                                path: target_url.path().to_string(),
                                query: target_url
                                    .query()
                                    .map(|query| format!("?{query}"))
                                    .unwrap_or_default(),
                                status_code: Some(parsed_response.status_code),
                                protocol: "HTTP/2".into(),
                                source: capture_source(client_addr),
                                client_address: client_address(client_addr),
                                duration_ms: Some(now_millis().saturating_sub(stream_started_at)),
                                request_headers,
                                response_headers: parsed_response.headers.clone(),
                                request_body_preview: request_body.preview,
                                request_body_path: request_body_path.clone(),
                                request_body_text_path: request_body.text_body_path.clone(),
                                request_body_preview_truncated: request_body.preview_truncated,
                                request_body_decoded_size: request_body.decoded_size as u64,
                                request_body_replay_size,
                                response_body_preview: response_preview.preview,
                                response_body_text_path: response_preview.text_body_path,
                                response_body_preview_truncated: response_preview.preview_truncated,
                                response_body_decoded_size: response_preview.decoded_size as u64,
                                request_size: request_body.size as u64,
                                response_size: response_preview.size as u64,
                                error_type: if !intercepted_error_type.is_empty() {
                                    intercepted_error_type
                                } else if parsed_response.status_code >= 400 {
                                    "http_error".into()
                                } else {
                                    String::new()
                                },
                                tags: flow_tags,
                            },
                        );
                    }
                }
                Err(error) => {
                    let response = http::Response::builder()
                        .status(502)
                        .header("content-type", "text/plain; charset=utf-8")
                        .body(())
                        .map_err(|build_error| build_error.to_string())?;
                    let mut send_stream = respond
                        .send_response(response, false)
                        .map_err(|respond_error| respond_error.to_string())?;
                    send_stream
                        .send_data(Bytes::from(error.clone()), true)
                        .map_err(|send_error| send_error.to_string())?;

                    let mut flow_tags = base_tags;
                    flow_tags.push("ssl-decrypted".into());
                    flow_tags.push("h2".into());
                    let flow_host = target_url.host_str().unwrap_or(&host).to_string();
                    if should_capture_host(
                        &flow_host,
                        &capture_hosts.lock().expect("capture hosts mutex poisoned"),
                    ) {
                        push_flow(
                            &flows,
                            CaptureFlow {
                                id: flow_id,
                                started_at: stream_started_at,
                                completed_at: Some(now_millis()),
                                method: method.clone(),
                                scheme: "https".into(),
                                host: flow_host,
                                port: Some(target_url.port_or_known_default().unwrap_or(443)),
                                path: target_url.path().to_string(),
                                query: target_url
                                    .query()
                                    .map(|query| format!("?{query}"))
                                    .unwrap_or_default(),
                                status_code: Some(502),
                                protocol: "HTTP/2".into(),
                                source: capture_source(client_addr),
                                client_address: client_address(client_addr),
                                duration_ms: Some(now_millis().saturating_sub(stream_started_at)),
                                request_headers,
                                response_headers: HashMap::new(),
                                request_body_preview: request_body.preview,
                                request_body_path,
                                request_body_text_path: request_body.text_body_path,
                                request_body_preview_truncated: request_body.preview_truncated,
                                request_body_decoded_size: request_body.decoded_size as u64,
                                request_body_replay_size,
                                response_body_preview: error.clone(),
                                response_body_text_path: None,
                                response_body_preview_truncated: false,
                                response_body_decoded_size: error.len() as u64,
                                request_size: request_body.size as u64,
                                response_size: error.len() as u64,
                                error_type: "proxy_error".into(),
                                tags: flow_tags,
                            },
                        );
                    }
                }
            }
        }

        Ok::<(), String>(())
    })
}

fn forward_https_request(request: &ParsedRequest, target_url: &Url) -> Result<Vec<u8>, String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| "missing target host".to_string())?
        .to_string();
    let port = target_url.port_or_known_default().unwrap_or(443);
    let tcp_stream =
        TcpStream::connect((host.as_str(), port)).map_err(|error| error.to_string())?;
    tcp_stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    tcp_stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;

    let mut root_store = RootCertStore::empty();
    root_store.extend(TLS_SERVER_ROOTS.iter().cloned());
    let client_config = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let server_name = ServerName::try_from(host.clone()).map_err(|error| error.to_string())?;
    let client_connection =
        ClientConnection::new(client_config, server_name).map_err(|error| error.to_string())?;
    let mut tls_stream = StreamOwned::new(client_connection, tcp_stream);

    let path = {
        let mut path = target_url.path().to_string();
        if let Some(query) = target_url.query() {
            path.push('?');
            path.push_str(query);
        }
        if path.is_empty() {
            "/".to_string()
        } else {
            path
        }
    };

    let mut wire = format!("{} {} {}\r\n", request.method, path, request.version);
    append_upstream_request_headers(&mut wire, request, &authority_for_url(target_url));

    tls_stream
        .write_all(wire.as_bytes())
        .and_then(|_| tls_stream.write_all(&request.body))
        .map_err(|error| error.to_string())?;

    let mut response_bytes = Vec::new();
    tls_stream
        .read_to_end(&mut response_bytes)
        .map_err(|error| error.to_string())?;
    Ok(response_bytes)
}

fn forward_h2_upstream(
    method: &str,
    target_url: &Url,
    request_headers: &HashMap<String, String>,
    request_body_chunks: &[Vec<u8>],
) -> Result<Vec<u8>, String> {
    let request = ParsedRequest {
        method: method.to_string(),
        target: format!(
            "{}://{}{}{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or_default(),
            target_url.path(),
            target_url
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        ),
        version: "HTTP/1.1".into(),
        headers: strip_http2_request_headers(request_headers),
        body: request_body_chunks.concat(),
    };

    if target_url.scheme() == "https" {
        forward_https_request(&request, target_url)
    } else {
        forward_http_request(&request, target_url)
    }
}

fn mitm_alpn_protocols() -> Vec<Vec<u8>> {
    vec![b"http/1.1".to_vec()]
}

fn load_server_config(
    host_cert: &crate::certs::HostCertificateInfo,
) -> Result<ServerConfig, String> {
    let cert_file = fs::File::open(&host_cert.cert_path).map_err(|error| error.to_string())?;
    let key_file = fs::File::open(&host_cert.key_path).map_err(|error| error.to_string())?;
    let mut cert_reader = BufReader::new(cert_file);
    let mut key_reader = BufReader::new(key_file);

    let cert_chain = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let private_key = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "missing private key in generated host certificate".to_string())?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, private_key)
        .map_err(|error| error.to_string())?;
    config.alpn_protocols = mitm_alpn_protocols();
    Ok(config)
}

fn complete_tls_handshake(
    tls_stream: &mut StreamOwned<ServerConnection, TcpStream>,
) -> Result<(), String> {
    while tls_stream.conn.is_handshaking() {
        tls_stream
            .conn
            .complete_io(&mut tls_stream.sock)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn build_h2_target_url(
    request: &http::Request<h2::RecvStream>,
    fallback_host: &str,
    fallback_port: u16,
) -> Result<Url, String> {
    let authority = request
        .uri()
        .authority()
        .map(|value| value.as_str().to_string())
        .or_else(|| {
            request
                .headers()
                .get("host")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            if fallback_port == 443 {
                fallback_host.to_string()
            } else {
                format!("{fallback_host}:{fallback_port}")
            }
        });
    let scheme = request.uri().scheme_str().unwrap_or("https");
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    Url::parse(&format!("{scheme}://{authority}{path}")).map_err(|error| error.to_string())
}

async fn read_h2_body(mut body: h2::RecvStream) -> Result<Vec<Vec<u8>>, String> {
    let mut chunks = Vec::new();
    while let Some(result) = body.data().await {
        let data = result.map_err(|error| error.to_string())?;
        chunks.push(data.to_vec());
    }
    Ok(chunks)
}

fn build_h2_response_head(
    status_code: u16,
    headers: &HashMap<String, String>,
) -> Result<http::Response<()>, String> {
    let mut builder = http::Response::builder().status(status_code);
    for (key, value) in strip_http2_response_headers(headers) {
        builder = builder.header(key, value);
    }
    builder.body(()).map_err(|error| error.to_string())
}

fn apply_request_controls(
    request: &ParsedRequest,
    target_url: &Url,
    request_headers: &HashMap<String, String>,
    request_body_preview: &str,
    flow_id: &str,
    rules: &Arc<Mutex<Vec<ProxyRule>>>,
    weak_network: &Arc<Mutex<WeakNetworkProfile>>,
    breakpoints: &BreakpointRegistry,
) -> Result<RequestControlOutcome, String> {
    let profile = weak_network
        .lock()
        .expect("weak network mutex poisoned")
        .clone();
    if profile.enabled && weak_network_should_drop(profile.error_rate) {
        return Err("weak network simulated connection drop".into());
    }

    let rules = rules.lock().expect("rules mutex poisoned").clone();
    let Some(rule) = matching_rule_for_phase(
        target_url,
        &rules,
        "request",
        &["mock", "maplocal", "breakpoint"],
    ) else {
        return Ok(RequestControlOutcome::Forward(RequestControlForward {
            request: request.clone(),
            target_url: target_url.clone(),
            tags: Vec::new(),
        }));
    };

    if let Some(delay_ms) = rule.delay_ms {
        if delay_ms > 0 {
            thread::sleep(Duration::from_millis(delay_ms.min(120_000)));
        }
    }

    let kind = rule.kind.to_ascii_lowercase().replace(['_', '-'], "");
    match kind.as_str() {
        "mock" => Ok(RequestControlOutcome::Respond(mock_response_for_rule(
            &rule,
        ))),
        "maplocal" => Ok(RequestControlOutcome::Respond(map_local_response_for_rule(
            &rule,
        ))),
        "breakpoint" => {
            let breakpoint = BreakpointRequest {
                id: format!(
                    "breakpoint-{}",
                    FLOW_COUNTER.fetch_add(1, Ordering::Relaxed)
                ),
                flow_id: flow_id.to_string(),
                rule_id: rule.id.clone(),
                created_at: now_millis(),
                direction: "request".into(),
                method: request.method.clone(),
                url: target_url.to_string(),
                headers: request_headers.clone(),
                body: String::from_utf8_lossy(&request.body).to_string(),
                body_preview: request_body_preview
                    .chars()
                    .take(BODY_PREVIEW_LIMIT)
                    .collect::<String>(),
                status_code: None,
                response_headers: HashMap::new(),
                response_body_preview: String::new(),
            };
            match breakpoints.wait_for_decision(breakpoint, Duration::from_secs(300)) {
                Some(decision) => breakpoint_request_decision(decision, request, target_url, &rule),
                None => Ok(RequestControlOutcome::Respond(InterceptedResponse {
                    response_bytes: build_http_response_bytes(
                        504,
                        &HashMap::from([(
                            "content-type".into(),
                            "text/plain; charset=utf-8".into(),
                        )]),
                        b"Breakpoint timed out after 300 seconds.",
                    ),
                    tags: vec!["breakpoint".into(), "breakpoint-timeout".into()],
                    error_type: "breakpoint_timeout".into(),
                })),
            }
        }
        _ => Ok(RequestControlOutcome::Forward(RequestControlForward {
            request: request.clone(),
            target_url: target_url.clone(),
            tags: Vec::new(),
        })),
    }
}

fn apply_response_controls(
    target_url: &Url,
    method: &str,
    flow_id: &str,
    response_bytes: Vec<u8>,
    rules: &Arc<Mutex<Vec<ProxyRule>>>,
    breakpoints: &BreakpointRegistry,
) -> Result<ResponseControlOutcome, String> {
    let mut response_bytes = response_bytes;
    let mut tags = Vec::new();
    let mut error_type = String::new();
    let rules = rules.lock().expect("rules mutex poisoned").clone();
    for rule in matching_rules_for_phase(target_url, &rules, "response", &["rewrite", "breakpoint"])
    {
        let kind = normalized_rule_kind(&rule);
        if let Some(delay_ms) = rule.delay_ms {
            if delay_ms > 0 {
                thread::sleep(Duration::from_millis(delay_ms.min(120_000)));
            }
        }
        match kind.as_str() {
            "rewrite" => {
                let outcome = rewrite_response_for_rule(&rule, &response_bytes)?;
                response_bytes = outcome.response_bytes;
                tags.extend(outcome.tags);
                if !outcome.error_type.is_empty() {
                    error_type = outcome.error_type;
                }
            }
            "breakpoint" => {
                let parsed = parse_http_response(&response_bytes)?;
                let preview = buffer_preview(
                    &parsed.body,
                    &parsed.headers,
                    parsed
                        .headers
                        .get("content-encoding")
                        .cloned()
                        .unwrap_or_default(),
                );
                let breakpoint = BreakpointRequest {
                    id: format!(
                        "breakpoint-{}",
                        FLOW_COUNTER.fetch_add(1, Ordering::Relaxed)
                    ),
                    flow_id: flow_id.to_string(),
                    rule_id: rule.id.clone(),
                    created_at: now_millis(),
                    direction: "response".into(),
                    method: method.to_string(),
                    url: target_url.to_string(),
                    headers: HashMap::new(),
                    body: String::new(),
                    body_preview: String::new(),
                    status_code: Some(parsed.status_code),
                    response_headers: parsed.headers.clone(),
                    response_body_preview: preview.preview,
                };
                match breakpoints.wait_for_decision(breakpoint, Duration::from_secs(300)) {
                    Some(decision) => {
                        if let Some(outcome) =
                            breakpoint_response_decision(decision, &parsed, &rule)
                        {
                            response_bytes = outcome.response_bytes;
                            tags.extend(outcome.tags);
                            if !outcome.error_type.is_empty() {
                                error_type = outcome.error_type;
                            }
                        }
                    }
                    None => {
                        response_bytes = build_http_response_bytes(
                            504,
                            &HashMap::from([(
                                "content-type".into(),
                                "text/plain; charset=utf-8".into(),
                            )]),
                            b"Response breakpoint timed out after 300 seconds.",
                        );
                        tags.extend([
                            "breakpoint".into(),
                            "breakpoint-timeout".into(),
                            format!("rule:{}", rule.id),
                        ]);
                        error_type = "breakpoint_timeout".into();
                    }
                }
            }
            _ => {}
        }
    }

    Ok(ResponseControlOutcome {
        response_bytes,
        tags,
        error_type,
    })
}

fn matching_rule_for_phase(
    target_url: &Url,
    rules: &[ProxyRule],
    phase: &str,
    kinds: &[&str],
) -> Option<ProxyRule> {
    matching_rules_for_phase(target_url, rules, phase, kinds)
        .into_iter()
        .next()
}

fn matching_rules_for_phase(
    target_url: &Url,
    rules: &[ProxyRule],
    phase: &str,
    kinds: &[&str],
) -> Vec<ProxyRule> {
    let full_url = target_url.to_string();
    let host = target_url.host_str().unwrap_or_default();
    let path = target_url.path();
    rules
        .iter()
        .filter(|rule| {
            let kind = normalized_rule_kind(rule);
            rule.enabled
                && kinds.contains(&kind.as_str())
                && rule_direction_allows(rule, phase)
                && (text_pattern_matches(&full_url, &rule.pattern)
                    || text_pattern_matches(host, &rule.pattern)
                    || text_pattern_matches(path, &rule.pattern))
        })
        .cloned()
        .collect()
}

fn normalized_rule_kind(rule: &ProxyRule) -> String {
    rule.kind.to_ascii_lowercase().replace(['_', '-'], "")
}

fn rule_direction_allows(rule: &ProxyRule, phase: &str) -> bool {
    let direction = rule.direction.trim().to_ascii_lowercase();
    direction.is_empty() || direction == "both" || direction == phase
}

fn text_pattern_matches(value: &str, pattern: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    let value = value.to_ascii_lowercase();
    if !pattern.contains('*') {
        return value.contains(&pattern);
    }

    let mut cursor = 0usize;
    for part in pattern.split('*').filter(|part| !part.is_empty()) {
        let Some(position) = value[cursor..].find(part) else {
            return false;
        };
        cursor += position + part.len();
    }
    true
}

fn mock_response_for_rule(rule: &ProxyRule) -> InterceptedResponse {
    let body = rule.body.as_bytes().to_vec();
    let mut headers = rule.headers.clone();
    ensure_header(
        &mut headers,
        "content-type",
        "application/json; charset=utf-8",
    );
    InterceptedResponse {
        response_bytes: build_http_response_bytes(rule.status_code.unwrap_or(200), &headers, &body),
        tags: vec!["mock".into(), format!("rule:{}", rule.id)],
        error_type: String::new(),
    }
}

fn map_local_response_for_rule(rule: &ProxyRule) -> InterceptedResponse {
    let path = rule.local_path.trim();
    match fs::read(path) {
        Ok(body) => {
            let mut headers = rule.headers.clone();
            ensure_header(
                &mut headers,
                "content-type",
                infer_content_type(Path::new(path)),
            );
            InterceptedResponse {
                response_bytes: build_http_response_bytes(
                    rule.status_code.unwrap_or(200),
                    &headers,
                    &body,
                ),
                tags: vec!["map-local".into(), format!("rule:{}", rule.id)],
                error_type: String::new(),
            }
        }
        Err(error) => {
            let body = format!("Map Local failed to read {path}: {error}");
            InterceptedResponse {
                response_bytes: build_http_response_bytes(
                    502,
                    &HashMap::from([("content-type".into(), "text/plain; charset=utf-8".into())]),
                    body.as_bytes(),
                ),
                tags: vec!["map-local".into(), "map-local-error".into()],
                error_type: "map_local_error".into(),
            }
        }
    }
}

fn breakpoint_request_decision(
    decision: BreakpointDecision,
    original_request: &ParsedRequest,
    original_url: &Url,
    rule: &ProxyRule,
) -> Result<RequestControlOutcome, String> {
    match decision.action.to_ascii_lowercase().as_str() {
        "continue" => {
            let mut request = original_request.clone();
            if let Some(method) = decision
                .request_method
                .filter(|value| !value.trim().is_empty())
            {
                request.method = method.trim().to_string();
            }
            if let Some(headers) = decision.request_headers {
                request.headers = normalize_edit_headers(headers);
            }
            if let Some(body) = decision.request_body {
                request.body = body.into_bytes();
            }
            let target_url = if let Some(url) = decision
                .request_url
                .filter(|value| !value.trim().is_empty())
            {
                Url::parse(url.trim())
                    .map_err(|error| format!("invalid breakpoint URL: {error}"))?
            } else {
                original_url.clone()
            };
            request.target = target_url.to_string();
            Ok(RequestControlOutcome::Forward(RequestControlForward {
                request,
                target_url,
                tags: vec![
                    "breakpoint".into(),
                    "breakpoint-edit".into(),
                    format!("rule:{}", rule.id),
                ],
            }))
        }
        _ => Ok(RequestControlOutcome::Respond(
            breakpoint_decision_response(decision, rule),
        )),
    }
}

fn breakpoint_response_decision(
    decision: BreakpointDecision,
    parsed: &ParsedResponse,
    rule: &ProxyRule,
) -> Option<InterceptedResponse> {
    match decision.action.to_ascii_lowercase().as_str() {
        "continue" | "mock" => {
            let mut headers = if decision.headers.is_empty() {
                parsed.headers.clone()
            } else {
                normalize_edit_headers(decision.headers)
            };
            let body = if decision.body.is_empty() {
                parsed.body.clone()
            } else {
                decision.body.into_bytes()
            };
            headers.remove("content-encoding");
            Some(InterceptedResponse {
                response_bytes: build_http_response_bytes(
                    decision.status_code.unwrap_or(parsed.status_code),
                    &headers,
                    &body,
                ),
                tags: vec![
                    "breakpoint".into(),
                    "breakpoint-edit".into(),
                    format!("rule:{}", rule.id),
                ],
                error_type: String::new(),
            })
        }
        "drop" => Some(InterceptedResponse {
            response_bytes: build_http_response_bytes(
                599,
                &HashMap::from([("content-type".into(), "text/plain; charset=utf-8".into())]),
                b"Response dropped by breakpoint decision.",
            ),
            tags: vec![
                "breakpoint".into(),
                "drop".into(),
                format!("rule:{}", rule.id),
            ],
            error_type: "breakpoint_drop".into(),
        }),
        _ => None,
    }
}

fn breakpoint_decision_response(
    decision: BreakpointDecision,
    rule: &ProxyRule,
) -> InterceptedResponse {
    match decision.action.to_ascii_lowercase().as_str() {
        "drop" => InterceptedResponse {
            response_bytes: build_http_response_bytes(
                599,
                &HashMap::from([("content-type".into(), "text/plain; charset=utf-8".into())]),
                b"Request dropped by breakpoint decision.",
            ),
            tags: vec![
                "breakpoint".into(),
                "drop".into(),
                format!("rule:{}", rule.id),
            ],
            error_type: "breakpoint_drop".into(),
        },
        "mock" => {
            let mut headers = decision.headers;
            ensure_header(
                &mut headers,
                "content-type",
                "application/json; charset=utf-8",
            );
            InterceptedResponse {
                response_bytes: build_http_response_bytes(
                    decision.status_code.unwrap_or(200),
                    &headers,
                    decision.body.as_bytes(),
                ),
                tags: vec![
                    "breakpoint".into(),
                    "mock".into(),
                    format!("rule:{}", rule.id),
                ],
                error_type: String::new(),
            }
        }
        _ => InterceptedResponse {
            response_bytes: build_http_response_bytes(204, &HashMap::new(), b""),
            tags: vec!["breakpoint".into(), format!("rule:{}", rule.id)],
            error_type: String::new(),
        },
    }
}

fn rewrite_response_for_rule(
    rule: &ProxyRule,
    response_bytes: &[u8],
) -> Result<InterceptedResponse, String> {
    let parsed = parse_http_response(response_bytes)?;
    let mut headers = parsed.headers.clone();
    for (key, value) in normalize_edit_headers(rule.headers.clone()) {
        if value.trim().is_empty() {
            headers.remove(&key);
        } else {
            headers.insert(key, value);
        }
    }

    let mut body = parsed.body.clone();
    let mut changed_body = false;
    if !rule.search.is_empty() {
        if let Ok(text) = String::from_utf8(body.clone()) {
            let next = text.replace(&rule.search, &rule.replace);
            changed_body = next.as_bytes() != body.as_slice();
            body = next.into_bytes();
        }
    } else if !rule.replace.is_empty() {
        body = rule.replace.as_bytes().to_vec();
        changed_body = true;
    } else if !rule.body.is_empty() && normalized_rule_kind(rule) == "rewrite" {
        body = rule.body.as_bytes().to_vec();
        changed_body = true;
    }
    if changed_body {
        headers.remove("content-encoding");
    }

    Ok(InterceptedResponse {
        response_bytes: build_http_response_bytes(
            rule.status_code.unwrap_or(parsed.status_code),
            &headers,
            &body,
        ),
        tags: vec!["rewrite".into(), format!("rule:{}", rule.id)],
        error_type: String::new(),
    })
}

fn normalize_edit_headers(headers: HashMap<String, String>) -> HashMap<String, String> {
    headers
        .into_iter()
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

fn ensure_header(headers: &mut HashMap<String, String>, key: &str, value: &str) {
    if !headers
        .keys()
        .any(|existing| existing.eq_ignore_ascii_case(key))
    {
        headers.insert(key.to_string(), value.to_string());
    }
}

fn infer_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "txt" | "log" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn build_http_response_bytes(
    status_code: u16,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> Vec<u8> {
    let mut wire = format!("HTTP/1.1 {status_code} {}\r\n", reason_phrase(status_code));
    let mut has_content_length = false;
    let mut has_connection = false;
    for (key, value) in headers {
        if key.eq_ignore_ascii_case("content-length") {
            has_content_length = true;
        }
        if key.eq_ignore_ascii_case("connection") {
            has_connection = true;
        }
        wire.push_str(&format!("{key}: {value}\r\n"));
    }
    if !has_content_length {
        wire.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    if !has_connection {
        wire.push_str("connection: close\r\n");
    }
    wire.push_str("\r\n");
    let mut bytes = wire.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn reason_phrase(status_code: u16) -> &'static str {
    match status_code {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        599 => "Network Connect Timeout Error",
        _ => "HTTP Status",
    }
}

fn apply_weak_network_before_upstream(weak_network: &Arc<Mutex<WeakNetworkProfile>>) {
    let profile = weak_network
        .lock()
        .expect("weak network mutex poisoned")
        .clone();
    if profile.enabled && profile.delay_ms > 0 {
        thread::sleep(Duration::from_millis(profile.delay_ms.min(120_000)));
    }
}

fn apply_weak_network_after_response(weak_network: &Arc<Mutex<WeakNetworkProfile>>, bytes: u64) {
    let profile = weak_network
        .lock()
        .expect("weak network mutex poisoned")
        .clone();
    if !profile.enabled || profile.downstream_kbps == 0 || bytes == 0 {
        return;
    }

    let throttle_ms = bytes
        .saturating_mul(1000)
        .checked_div(profile.downstream_kbps.saturating_mul(1024).max(1))
        .unwrap_or(0)
        .min(120_000);
    if throttle_ms > 0 {
        thread::sleep(Duration::from_millis(throttle_ms));
    }
}

fn weak_network_should_drop(error_rate: f64) -> bool {
    if error_rate <= 0.0 {
        return false;
    }
    if error_rate >= 1.0 {
        return true;
    }
    let seed = now_millis()
        .wrapping_mul(1_103_515_245)
        .wrapping_add(FLOW_COUNTER.load(Ordering::Relaxed));
    (seed % 10_000) as f64 / 10_000.0 < error_rate
}

fn normalize_http_header_map(headers: &http::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|text| (key.as_str().to_string(), text.to_string()))
        })
        .collect()
}

fn strip_http2_request_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    strip_hop_by_hop_headers(headers)
        .into_iter()
        .filter(|(key, _)| !key.starts_with(':') && !key.eq_ignore_ascii_case("http2-settings"))
        .collect()
}

fn strip_http2_response_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    strip_hop_by_hop_headers(headers)
        .into_iter()
        .filter(|(key, _)| !key.starts_with(':') && !key.eq_ignore_ascii_case("http2-settings"))
        .collect()
}

fn forward_http_request(request: &ParsedRequest, target_url: &Url) -> Result<Vec<u8>, String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| "missing target host".to_string())?
        .to_string();
    let port = target_url.port_or_known_default().unwrap_or(80);
    let mut upstream_stream =
        TcpStream::connect((host.as_str(), port)).map_err(|error| error.to_string())?;
    upstream_stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    upstream_stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;

    let path = {
        let mut path = target_url.path().to_string();
        if let Some(query) = target_url.query() {
            path.push('?');
            path.push_str(query);
        }
        if path.is_empty() {
            "/".to_string()
        } else {
            path
        }
    };

    let mut wire = format!("{} {} {}\r\n", request.method, path, request.version);
    append_upstream_request_headers(&mut wire, request, &authority_for_url(target_url));

    upstream_stream
        .write_all(wire.as_bytes())
        .and_then(|_| upstream_stream.write_all(&request.body))
        .map_err(|error| error.to_string())?;

    let mut response_bytes = Vec::new();
    upstream_stream
        .read_to_end(&mut response_bytes)
        .map_err(|error| error.to_string())?;
    Ok(response_bytes)
}

fn proxy_websocket_plain(
    request: ParsedRequest,
    client_stream: &mut TcpStream,
    target_url: &Url,
) -> Result<WebSocketCapture, String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| "missing target host".to_string())?
        .to_string();
    let port = target_url.port_or_known_default().unwrap_or(80);
    let mut upstream_stream =
        TcpStream::connect((host.as_str(), port)).map_err(|error| error.to_string())?;
    set_websocket_timeout(client_stream);
    set_websocket_timeout(&upstream_stream);

    let wire = websocket_request_wire(&request, target_url);
    upstream_stream
        .write_all(wire.as_bytes())
        .and_then(|_| upstream_stream.write_all(&request.body))
        .map_err(|error| error.to_string())?;

    let (response_head, parsed_response, remainder) =
        read_http_response_head(&mut upstream_stream)?;
    client_stream
        .write_all(&response_head)
        .map_err(|error| error.to_string())?;

    websocket_capture_from_tunnel(
        parsed_response,
        remainder,
        client_stream,
        &mut upstream_stream,
    )
}

fn proxy_websocket_tls(
    request: &ParsedRequest,
    client_tls_stream: &mut StreamOwned<ServerConnection, TcpStream>,
    target_url: &Url,
) -> Result<WebSocketCapture, String> {
    let host = target_url
        .host_str()
        .ok_or_else(|| "missing target host".to_string())?
        .to_string();
    let port = target_url.port_or_known_default().unwrap_or(443);
    let tcp_stream =
        TcpStream::connect((host.as_str(), port)).map_err(|error| error.to_string())?;
    set_websocket_timeout(&tcp_stream);
    set_websocket_timeout(&client_tls_stream.sock);

    let mut root_store = RootCertStore::empty();
    root_store.extend(TLS_SERVER_ROOTS.iter().cloned());
    let client_config = Arc::new(
        ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let server_name = ServerName::try_from(host.clone()).map_err(|error| error.to_string())?;
    let client_connection =
        ClientConnection::new(client_config, server_name).map_err(|error| error.to_string())?;
    let mut upstream_tls_stream = StreamOwned::new(client_connection, tcp_stream);

    let wire = websocket_request_wire(request, target_url);
    upstream_tls_stream
        .write_all(wire.as_bytes())
        .and_then(|_| upstream_tls_stream.write_all(&request.body))
        .map_err(|error| error.to_string())?;

    let (response_head, parsed_response, remainder) =
        read_http_response_head(&mut upstream_tls_stream)?;
    client_tls_stream
        .write_all(&response_head)
        .map_err(|error| error.to_string())?;
    let _ = client_tls_stream.flush();

    websocket_capture_from_tunnel(
        parsed_response,
        remainder,
        client_tls_stream,
        &mut upstream_tls_stream,
    )
}

fn websocket_capture_from_tunnel<C, U>(
    parsed_response: ParsedResponse,
    remainder: Vec<u8>,
    client: &mut C,
    upstream: &mut U,
) -> Result<WebSocketCapture, String>
where
    C: Read + Write,
    U: Read + Write,
{
    let status_code = parsed_response.status_code;
    if status_code != 101 {
        if !remainder.is_empty() {
            client
                .write_all(&remainder)
                .map_err(|error| error.to_string())?;
        }
        let response_size = remainder.len() as u64;
        return Ok(WebSocketCapture {
            status_code,
            response_headers: parsed_response.headers,
            response_body_preview: String::from_utf8_lossy(&remainder).to_string(),
            response_size,
            client_to_server_bytes: 0,
            server_to_client_bytes: response_size,
            tags: vec!["websocket".into(), "websocket-upgrade-failed".into()],
            error_type: if status_code >= 400 {
                "websocket_upgrade_error".into()
            } else {
                String::new()
            },
        });
    }

    let (client_to_server, server_to_client, tunnel_error) =
        tunnel_websocket_streams(client, upstream, remainder)?;
    let preview = format!(
        "WebSocket tunnel established.\nclient -> server: {client_to_server} bytes\nserver -> client: {server_to_client} bytes"
    );
    Ok(WebSocketCapture {
        status_code,
        response_headers: parsed_response.headers,
        response_body_preview: preview,
        response_size: server_to_client,
        client_to_server_bytes: client_to_server,
        server_to_client_bytes: server_to_client,
        tags: vec!["websocket".into(), "upgrade".into()],
        error_type: tunnel_error,
    })
}

fn tunnel_websocket_streams<C, U>(
    client: &mut C,
    upstream: &mut U,
    server_initial: Vec<u8>,
) -> Result<(u64, u64, String), String>
where
    C: Read + Write,
    U: Read + Write,
{
    let mut client_to_server = 0u64;
    let mut server_to_client = 0u64;
    let mut tunnel_error = String::new();
    if !server_initial.is_empty() {
        client
            .write_all(&server_initial)
            .map_err(|error| error.to_string())?;
        server_to_client += server_initial.len() as u64;
    }

    let mut client_closed = false;
    let mut upstream_closed = false;
    let mut last_activity = Instant::now();
    let mut client_buffer = [0u8; 16 * 1024];
    let mut upstream_buffer = [0u8; 16 * 1024];

    while last_activity.elapsed() < Duration::from_secs(300) {
        let mut moved = false;
        if !client_closed {
            match client.read(&mut client_buffer) {
                Ok(0) => client_closed = true,
                Ok(read) => {
                    upstream
                        .write_all(&client_buffer[..read])
                        .and_then(|_| upstream.flush())
                        .map_err(|error| error.to_string())?;
                    client_to_server += read as u64;
                    moved = true;
                }
                Err(error) if is_temporary_read_error(&error) => {}
                Err(error) => {
                    tunnel_error = format!("websocket client read error: {error}");
                    client_closed = true;
                }
            }
        }

        if !upstream_closed {
            match upstream.read(&mut upstream_buffer) {
                Ok(0) => upstream_closed = true,
                Ok(read) => {
                    client
                        .write_all(&upstream_buffer[..read])
                        .and_then(|_| client.flush())
                        .map_err(|error| error.to_string())?;
                    server_to_client += read as u64;
                    moved = true;
                }
                Err(error) if is_temporary_read_error(&error) => {}
                Err(error) => {
                    tunnel_error = format!("websocket upstream read error: {error}");
                    upstream_closed = true;
                }
            }
        }

        if moved {
            last_activity = Instant::now();
        } else {
            thread::sleep(Duration::from_millis(10));
        }
        if client_closed || upstream_closed {
            break;
        }
    }

    if tunnel_error.is_empty() && last_activity.elapsed() >= Duration::from_secs(300) {
        tunnel_error = "websocket_idle_timeout".into();
    }
    Ok((client_to_server, server_to_client, tunnel_error))
}

fn is_temporary_read_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn set_websocket_timeout(stream: &TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
}

fn websocket_request_wire(request: &ParsedRequest, target_url: &Url) -> String {
    let mut path = target_url.path().to_string();
    if let Some(query) = target_url.query() {
        path.push('?');
        path.push_str(query);
    }
    if path.is_empty() {
        path = "/".into();
    }

    let mut wire = format!("{} {} {}\r\n", request.method, path, request.version);
    let mut has_connection = false;
    let mut has_upgrade = false;
    for (key, value) in &request.headers {
        if key.eq_ignore_ascii_case("host")
            || key.eq_ignore_ascii_case("content-length")
            || key.eq_ignore_ascii_case("proxy-connection")
            || key.eq_ignore_ascii_case("proxy-authorization")
        {
            continue;
        }
        if key.eq_ignore_ascii_case("connection") {
            has_connection = true;
        }
        if key.eq_ignore_ascii_case("upgrade") {
            has_upgrade = true;
        }
        wire.push_str(&format!("{key}: {value}\r\n"));
    }
    wire.push_str(&format!("Host: {}\r\n", authority_for_url(target_url)));
    if !has_connection {
        wire.push_str("Connection: Upgrade\r\n");
    }
    if !has_upgrade {
        wire.push_str("Upgrade: websocket\r\n");
    }
    if request_has_body(&request.method, &request.headers, request.body.len()) {
        wire.push_str(&format!("Content-Length: {}\r\n", request.body.len()));
    }
    wire.push_str("\r\n");
    wire
}

fn is_websocket_upgrade(headers: &HashMap<String, String>) -> bool {
    header_value(headers, "upgrade")
        .to_ascii_lowercase()
        .contains("websocket")
        && header_value(headers, "connection")
            .to_ascii_lowercase()
            .contains("upgrade")
}

fn read_http_response_head<R: Read>(
    stream: &mut R,
) -> Result<(Vec<u8>, ParsedResponse, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let header_end = read_until_headers_complete(stream, &mut buffer)?;
    let head = buffer[..header_end + 4].to_vec();
    let mut parsed = parse_http_response(&head)?;
    let remainder = buffer[header_end + 4..].to_vec();
    parsed.body = remainder.clone();
    Ok((head, parsed, remainder))
}

fn read_http_request<R: Read>(stream: &mut R) -> Result<ParsedRequest, String> {
    let mut buffer = Vec::new();
    let header_end = read_until_headers_complete(stream, &mut buffer)?;
    let header_bytes = &buffer[..header_end];
    let mut body = buffer[(header_end + 4)..].to_vec();
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or_else(|| "empty request".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default().to_string();
    let version = request_parts.next().unwrap_or("HTTP/1.1").to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    if headers
        .get("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        body = read_chunked_body(stream, body)?;
    } else {
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);

        while body.len() < content_length {
            let mut chunk = [0u8; 8192];
            let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
    }

    Ok(ParsedRequest {
        method,
        target,
        version,
        headers,
        body,
    })
}

fn parse_http_response(bytes: &[u8]) -> Result<ParsedResponse, String> {
    let header_end =
        find_header_end(bytes).ok_or_else(|| "response missing headers".to_string())?;
    let header_text = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "missing status line".to_string())?;
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "invalid status code".to_string())?;
    let mut headers = HashMap::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok(ParsedResponse {
        status_code,
        headers,
        body: bytes[(header_end + 4)..].to_vec(),
    })
}

fn read_until_headers_complete<R: Read>(
    stream: &mut R,
    buffer: &mut Vec<u8>,
) -> Result<usize, String> {
    loop {
        if let Some(position) = find_header_end(buffer) {
            return Ok(position);
        }
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            if buffer.is_empty() {
                return Err("connection closed".into());
            }
            return Err("connection closed before headers completed".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 1024 * 1024 {
            return Err("request headers too large".into());
        }
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn build_target_url(request: &ParsedRequest) -> Result<Url, String> {
    build_target_url_for_scheme(request, "http", "")
}

fn build_target_url_for_scheme(
    request: &ParsedRequest,
    default_scheme: &str,
    fallback_host: &str,
) -> Result<Url, String> {
    if request.target.starts_with("http://") || request.target.starts_with("https://") {
        return Url::parse(&request.target).map_err(|error| error.to_string());
    }

    let host = request
        .headers
        .get("host")
        .cloned()
        .or_else(|| {
            if fallback_host.is_empty() {
                None
            } else {
                Some(fallback_host.to_string())
            }
        })
        .ok_or_else(|| "missing host header".to_string())?;
    Url::parse(&format!("{default_scheme}://{host}{}", request.target))
        .map_err(|error| error.to_string())
}

fn split_host_port(value: &str, default_port: u16) -> Result<(String, u16), String> {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(format!("invalid IPv6 authority: {value}"));
        };
        let host = rest[..end].to_string();
        let port = rest[(end + 1)..]
            .strip_prefix(':')
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Ok((host, port));
    }
    if let Some((host, port)) = value.rsplit_once(':') {
        if !host.contains(':') && port.parse::<u16>().is_ok() {
            let port = port.parse::<u16>().map_err(|error| error.to_string())?;
            return Ok((host.to_string(), port));
        }
    }
    Ok((value.to_string(), default_port))
}

fn append_upstream_request_headers(wire: &mut String, request: &ParsedRequest, authority: &str) {
    let mut has_content_length = false;
    for (key, value) in strip_hop_by_hop_headers(&request.headers) {
        if key.eq_ignore_ascii_case("host")
            || key.eq_ignore_ascii_case("content-length")
            || key.eq_ignore_ascii_case("accept-encoding")
        {
            continue;
        }
        wire.push_str(&format!("{key}: {value}\r\n"));
    }

    wire.push_str(&format!("Host: {authority}\r\n"));
    if request_has_body(&request.method, &request.headers, request.body.len()) {
        wire.push_str(&format!("Content-Length: {}\r\n", request.body.len()));
        has_content_length = true;
    }
    if !has_content_length && request.headers.contains_key("content-length") {
        wire.push_str("Content-Length: 0\r\n");
    }
    wire.push_str("Accept-Encoding: identity\r\n");
    wire.push_str("Connection: close\r\n\r\n");
}

fn authority_for_url(target_url: &Url) -> String {
    let host = target_url.host_str().unwrap_or_default();
    match target_url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

fn request_has_body(method: &str, headers: &HashMap<String, String>, body_len: usize) -> bool {
    if body_len > 0 {
        return true;
    }
    if headers.contains_key("content-length") || headers.contains_key("transfer-encoding") {
        return true;
    }
    matches!(
        method.to_ascii_uppercase().as_str(),
        "POST" | "PUT" | "PATCH" | "DELETE"
    )
}

fn read_chunked_body<R: Read>(stream: &mut R, initial: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut buffer = initial;
    let mut decoded = Vec::new();

    loop {
        let line = read_crlf_line(stream, &mut buffer)?;
        let size_text = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|error| format!("invalid chunk size {size_text:?}: {error}"))?;
        if size == 0 {
            loop {
                let trailer = read_crlf_line(stream, &mut buffer)?;
                if trailer.is_empty() {
                    return Ok(decoded);
                }
            }
        }

        let chunk = read_exact_buffered(stream, &mut buffer, size)?;
        decoded.extend_from_slice(&chunk);
        let crlf = read_exact_buffered(stream, &mut buffer, 2)?;
        if crlf.as_slice() != b"\r\n" {
            return Err("invalid chunk terminator".into());
        }
    }
}

fn read_crlf_line<R: Read>(stream: &mut R, buffer: &mut Vec<u8>) -> Result<String, String> {
    loop {
        if let Some(position) = buffer.windows(2).position(|window| window == b"\r\n") {
            let line = buffer.drain(..position).collect::<Vec<_>>();
            buffer.drain(..2);
            return String::from_utf8(line).map_err(|error| error.to_string());
        }
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed while reading chunked body".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > BODY_PREVIEW_LIMIT * 16 {
            return Err("chunked body line too large".into());
        }
    }
}

fn read_exact_buffered<R: Read>(
    stream: &mut R,
    buffer: &mut Vec<u8>,
    length: usize,
) -> Result<Vec<u8>, String> {
    while buffer.len() < length {
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed while reading body".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    Ok(buffer.drain(..length).collect())
}

fn strip_hop_by_hop_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let blocked: HashSet<&str> = [
        "connection",
        "proxy-connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]
    .into_iter()
    .collect();

    headers
        .iter()
        .filter(|(key, _)| !blocked.contains(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn normalize_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn header_value(headers: &HashMap<String, String>, name: &str) -> String {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

struct BufferPreview {
    size: usize,
    decoded_size: usize,
    preview: String,
    preview_truncated: bool,
    text_body_path: Option<String>,
}

fn body_storage_tags(preview: &BufferPreview, direction: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if preview.preview_truncated && preview.text_body_path.is_some() {
        tags.push(format!("{direction}-body-spooled"));
        tags.push("large-body".into());
    }
    tags
}

fn buffer_preview(
    body: &[u8],
    headers: &HashMap<String, String>,
    encoding_override: String,
) -> BufferPreview {
    let preview_body = if headers
        .get("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        decode_chunked_buffer(body).unwrap_or_else(|| body.to_vec())
    } else {
        body.to_vec()
    };
    let decoded = decode_body_buffer(&preview_body, headers, &encoding_override);
    if is_binary_preview(headers, &decoded) {
        return BufferPreview {
            size: body.len(),
            decoded_size: decoded.len(),
            preview: binary_preview_message(headers, decoded.len()),
            preview_truncated: false,
            text_body_path: None,
        };
    }
    BufferPreview {
        size: body.len(),
        decoded_size: decoded.len(),
        preview: String::from_utf8_lossy(&decoded[..decoded.len().min(BODY_PREVIEW_LIMIT)])
            .to_string(),
        preview_truncated: decoded.len() > BODY_PREVIEW_LIMIT,
        text_body_path: store_text_body(&decoded),
    }
}

fn binary_preview_message(headers: &HashMap<String, String>, decoded_size: usize) -> String {
    let content_type = headers
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    format!(
        "[binary body omitted]\ncontent-type: {content_type}\ndecoded-size: {decoded_size} bytes"
    )
}

fn is_binary_preview(headers: &HashMap<String, String>, decoded: &[u8]) -> bool {
    if decoded.is_empty() {
        return false;
    }

    let content_type = headers
        .get("content-type")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let textual_type = content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript")
        || content_type.contains("x-www-form-urlencoded")
        || content_type.contains("graphql");
    if textual_type {
        return false;
    }
    let binary_type = content_type.starts_with("image/")
        || content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || content_type.contains("font")
        || content_type.contains("octet-stream")
        || content_type.contains("zip")
        || content_type.contains("protobuf")
        || content_type.contains("wasm");
    if binary_type {
        return true;
    }

    if decoded.contains(&0) {
        return true;
    }
    let sample_len = decoded.len().min(2048);
    let sample = &decoded[..sample_len];
    let suspicious = sample
        .iter()
        .filter(|byte| {
            let value = **byte;
            value < 0x09 || (value > 0x0d && value < 0x20)
        })
        .count();
    suspicious * 100 / sample_len > 8 || std::str::from_utf8(sample).is_err()
}

fn decode_chunked_buffer(body: &[u8]) -> Option<Vec<u8>> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let line_end = body[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + cursor;
        let line = std::str::from_utf8(&body[cursor..line_end]).ok()?;
        let size_text = line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        cursor = line_end + 2;
        if size == 0 {
            return Some(decoded);
        }
        let chunk_end = cursor.checked_add(size)?;
        if chunk_end + 2 > body.len() || &body[chunk_end..chunk_end + 2] != b"\r\n" {
            return None;
        }
        decoded.extend_from_slice(&body[cursor..chunk_end]);
        cursor = chunk_end + 2;
    }
}

fn decode_body_buffer(
    body: &[u8],
    headers: &HashMap<String, String>,
    encoding_override: &str,
) -> Vec<u8> {
    let encoding = if !encoding_override.is_empty() {
        encoding_override.to_ascii_lowercase()
    } else {
        headers
            .get("content-encoding")
            .cloned()
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    if encoding.is_empty() || body.is_empty() {
        return body.to_vec();
    }

    if encoding.contains("gzip") {
        let mut decoder = GzDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return decoded;
        }
    }

    if encoding.contains("deflate") {
        let mut decoder = ZlibDecoder::new(Cursor::new(body));
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return decoded;
        }
    }

    body.to_vec()
}

fn request_body_encoding_from_url(target_url: &Url) -> String {
    target_url
        .query_pairs()
        .find(|(key, _)| key == "compression")
        .map(|(_, value)| value.to_string())
        .filter(|value| value.to_ascii_lowercase().contains("gzip"))
        .map(|_| "gzip".to_string())
        .unwrap_or_default()
}

fn is_connection_closed_error(error: &str) -> bool {
    error == "connection closed" || error == "connection closed before headers completed"
}

fn request_wants_close(request: &ParsedRequest) -> bool {
    request
        .headers
        .get("connection")
        .map(|value| value.to_ascii_lowercase().contains("close"))
        .unwrap_or(false)
}

fn push_flow(flows: &Arc<Mutex<Vec<CaptureFlow>>>, flow: CaptureFlow) {
    let mut flows = flows.lock().expect("flows mutex poisoned");
    flows.insert(0, flow);
    if flows.len() > 500 {
        let removed = flows.split_off(500);
        for flow in removed {
            delete_replay_body(&flow);
        }
    }
}

fn next_flow_id() -> String {
    format!("rust-flow-{}", FLOW_COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn replay_body_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("heaveneye-agent-replay-bodies")
}

fn body_cache_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("heaveneye-agent-body-cache")
}

fn store_replay_body(body: &[u8]) -> Option<String> {
    if body.is_empty() {
        return None;
    }

    let dir = replay_body_dir();
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }

    let path = dir.join(format!(
        "{}-{}.body",
        now_millis(),
        FLOW_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&path, body).ok()?;
    Some(path.display().to_string())
}

fn store_text_body(body: &[u8]) -> Option<String> {
    if body.is_empty() {
        return None;
    }

    let dir = body_cache_dir();
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }

    let path = dir.join(format!(
        "{}-{}.body.txt",
        now_millis(),
        FLOW_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&path, body).ok()?;
    Some(path.display().to_string())
}

fn delete_body_file(path: &Option<String>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn delete_replay_body(flow: &CaptureFlow) {
    delete_body_file(&flow.request_body_path);
    delete_body_file(&flow.request_body_text_path);
    delete_body_file(&flow.response_body_text_path);
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn should_capture_host(host: &str, capture_hosts: &[String]) -> bool {
    if capture_hosts.is_empty() {
        return true;
    }
    capture_hosts
        .iter()
        .any(|pattern| host_matches_pattern(host, pattern))
}

pub fn should_mitm_host(host: &str, capture_hosts: &[String]) -> bool {
    should_capture_host(host, capture_hosts) && !should_bypass_mitm_host(host)
}

pub fn should_bypass_mitm_host(host: &str) -> bool {
    DEFAULT_MITM_BYPASS_HOSTS
        .iter()
        .any(|pattern| host_matches_exact_or_subdomain(host, pattern))
}

pub fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    let normalized_host = normalize_host(host);
    let normalized_pattern = normalize_capture_host(pattern);
    if normalized_host.is_empty() || normalized_pattern.is_empty() {
        return false;
    }
    if normalized_pattern == "*" {
        return true;
    }
    if normalized_pattern.starts_with("*.") {
        let suffix = normalized_pattern.trim_start_matches("*.");
        return normalized_host == suffix || normalized_host.ends_with(&format!(".{suffix}"));
    }
    normalized_host == normalized_pattern
        || normalized_host.ends_with(&format!(".{normalized_pattern}"))
        || same_registrable_domain(&normalized_host, &normalized_pattern)
        || brand_related_domain(&normalized_host, &normalized_pattern)
}

fn host_matches_exact_or_subdomain(host: &str, pattern: &str) -> bool {
    let normalized_host = normalize_host(host);
    let normalized_pattern = normalize_capture_host(pattern);
    if normalized_host.is_empty() || normalized_pattern.is_empty() {
        return false;
    }
    if normalized_pattern == "*" {
        return true;
    }
    if normalized_pattern.starts_with("*.") {
        let suffix = normalized_pattern.trim_start_matches("*.");
        return normalized_host == suffix || normalized_host.ends_with(&format!(".{suffix}"));
    }
    normalized_host == normalized_pattern
        || normalized_host.ends_with(&format!(".{normalized_pattern}"))
}

fn normalize_host(host: &str) -> String {
    let mut value = host.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        if let Ok(url) = Url::parse(value) {
            return normalize_host(url.host_str().unwrap_or_default());
        }
    }
    value = value.trim_start_matches("//");
    value = value
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim();

    if let Some(rest) = value.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].trim_end_matches('.').to_ascii_lowercase();
        }
    }

    let without_port = value
        .rsplit_once(':')
        .and_then(|(candidate, port)| {
            if !candidate.contains(':') && port.parse::<u16>().is_ok() {
                Some(candidate)
            } else {
                None
            }
        })
        .unwrap_or(value);

    without_port
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn normalize_capture_host(input: &str) -> String {
    let value = input.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        if let Ok(url) = Url::parse(value) {
            return normalize_host(url.host_str().unwrap_or_default());
        }
    }
    normalize_host(
        value
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or_default(),
    )
}

pub fn normalize_capture_hosts(hosts: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for host in hosts
        .iter()
        .flat_map(|host| host.split(|char: char| char == ',' || char.is_whitespace()))
        .map(normalize_capture_host)
        .filter(|host| !host.is_empty())
    {
        if !result.contains(&host) {
            result.push(host);
        }
    }
    result
}

fn same_registrable_domain(host: &str, pattern: &str) -> bool {
    if !has_subdomain_depth(pattern) {
        return false;
    }
    match (registrable_domain(host), registrable_domain(pattern)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn brand_related_domain(host: &str, pattern: &str) -> bool {
    let Some(root_domain) = registrable_domain(pattern) else {
        return false;
    };
    let brand = root_domain.split('.').next().unwrap_or_default();
    if brand.len() < 4 {
        return false;
    }

    host.starts_with(&format!("{brand}-"))
        || host.contains(&format!(".{brand}-"))
        || host.contains(&format!("-{brand}."))
        || host.contains(&format!("-{brand}-"))
}

fn has_subdomain_depth(host: &str) -> bool {
    host.split('.').filter(|part| !part.is_empty()).count() >= 3
}

fn registrable_domain(host: &str) -> Option<String> {
    if host.is_empty() || host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }

    let labels = host
        .split('.')
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();
    if labels.len() < 2 {
        return None;
    }

    let suffix_two = format!("{}.{}", labels[labels.len() - 2], labels[labels.len() - 1]);
    let public_suffix_two = [
        "co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "com.au", "net.au",
        "org.au", "co.jp", "ne.jp", "or.jp", "co.kr", "or.kr", "com.br", "com.sg", "com.hk",
        "com.tw", "co.nz",
    ];
    let take = if public_suffix_two.contains(&suffix_two.as_str()) && labels.len() >= 3 {
        3
    } else {
        2
    };

    Some(labels[labels.len() - take..].join("."))
}

#[cfg(test)]
mod tests {
    use super::{
        buffer_preview, configure_client_stream, host_matches_pattern, is_websocket_upgrade,
        matching_rule_for_phase, mitm_alpn_protocols, normalize_capture_hosts,
        poll_blocking_result, rewrite_response_for_rule, should_capture_host, should_mitm_host,
        websocket_request_wire, ParsedRequest,
    };
    use crate::models::ProxyRule;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn normalizes_urls_and_lists() {
        assert_eq!(
            normalize_capture_hosts(&["https://app.example.test/, *.example.com".to_string()]),
            vec!["app.example.test".to_string(), "*.example.com".to_string()]
        );
    }

    #[test]
    fn page_host_filter_matches_same_site_api_hosts() {
        assert!(host_matches_pattern("app.example.test", "app.example.test"));
        assert!(host_matches_pattern(
            "api.app.example.test",
            "app.example.test"
        ));
        assert!(host_matches_pattern("api.example.test", "app.example.test"));
        assert!(host_matches_pattern(
            "static.example.test",
            "app.example.test"
        ));
        assert!(host_matches_pattern(
            "assets.example.test",
            "app.example.test"
        ));
        assert!(host_matches_pattern("cdn.example.test", "app.example.test"));
        assert!(!host_matches_pattern("google.com", "app.example.test"));
    }

    #[test]
    fn root_domain_filter_matches_subdomains() {
        assert!(host_matches_pattern("example.test", "example.test"));
        assert!(host_matches_pattern("static.example.test", "example.test"));
        assert!(!host_matches_pattern("google.com", "example.test"));
    }

    #[test]
    fn mitm_uses_same_domain_gate_as_capture() {
        let patterns = vec!["app.example.test".to_string()];
        assert!(should_mitm_host("app.example.test", &patterns));
        assert!(should_mitm_host("api.app.example.test", &patterns));
        assert!(should_mitm_host("api.example.test", &patterns));
        assert!(should_mitm_host("static.example.test", &patterns));
        assert!(!should_mitm_host("google.com", &patterns));
    }

    #[test]
    fn mitm_bypasses_pinned_system_hosts_by_default() {
        let all_hosts = vec!["*".to_string()];
        assert!(should_capture_host("api.apple-cloudkit.com", &all_hosts));
        assert!(!should_mitm_host("api.apple-cloudkit.com", &all_hosts));
        assert!(!should_mitm_host("p123-content.icloud.com", &all_hosts));
        assert!(!should_mitm_host("www.google.com", &all_hosts));
        assert!(!should_mitm_host("fonts.gstatic.com", &all_hosts));
        assert!(should_mitm_host("api.example.test", &all_hosts));
        assert!(should_mitm_host(
            "generativelanguage.googleapis.com",
            &all_hosts
        ));
    }

    #[test]
    fn exact_host_filter_does_not_match_unrelated_domains() {
        assert!(host_matches_pattern(
            "app.example.test",
            "https://app.example.test"
        ));
        assert!(!host_matches_pattern(
            "analytics.example.net",
            "https://app.example.test"
        ));
        assert!(!host_matches_pattern(
            "edge.example.net",
            "https://app.example.test"
        ));
    }

    #[test]
    fn response_rewrite_replaces_text_and_headers() {
        let rule = ProxyRule {
            id: "rule-rewrite".into(),
            enabled: true,
            kind: "rewrite".into(),
            direction: "response".into(),
            pattern: "example.test".into(),
            status_code: Some(202),
            headers: HashMap::from([("x-debug".into(), "rewritten".into())]),
            body: String::new(),
            search: "old".into(),
            replace: "new".into(),
            local_path: String::new(),
            delay_ms: None,
        };
        let response =
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\n\r\nold value";

        let rewritten = rewrite_response_for_rule(&rule, response).expect("rewrite response");
        let parsed =
            super::parse_http_response(&rewritten.response_bytes).expect("parse rewritten");

        assert_eq!(parsed.status_code, 202);
        assert_eq!(
            parsed.headers.get("x-debug").map(String::as_str),
            Some("rewritten")
        );
        assert_eq!(String::from_utf8_lossy(&parsed.body), "new value");
        assert!(rewritten.tags.contains(&"rewrite".to_string()));
    }

    #[test]
    fn response_rules_do_not_match_request_phase() {
        let rules = vec![ProxyRule {
            id: "rule-response".into(),
            enabled: true,
            kind: "rewrite".into(),
            direction: "response".into(),
            pattern: "example.test".into(),
            status_code: None,
            headers: HashMap::new(),
            body: String::new(),
            search: String::new(),
            replace: String::new(),
            local_path: String::new(),
            delay_ms: None,
        }];
        let url = url::Url::parse("https://app.example.test/api").unwrap();

        assert!(matching_rule_for_phase(&url, &rules, "request", &["rewrite"]).is_none());
        assert!(matching_rule_for_phase(&url, &rules, "response", &["rewrite"]).is_some());
    }

    #[test]
    fn websocket_upgrade_wire_preserves_upgrade_headers() {
        let request = ParsedRequest {
            method: "GET".into(),
            target: "http://socket.example.test/chat?room=1".into(),
            version: "HTTP/1.1".into(),
            headers: HashMap::from([
                ("host".into(), "socket.example.test".into()),
                ("connection".into(), "Upgrade".into()),
                ("upgrade".into(), "websocket".into()),
                ("sec-websocket-key".into(), "abc".into()),
            ]),
            body: Vec::new(),
        };
        let url = url::Url::parse(&request.target).unwrap();

        assert!(is_websocket_upgrade(&request.headers));
        let wire = websocket_request_wire(&request, &url);
        assert!(wire.starts_with("GET /chat?room=1 HTTP/1.1\r\n"));
        assert!(wire.contains("upgrade: websocket\r\n"));
        assert!(wire.contains("sec-websocket-key: abc\r\n"));
        assert!(wire.contains("Host: socket.example.test\r\n"));
    }

    #[test]
    fn mitm_advertises_http1_only() {
        assert_eq!(mitm_alpn_protocols(), vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn configure_client_stream_restores_blocking_mode() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback listener");
        let addr = listener.local_addr().expect("read listener addr");
        let connector = thread::spawn(move || {
            let mut client = TcpStream::connect(addr).expect("connect to listener");
            thread::sleep(Duration::from_millis(20));
            client.write_all(&[7]).expect("write test byte");
        });
        let (mut server_stream, _) = listener.accept().expect("accept client connection");

        server_stream
            .set_nonblocking(true)
            .expect("set accepted stream to nonblocking");
        configure_client_stream(&server_stream).expect("configure accepted stream");

        let mut byte = [0u8; 1];
        server_stream
            .read_exact(&mut byte)
            .expect("read delayed byte");
        assert_eq!(byte, [7]);

        connector.join().expect("join connector thread");
    }

    #[test]
    fn would_block_maps_to_pending_for_async_wrapper() {
        let result = poll_blocking_result::<usize>(Err(std::io::Error::from(
            std::io::ErrorKind::WouldBlock,
        )));

        assert!(matches!(result, std::task::Poll::Pending));
    }

    #[test]
    fn binary_preview_uses_readable_placeholder() {
        let preview = buffer_preview(
            &[0, 1, 2, 3, 4, 5],
            &HashMap::from([("content-type".into(), "video/mp4".into())]),
            String::new(),
        );

        assert!(preview.preview.contains("[binary body omitted]"));
        assert!(preview.preview.contains("video/mp4"));
    }
}

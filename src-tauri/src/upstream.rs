//! Preserve the user's original HTTP proxy routes while HeavenEye is the system proxy.
use crate::models::SystemProxySetting;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct Routes {
    pub http: Option<(String, u16)>,
    pub https: Option<(String, u16)>,
    pub bypass: Vec<String>,
    pub listener_port: u16,
}

static ROUTES: OnceLock<RwLock<Routes>> = OnceLock::new();

pub fn configure(routes: Routes) {
    *ROUTES
        .get_or_init(Default::default)
        .write()
        .expect("upstream routes lock") = routes;
}

pub fn endpoint(
    setting: &SystemProxySetting,
    listener_port: u16,
) -> Result<Option<(String, u16)>, String> {
    if !setting.enabled {
        return Ok(None);
    }
    let port = setting
        .port
        .filter(|port| *port > 0)
        .ok_or("原代理端口无效")?;
    if is_loopback(&setting.host) && port == listener_port {
        return Err("原代理指向 HeavenEye 自身，已阻止代理循环。".into());
    }
    Ok(Some((setting.host.clone(), port)))
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn wildcard_matches(value: &str, pattern: &str) -> bool {
    let mut matches = vec![false; value.len() + 1];
    matches[0] = true;
    for p in pattern.bytes() {
        if p == b'*' {
            for i in 1..=value.len() {
                matches[i] |= matches[i - 1];
            }
        } else {
            for i in (1..=value.len()).rev() {
                matches[i] = matches[i - 1] && (p == b'?' || p == value.as_bytes()[i - 1]);
            }
            matches[0] = false;
        }
    }
    matches[value.len()]
}

impl Routes {
    fn proxy_for(&self, host: &str, port: u16, tls: bool) -> Option<&(String, u16)> {
        let host = host.to_ascii_lowercase();
        if is_loopback(&host)
            || self.bypass.iter().any(|pattern| {
                let pattern = pattern.to_ascii_lowercase();
                (pattern == "<local>" && !host.contains('.') && host.parse::<IpAddr>().is_err())
                    || wildcard_matches(&host, &pattern)
                    || wildcard_matches(&format!("{host}:{port}"), &pattern)
            })
        {
            return None;
        }
        if tls {
            self.https.as_ref()
        } else {
            self.http.as_ref()
        }
    }

    pub fn connect(&self, host: &str, port: u16, tls: bool) -> Result<TcpStream, String> {
        if self.listener_port != 0 && port == self.listener_port && is_loopback(host) {
            return Err("拒绝连接抓包代理自身，避免代理循环。".into());
        }
        let Some((proxy_host, proxy_port)) = self.proxy_for(host, port, tls) else {
            return connect_direct(host, port);
        };
        let mut stream = connect_direct(proxy_host, *proxy_port)?;
        let authority = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        write!(
            stream,
            "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n"
        )
        .map_err(|e| e.to_string())?;
        // Read only the response header; TLS/application bytes must stay in the socket.
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() >= 16384 {
                return Err("上游代理响应头过大".into());
            }
            let mut byte = [0];
            stream
                .read_exact(&mut byte)
                .map_err(|e| format!("上游代理握手失败：{e}"))?;
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head);
        if head.split_whitespace().nth(1) != Some("200") {
            return Err(format!(
                "上游代理拒绝连接：{}",
                head.lines().next().unwrap_or_default()
            ));
        }
        Ok(stream)
    }
}

fn connect_direct(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?;
    let mut last_error = "没有可连接的地址".to_string();
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(30)))
                    .map_err(|e| e.to_string())?;
                return Ok(stream);
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(last_error)
}

pub fn connect(host: &str, port: u16, tls: bool) -> Result<TcpStream, String> {
    let routes = ROUTES
        .get_or_init(Default::default)
        .read()
        .expect("upstream routes lock")
        .clone();
    routes.connect(host, port, tls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    #[test]
    fn keeps_original_bypass_and_protocol_routes() {
        let routes = Routes {
            http: Some(("proxy".into(), 7890)),
            https: Some(("secure".into(), 7891)),
            bypass: vec!["*zhihu.com".into(), "192.168.*".into(), "<local>".into()],
            listener_port: 9090,
        };
        assert!(routes.proxy_for("127.0.0.1", 5188, false).is_none());
        assert!(routes.proxy_for("::1", 5188, false).is_none());
        assert!(routes.proxy_for("192.168.1.9", 80, false).is_none());
        assert!(routes.proxy_for("www.zhihu.com", 443, true).is_none());
        assert!(routes.proxy_for("intranet", 80, false).is_none());
        assert_eq!(
            routes.proxy_for("example.com", 443, true),
            routes.https.as_ref()
        );
        assert_eq!(
            routes.proxy_for("example.com", 80, false),
            routes.http.as_ref()
        );
        assert!(routes.connect("127.0.0.1", 9090, false).is_err());
    }
    #[test]
    fn upstream_connect_preserves_bytes_after_header() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            assert!(String::from_utf8_lossy(&head).starts_with("CONNECT example.test:443 HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nhello")
                .unwrap();
        });
        let routes = Routes {
            https: Some(("127.0.0.1".into(), port)),
            ..Routes::default()
        };
        let mut socket = routes.connect("example.test", 443, true).unwrap();
        let mut body = [0; 5];
        socket.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"hello");
        server.join().unwrap();
    }

    #[test]
    fn upstream_auth_failure_is_reported_without_direct_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                .unwrap();
        });
        let routes = Routes {
            https: Some(("127.0.0.1".into(), port)),
            ..Routes::default()
        };
        assert!(routes
            .connect("never-resolve.invalid", 443, true)
            .unwrap_err()
            .contains("407"));
        server.join().unwrap();
    }
}

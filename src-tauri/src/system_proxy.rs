use crate::models::{SystemProxySetting, SystemProxyStatus};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const TARGET_HOST: &str = "127.0.0.1";

#[derive(Clone)]
pub struct SystemProxyManager {
    snapshot_path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
struct SystemProxySnapshot {
    service: String,
    http: SystemProxySetting,
    https: SystemProxySetting,
    socks: SystemProxySetting,
}

impl SystemProxyManager {
    pub fn new(snapshot_path: PathBuf) -> Self {
        Self { snapshot_path }
    }

    pub fn status(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        if !cfg!(target_os = "macos") {
            return Ok(self.unsupported_status(target_port));
        }

        let service = preferred_network_service()?;
        let http = get_proxy_setting(&service, "-getwebproxy")?;
        let https = get_proxy_setting(&service, "-getsecurewebproxy")?;
        let socks = get_proxy_setting(&service, "-getsocksfirewallproxy")?;
        Ok(self.build_status(service, target_port, http, https, socks))
    }

    pub fn apply(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        if !cfg!(target_os = "macos") {
            return Ok(self.unsupported_status(target_port));
        }

        let service = preferred_network_service()?;
        if !self.snapshot_path.exists() {
            let snapshot = SystemProxySnapshot {
                service: service.clone(),
                http: get_proxy_setting(&service, "-getwebproxy")?,
                https: get_proxy_setting(&service, "-getsecurewebproxy")?,
                socks: get_proxy_setting(&service, "-getsocksfirewallproxy")?,
            };
            self.write_snapshot(&snapshot)?;
        }

        let port = target_port.to_string();
        run_networksetup(&["-setwebproxy", &service, TARGET_HOST, &port])?;
        run_networksetup(&["-setwebproxystate", &service, "on"])?;
        run_networksetup(&["-setsecurewebproxy", &service, TARGET_HOST, &port])?;
        run_networksetup(&["-setsecurewebproxystate", &service, "on"])?;
        let _ = run_networksetup(&["-setsocksfirewallproxystate", &service, "off"]);

        self.status(target_port)
    }

    pub fn restore(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        if !cfg!(target_os = "macos") {
            return Ok(self.unsupported_status(target_port));
        }

        let Some(snapshot) = self.read_snapshot()? else {
            let mut status = self.status(target_port)?;
            status.message = "没有可恢复的系统代理快照。".to_string();
            return Ok(status);
        };

        restore_web_proxy(
            &snapshot.service,
            "-setwebproxy",
            "-setwebproxystate",
            &snapshot.http,
        )?;
        restore_web_proxy(
            &snapshot.service,
            "-setsecurewebproxy",
            "-setsecurewebproxystate",
            &snapshot.https,
        )?;
        restore_web_proxy(
            &snapshot.service,
            "-setsocksfirewallproxy",
            "-setsocksfirewallproxystate",
            &snapshot.socks,
        )?;

        let _ = fs::remove_file(&self.snapshot_path);
        let mut status = self.status(target_port)?;
        status.message = format!("已恢复 {} 的系统代理设置。", snapshot.service);
        Ok(status)
    }

    fn build_status(
        &self,
        service: String,
        target_port: u16,
        http: SystemProxySetting,
        https: SystemProxySetting,
        socks: SystemProxySetting,
    ) -> SystemProxyStatus {
        let http_matches = setting_matches(&http, target_port);
        let https_matches = setting_matches(&https, target_port);
        let socks_matches = setting_matches(&socks, target_port);
        let matches_proxy = http_matches && https_matches && !socks.enabled;
        let managed_proxy_active = http_matches || https_matches || socks_matches;
        let can_restore = self.snapshot_path.exists();
        let restore_recommended = can_restore && managed_proxy_active;
        let message = if matches_proxy {
            format!("系统代理已指向 {TARGET_HOST}:{target_port}。")
        } else if restore_recommended {
            format!("检测到上次留下的系统代理仍指向 {TARGET_HOST}:{target_port}，建议恢复原设置。")
        } else if socks.enabled {
            "SOCKS 代理仍处于开启状态，浏览器流量可能没有进入当前抓包代理。".to_string()
        } else {
            format!("系统 HTTP/HTTPS 代理未同时指向 {TARGET_HOST}:{target_port}。")
        };

        SystemProxyStatus {
            supported: true,
            service: Some(service),
            target_host: TARGET_HOST.to_string(),
            target_port,
            http,
            https,
            socks,
            matches_proxy,
            managed_proxy_active,
            can_restore,
            restore_recommended,
            message,
        }
    }

    fn unsupported_status(&self, target_port: u16) -> SystemProxyStatus {
        SystemProxyStatus {
            supported: false,
            service: None,
            target_host: TARGET_HOST.to_string(),
            target_port,
            http: empty_setting(),
            https: empty_setting(),
            socks: empty_setting(),
            matches_proxy: false,
            managed_proxy_active: false,
            can_restore: false,
            restore_recommended: false,
            message: "当前平台暂不支持自动配置系统代理。".to_string(),
        }
    }

    fn write_snapshot(&self, snapshot: &SystemProxySnapshot) -> Result<(), String> {
        if let Some(parent) = self.snapshot_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let payload = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
        fs::write(&self.snapshot_path, payload).map_err(|error| error.to_string())
    }

    fn read_snapshot(&self) -> Result<Option<SystemProxySnapshot>, String> {
        if !self.snapshot_path.exists() {
            return Ok(None);
        }
        let payload = fs::read(&self.snapshot_path).map_err(|error| error.to_string())?;
        serde_json::from_slice(&payload)
            .map(Some)
            .map_err(|error| format!("系统代理快照无法读取：{error}"))
    }
}

fn empty_setting() -> SystemProxySetting {
    SystemProxySetting {
        enabled: false,
        host: String::new(),
        port: None,
    }
}

fn setting_matches(setting: &SystemProxySetting, target_port: u16) -> bool {
    setting.enabled
        && setting.host.trim().eq_ignore_ascii_case(TARGET_HOST)
        && setting.port == Some(target_port)
}

fn preferred_network_service() -> Result<String, String> {
    let services = network_services()?;
    services
        .iter()
        .find(|service| {
            service.eq_ignore_ascii_case("Wi-Fi") || service.eq_ignore_ascii_case("WiFi")
        })
        .cloned()
        .or_else(|| services.into_iter().next())
        .ok_or_else(|| "没有找到可配置的网络服务。".to_string())
}

fn network_services() -> Result<Vec<String>, String> {
    let output = run_networksetup(&["-listallnetworkservices"])?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("An asterisk"))
        .map(|line| line.trim_start_matches('*').trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

fn get_proxy_setting(service: &str, command: &str) -> Result<SystemProxySetting, String> {
    parse_proxy_setting(&run_networksetup(&[command, service])?)
}

fn parse_proxy_setting(output: &str) -> Result<SystemProxySetting, String> {
    let mut enabled = false;
    let mut host = String::new();
    let mut port = None;

    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "enabled" => {
                enabled = matches!(
                    value.to_ascii_lowercase().as_str(),
                    "yes" | "on" | "1" | "true"
                );
            }
            "server" => host = value.to_string(),
            "port" => port = value.parse::<u16>().ok(),
            _ => {}
        }
    }

    Ok(SystemProxySetting {
        enabled,
        host,
        port,
    })
}

fn restore_web_proxy(
    service: &str,
    set_command: &str,
    state_command: &str,
    setting: &SystemProxySetting,
) -> Result<(), String> {
    if setting.enabled {
        if !setting.host.trim().is_empty() {
            let port = setting.port.unwrap_or(0).to_string();
            run_networksetup(&[set_command, service, &setting.host, &port])?;
        }
        run_networksetup(&[state_command, service, "on"])?;
    } else {
        run_networksetup(&[state_command, service, "off"])?;
    }
    Ok(())
}

fn run_networksetup(args: &[&str]) -> Result<String, String> {
    let output = Command::new("networksetup")
        .args(args)
        .output()
        .map_err(|error| format!("networksetup 执行失败：{error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("networksetup {:?} 执行失败。", args)
        } else {
            stderr
        })
    }
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_setting;

    #[test]
    fn parses_enabled_networksetup_proxy_output() {
        let setting = parse_proxy_setting(
            "Enabled: Yes\nServer: 127.0.0.1\nPort: 9090\nAuthenticated Proxy Enabled: 0\n",
        )
        .expect("parse proxy setting");

        assert!(setting.enabled);
        assert_eq!(setting.host, "127.0.0.1");
        assert_eq!(setting.port, Some(9090));
    }

    #[test]
    fn parses_disabled_networksetup_proxy_output() {
        let setting =
            parse_proxy_setting("Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n")
                .expect("parse proxy setting");

        assert!(!setting.enabled);
        assert_eq!(setting.host, "");
        assert_eq!(setting.port, Some(0));
    }
}

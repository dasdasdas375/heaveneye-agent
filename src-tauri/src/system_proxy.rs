use crate::models::{SystemProxySetting, SystemProxyStatus};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const TARGET_HOST: &str = "127.0.0.1";
const WINDOWS_SERVICE_NAME: &str = "Windows Current User Proxy";
const WINDOWS_INTERNET_SETTINGS_KEY: &str =
    "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

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
    #[serde(default)]
    windows: Option<WindowsProxySnapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsProxySnapshot {
    proxy_enable: Option<u32>,
    proxy_server: Option<String>,
    proxy_override: Option<String>,
}

impl SystemProxyManager {
    pub fn new(snapshot_path: PathBuf) -> Self {
        Self { snapshot_path }
    }

    pub fn status(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        if cfg!(target_os = "windows") {
            return self.windows_status(target_port);
        }
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
        if cfg!(target_os = "windows") {
            return self.apply_windows(target_port);
        }
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
                windows: None,
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
        if cfg!(target_os = "windows") {
            return self.restore_windows(target_port);
        }
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

    fn windows_status(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        let settings = read_windows_proxy_snapshot()?;
        let enabled = settings.proxy_enable.unwrap_or(0) != 0;
        let (http, https, socks) =
            parse_windows_proxy_settings(enabled, settings.proxy_server.as_deref().unwrap_or(""));
        Ok(self.build_status(
            WINDOWS_SERVICE_NAME.to_string(),
            target_port,
            http,
            https,
            socks,
        ))
    }

    fn apply_windows(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        if !self.snapshot_path.exists() {
            let snapshot = SystemProxySnapshot {
                service: WINDOWS_SERVICE_NAME.to_string(),
                http: empty_setting(),
                https: empty_setting(),
                socks: empty_setting(),
                windows: Some(read_windows_proxy_snapshot()?),
            };
            self.write_snapshot(&snapshot)?;
        }

        set_windows_proxy(target_port)?;
        self.status(target_port)
    }

    fn restore_windows(&self, target_port: u16) -> Result<SystemProxyStatus, String> {
        let Some(snapshot) = self.read_snapshot()? else {
            let mut status = self.status(target_port)?;
            status.message = "No system proxy snapshot is available to restore.".to_string();
            return Ok(status);
        };
        let Some(windows) = snapshot.windows else {
            let mut status = self.status(target_port)?;
            status.message = "The saved proxy snapshot was not created on Windows.".to_string();
            return Ok(status);
        };

        restore_windows_proxy_snapshot(&windows)?;
        let _ = fs::remove_file(&self.snapshot_path);
        let mut status = self.status(target_port)?;
        status.message = "Restored Windows current-user proxy settings.".to_string();
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

fn read_windows_proxy_snapshot() -> Result<WindowsProxySnapshot, String> {
    let key = powershell_string(WINDOWS_INTERNET_SETTINGS_KEY);
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$path = {key}
if (-not (Test-Path $path)) {{ New-Item -Path $path -Force | Out-Null }}
$item = Get-ItemProperty -Path $path
$proxyEnable = $null
$proxyServer = $null
$proxyOverride = $null
if ($null -ne $item.ProxyEnable) {{ $proxyEnable = [int]$item.ProxyEnable }}
if ($null -ne $item.ProxyServer) {{ $proxyServer = [string]$item.ProxyServer }}
if ($null -ne $item.ProxyOverride) {{ $proxyOverride = [string]$item.ProxyOverride }}
[pscustomobject]@{{
  proxyEnable = $proxyEnable
  proxyServer = $proxyServer
  proxyOverride = $proxyOverride
}} | ConvertTo-Json -Compress
"#
    );
    let output = run_powershell(&script)?;
    serde_json::from_str(output.trim()).map_err(|error| error.to_string())
}

fn set_windows_proxy(target_port: u16) -> Result<(), String> {
    let key = powershell_string(WINDOWS_INTERNET_SETTINGS_KEY);
    let proxy_server =
        powershell_string(&format!("http={TARGET_HOST}:{target_port};https={TARGET_HOST}:{target_port}"));
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$path = {key}
if (-not (Test-Path $path)) {{ New-Item -Path $path -Force | Out-Null }}
New-ItemProperty -Path $path -Name ProxyEnable -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path $path -Name ProxyServer -PropertyType String -Value {proxy_server} -Force | Out-Null
{notify}
"#,
        notify = windows_proxy_refresh_script(),
    );
    run_powershell(&script).map(|_| ())
}

fn restore_windows_proxy_snapshot(snapshot: &WindowsProxySnapshot) -> Result<(), String> {
    let key = powershell_string(WINDOWS_INTERNET_SETTINGS_KEY);
    let proxy_enable_statement = match snapshot.proxy_enable {
        Some(value) => format!(
            "New-ItemProperty -Path $path -Name ProxyEnable -PropertyType DWord -Value {value} -Force | Out-Null"
        ),
        None => {
            "Remove-ItemProperty -Path $path -Name ProxyEnable -ErrorAction SilentlyContinue"
                .to_string()
        }
    };
    let proxy_server_statement =
        windows_restore_string_property("ProxyServer", snapshot.proxy_server.as_deref());
    let proxy_override_statement =
        windows_restore_string_property("ProxyOverride", snapshot.proxy_override.as_deref());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$path = {key}
if (-not (Test-Path $path)) {{ New-Item -Path $path -Force | Out-Null }}
{proxy_enable_statement}
{proxy_server_statement}
{proxy_override_statement}
{notify}
"#,
        notify = windows_proxy_refresh_script(),
    );
    run_powershell(&script).map(|_| ())
}

fn windows_restore_string_property(name: &str, value: Option<&str>) -> String {
    match value {
        Some(value) => format!(
            "New-ItemProperty -Path $path -Name {name} -PropertyType String -Value {value} -Force | Out-Null",
            name = powershell_string(name),
            value = powershell_string(value)
        ),
        None => format!(
            "Remove-ItemProperty -Path $path -Name {name} -ErrorAction SilentlyContinue",
            name = powershell_string(name)
        ),
    }
}

fn parse_windows_proxy_settings(
    enabled: bool,
    proxy_server: &str,
) -> (SystemProxySetting, SystemProxySetting, SystemProxySetting) {
    let mut http = empty_setting();
    let mut https = empty_setting();
    let mut socks = empty_setting();
    let entries = proxy_server
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();

    if entries.is_empty() {
        return (http, https, socks);
    }

    let has_protocol_entries = entries.iter().any(|entry| entry.contains('='));
    if !has_protocol_entries {
        http = windows_proxy_setting(enabled, entries[0]);
        https = http.clone();
        return (http, https, socks);
    }

    for entry in entries {
        let Some((scheme, endpoint)) = entry.split_once('=') else {
            continue;
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = windows_proxy_setting(enabled, endpoint),
            "https" | "secure" => https = windows_proxy_setting(enabled, endpoint),
            "socks" | "socks4" | "socks5" => socks = windows_proxy_setting(enabled, endpoint),
            _ => {}
        }
    }

    (http, https, socks)
}

fn windows_proxy_setting(enabled: bool, endpoint: &str) -> SystemProxySetting {
    let (host, port) = parse_windows_proxy_endpoint(endpoint);
    SystemProxySetting {
        enabled: enabled && !host.is_empty(),
        host,
        port,
    }
}

fn parse_windows_proxy_endpoint(endpoint: &str) -> (String, Option<u16>) {
    let value = endpoint
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks://");
    if value.is_empty() {
        return (String::new(), None);
    }

    if let Some(rest) = value.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = rest[..end].to_string();
            let port = rest[end + 1..]
                .strip_prefix(':')
                .and_then(|value| value.parse::<u16>().ok());
            return (host, port);
        }
    }

    if let Some((host, port)) = value.rsplit_once(':') {
        if !host.contains(':') {
            return (host.to_string(), port.parse::<u16>().ok());
        }
    }

    (value.to_string(), None)
}

fn windows_proxy_refresh_script() -> &'static str {
    r#"
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class HeavenEyeWinInetRefresh {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
[HeavenEyeWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[HeavenEyeWinInetRefresh]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
"#
}

fn run_powershell(script: &str) -> Result<String, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("powershell.exe failed to start: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }

    let message = [stdout, stderr]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(if message.is_empty() {
        "PowerShell command failed.".into()
    } else {
        message
    })
}

fn powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
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
    use super::{parse_proxy_setting, parse_windows_proxy_settings};

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

    #[test]
    fn parses_windows_per_scheme_proxy_server() {
        let (http, https, socks) = parse_windows_proxy_settings(
            true,
            "http=127.0.0.1:9090;https=127.0.0.1:9090;socks=127.0.0.1:1080",
        );

        assert!(http.enabled);
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(http.port, Some(9090));
        assert!(https.enabled);
        assert_eq!(https.host, "127.0.0.1");
        assert_eq!(https.port, Some(9090));
        assert!(socks.enabled);
        assert_eq!(socks.port, Some(1080));
    }

    #[test]
    fn parses_windows_single_proxy_for_http_and_https() {
        let (http, https, socks) = parse_windows_proxy_settings(true, "127.0.0.1:9090");

        assert!(http.enabled);
        assert!(https.enabled);
        assert!(!socks.enabled);
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(https.host, "127.0.0.1");
        assert_eq!(http.port, Some(9090));
        assert_eq!(https.port, Some(9090));
    }

    #[test]
    fn keeps_windows_proxy_values_disabled_when_proxy_enable_is_off() {
        let (http, https, _) =
            parse_windows_proxy_settings(false, "http=127.0.0.1:9090;https=127.0.0.1:9090");

        assert!(!http.enabled);
        assert!(!https.enabled);
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(https.port, Some(9090));
    }
}

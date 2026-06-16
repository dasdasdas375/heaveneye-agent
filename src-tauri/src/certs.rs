use crate::models::{AppConfig, CertInfo};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const ROOT_CERT_FILE: &str = "heaveneye-agent-root-ca.pem";
const ROOT_KEY_FILE: &str = "heaveneye-agent-root-ca-key.pem";
const ROOT_CERT_COMMON_NAME: &str = "HeavenEye Agent Local Root CA";
const SYSTEM_KEYCHAIN_PATH: &str = "/Library/Keychains/System.keychain";
const WINDOWS_ROOT_STORE: &str = "Cert:\\CurrentUser\\Root";
static ROOT_CERT_GENERATION_LOCK: Mutex<()> = Mutex::new(());
static HOST_CERT_GENERATION_LOCK: Mutex<()> = Mutex::new(());

pub struct RootCertificateInfo {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

pub struct HostCertificateInfo {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

pub struct CertificateService {
    cert_dir: PathBuf,
    host_cert_dir: PathBuf,
}

impl CertificateService {
    pub fn new(config: &AppConfig) -> Self {
        let cert_dir = PathBuf::from(&config.cert_dir);
        let host_cert_dir = cert_dir.join("hosts");
        Self {
            cert_dir,
            host_cert_dir,
        }
    }

    pub fn root_cert_path(&self) -> PathBuf {
        self.cert_dir.join(ROOT_CERT_FILE)
    }

    pub fn root_key_path(&self) -> PathBuf {
        self.cert_dir.join(ROOT_KEY_FILE)
    }

    fn serial_path(&self) -> PathBuf {
        self.cert_dir.join("heaveneye-agent-root-ca.srl")
    }

    fn ensure_dirs(&self) -> Result<(), String> {
        fs::create_dir_all(&self.cert_dir).map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.host_cert_dir).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn ensure_root_certificate(&self) -> Result<RootCertificateInfo, String> {
        let _guard = ROOT_CERT_GENERATION_LOCK
            .lock()
            .map_err(|_| "root certificate lock poisoned".to_string())?;
        self.ensure_dirs()?;
        let cert_path = self.root_cert_path();
        let key_path = self.root_key_path();
        if cert_path.exists() && key_path.exists() {
            return Ok(RootCertificateInfo {
                cert_path,
                key_path,
            });
        }

        let key_pair = KeyPair::generate().map_err(|error| error.to_string())?;
        let cert = root_certificate_params()
            .self_signed(&key_pair)
            .map_err(|error| error.to_string())?;
        fs::write(&cert_path, cert.pem()).map_err(|error| error.to_string())?;
        fs::write(&key_path, key_pair.serialize_pem()).map_err(|error| error.to_string())?;

        Ok(RootCertificateInfo {
            cert_path,
            key_path,
        })
    }

    pub fn ensure_host_certificate(&self, host: &str) -> Result<HostCertificateInfo, String> {
        let _guard = HOST_CERT_GENERATION_LOCK
            .lock()
            .map_err(|_| "host certificate lock poisoned".to_string())?;
        let root = self.ensure_root_certificate()?;
        let file_stem = sanitize_host(host);
        let cert_path = self.host_cert_dir.join(format!("{file_stem}.pem"));
        let key_path = self.host_cert_dir.join(format!("{file_stem}-key.pem"));
        if non_empty_file(&cert_path) && non_empty_file(&key_path) {
            return Ok(HostCertificateInfo {
                cert_path,
                key_path,
            });
        }

        let _ = fs::remove_file(&cert_path);
        let _ = fs::remove_file(&key_path);

        let root_cert_pem =
            fs::read_to_string(&root.cert_path).map_err(|error| error.to_string())?;
        let root_key_pem =
            fs::read_to_string(&root.key_path).map_err(|error| error.to_string())?;
        let root_key = KeyPair::from_pem(&root_key_pem).map_err(|error| error.to_string())?;
        let issuer = Issuer::from_ca_cert_pem(&root_cert_pem, root_key)
            .map_err(|error| error.to_string())?;
        let host_key = KeyPair::generate().map_err(|error| error.to_string())?;
        let cert = host_certificate_params(host)?
            .signed_by(&host_key, &issuer)
            .map_err(|error| error.to_string())?;
        fs::write(&cert_path, cert.pem()).map_err(|error| error.to_string())?;
        fs::write(&key_path, host_key.serialize_pem()).map_err(|error| error.to_string())?;

        Ok(HostCertificateInfo {
            cert_path,
            key_path,
        })
    }

    pub fn cert_info(&self) -> Result<CertInfo, String> {
        let root = self.ensure_root_certificate()?;
        let (trusted, message) = trust_status(&root.cert_path);
        let can_manage_certificate = cfg!(target_os = "macos") || cfg!(target_os = "windows");
        Ok(CertInfo {
            trusted,
            platform: std::env::consts::OS.to_string(),
            cert_path: root.cert_path.display().to_string(),
            can_install: can_manage_certificate,
            can_uninstall: can_manage_certificate,
            needs_admin: cfg!(target_os = "macos"),
            message,
        })
    }

    pub fn install_root_certificate(&self) -> Result<CertInfo, String> {
        if !cfg!(target_os = "macos") && !cfg!(target_os = "windows") {
            return Err("当前平台暂不支持自动安装根证书。".to_string());
        }

        let root = self.ensure_root_certificate()?;
        let (trusted, _) = trust_status(&root.cert_path);
        if trusted {
            return self.cert_info();
        }

        if cfg!(target_os = "windows") {
            install_windows_root_certificate(&root.cert_path)?;
            return self.cert_info();
        }

        let script = format!(
            "while /usr/bin/security find-certificate -c {common_name} {keychain} >/dev/null 2>&1; do /usr/bin/security delete-certificate -c {common_name} {keychain} >/dev/null 2>&1 || exit 1; done\n/usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k {keychain} {cert_path}",
            common_name = shell_quote(ROOT_CERT_COMMON_NAME),
            keychain = shell_quote(SYSTEM_KEYCHAIN_PATH),
            cert_path = shell_quote(&root.cert_path.display().to_string()),
        );
        run_admin_shell_script(&script)?;
        self.cert_info()
    }

    pub fn uninstall_root_certificate(&self) -> Result<CertInfo, String> {
        if !cfg!(target_os = "macos") && !cfg!(target_os = "windows") {
            return Err("当前平台暂不支持自动移除根证书。".to_string());
        }

        if cfg!(target_os = "windows") {
            uninstall_windows_root_certificate()?;
            self.remove_local_certificate_files();
            return self.cert_info();
        }

        if certificate_exists_in_system_keychain() {
            let script = format!(
                "while /usr/bin/security find-certificate -c {common_name} {keychain} >/dev/null 2>&1; do /usr/bin/security delete-certificate -c {common_name} {keychain} >/dev/null 2>&1 || exit 1; done",
                common_name = shell_quote(ROOT_CERT_COMMON_NAME),
                keychain = shell_quote(SYSTEM_KEYCHAIN_PATH),
            );
            run_admin_shell_script(&script)?;
        }

        self.remove_local_certificate_files();
        self.cert_info()
    }

    fn remove_local_certificate_files(&self) {
        let _ = fs::remove_file(self.root_cert_path());
        let _ = fs::remove_file(self.root_key_path());
        let _ = fs::remove_file(self.serial_path());
        let _ = fs::remove_file(self.cert_dir.join("openssl-root.cnf"));
        let _ = fs::remove_dir_all(&self.host_cert_dir);
    }
}

fn sanitize_host(host: &str) -> String {
    host.chars()
        .map(|char| match char {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' => char,
            _ => '_',
        })
        .collect()
}

fn non_empty_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn root_certificate_params() -> CertificateParams {
    let mut distinguished_name = DistinguishedName::new();
    distinguished_name.push(DnType::CommonName, ROOT_CERT_COMMON_NAME);
    distinguished_name.push(DnType::OrganizationName, "HeavenEye Agent");
    distinguished_name.push(DnType::OrganizationalUnitName, "Local Debugging");

    let mut params = CertificateParams::default();
    params.distinguished_name = distinguished_name;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params
}

fn host_certificate_params(host: &str) -> Result<CertificateParams, String> {
    let mut params = CertificateParams::new(vec![host.to_string()])
        .map_err(|error| error.to_string())?;
    let mut distinguished_name = DistinguishedName::new();
    distinguished_name.push(DnType::CommonName, host);
    distinguished_name.push(DnType::OrganizationName, "HeavenEye Agent");
    params.distinguished_name = distinguished_name;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    Ok(params)
}

fn certificate_exists_in_system_keychain() -> bool {
    Command::new("security")
        .args([
            "find-certificate",
            "-c",
            ROOT_CERT_COMMON_NAME,
            SYSTEM_KEYCHAIN_PATH,
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn run_admin_shell_script(script: &str) -> Result<(), String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(format!(
            "do shell script {} with administrator privileges",
            apple_script_string(script)
        ))
        .output()
        .map_err(|error| format!("管理员授权命令启动失败：{error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = [stdout, stderr]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(if message.is_empty() {
        "管理员授权命令执行失败。".into()
    } else {
        message
    })
}

fn install_windows_root_certificate(cert_path: &Path) -> Result<(), String> {
    let cert_path = powershell_string(&cert_path.display().to_string());
    let store = powershell_string(WINDOWS_ROOT_STORE);
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$certPath = {cert_path}
$store = {store}
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
Get-ChildItem -Path $store |
  Where-Object {{ $_.Subject -eq $cert.Subject -or $_.Thumbprint -eq $cert.Thumbprint }} |
  Remove-Item -Force
Import-Certificate -FilePath $certPath -CertStoreLocation $store | Out-Null
"#
    );
    run_powershell(&script).map(|_| ())
}

fn uninstall_windows_root_certificate() -> Result<(), String> {
    let store = powershell_string(WINDOWS_ROOT_STORE);
    let common_name = powershell_string(ROOT_CERT_COMMON_NAME);
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$store = {store}
$commonName = {common_name}
Get-ChildItem -Path $store |
  Where-Object {{ $_.Subject -like "*CN=$commonName*" }} |
  Remove-Item -Force
"#
    );
    run_powershell(&script).map(|_| ())
}

fn windows_trust_status(cert_path: &Path) -> (bool, String) {
    let cert_path = powershell_string(&cert_path.display().to_string());
    let store = powershell_string(WINDOWS_ROOT_STORE);
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$certPath = {cert_path}
$store = {store}
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
$match = Get-ChildItem -Path $store |
  Where-Object {{ $_.Thumbprint -eq $cert.Thumbprint }} |
  Select-Object -First 1
if ($null -eq $match) {{
  Write-Output 'Root certificate is not trusted in the Windows Current User Root store.'
  exit 2
}}
Write-Output 'Root certificate is trusted in the Windows Current User Root store.'
"#
    );

    match run_powershell(&script) {
        Ok(output) => (true, output.trim().to_string()),
        Err(error) => (false, error),
    }
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn trust_status(cert_path: &Path) -> (bool, String) {
    if cfg!(target_os = "macos") && cert_path.exists() {
        match Command::new("security")
            .args(["verify-cert", "-c"])
            .arg(cert_path)
            .args(["-p", "ssl"])
            .output()
        {
            Ok(output) if output.status.success() => {
                (true, "Root certificate is trusted for SSL.".into())
            }
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let details = [stdout, stderr]
                    .into_iter()
                    .filter(|item| !item.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                (
                    false,
                    if details.is_empty() {
                        "Root certificate is not trusted.".into()
                    } else {
                        details
                    },
                )
            }
            Err(error) => (false, format!("Failed to verify root certificate: {error}")),
        }
    } else if cfg!(target_os = "windows") && cert_path.exists() {
        windows_trust_status(cert_path)
    } else if cert_path.exists() {
        (
            false,
            "Root certificate exists, but automatic trust checks are implemented for macOS and Windows only.".into(),
        )
    } else {
        (false, "Root certificate is not available yet.".into())
    }
}

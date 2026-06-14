use crate::models::{AppConfig, CertInfo};
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const ROOT_CERT_FILE: &str = "heaveneye-agent-root-ca.pem";
const ROOT_KEY_FILE: &str = "heaveneye-agent-root-ca-key.pem";
const ROOT_CERT_COMMON_NAME: &str = "HeavenEye Agent Local Root CA";
const SYSTEM_KEYCHAIN_PATH: &str = "/Library/Keychains/System.keychain";
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

        let config_path = self.cert_dir.join("openssl-root.cnf");
        let config = r#"[req]
prompt = no
default_bits = 2048
default_md = sha256
distinguished_name = dn
x509_extensions = v3_ca

[dn]
CN = HeavenEye Agent Local Root CA
O = HeavenEye Agent
OU = Local Debugging

[v3_ca]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign,digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
"#;
        fs::write(&config_path, config).map_err(|error| error.to_string())?;

        run_openssl(
            Command::new("openssl")
                .arg("req")
                .arg("-x509")
                .arg("-newkey")
                .arg("rsa:2048")
                .arg("-keyout")
                .arg(&key_path)
                .arg("-out")
                .arg(&cert_path)
                .arg("-days")
                .arg("3650")
                .arg("-sha256")
                .arg("-nodes")
                .arg("-config")
                .arg(&config_path),
        )?;

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

        let csr_path = self.host_cert_dir.join(format!("{file_stem}.csr"));
        let ext_path = self.host_cert_dir.join(format!("{file_stem}.ext"));
        for path in [&cert_path, &key_path, &csr_path, &ext_path] {
            let _ = fs::remove_file(path);
        }
        let ext_content = build_host_ext_file(host);
        fs::write(&ext_path, ext_content).map_err(|error| error.to_string())?;

        run_openssl(
            Command::new("openssl")
                .arg("req")
                .arg("-new")
                .arg("-newkey")
                .arg("rsa:2048")
                .arg("-keyout")
                .arg(&key_path)
                .arg("-out")
                .arg(&csr_path)
                .arg("-nodes")
                .arg("-subj")
                .arg(format!(
                    "/CN={}/O=HeavenEye Agent",
                    openssl_subject_value(host)
                )),
        )?;

        run_openssl(
            Command::new("openssl")
                .arg("x509")
                .arg("-req")
                .arg("-in")
                .arg(&csr_path)
                .arg("-CA")
                .arg(&root.cert_path)
                .arg("-CAkey")
                .arg(&root.key_path)
                .arg("-CAcreateserial")
                .arg("-CAserial")
                .arg(self.serial_path())
                .arg("-out")
                .arg(&cert_path)
                .arg("-days")
                .arg("825")
                .arg("-sha256")
                .arg("-extfile")
                .arg(&ext_path),
        )?;

        let _ = fs::remove_file(csr_path);
        let _ = fs::remove_file(ext_path);

        Ok(HostCertificateInfo {
            cert_path,
            key_path,
        })
    }

    pub fn cert_info(&self) -> Result<CertInfo, String> {
        let root = self.ensure_root_certificate()?;
        let (trusted, message) = trust_status(&root.cert_path);
        Ok(CertInfo {
            trusted,
            platform: std::env::consts::OS.to_string(),
            cert_path: root.cert_path.display().to_string(),
            can_install: cfg!(target_os = "macos"),
            can_uninstall: cfg!(target_os = "macos"),
            needs_admin: cfg!(target_os = "macos"),
            message,
        })
    }

    pub fn install_root_certificate(&self) -> Result<CertInfo, String> {
        if !cfg!(target_os = "macos") {
            return Err("当前平台暂不支持自动安装根证书。".to_string());
        }

        let root = self.ensure_root_certificate()?;
        let (trusted, _) = trust_status(&root.cert_path);
        if trusted {
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
        if !cfg!(target_os = "macos") {
            return Err("当前平台暂不支持自动移除根证书。".to_string());
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

fn openssl_subject_value(value: &str) -> String {
    value
        .chars()
        .flat_map(|char| match char {
            '/' | '\\' => vec!['\\', char],
            _ => vec![char],
        })
        .collect()
}

fn build_host_ext_file(host: &str) -> String {
    let alt_name = if host.parse::<IpAddr>().is_ok() {
        format!("IP.1 = {host}")
    } else {
        format!("DNS.1 = {host}")
    };
    format!(
        "authorityKeyIdentifier=keyid,issuer\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=@alt_names\n\n[alt_names]\n{alt_name}\n"
    )
}

fn run_openssl(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|error| error.to_string())?;
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
        "openssl command failed".into()
    } else {
        message
    })
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
    } else if cert_path.exists() {
        (
            false,
            "Root certificate exists, but automatic trust checks are currently implemented for macOS only.".into(),
        )
    } else {
        (false, "Root certificate is not available yet.".into())
    }
}

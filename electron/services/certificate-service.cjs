const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const forge = require("node-forge");

const execFileAsync = promisify(execFile);
const ROOT_CERT_FILE = "heaveneye-agent-root-ca.pem";
const ROOT_KEY_FILE = "heaveneye-agent-root-ca-key.pem";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function pemToForgeCert(pem) {
  return forge.pki.certificateFromPem(pem);
}

function pemToForgeKey(pem) {
  return forge.pki.privateKeyFromPem(pem);
}

function createSerial() {
  return crypto.randomBytes(16).toString("hex");
}

function createValidity(days) {
  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + days);
  return { notBefore, notAfter };
}

function safeHostFileName(host) {
  return host.replace(/[^a-zA-Z0-9.-]/g, "_");
}

function altNameForHost(host) {
  const ipVersion = net.isIP(host);
  if (ipVersion) {
    return {
      type: 7,
      ip: host,
    };
  }

  return {
    type: 2,
    value: host,
  };
}

class CertificateService {
  constructor({ certDir }) {
    this.certDir = certDir;
    this.rootCertPath = path.join(certDir, ROOT_CERT_FILE);
    this.rootKeyPath = path.join(certDir, ROOT_KEY_FILE);
    this.hostCertDir = path.join(certDir, "hosts");
    this.cache = new Map();
  }

  ensureRootCertificate() {
    ensureDir(this.certDir);
    ensureDir(this.hostCertDir);

    if (fs.existsSync(this.rootCertPath) && fs.existsSync(this.rootKeyPath)) {
      return {
        certPath: this.rootCertPath,
        keyPath: this.rootKeyPath,
        certPem: fs.readFileSync(this.rootCertPath, "utf8"),
        keyPem: fs.readFileSync(this.rootKeyPath, "utf8"),
      };
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    const validity = createValidity(3650);

    cert.publicKey = keys.publicKey;
    cert.serialNumber = createSerial();
    cert.validity.notBefore = validity.notBefore;
    cert.validity.notAfter = validity.notAfter;

    const attrs = [
      { name: "commonName", value: "HeavenEye Agent Local Root CA" },
      { name: "organizationName", value: "HeavenEye Agent" },
      { shortName: "OU", value: "Local Debugging" },
    ];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      {
        name: "keyUsage",
        keyCertSign: true,
        digitalSignature: true,
        cRLSign: true,
        critical: true,
      },
      {
        name: "subjectKeyIdentifier",
      },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

    fs.writeFileSync(this.rootCertPath, certPem, { mode: 0o600 });
    fs.writeFileSync(this.rootKeyPath, keyPem, { mode: 0o600 });

    return {
      certPath: this.rootCertPath,
      keyPath: this.rootKeyPath,
      certPem,
      keyPem,
    };
  }

  getRootCertificateInfo() {
    const root = this.ensureRootCertificate();
    return {
      certPath: root.certPath,
      keyPath: root.keyPath,
    };
  }

  async getTrustStatus() {
    const root = this.ensureRootCertificate();

    if (process.platform !== "darwin") {
      return {
        trusted: false,
        platform: process.platform,
        certPath: root.certPath,
        message: "Automatic trust checks are currently implemented for macOS only.",
      };
    }

    try {
      await execFileAsync("security", ["verify-cert", "-c", root.certPath, "-p", "ssl"]);
      return {
        trusted: true,
        platform: process.platform,
        certPath: root.certPath,
        message: "Root certificate is trusted for SSL.",
      };
    } catch (error) {
      const details = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
      return {
        trusted: false,
        platform: process.platform,
        certPath: root.certPath,
        message: details || "Root certificate is not trusted.",
      };
    }
  }

  getCertificateForHost(host) {
    if (this.cache.has(host)) {
      return this.cache.get(host);
    }

    const root = this.ensureRootCertificate();
    const fileName = safeHostFileName(host);
    const certPath = path.join(this.hostCertDir, `${fileName}.pem`);
    const keyPath = path.join(this.hostCertDir, `${fileName}-key.pem`);

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const result = {
        cert: fs.readFileSync(certPath, "utf8"),
        key: fs.readFileSync(keyPath, "utf8"),
      };
      this.cache.set(host, result);
      return result;
    }

    const rootCert = pemToForgeCert(root.certPem);
    const rootKey = pemToForgeKey(root.keyPem);
    const hostKeys = forge.pki.rsa.generateKeyPair(2048);
    const hostCert = forge.pki.createCertificate();
    const validity = createValidity(825);

    hostCert.publicKey = hostKeys.publicKey;
    hostCert.serialNumber = createSerial();
    hostCert.validity.notBefore = validity.notBefore;
    hostCert.validity.notAfter = validity.notAfter;
    hostCert.setSubject([
      { name: "commonName", value: host },
      { name: "organizationName", value: "HeavenEye Agent" },
    ]);
    hostCert.setIssuer(rootCert.subject.attributes);
    hostCert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      {
        name: "extKeyUsage",
        serverAuth: true,
      },
      {
        name: "subjectAltName",
        altNames: [altNameForHost(host)],
      },
    ]);
    hostCert.sign(rootKey, forge.md.sha256.create());

    const result = {
      cert: forge.pki.certificateToPem(hostCert),
      key: forge.pki.privateKeyToPem(hostKeys.privateKey),
    };

    fs.writeFileSync(certPath, result.cert, { mode: 0o600 });
    fs.writeFileSync(keyPath, result.key, { mode: 0o600 });
    this.cache.set(host, result);
    return result;
  }
}

module.exports = { CertificateService };

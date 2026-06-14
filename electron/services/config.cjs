const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

function loadEnvFile(fileName) {
  const filePath = path.join(process.cwd(), fileName);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
  }
}

function loadConfig() {
  loadEnvFile(".env");
  loadEnvFile(".env.local");

  return {
    proxyPort: Number(process.env.APP_PROXY_PORT || 9090),
    certDir: process.env.CERT_DIR || path.join(process.cwd(), ".local-certs"),
    captureHosts: parseList(process.env.CAPTURE_HOSTS || process.env.SSL_PROXY_HOSTS || ""),
    sslProxyHosts: parseList(process.env.SSL_PROXY_HOSTS || ""),
    qwen: {
      apiKey: process.env.QWEN_API_KEY || "",
      baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: process.env.QWEN_MODEL || "qwen3.7-max",
      visionModel: process.env.QWEN_VISION_MODEL || "qwen3-vl-plus",
    },
  };
}

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = { loadConfig };

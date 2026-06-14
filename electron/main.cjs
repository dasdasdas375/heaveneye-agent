const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { loadConfig } = require("./services/config.cjs");
const { CaptureStore } = require("./services/capture-store.cjs");
const { CertificateService } = require("./services/certificate-service.cjs");
const { ProxyService } = require("./services/proxy-service.cjs");
const { QwenClient } = require("./services/qwen-client.cjs");
const { registerIpc } = require("./ipc/register-ipc.cjs");

const config = loadConfig();
const captureStore = new CaptureStore();
const certificateService = new CertificateService({
  certDir: config.certDir,
});
const proxyService = new ProxyService({
  captureStore,
  certificateService,
  defaultPort: config.proxyPort,
  captureHosts: config.captureHosts,
  sslProxyHosts: config.sslProxyHosts,
});
const qwenClient = new QwenClient(config.qwen);

registerIpc({
  app,
  config,
  proxyService,
  captureStore,
  certificateService,
  qwenClient,
});

const createWindow = async () => {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: "HeavenEye Agent",
    backgroundColor: "#101214",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
};

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  proxyService.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  proxyService.stop();
});

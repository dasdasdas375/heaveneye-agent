const { ipcMain, shell } = require("electron");

function registerIpc({ config, proxyService, captureStore, certificateService, qwenClient }) {
  ipcMain.handle("app:get-config", () => ({
    proxyPort: config.proxyPort,
    certDir: config.certDir,
    captureHosts: config.captureHosts,
    sslProxyHosts: config.sslProxyHosts,
    qwen: {
      baseUrl: config.qwen.baseUrl,
      model: config.qwen.model,
      visionModel: config.qwen.visionModel,
      hasApiKey: Boolean(config.qwen.apiKey),
    },
  }));

  ipcMain.handle("proxy:start", async (_event, payload = {}) => {
    const port = Number(payload.port || config.proxyPort);
    await proxyService.start(port);
    return proxyService.status();
  });

  ipcMain.handle("proxy:stop", async () => {
    await proxyService.stop();
    return proxyService.status();
  });

  ipcMain.handle("proxy:status", () => proxyService.status());
  ipcMain.handle("proxy:set-capture-hosts", (_event, payload = {}) =>
    proxyService.setCaptureHosts(payload.hosts || payload.host || ""),
  );
  ipcMain.handle("proxy:flows", () => captureStore.list());
  ipcMain.handle("proxy:body", (_event, payload = {}) =>
    proxyService.bodyContent(payload.flowId || payload.id || "", payload.direction || "response"),
  );
  ipcMain.handle("proxy:clear", () => {
    captureStore.clear();
    return captureStore.list();
  });

  ipcMain.handle("cert:info", () => certificateService.getTrustStatus());
  ipcMain.handle("cert:open-root", async () => {
    const info = certificateService.getRootCertificateInfo();
    shell.showItemInFolder(info.certPath);
    return info;
  });

  ipcMain.handle("ai:test-connection", () => qwenClient.testConnection());
  ipcMain.handle("ai:analyze-failures", (_event, payload = {}) =>
    qwenClient.analyzeFailures(payload.flows || captureStore.list()),
  );
  ipcMain.handle("ai:compare-flows", (_event, payload = {}) =>
    qwenClient.compareFlows(payload.left, payload.right),
  );
  ipcMain.handle("ai:generate-bug-report", (_event, payload = {}) =>
    qwenClient.generateBugReport(payload.flows || captureStore.list(), payload.note || ""),
  );
  ipcMain.handle("ai:ask-agent", (_event, payload = {}) =>
    qwenClient.askAgent({
      question: payload.question || "",
      flows: payload.flows || captureStore.list(),
      history: payload.history || [],
      attachments: payload.attachments || [],
    }),
  );
}

module.exports = { registerIpc };

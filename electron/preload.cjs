const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("packetAgent", {
  getConfig: () => invoke("app:get-config"),
  proxy: {
    start: (payload) => invoke("proxy:start", payload),
    stop: () => invoke("proxy:stop"),
    status: () => invoke("proxy:status"),
    setCaptureHosts: (payload) => invoke("proxy:set-capture-hosts", payload),
    flows: () => invoke("proxy:flows"),
    body: (payload) => invoke("proxy:body", payload),
    clear: () => invoke("proxy:clear"),
  },
  cert: {
    info: () => invoke("cert:info"),
    openRoot: () => invoke("cert:open-root"),
  },
  ai: {
    testConnection: () => invoke("ai:test-connection"),
    analyzeFailures: (payload) => invoke("ai:analyze-failures", payload),
    compareFlows: (payload) => invoke("ai:compare-flows", payload),
    generateBugReport: (payload) => invoke("ai:generate-bug-report", payload),
    askAgent: (payload) => invoke("ai:ask-agent", payload),
  },
});

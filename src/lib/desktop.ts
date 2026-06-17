import type {
  AgentAttachment,
  AgentChatMessage,
  AiConfigUpdate,
  AiResult,
  AppConfig,
  BreakpointDecision,
  BreakpointRequest,
  CaptureBodyContent,
  CaptureFlow,
  CertInfo,
  ProxyRule,
  ProxyStatus,
  RequestDraft,
  ReplayResult,
  SystemProxyStatus,
  WeakNetworkProfile,
} from "../types";

type InvokeArgs = Record<string, unknown> | undefined;
type TauriInvoke = <T>(command: string, args?: InvokeArgs) => Promise<T>;

export type DesktopBackend = {
  getConfig: () => Promise<AppConfig>;
  openUrl: (payload: { url: string }) => Promise<void>;
  proxy: {
    start: (payload?: { port?: number }) => Promise<ProxyStatus>;
    stop: () => Promise<ProxyStatus>;
    status: () => Promise<ProxyStatus>;
    setCaptureHosts: (payload: { hosts: string }) => Promise<ProxyStatus>;
    flows: () => Promise<CaptureFlow[]>;
    body: (payload: { flowId: string; direction: "request" | "response" }) => Promise<CaptureBodyContent>;
    clear: () => Promise<CaptureFlow[]>;
    replay: (payload: { flow: CaptureFlow }) => Promise<ReplayResult>;
    sendDraft: (payload: { draft: RequestDraft }) => Promise<ReplayResult>;
    importFlows: (payload: { flows: CaptureFlow[] }) => Promise<CaptureFlow[]>;
    rules: () => Promise<ProxyRule[]>;
    setRules: (payload: { rules: ProxyRule[] }) => Promise<ProxyRule[]>;
    weakNetwork: () => Promise<WeakNetworkProfile>;
    setWeakNetwork: (payload: { profile: WeakNetworkProfile }) => Promise<WeakNetworkProfile>;
    breakpoints: () => Promise<BreakpointRequest[]>;
    resolveBreakpoint: (payload: { decision: BreakpointDecision }) => Promise<BreakpointRequest[]>;
  };
  cert: {
    info: () => Promise<CertInfo>;
    installRoot: () => Promise<CertInfo>;
    uninstallRoot: () => Promise<CertInfo>;
    openRoot: () => Promise<{ certPath: string; keyPath: string }>;
  };
  systemProxy: {
    status: () => Promise<SystemProxyStatus>;
    apply: () => Promise<SystemProxyStatus>;
    restore: () => Promise<SystemProxyStatus>;
  };
  ai: {
    updateConfig: (payload: { settings: AiConfigUpdate }) => Promise<AppConfig>;
    testConnection: () => Promise<{
      ok: boolean;
      model: string;
      message: string;
      usage: AiResult["usage"];
    }>;
    analyzeFailures: (payload?: { flows?: CaptureFlow[] }) => Promise<AiResult>;
    compareFlows: (payload: { left: CaptureFlow; right: CaptureFlow }) => Promise<AiResult>;
    generateBugReport: (payload?: { flows?: CaptureFlow[]; note?: string }) => Promise<AiResult>;
    askAgent: (payload: {
      question: string;
      flows?: CaptureFlow[];
      history?: AgentChatMessage[];
      attachments?: AgentAttachment[];
    }) => Promise<AiResult>;
    askAgentStream: (payload: {
      streamId: string;
      question: string;
      flows?: CaptureFlow[];
      history?: AgentChatMessage[];
      attachments?: AgentAttachment[];
    }) => Promise<AiResult>;
  };
};

type CreateDesktopBackendOptions = {
  loadTauriInvoke?: () => Promise<TauriInvoke>;
  enableWebDemoBackend?: boolean;
};

const missingDesktopBackendMessage =
  "No desktop backend is available. Start the app through Tauri or Electron preload.";

async function defaultLoadTauriInvoke() {
  const core = await import("@tauri-apps/api/core");
  if (typeof core.invoke !== "function") {
    throw new Error(missingDesktopBackendMessage);
  }
  return core.invoke as TauriInvoke;
}

function invokeProxy<T>(invoke: TauriInvoke, command: string, payload?: InvokeArgs) {
  return invoke<T>(command, payload).catch((error) => {
    if (error instanceof TypeError && /reading 'invoke'/.test(error.message)) {
      throw new Error(missingDesktopBackendMessage);
    }
    throw error;
  });
}

function createTauriBackend(invoke: TauriInvoke): DesktopBackend {
  return {
    getConfig: () => invokeProxy<AppConfig>(invoke, "get_config"),
    openUrl: (payload) => invokeProxy<void>(invoke, "open_url", payload),
    proxy: {
      start: (payload) => invokeProxy<ProxyStatus>(invoke, "proxy_start", payload),
      stop: () => invokeProxy<ProxyStatus>(invoke, "proxy_stop"),
      status: () => invokeProxy<ProxyStatus>(invoke, "proxy_status"),
      setCaptureHosts: (payload) => invokeProxy<ProxyStatus>(invoke, "proxy_set_capture_hosts", payload),
      flows: () => invokeProxy<CaptureFlow[]>(invoke, "proxy_flows"),
      body: (payload) => invokeProxy<CaptureBodyContent>(invoke, "proxy_body", payload),
      clear: () => invokeProxy<CaptureFlow[]>(invoke, "proxy_clear"),
      replay: (payload) => invokeProxy<ReplayResult>(invoke, "proxy_replay_flow", payload),
      sendDraft: (payload) => invokeProxy<ReplayResult>(invoke, "proxy_send_request_draft", payload),
      importFlows: (payload) => invokeProxy<CaptureFlow[]>(invoke, "proxy_import_flows", payload),
      rules: () => invokeProxy<ProxyRule[]>(invoke, "proxy_rules"),
      setRules: (payload) => invokeProxy<ProxyRule[]>(invoke, "proxy_set_rules", payload),
      weakNetwork: () => invokeProxy<WeakNetworkProfile>(invoke, "proxy_weak_network"),
      setWeakNetwork: (payload) => invokeProxy<WeakNetworkProfile>(invoke, "proxy_set_weak_network", payload),
      breakpoints: () => invokeProxy<BreakpointRequest[]>(invoke, "proxy_breakpoints"),
      resolveBreakpoint: (payload) => invokeProxy<BreakpointRequest[]>(invoke, "proxy_resolve_breakpoint", payload),
    },
    cert: {
      info: () => invokeProxy<CertInfo>(invoke, "cert_info"),
      installRoot: () => invokeProxy<CertInfo>(invoke, "cert_install_root"),
      uninstallRoot: () => invokeProxy<CertInfo>(invoke, "cert_uninstall_root"),
      openRoot: () => invokeProxy<{ certPath: string; keyPath: string }>(invoke, "cert_open_root"),
    },
    systemProxy: {
      status: () => invokeProxy<SystemProxyStatus>(invoke, "system_proxy_status"),
      apply: () => invokeProxy<SystemProxyStatus>(invoke, "system_proxy_apply"),
      restore: () => invokeProxy<SystemProxyStatus>(invoke, "system_proxy_restore"),
    },
    ai: {
      updateConfig: (payload) => invokeProxy<AppConfig>(invoke, "ai_update_config", payload),
      testConnection: () =>
        invokeProxy<{
          ok: boolean;
          model: string;
          message: string;
          usage: AiResult["usage"];
        }>(invoke, "ai_test_connection"),
      analyzeFailures: (payload) => invokeProxy<AiResult>(invoke, "ai_analyze_failures", payload),
      compareFlows: (payload) => invokeProxy<AiResult>(invoke, "ai_compare_flows", payload),
      generateBugReport: (payload) => invokeProxy<AiResult>(invoke, "ai_generate_bug_report", payload),
      askAgent: (payload) => invokeProxy<AiResult>(invoke, "ai_ask_agent", payload),
      askAgentStream: (payload) => invokeProxy<AiResult>(invoke, "ai_ask_agent_stream", payload),
    },
  };
}

function now() {
  return Date.now();
}

function demoFlows(): CaptureFlow[] {
  const startedAt = now();
  return [
    {
      id: "demo-flow-current",
      startedAt: startedAt - 2200,
      completedAt: startedAt - 1100,
      method: "GET",
      scheme: "https",
      host: "api.example.test",
      port: 443,
      path: "/demo-agent/api/v1/subscriptions/current",
      query: "",
      statusCode: 200,
      protocol: "HTTP/1.1",
      source: "web-demo",
      durationMs: 1112,
      requestHeaders: {
        accept: "application/json",
        "sec-fetch-dest": "empty",
        "user-agent": "Mozilla/5.0 HeavenEye Agent Web Demo",
      },
      responseHeaders: {
        "content-type": "application/json",
        server: "demo",
      },
      requestBodyPreview: "",
      responseBodyPreview: JSON.stringify(
        {
          id: "sub_demo_001",
          plan: "pro",
          userId: "uid_13975_demo",
          status: "active",
        },
        null,
        2,
      ),
      requestSize: 0,
      responseSize: 488,
      errorType: "",
      tags: ["web-demo", "xhr"],
    },
    {
      id: "demo-flow-page",
      startedAt: startedAt - 4600,
      completedAt: startedAt - 3860,
      method: "POST",
      scheme: "https",
      host: "api.example.test",
      port: 443,
      path: "/demo-agent/api/v1/tasks/page",
      query: "?page=1&page_size=8&sort=created_at",
      statusCode: 200,
      protocol: "HTTP/2",
      source: "web-demo",
      durationMs: 736,
      requestHeaders: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: "session=demo-session",
      },
      responseHeaders: {
        "content-type": "application/json",
      },
      requestBodyPreview: JSON.stringify({ status: "running", owner: "uid_13975_demo" }),
      responseBodyPreview: JSON.stringify(
        {
          total: 16,
          items: [{ id: "task_1", title: "Generate avatar cover", state: "done" }],
        },
        null,
        2,
      ),
      requestSize: 48,
      responseSize: 3584,
      errorType: "",
      tags: ["web-demo", "xhr"],
    },
    {
      id: "demo-flow-cover",
      startedAt: startedAt - 7800,
      completedAt: startedAt - 6298,
      method: "GET",
      scheme: "https",
      host: "assets.example.test",
      port: 443,
      path: "/dh_models/chat_video_task/14982/cover.png",
      query: "",
      statusCode: 200,
      protocol: "HTTP/1.1",
      source: "web-demo",
      durationMs: 1502,
      requestHeaders: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "sec-fetch-dest": "image",
      },
      responseHeaders: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000",
      },
      requestBodyPreview: "",
      responseBodyPreview: "<binary image/png preview omitted in web demo>",
      requestSize: 0,
      responseSize: 558 * 1024,
      errorType: "",
      tags: ["web-demo", "encrypted", "img"],
    },
    {
      id: "demo-flow-404",
      startedAt: startedAt - 11200,
      completedAt: startedAt - 10536,
      method: "GET",
      scheme: "https",
      host: "app.example.test",
      port: 443,
      path: "/missing/chunk.js",
      query: "",
      statusCode: 404,
      protocol: "HTTP/1.1",
      source: "web-demo",
      durationMs: 664,
      requestHeaders: {
        accept: "*/*",
      },
      responseHeaders: {
        "content-type": "text/plain",
      },
      requestBodyPreview: "",
      responseBodyPreview: "Not Found",
      requestSize: 0,
      responseSize: 9,
      errorType: "",
      tags: ["web-demo", "script"],
    },
  ];
}

function createWebDemoBackend(): DesktopBackend {
  let flows = demoFlows();
  let captureHosts = ["app.example.test"];
  let running = true;
  let rules: ProxyRule[] = [];
  let weakNetwork: WeakNetworkProfile = {
    enabled: false,
    delayMs: 0,
    downstreamKbps: 0,
    errorRate: 0,
  };
  let breakpoints: BreakpointRequest[] = [];

  function status(): ProxyStatus {
    const lanIp = "192.168.1.8";
    const port = 9090;
    const baseUrl = `http://${lanIp}:${port}`;
    return {
      running,
      port,
      bindHost: "0.0.0.0",
      lanIp,
      proxyAddress: `${lanIp}:${port}`,
      mobileSetupUrl: running ? `${baseUrl}/mobile-setup` : null,
      certDownloadUrl: running ? `${baseUrl}/cert/ca.crt` : null,
      iosProfileUrl: running ? `${baseUrl}/ios.mobileconfig` : null,
      pacUrl: running ? `${baseUrl}/proxy.pac` : null,
      mode: "web-demo",
      httpsMitm: true,
      captureHosts,
      sslProxyHosts: captureHosts,
      rootCertificatePath: null,
    };
  }

  return {
    getConfig: async () => ({
      proxyPort: 9090,
      certDir: ".local-certs",
      captureHosts,
      sslProxyHosts: captureHosts,
      qwen: {
        provider: "web-demo",
        baseUrl: "web-demo",
        model: "web-demo",
        visionModel: "web-demo",
        hasApiKey: true,
      },
    }),
    openUrl: async ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    proxy: {
      start: async () => {
        running = true;
        return status();
      },
      stop: async () => {
        running = false;
        return status();
      },
      status: async () => status(),
      setCaptureHosts: async ({ hosts }) => {
        captureHosts = hosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean);
        return status();
      },
      flows: async () => flows,
      body: async ({ flowId, direction }) => {
        const flow = flows.find((item) => item.id === flowId);
        const content =
          direction === "request" ? flow?.requestBodyPreview || "" : flow?.responseBodyPreview || "";
        return {
          flowId,
          direction,
          content,
          contentType:
            direction === "request"
              ? flow?.requestHeaders["content-type"] || ""
              : flow?.responseHeaders["content-type"] || "",
          size: direction === "request" ? flow?.requestSize || 0 : flow?.responseSize || 0,
          decodedSize: content.length,
          fromPreview: true,
          complete: true,
          omittedReason: "",
        };
      },
      clear: async () => {
        flows = [];
        return flows;
      },
      replay: async ({ flow }) => ({
        startedAt: now(),
        completedAt: now() + 42,
        method: flow.method,
        url: `${flow.scheme}://${flow.host}${flow.path}${flow.query}`,
        statusCode: flow.statusCode,
        durationMs: 42,
        requestHeaders: flow.requestHeaders,
        responseHeaders: {
          "content-type": flow.responseHeaders["content-type"] || "application/json",
          "x-web-demo": "true",
        },
        responseBodyPreview: flow.responseBodyPreview || JSON.stringify({ ok: true, demo: true }, null, 2),
        responseSize: flow.responseSize,
        errorType: "",
      }),
      sendDraft: async ({ draft }) => ({
        startedAt: now(),
        completedAt: now() + 42,
        method: draft.method,
        url: draft.url,
        statusCode: 200,
        durationMs: 42,
        requestHeaders: draft.headers,
        responseHeaders: {
          "content-type": "application/json",
          "x-web-demo": "true",
        },
        responseBodyPreview: JSON.stringify({ ok: true, repeated: true }, null, 2),
        responseSize: 38,
        errorType: "",
      }),
      importFlows: async (payload) => {
        flows = payload.flows;
        return flows;
      },
      rules: async () => rules,
      setRules: async (payload) => {
        rules = payload.rules;
        return rules;
      },
      weakNetwork: async () => weakNetwork,
      setWeakNetwork: async (payload) => {
        weakNetwork = payload.profile;
        return weakNetwork;
      },
      breakpoints: async () => breakpoints,
      resolveBreakpoint: async (payload) => {
        breakpoints = breakpoints.filter((item) => item.id !== payload.decision.id);
        return breakpoints;
      },
    },
    cert: {
      info: async () => ({
        trusted: true,
        platform: "web-demo",
        certPath: "",
        canInstall: false,
        canUninstall: false,
        needsAdmin: false,
        message: "Web demo mode does not use a local root certificate.",
      }),
      installRoot: async () => ({
        trusted: true,
        platform: "web-demo",
        certPath: "",
        canInstall: false,
        canUninstall: false,
        needsAdmin: false,
        message: "Web demo mode does not use a local root certificate.",
      }),
      uninstallRoot: async () => ({
        trusted: true,
        platform: "web-demo",
        certPath: "",
        canInstall: false,
        canUninstall: false,
        needsAdmin: false,
        message: "Web demo mode does not use a local root certificate.",
      }),
      openRoot: async () => ({ certPath: "", keyPath: "" }),
    },
    systemProxy: {
      status: async () => ({
        supported: false,
        service: null,
        targetHost: "127.0.0.1",
        targetPort: 9090,
        http: { enabled: false, host: "", port: null },
        https: { enabled: false, host: "", port: null },
        socks: { enabled: false, host: "", port: null },
        autoProxy: { enabled: false, url: "" },
        autoDiscoveryEnabled: false,
        matchesProxy: true,
        managedProxyActive: false,
        canRestore: false,
        restoreRecommended: false,
        message: "Web demo mode does not manage system proxy settings.",
      }),
      apply: async () => (await createWebDemoBackend().systemProxy.status()),
      restore: async () => (await createWebDemoBackend().systemProxy.status()),
    },
    ai: {
      updateConfig: async ({ settings }) => ({
        proxyPort: 9090,
        certDir: "",
        captureHosts: [],
        sslProxyHosts: [],
        qwen: {
          provider: settings.provider || "custom",
          baseUrl: settings.baseUrl,
          model: settings.model,
          visionModel: settings.visionModel,
          hasApiKey: Boolean(settings.apiKey && settings.apiKey.trim()) && !settings.clearApiKey,
        },
      }),
      testConnection: async () => ({
        ok: true,
        model: "web-demo",
        message: "Web demo Agent 连接正常。",
        usage: null,
      }),
      analyzeFailures: async () => ({
        model: "web-demo",
        content: "Web demo：当前有 1 个 404 示例请求，可用于调试报告 UI。",
        structured: null,
        usage: null,
      }),
      compareFlows: async () => ({
        model: "web-demo",
        content: "Web demo：已生成示例差异结果。",
        structured: null,
        usage: null,
      }),
      generateBugReport: async () => ({
        model: "web-demo",
        content: "Web demo 缺陷报告：复现步骤、实际结果、期望结果和接口证据会显示在这里。",
        structured: null,
        usage: null,
      }),
      askAgent: async ({ question }) => ({
        model: "web-demo",
        content: `Web demo 收到问题：${question}`,
        structured: null,
        usage: null,
      }),
      askAgentStream: async ({ question }) => ({
        model: "web-demo",
        content: `Web demo 收到问题：${question}`,
        structured: null,
        usage: null,
      }),
    },
  };
}

function shouldUseWebDemoBackend() {
  if (typeof window === "undefined") {
    return false;
  }

  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function hasTauriRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const runtimeWindow = window as unknown as Record<string, unknown>;
  return Boolean(runtimeWindow.__TAURI_INTERNALS__ || runtimeWindow.__TAURI__);
}

export function createDesktopBackend(options: CreateDesktopBackendOptions = {}): DesktopBackend {
  const loadTauriInvoke = options.loadTauriInvoke ?? defaultLoadTauriInvoke;
  const enableWebDemoBackend = options.enableWebDemoBackend ?? shouldUseWebDemoBackend();

  let resolvedBackendPromise: Promise<DesktopBackend> | null = null;

  async function resolveBackend() {
    if (!resolvedBackendPromise) {
      resolvedBackendPromise = (async () => {
        if (enableWebDemoBackend && !hasTauriRuntime()) {
          return createWebDemoBackend();
        }

        const invoke = await loadTauriInvoke().catch(() => {
          if (enableWebDemoBackend) {
            return null;
          }
          throw new Error(missingDesktopBackendMessage);
        });
        if (invoke === null) {
          return createWebDemoBackend();
        }
        if (typeof invoke !== "function") {
          throw new Error(missingDesktopBackendMessage);
        }
        return createTauriBackend(invoke);
      })();
    }

    return resolvedBackendPromise;
  }

  return {
    getConfig: async () => (await resolveBackend()).getConfig(),
    openUrl: async (payload) => (await resolveBackend()).openUrl(payload),
    proxy: {
      start: async (payload) => (await resolveBackend()).proxy.start(payload),
      stop: async () => (await resolveBackend()).proxy.stop(),
      status: async () => (await resolveBackend()).proxy.status(),
      setCaptureHosts: async (payload) => (await resolveBackend()).proxy.setCaptureHosts(payload),
      flows: async () => (await resolveBackend()).proxy.flows(),
      body: async (payload) => (await resolveBackend()).proxy.body(payload),
      clear: async () => (await resolveBackend()).proxy.clear(),
      replay: async (payload) => (await resolveBackend()).proxy.replay(payload),
      sendDraft: async (payload) => (await resolveBackend()).proxy.sendDraft(payload),
      importFlows: async (payload) => (await resolveBackend()).proxy.importFlows(payload),
      rules: async () => (await resolveBackend()).proxy.rules(),
      setRules: async (payload) => (await resolveBackend()).proxy.setRules(payload),
      weakNetwork: async () => (await resolveBackend()).proxy.weakNetwork(),
      setWeakNetwork: async (payload) => (await resolveBackend()).proxy.setWeakNetwork(payload),
      breakpoints: async () => (await resolveBackend()).proxy.breakpoints(),
      resolveBreakpoint: async (payload) => (await resolveBackend()).proxy.resolveBreakpoint(payload),
    },
    cert: {
      info: async () => (await resolveBackend()).cert.info(),
      installRoot: async () => (await resolveBackend()).cert.installRoot(),
      uninstallRoot: async () => (await resolveBackend()).cert.uninstallRoot(),
      openRoot: async () => (await resolveBackend()).cert.openRoot(),
    },
    systemProxy: {
      status: async () => (await resolveBackend()).systemProxy.status(),
      apply: async () => (await resolveBackend()).systemProxy.apply(),
      restore: async () => (await resolveBackend()).systemProxy.restore(),
    },
    ai: {
      updateConfig: async (payload) => (await resolveBackend()).ai.updateConfig(payload),
      testConnection: async () => (await resolveBackend()).ai.testConnection(),
      analyzeFailures: async (payload) => (await resolveBackend()).ai.analyzeFailures(payload),
      compareFlows: async (payload) => (await resolveBackend()).ai.compareFlows(payload),
      generateBugReport: async (payload) => (await resolveBackend()).ai.generateBugReport(payload),
      askAgent: async (payload) => (await resolveBackend()).ai.askAgent(payload),
      askAgentStream: async (payload) => (await resolveBackend()).ai.askAgentStream(payload),
    },
  };
}

export const desktopBackend = createDesktopBackend();

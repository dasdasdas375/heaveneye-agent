export type ProxyStatus = {
  running: boolean;
  port: number;
  bindHost?: string;
  lanIp?: string | null;
  proxyAddress?: string;
  mobileSetupUrl?: string | null;
  certDownloadUrl?: string | null;
  iosProfileUrl?: string | null;
  pacUrl?: string | null;
  mode: string;
  httpsMitm: boolean;
  captureHosts?: string[];
  sslProxyHosts?: string[];
  rootCertificatePath?: string | null;
};

export type AppConfig = {
  proxyPort: number;
  certDir: string;
  captureHosts: string[];
  sslProxyHosts: string[];
  qwen: {
    provider: string;
    baseUrl: string;
    model: string;
    visionModel: string;
    hasApiKey: boolean;
  };
};

export type AiConfigUpdate = {
  provider: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  apiKey?: string | null;
  clearApiKey?: boolean;
};

export type CertInfo = {
  trusted: boolean;
  platform: string;
  certPath: string;
  canInstall: boolean;
  canUninstall: boolean;
  needsAdmin: boolean;
  message: string;
};

export type SystemProxySetting = {
  enabled: boolean;
  host: string;
  port: number | null;
};

export type SystemProxyStatus = {
  supported: boolean;
  service: string | null;
  targetHost: string;
  targetPort: number;
  http: SystemProxySetting;
  https: SystemProxySetting;
  socks: SystemProxySetting;
  matchesProxy: boolean;
  managedProxyActive: boolean;
  canRestore: boolean;
  restoreRecommended: boolean;
  message: string;
};

export type CaptureFlow = {
  id: string;
  startedAt: number;
  completedAt: number | null;
  method: string;
  scheme: string;
  host: string;
  port: number | null;
  path: string;
  query: string;
  statusCode: number | null;
  protocol: string;
  source: string;
  clientAddress?: string | null;
  durationMs: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyPreview: string;
  requestBodyPreviewTruncated?: boolean;
  requestBodyDecodedSize?: number;
  requestBodyReplaySize?: number;
  responseBodyPreview: string;
  responseBodyPreviewTruncated?: boolean;
  responseBodyDecodedSize?: number;
  requestSize: number;
  responseSize: number;
  errorType: string;
  tags: string[];
};

export type ReplayResult = {
  startedAt: number;
  completedAt: number;
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBodyPreview: string;
  responseBodyPreviewTruncated?: boolean;
  responseBodyDecodedSize?: number;
  responseSize: number;
  errorType: string;
};

export type CaptureBodyContent = {
  flowId: string;
  direction: "request" | "response";
  content: string;
  contentType: string;
  size: number;
  decodedSize: number;
  fromPreview: boolean;
  complete: boolean;
  omittedReason: string;
};

export type RequestDraft = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type ProxyRuleKind = "mock" | "mapLocal" | "breakpoint" | "rewrite";
export type ProxyRuleDirection = "request" | "response" | "both";

export type ProxyRule = {
  id: string;
  enabled: boolean;
  kind: ProxyRuleKind;
  direction: ProxyRuleDirection;
  pattern: string;
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  search: string;
  replace: string;
  localPath: string;
  delayMs: number | null;
};

export type WeakNetworkProfile = {
  enabled: boolean;
  delayMs: number;
  downstreamKbps: number;
  errorRate: number;
};

export type BreakpointRequest = {
  id: string;
  flowId: string;
  ruleId: string;
  createdAt: number;
  direction: "request" | "response";
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  bodyPreview: string;
  statusCode?: number | null;
  responseHeaders?: Record<string, string>;
  responseBodyPreview?: string;
};

export type BreakpointDecision = {
  id: string;
  action: "continue" | "mock" | "drop";
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  requestMethod?: string | null;
  requestUrl?: string | null;
  requestHeaders?: Record<string, string> | null;
  requestBody?: string | null;
};

export type AiResult = {
  model: string;
  content: string;
  structured?: AgentStructuredAnswer | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

export type AgentHighlight = {
  label: string;
  value: string;
  kind?: "uid" | "account" | "password" | "token" | "error" | "url" | "field" | "status" | "time" | "other";
  source?: string;
};

export type AgentEvidenceField = {
  label: string;
  value: string;
};

export type AgentEvidence = {
  title?: string;
  time?: string;
  method?: string;
  status?: string | number | null;
  host?: string;
  path?: string;
  fields?: AgentEvidenceField[];
};

export type AgentStructuredAnswer = {
  summary?: string;
  highlights?: AgentHighlight[];
  evidence?: AgentEvidence[];
  analysis?: string[];
  testCases?: AgentTestCase[];
};

export type AgentTestCase = {
  name: string;
  purpose?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null>;
  body?: unknown;
  expected?: string;
};

export type AgentAttachment = {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
};

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: AgentAttachment[];
  model?: string;
  structured?: AgentStructuredAnswer | null;
  status?: "loading" | "error" | "cancelled";
};

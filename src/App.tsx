import {
  AlertTriangle,
  Bot,
  Bug,
  Check,
  ChevronRight,
  Clock3,
  Circle,
  ClipboardList,
  Code2,
  Columns3,
  Copy,
  Download,
  Eraser,
  FileJson,
  FolderOpen,
  Globe2,
  ImageIcon,
  Loader2,
  Maximize2,
  Mic,
  PauseCircle,
  Play,
  Palette,
  QrCode,
  Radio,
  RefreshCcw,
  Repeat2,
  Search,
  SendHorizontal,
  ShieldAlert,
  Smartphone,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { desktopBackend } from "./lib/desktop";
import appLogo from "./assets/app-logo.png";
import {
  buildInspectorViewModel,
  formatInspectorContent,
  parseJsonLikeContent,
  serializeInspectorContent,
} from "./lib/inspector";
import {
  buildCurlCommand,
  buildPlaywrightSnippet,
  buildPostmanCollection,
  buildRequestUrl,
} from "./lib/request-export";
import { buildHarArchive, buildSessionExport } from "./lib/session-export";
import { parseSseEvents, type SseEventRow } from "./lib/sse";
import { formatSpeechRecognitionError, shouldAutoClearError } from "./lib/ui-errors";
import {
  InspectorPreview,
  InspectorViewer,
  type InspectorPayloadMeta,
} from "./components/inspector-preview";
import { StructuredAgentAnswer } from "./components/structured-agent-answer";
import type {
  AgentAttachment,
  AgentChatMessage,
  AgentTestCase,
  AiConfigUpdate,
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
  SystemProxySetting,
  SystemProxyStatus,
  WeakNetworkProfile,
} from "./types";

const emptyStatus: ProxyStatus = {
  running: false,
  port: 9090,
  mode: "http-proxy",
  httpsMitm: false,
};

const emptyWeakNetwork: WeakNetworkProfile = {
  enabled: false,
  delayMs: 0,
  downstreamKbps: 0,
  errorRate: 0,
};

const quickWeakNetworkProfile: WeakNetworkProfile = {
  enabled: true,
  delayMs: 800,
  downstreamKbps: 64,
  errorRate: 0.02,
};

const emptyRuleDraft: Omit<ProxyRule, "id" | "enabled"> = {
  kind: "mock",
  direction: "request",
  pattern: "",
  statusCode: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: "{\n  \"ok\": true\n}",
  search: "",
  replace: "",
  localPath: "",
  delayMs: null,
};

type AppLanguage = "zh" | "en";
type LayoutMode = "agent" | "classic" | "sidecar";
type ThemeMode = "graphite" | "ocean" | "ember" | "paper";
type UtilityPanel = "agent" | "lab";
type LayoutSizing = { request: number; side: number };
type NativeWindowFrame = {
  size: { width: number; height: number };
  position: { x: number; y: number };
  maximized: boolean;
  fullscreen: boolean;
};
type WorkspaceResizeTarget = "request" | "side";
type DetailTab = "overview" | "cookies" | "timing" | "preview" | "raw";
type StatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "error" | "pending";
type TagFilter = "all" | "rule" | "mock" | "map-local" | "breakpoint" | "slow" | "failure";
type RequestColumnKey = "status" | "type" | "size" | "captured" | "duration";
type RequestColumnVisibility = Record<RequestColumnKey, boolean>;

type BreakpointEditDraft = {
  breakpoint: BreakpointRequest;
  action: BreakpointDecision["action"];
  requestMethod: string;
  requestUrl: string;
  requestHeadersText: string;
  requestBody: string;
  statusCode: number | null;
  responseHeadersText: string;
  responseBody: string;
};
type InspectorViewModel = ReturnType<typeof buildInspectorViewModel>;
type ExpandedInspectorViewModel = InspectorViewModel & {
  meta?: InspectorPayloadMeta;
  requestLabel?: string;
  requestSubtitle?: string;
};
type StructuredFilters = {
  method: string;
  status: StatusFilter;
  type: string;
  tag: TagFilter;
};
type CertTrustDialog = {
  title: string;
  message: string;
  detail: string;
  hint: string;
  certPath: string;
  command: string;
};

const defaultStructuredFilters: StructuredFilters = {
  method: "all",
  status: "all",
  type: "all",
  tag: "all",
};

const localSessionKey = "dpa-auto-session-v1";
const localSessionFlowLimit = 250;
const localSessionTextLimit = 64 * 1024;
const requestColumnStorageKey = "dpa-request-columns-v2";
const requestColumnKeys: RequestColumnKey[] = ["status", "type", "size", "captured", "duration"];
const defaultRequestColumnVisibility: RequestColumnVisibility = {
  status: true,
  type: false,
  size: false,
  captured: true,
  duration: false,
};
const requestColumnTracks: Record<RequestColumnKey, string> = {
  status: "58px",
  type: "52px",
  size: "64px",
  captured: "76px",
  duration: "78px",
};

type AiProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  visionModel: string;
};

const aiProviderPresets: AiProviderPreset[] = [
  {
    id: "qwen",
    label: "Qwen / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-max",
    visionModel: "qwen3-vl-plus",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    visionModel: "gpt-4.1",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    visionModel: "claude-sonnet-4-20250514",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
    visionModel: "gemini-2.5-pro",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    visionModel: "deepseek-chat",
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    visionModel: "moonshot-v1-8k",
  },
  {
    id: "doubao",
    label: "Doubao / Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6",
    visionModel: "doubao-seed-1-6",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
    visionModel: "glm-4v-plus",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    visionModel: "google/gemini-2.5-pro",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: "",
    model: "",
    visionModel: "",
  },
];

const defaultLayoutSizing: Record<LayoutMode, LayoutSizing> = {
  agent: { request: 420, side: 380 },
  classic: { request: 540, side: 340 },
  sidecar: { request: 240, side: 0 },
};

const layoutModes: LayoutMode[] = ["agent", "classic", "sidecar"];

const layoutSizingBounds = {
  minRequest: 300,
  minSide: 300,
  minMiddle: 360,
};

const quickPromptsByLanguage: Record<AppLanguage, string[]> = {
  zh: [
    "帮我找一下最新登录账号的 uid，并列出证据接口",
    "开启一键弱网，并重放当前接口",
    "今天总共登录了哪些账号？按时间排序",
    "今天有哪些接口报错？给出 status、path 和可能原因",
    "找出最近 10 分钟最慢的接口，并判断瓶颈",
  ],
  en: [
    "Find the latest logged-in uid and list the evidence requests",
    "Enable quick weak network and replay the current request",
    "Which accounts logged in today? Sort by time",
    "Which APIs failed today? Include status, path, and likely cause",
    "Find the slowest requests from the last 10 minutes and diagnose bottlenecks",
  ],
};

const copyByLanguage = {
  zh: {
    layout: "布局",
    agentLayout: "Agent 主场",
    classicLayout: "经典三栏",
    sidecarLayout: "F12 侧栏",
    language: "语言",
    theme: "配色",
    graphite: "石墨",
    ocean: "海雾",
    ember: "暖夜",
    paper: "白昼",
    total: "总数",
    failures: "失败",
    tunnels: "隧道",
    slow: "慢请求",
    ready: "Ready",
    missingKey: "Missing key",
    aiSettings: "AI 设置",
    aiSettingsHint: "选择主流 AI Provider，或填写自定义 OpenAI-compatible / Anthropic / Gemini 接口。",
    aiProvider: "AI Provider",
    aiBaseUrl: "Base URL",
    aiModel: "文本模型",
    aiVisionModel: "视觉模型",
    aiApiKey: "API Key",
    aiApiKeyPlaceholder: "留空则保留当前 Key",
    aiKeyConfigured: "当前已配置 Key",
    aiKeyNotConfigured: "当前未配置 Key",
    clearApiKey: "清除 Key",
    saveSettings: "保存设置",
    aiSettingsSaved: "AI 设置已保存",
    stopped: "Stopped",
    start: "Start",
    stop: "Stop",
    session: "Session",
    har: "HAR",
    apply: "Apply",
    targetPlaceholder: "目标域名，例如 example.test",
    filterPlaceholder: "过滤名称、域名、路径、状态",
    name: "名称",
    status: "状态",
    type: "类型",
    size: "大小",
    captureTime: "抓包时间",
    time: "耗时",
    fields: "字段",
    showFields: "显示字段",
    resetFields: "重置",
    payloadRequest: "传参",
    payloadResponse: "响应",
    payloadTabsLabel: "传参与响应",
    payloadRequestTitle: "传参",
    payloadResponseTitle: "响应",
    queryParams: "Query 参数",
    requestBody: "请求体",
    responseBody: "响应体",
    copy: "复制",
    copied: "已复制",
    expand: "放大查看",
    compare: "对比",
    complete: "完整",
    previewFallback: "缓存不可用，显示预览",
    noCaptures: "暂无抓包",
    noCapturesTitle: "还没有捕获请求",
    noCapturesHint: "启动代理并接入系统代理后，访问目标站点即可开始记录。也可以先导入 Session/HAR 继续分析已有会话。",
    captureNote: "Network proxy view excludes browser disk-cache-only and extension-injected entries shown by DevTools.",
    agent: "Agent",
    lab: "实验室",
    test: "Test",
    analyze: "Analyze",
    report: "Report",
    speakFirst: "动嘴就行",
    speakFirstHint: "Agent 优先布局会把对话区放到主舞台，适合只问问题、贴截图、让它自己找证据。",
    emptyChat: "可以直接问：最新登录账号 uid、今天登录过哪些账号、哪些接口报错、某张截图里的请求线索。",
    composerPlaceholder: "问 Agent：帮我找最新登录账号 uid / 今天哪些接口报错 / 这张图里请求有什么异常",
    thinkingTitle: "Agent 正在分析",
    thinkingHint: "正在读取当前抓包、历史对话和图片，大请求可能需要几秒。",
    thinkingStepRequests: "筛选相关请求",
    thinkingStepEvidence: "提取证据字段",
    thinkingStepAnswer: "整理可复制结论",
    cancelAgent: "终止",
    agentCancelled: "已终止本次分析，后续返回结果会被忽略。",
    contextMenuTitle: "请求操作",
    contextReplay: "Replay 请求",
    contextReplaying: "重放中",
    contextReplayHint: "用后端保存的原始请求再发一次",
    contextEdit: "Edit & Repeat",
    contextEditHint: "修改 URL、Headers、Body 后手动发送",
    contextCopySection: "复制脚本",
    contextCopyCurl: "复制 cURL",
    contextCopyCurlHint: "终端可直接粘贴复现",
    contextCopyPlaywright: "复制 Playwright",
    contextCopyPlaywrightHint: "生成测试脚本片段",
    contextCopyPostman: "复制 Postman",
    contextCopyPostmanHint: "生成 collection JSON",
    contextCopied: "已复制",
    contextBusy: "正在处理，请稍等",
    contextConnectDisabled: "CONNECT 隧道不能直接重放或编辑",
    networkLab: "网络实验室",
    mobileCapture: "手机抓包",
    mobileReady: "可扫码",
    mobileUnavailable: "未启动",
    mobileCaptureHint: "对齐 Charles：同 Wi-Fi 手机通过显式 HTTP/HTTPS 代理接入当前端口。",
    mobileStartHint: "启动代理后会生成二维码和手机配置链接。",
    mobileToolbar: "手机",
    mobileModalTitle: "手机抓包配置",
    mobileModalHint: "用手机扫描二维码，或在手机浏览器输入配置页地址。电脑和手机必须在同一个 Wi-Fi。",
    mobileOpenBrowser: "浏览器打开",
    mobileSetupUrl: "配置页",
    mobileProxy: "代理",
    mobileCert: "CA 证书",
    mobilePac: "PAC",
    mobileCopySetup: "复制配置页",
    mobileCopyProxy: "复制代理地址",
    mobileCopyCert: "复制证书链接",
    mobileCopyPac: "复制 PAC",
    mobileOpenSetup: "打开配置页",
    mobileIosTitle: "iOS",
    mobileAndroidTitle: "Android",
    mobileIosGuide: "安装描述文件后，还需要在证书信任设置里手动信任 CA，再把 Wi-Fi HTTP 代理设为手动。",
    mobileAndroidGuide:
      "扫码下载 CA 后按系统提示安装；Android 7+ App 默认可能不信任用户 CA，需要测试包显式信任用户证书。",
    mobileBoundary: "不覆盖 QUIC/HTTP3、UDP、强 pinning 或绕开系统代理的 App，范围与 Charles 显式代理一致。",
    weakNetwork: "弱网",
    weakNetworkOn: "已开启",
    weakNetworkOff: "已关闭",
    quickWeakNetwork: "一键弱网",
    disableWeakNetwork: "关闭弱网",
    weakNetworkHint: "默认 800ms 延迟、64 KB/s 下行、2% 错误率，适合快速复现弱网问题。",
    advancedSettings: "高级设置",
    delayMs: "延迟 ms",
    downKbps: "下行 KB/s",
    errorRate: "错误率",
    applySettings: "应用设置",
    settingsApplied: "已应用",
    rules: "规则",
    activeRules: "条规则",
    ruleModeHint: "mock / rewrite / 本地文件 / 断点",
    ruleMock: "Mock",
    ruleRewrite: "Rewrite",
    ruleMapLocal: "本地文件",
    ruleBreakpoint: "断点",
    ruleDirectionRequest: "请求",
    ruleDirectionResponse: "响应",
    ruleDirectionBoth: "双向",
    rewriteSearchPlaceholder: "响应正文搜索文本",
    rewriteReplacePlaceholder: "替换为；留空可只改 headers/status",
    urlPatternPlaceholder: "URL / 域名 / 路径匹配",
    statusPlaceholder: "状态码",
    localFilePlaceholder: "/本地文件路径",
    mockBodyPlaceholder: "Mock / Rewrite 响应体",
    noActiveRules: "暂无规则",
    addRule: "添加规则",
    breakpoints: "断点",
    pending: "待处理",
    continueRequest: "继续",
    editContinue: "编辑继续",
    breakpointEditor: "断点编辑",
    requestEdit: "请求编辑",
    responseEdit: "响应编辑",
    mock200: "Mock 200",
    dropRequest: "丢弃",
    agentNoTargetRequest: "请先选择一个请求，或在问题里 @接口名，再让我重放或测试。",
    agentWeakApplied: "已开启一键弱网：延迟 {delay} ms，下行 {down} KB/s，错误率 {error}%。可以继续说“关闭弱网”恢复正常网络。",
    agentWeakDisabled: "已关闭弱网，网络配置恢复正常。",
    agentReplayDone: "已重放 {method} {name}，返回 {status}，耗时 {duration} ms。",
    agentReplayFailed: "重放请求失败，详情已显示在顶部提示区。",
    agentApiTestRunning: "已收到接口测试请求：先让模型分析传参和响应、设计用例，再按用例修改参数执行。",
    agentApiTestNoCases: "模型已经完成接口分析，但没有返回可执行的测试用例。请明确要测边界值、异常参数、权限或弱网场景。",
    agentApiTestNoTarget: "接口测试需要一个基准请求。请先选中接口，或在问题里 @接口名。",
    agentApiTestDone: "接口测试已执行 {count} 个用例：",
    agentApiTestFailed: "接口测试执行失败，详情已显示在顶部提示区。",
    agentApiTestCaseFailed: "用例执行失败",
    apiTestPassedCases: "通过用例",
    apiTestFailedCases: "不通过用例",
    apiTestNoCasesInGroup: "无",
  },
  en: {
    layout: "Layout",
    agentLayout: "Agent Stage",
    classicLayout: "Classic",
    sidecarLayout: "Sidecar",
    language: "Language",
    theme: "Theme",
    graphite: "Graphite",
    ocean: "Ocean",
    ember: "Ember",
    paper: "Paper",
    total: "Total",
    failures: "Failures",
    tunnels: "Tunnels",
    slow: "Slow",
    ready: "Ready",
    missingKey: "Missing key",
    aiSettings: "AI Settings",
    aiSettingsHint: "Choose a mainstream AI provider, or use a custom OpenAI-compatible / Anthropic / Gemini endpoint.",
    aiProvider: "AI Provider",
    aiBaseUrl: "Base URL",
    aiModel: "Text model",
    aiVisionModel: "Vision model",
    aiApiKey: "API Key",
    aiApiKeyPlaceholder: "Leave blank to keep current key",
    aiKeyConfigured: "A key is configured",
    aiKeyNotConfigured: "No key configured",
    clearApiKey: "Clear key",
    saveSettings: "Save settings",
    aiSettingsSaved: "AI settings saved",
    stopped: "Stopped",
    start: "Start",
    stop: "Stop",
    session: "Session",
    har: "HAR",
    apply: "Apply",
    targetPlaceholder: "Target domain, e.g. example.test",
    filterPlaceholder: "Filter name, host, path, status",
    name: "Name",
    status: "Status",
    type: "Type",
    size: "Size",
    captureTime: "Captured",
    time: "Time",
    fields: "Fields",
    showFields: "Visible fields",
    resetFields: "Reset",
    payloadRequest: "Payload",
    payloadResponse: "Preview",
    payloadTabsLabel: "Payload and preview",
    payloadRequestTitle: "Payload",
    payloadResponseTitle: "Preview",
    queryParams: "Query Params",
    requestBody: "Request Body",
    responseBody: "Response Body",
    copy: "Copy",
    copied: "Copied",
    expand: "Expand",
    compare: "Compare",
    complete: "Full",
    previewFallback: "Cache unavailable, showing preview",
    noCaptures: "No captures",
    noCapturesTitle: "No requests captured yet",
    noCapturesHint: "Start the proxy, connect the system proxy, then browse the target site. You can also import a saved session or HAR-like export.",
    captureNote: "Network proxy view excludes browser disk-cache-only and extension-injected entries shown by DevTools.",
    agent: "Agent",
    lab: "Lab",
    test: "Test",
    analyze: "Analyze",
    report: "Report",
    speakFirst: "Just talk",
    speakFirstHint: "Voice-first layout puts Agent in the main stage for questions, screenshots, and evidence hunting.",
    emptyChat: "Ask about the latest uid, today's accounts, failed APIs, or clues from a screenshot.",
    composerPlaceholder: "Ask Agent: latest uid / failed APIs today / what is odd in this screenshot",
    thinkingTitle: "Agent is analyzing",
    thinkingHint: "Reading captured requests, chat history, and images. Large sessions can take a few seconds.",
    thinkingStepRequests: "Finding relevant requests",
    thinkingStepEvidence: "Extracting evidence fields",
    thinkingStepAnswer: "Preparing a copyable answer",
    cancelAgent: "Stop",
    agentCancelled: "This analysis was stopped. Any later result will be ignored.",
    contextMenuTitle: "Request actions",
    contextReplay: "Replay request",
    contextReplaying: "Replaying",
    contextReplayHint: "Send it again with the saved raw body",
    contextEdit: "Edit & Repeat",
    contextEditHint: "Change URL, headers, or body before sending",
    contextCopySection: "Copy scripts",
    contextCopyCurl: "Copy cURL",
    contextCopyCurlHint: "Paste into a terminal to reproduce",
    contextCopyPlaywright: "Copy Playwright",
    contextCopyPlaywrightHint: "Generate a test snippet",
    contextCopyPostman: "Copy Postman",
    contextCopyPostmanHint: "Generate collection JSON",
    contextCopied: "Copied",
    contextBusy: "Working, please wait",
    contextConnectDisabled: "CONNECT tunnels cannot be replayed or edited",
    networkLab: "Network Lab",
    mobileCapture: "Mobile capture",
    mobileReady: "Ready",
    mobileUnavailable: "Stopped",
    mobileCaptureHint: "Charles-aligned: phone on the same Wi-Fi uses this explicit HTTP/HTTPS proxy.",
    mobileStartHint: "Start the proxy to generate the QR code and setup links.",
    mobileToolbar: "Mobile",
    mobileModalTitle: "Mobile capture setup",
    mobileModalHint: "Scan this QR code on the phone, or type the setup URL in the phone browser. Mac and phone must be on the same Wi-Fi.",
    mobileOpenBrowser: "Open browser",
    mobileSetupUrl: "Setup page",
    mobileProxy: "Proxy",
    mobileCert: "CA cert",
    mobilePac: "PAC",
    mobileCopySetup: "Copy setup",
    mobileCopyProxy: "Copy proxy",
    mobileCopyCert: "Copy cert URL",
    mobileCopyPac: "Copy PAC",
    mobileOpenSetup: "Open setup",
    mobileIosTitle: "iOS",
    mobileAndroidTitle: "Android",
    mobileIosGuide: "Install the profile, manually trust the CA in Certificate Trust Settings, then set the Wi-Fi HTTP proxy to Manual.",
    mobileAndroidGuide:
      "Scan to download the CA and install it. Android 7+ apps may not trust user CAs unless the test build opts in.",
    mobileBoundary: "Does not cover QUIC/HTTP3, UDP, strong pinning, or apps bypassing explicit system proxy.",
    weakNetwork: "Weak network",
    weakNetworkOn: "On",
    weakNetworkOff: "Off",
    quickWeakNetwork: "Quick weak network",
    disableWeakNetwork: "Disable weak network",
    weakNetworkHint: "Default 800 ms delay, 64 KB/s downstream, 2% errors for quick weak-network reproduction.",
    advancedSettings: "Advanced settings",
    delayMs: "Delay ms",
    downKbps: "Down KB/s",
    errorRate: "Error rate",
    applySettings: "Apply settings",
    settingsApplied: "Applied",
    rules: "Rules",
    ruleModeHint: "mock / rewrite / local / breakpoint",
    ruleMock: "Mock",
    ruleRewrite: "Rewrite",
    ruleMapLocal: "Map local",
    ruleBreakpoint: "Breakpoint",
    ruleDirectionRequest: "Request",
    ruleDirectionResponse: "Response",
    ruleDirectionBoth: "Both",
    rewriteSearchPlaceholder: "Search response body",
    rewriteReplacePlaceholder: "Replace with; leave blank to change only headers/status",
    urlPatternPlaceholder: "URL / host / path pattern",
    statusPlaceholder: "Status",
    localFilePlaceholder: "/path/to/local file",
    mockBodyPlaceholder: "Mock / rewrite body",
    noActiveRules: "No active rules",
    addRule: "Add rule",
    breakpoints: "Breakpoints",
    pending: "pending",
    continueRequest: "Continue",
    editContinue: "Edit & continue",
    breakpointEditor: "Breakpoint editor",
    requestEdit: "Request edit",
    responseEdit: "Response edit",
    mock200: "Mock 200",
    dropRequest: "Drop",
    activeRules: "rules",
    agentNoTargetRequest: "Select a request first, or mention one with @request, then ask me to replay or test it.",
    agentWeakApplied: "Quick weak network is on: {delay} ms delay, {down} KB/s downstream, {error}% errors. Say \"disable weak network\" to restore normal networking.",
    agentWeakDisabled: "Weak network is disabled. Networking is back to normal.",
    agentReplayDone: "Replayed {method} {name}: {status}, {duration} ms.",
    agentReplayFailed: "Replay failed. Details are shown in the top notice area.",
    agentApiTestRunning: "API test request received: I will have the model analyze params and response, design cases, then execute parameter variants.",
    agentApiTestNoCases: "The model analyzed the API but did not return executable test cases. Ask for boundary, invalid-param, permission, or weak-network cases.",
    agentApiTestNoTarget: "API testing needs a baseline request. Select one first, or mention it with @request.",
    agentApiTestDone: "Executed {count} API test cases:",
    agentApiTestFailed: "API test execution failed. Details are shown in the top notice area.",
    agentApiTestCaseFailed: "Case execution failed",
    apiTestPassedCases: "Passed cases",
    apiTestFailedCases: "Failed cases",
    apiTestNoCasesInGroup: "None",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

type AppCopy = (typeof copyByLanguage)[AppLanguage];

function findAiProviderPreset(provider?: string | null) {
  const normalized = (provider || "qwen").trim().toLowerCase();
  return aiProviderPresets.find((preset) => preset.id === normalized) || aiProviderPresets.find((preset) => preset.id === "custom") || aiProviderPresets[0];
}

function aiProviderDisplayName(provider?: string | null) {
  const trimmed = provider?.trim();
  if (!trimmed) {
    return aiProviderPresets[0].label;
  }
  const preset = aiProviderPresets.find((item) => item.id === trimmed.toLowerCase());
  return preset?.label || trimmed;
}

function aiProviderSelectValue(provider?: string | null) {
  const normalized = (provider || "qwen").trim().toLowerCase();
  return aiProviderPresets.some((preset) => preset.id === normalized) ? normalized : "custom";
}

function readStoredOption<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

function readStoredRequestColumnVisibility(): RequestColumnVisibility {
  if (typeof window === "undefined") {
    return defaultRequestColumnVisibility;
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(requestColumnStorageKey) || "null") as
      | Partial<RequestColumnVisibility>
      | null;
    return requestColumnKeys.reduce<RequestColumnVisibility>(
      (acc, key) => ({
        ...acc,
        [key]: typeof parsed?.[key] === "boolean" ? parsed[key] : defaultRequestColumnVisibility[key],
      }),
      { ...defaultRequestColumnVisibility },
    );
  } catch {
    return defaultRequestColumnVisibility;
  }
}

function requestColumnTemplate(columns: RequestColumnVisibility) {
  return [
    "minmax(0, 1fr)",
    ...requestColumnKeys.filter((key) => columns[key]).map((key) => requestColumnTracks[key]),
  ].join(" ");
}

function readInitialLayoutMode(): LayoutMode {
  if (typeof window === "undefined") {
    return "agent";
  }

  if (!window.localStorage.getItem("dpa-clear-layout-v1")) {
    window.localStorage.setItem("dpa-clear-layout-v1", "1");
    window.localStorage.setItem("dpa-layout", "agent");
    return "agent";
  }

  return readStoredOption("dpa-layout", layoutModes, "agent");
}

function clampNumber(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function isLayoutSizing(value: unknown): value is LayoutSizing {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as LayoutSizing).request === "number" &&
    typeof (value as LayoutSizing).side === "number"
  );
}

function readStoredLayoutSizing(): Record<LayoutMode, LayoutSizing> {
  if (typeof window === "undefined") {
    return defaultLayoutSizing;
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem("dpa-layout-sizing") || "{}") as Partial<
      Record<LayoutMode, LayoutSizing>
    >;
    return layoutModes.reduce<Record<LayoutMode, LayoutSizing>>(
      (acc, mode) => {
        const sizing = parsed[mode];
        acc[mode] = isLayoutSizing(sizing)
          ? {
              request: clampNumber(Math.round(sizing.request), layoutSizingBounds.minRequest, 900),
              side: clampNumber(Math.round(sizing.side), layoutSizingBounds.minSide, 760),
            }
          : defaultLayoutSizing[mode];
        return acc;
      },
      { ...defaultLayoutSizing },
    );
  } catch {
    return defaultLayoutSizing;
  }
}

function isStructuredFilters(value: unknown): value is StructuredFilters {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as StructuredFilters;
  return (
    typeof candidate.method === "string" &&
    typeof candidate.type === "string" &&
    ["all", "2xx", "3xx", "4xx", "5xx", "error", "pending"].includes(candidate.status) &&
    ["all", "rule", "mock", "map-local", "breakpoint", "slow", "failure"].includes(candidate.tag)
  );
}

function readStoredStructuredFilters(): StructuredFilters {
  if (typeof window === "undefined") {
    return defaultStructuredFilters;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem("dpa-structured-filters") || "null");
    return isStructuredFilters(parsed) ? parsed : defaultStructuredFilters;
  } catch {
    return defaultStructuredFilters;
  }
}

function trimStoredText(value: string) {
  if (value.length <= localSessionTextLimit) {
    return value;
  }
  return `${value.slice(0, localSessionTextLimit)}\n\n[HeavenEye Agent truncated this persisted preview at ${localSessionTextLimit} chars]`;
}

function compactFlowForStorage(flow: CaptureFlow): CaptureFlow {
  return {
    ...flow,
    requestBodyPreview: trimStoredText(flow.requestBodyPreview || ""),
    responseBodyPreview: trimStoredText(flow.responseBodyPreview || ""),
    tags: Array.isArray(flow.tags) ? flow.tags : [],
  };
}

function normalizeStoredFlow(flow: CaptureFlow): CaptureFlow {
  return {
    ...flow,
    tags: Array.isArray(flow.tags) ? flow.tags : [],
    requestBodyPreview: flow.requestBodyPreview || "",
    responseBodyPreview: flow.responseBodyPreview || "",
    errorType: flow.errorType || "",
  };
}

function normalizeStoredRule(rule: ProxyRule): ProxyRule {
  const kind = ["mock", "mapLocal", "breakpoint", "rewrite"].includes(rule.kind)
    ? rule.kind
    : "mock";
  const fallbackDirection = kind === "rewrite" ? "response" : "request";
  const direction = ["request", "response", "both"].includes(rule.direction)
    ? rule.direction
    : fallbackDirection;
  return {
    ...rule,
    kind,
    direction,
    pattern: rule.pattern || "",
    statusCode: rule.statusCode ?? null,
    headers: rule.headers && typeof rule.headers === "object" ? rule.headers : {},
    body: rule.body || "",
    search: rule.search || "",
    replace: rule.replace || "",
    localPath: rule.localPath || "",
    delayMs: rule.delayMs ?? null,
  };
}

function SetupQrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSrc("");
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(value, {
      width: 148,
      margin: 1,
      color: {
        dark: "#172233",
        light: "#ffffff",
      },
    })
      .then((nextSrc) => {
        if (!cancelled) {
          setSrc(nextSrc);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSrc("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <div className="setup-qr" aria-label={label}>
      {src ? <img src={src} alt={label} /> : <QrCode size={36} />}
    </div>
  );
}

function readLocalSession():
  | { flows: CaptureFlow[]; rules: ProxyRule[]; weakNetwork?: WeakNetworkProfile; savedAt?: string }
  | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const payload = JSON.parse(window.localStorage.getItem(localSessionKey) || "null") as
      | {
          flows?: CaptureFlow[];
          rules?: ProxyRule[];
          weakNetwork?: WeakNetworkProfile;
          savedAt?: string;
        }
      | null;
    if (!payload || !Array.isArray(payload.flows)) {
      return null;
    }
    return {
      flows: payload.flows.map(normalizeStoredFlow),
      rules: Array.isArray(payload.rules) ? payload.rules.map(normalizeStoredRule) : [],
      weakNetwork: payload.weakNetwork,
      savedAt: payload.savedAt,
    };
  } catch {
    return null;
  }
}

function writeLocalSession(flows: CaptureFlow[], rules: ProxyRule[], weakNetwork: WeakNetworkProfile) {
  if (typeof window === "undefined") {
    return;
  }
  const makePayload = (limit: number) =>
    JSON.stringify({
      ...buildSessionExport(flows.slice(0, limit).map(compactFlowForStorage), rules, weakNetwork),
      savedAt: new Date().toISOString(),
      autoSaved: true,
    });

  try {
    window.localStorage.setItem(localSessionKey, makePayload(localSessionFlowLimit));
  } catch {
    try {
      window.localStorage.setItem(localSessionKey, makePayload(80));
    } catch {
      window.localStorage.removeItem(localSessionKey);
    }
  }
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function flowToDraft(flow: CaptureFlow): RequestDraft {
  return {
    method: flow.method,
    url: buildRequestUrl(flow),
    headers: { ...flow.requestHeaders },
    body: flow.requestBodyPreview,
  };
}

function parseJsonObject(value: string, label: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON object。`);
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

function downloadJsonFile(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sessionFileName(extension: "json" | "har") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `heaveneye-agent-${stamp}.${extension}`;
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildTrustCertificateCommand(certPath: string) {
  return certPath
    ? `sudo security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain ${shellQuote(certPath)}`
    : "";
}

function buildCertTrustFailureDialog(
  title: string,
  message: string,
  certPath: string,
): CertTrustDialog {
  const deniedByInteraction = /authorization was denied|no user interaction|user interaction was possible/i.test(message);
  return {
    title,
    message,
    detail: message,
    hint: deniedByInteraction
      ? "macOS 没有允许 HeavenEye Agent 弹出管理员授权窗口，或授权已被取消。可以重试一次；如果仍失败，请复制下方命令到终端执行，或打开证书后在钥匙串中手动设为始终信任。"
      : "系统没有完成根证书信任配置。请查看完整错误；可以重试一键信任，或复制终端命令手动加入系统钥匙串。",
    certPath,
    command: buildTrustCertificateCommand(certPath),
  };
}

function statusTone(statusCode: number | null, errorType: string) {
  if (errorType) {
    return "bad";
  }
  if (!statusCode) {
    return "muted";
  }
  if (statusCode >= 500) {
    return "bad";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  if (statusCode >= 300) {
    return "info";
  }
  return "good";
}

function formatProxySetting(setting: SystemProxySetting) {
  if (!setting.enabled) {
    return "off";
  }
  return `${setting.host || "-"}:${setting.port ?? "-"}`;
}

function byteLabel(value: number) {
  if (value > 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value > 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

const bodyPreviewLimitBytes = 128 * 1024;
const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

type PayloadTab = "request" | "response" | "eventstream";

function utf8ByteLength(value: string) {
  if (textEncoder) {
    return textEncoder.encode(value).length;
  }
  return value.length;
}

function bodyPreviewMeta(flow: CaptureFlow, direction: "request" | "response"): InspectorPayloadMeta {
  const preview = direction === "request" ? flow.requestBodyPreview || "" : flow.responseBodyPreview || "";
  const previewBytes = utf8ByteLength(preview);
  const decodedBytes =
    direction === "request" ? flow.requestBodyDecodedSize || undefined : flow.responseBodyDecodedSize || undefined;
  const capturedBytes =
    direction === "request" ? flow.requestBodyReplaySize || flow.requestSize : flow.responseSize;
  const knownTruncated =
    direction === "request" ? flow.requestBodyPreviewTruncated : flow.responseBodyPreviewTruncated;
  const likelyTruncated =
    previewBytes >= bodyPreviewLimitBytes * 0.96 &&
    (decodedBytes ? decodedBytes > previewBytes : capturedBytes > previewBytes);

  return {
    mode: "preview",
    previewBytes,
    decodedBytes,
    capturedBytes,
    truncated: Boolean(knownTruncated) || likelyTruncated,
  };
}

function replayBodyPreviewMeta(result: ReplayResult): InspectorPayloadMeta {
  const previewBytes = utf8ByteLength(result.responseBodyPreview || "");
  const decodedBytes = result.responseBodyDecodedSize || undefined;
  const capturedBytes = result.responseSize;
  return {
    mode: "preview",
    previewBytes,
    decodedBytes,
    capturedBytes,
    truncated:
      Boolean(result.responseBodyPreviewTruncated) ||
      (previewBytes >= bodyPreviewLimitBytes * 0.96 &&
        (decodedBytes ? decodedBytes > previewBytes : capturedBytes > previewBytes)),
  };
}

function bodyContentKey(flowId: string, direction: "request" | "response") {
  return `${flowId}:${direction}`;
}

function fullBodyMeta(body: CaptureBodyContent): InspectorPayloadMeta {
  return {
    mode: "body",
    previewBytes: utf8ByteLength(body.content || ""),
    decodedBytes: body.decodedSize || undefined,
    capturedBytes: body.size || undefined,
    truncated: !body.complete,
  };
}

function isStreamingFlow(flow: CaptureFlow) {
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  return tags.includes("streaming-response") || tags.includes("sse");
}

function isEventStreamFlow(flow: CaptureFlow) {
  const contentType = headerValue(flow.responseHeaders, "content-type").toLowerCase();
  return isStreamingFlow(flow) || contentType.includes("text/event-stream");
}

function compactByteLabel(value: number) {
  if (!value) {
    return "0 B";
  }
  if (value > 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
}

function CollapsibleCard({
  title,
  actions,
  children,
  defaultOpen = true,
  className = "",
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={["detail-card", open ? "open" : "collapsed", className].filter(Boolean).join(" ")}>
      <div className="detail-card-head">
        <button
          type="button"
          className="detail-card-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          title={`${open ? "收起" : "展开"}${title}`}
        >
          <ChevronRight size={15} className={open ? "open" : ""} />
          <h3>{title}</h3>
        </button>
        {actions ? <div className="inspector-actions">{actions}</div> : null}
      </div>
      {open ? <div className="detail-card-body">{children}</div> : null}
    </section>
  );
}

function InspectorBlock({
  title,
  value,
  meta,
  copyKey,
  copiedKey,
  onCopy,
  onExpand,
  showActions = true,
  defaultOpen = false,
}: {
  title: string;
  value: unknown;
  meta?: InspectorPayloadMeta;
  copyKey: string;
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
  onExpand: (title: string, value: unknown, meta?: InspectorPayloadMeta) => void;
  showActions?: boolean;
  defaultOpen?: boolean;
}) {
  const hasContent = typeof value === "string" ? value.length > 0 : true;
  const formatted = hasContent ? formatInspectorContent(value) : null;
  const copyLabel = copiedKey === copyKey ? "已复制" : "复制";

  return (
    <CollapsibleCard
      title={title}
      defaultOpen={defaultOpen}
      actions={
        showActions ? (
          <>
            <button
              type="button"
              className="inline-code-action"
              disabled={!hasContent}
              onClick={() => onCopy(serializeInspectorContent(value), copyKey)}
              title={`复制${title}`}
            >
              <Copy size={13} />
              <span>{copyLabel}</span>
            </button>
            <button
              type="button"
              className="inline-code-action"
              disabled={!hasContent}
              onClick={() => onExpand(title, value, meta)}
              title={`放大查看${title}`}
            >
              <Maximize2 size={13} />
              <span>放大查看</span>
            </button>
          </>
        ) : null
      }
    >
      {formatted ? (
        <InspectorPreview content={formatted.content} language={formatted.language} meta={meta} />
      ) : (
        <div className="empty-line">Empty</div>
      )}
    </CollapsibleCard>
  );
}

function EventStreamPanel({
  events,
  rawContent,
  flow,
  copiedKey,
  onCopy,
  onExpand,
}: {
  events: SseEventRow[];
  rawContent: string;
  flow: CaptureFlow;
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
  onExpand: (title: string, value: unknown, meta?: InspectorPayloadMeta) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const isOpen = !flow.completedAt;

  useEffect(() => {
    setSelectedIndex(0);
  }, [flow.id]);

  useEffect(() => {
    if (selectedIndex >= events.length) {
      setSelectedIndex(Math.max(events.length - 1, 0));
    }
  }, [events.length, selectedIndex]);

  const selectedEvent = events[selectedIndex] || null;
  const selectedValue = selectedEvent?.data || selectedEvent?.raw || "";
  const selectedFormatted = selectedValue ? formatInspectorContent(selectedValue) : null;
  const rawMeta: InspectorPayloadMeta = bodyPreviewMeta(flow, "response");
  const copyKey = `eventstream-${flow.id}`;
  const selectedCopyKey = selectedEvent ? `eventstream-event-${flow.id}-${selectedEvent.index}` : copyKey;

  return (
    <div className="eventstream-panel">
      <div className="eventstream-toolbar">
        <div className="eventstream-state">
          <span className={["eventstream-dot", isOpen ? "live" : ""].join(" ")} />
          <strong>EventStream</strong>
          <span>{events.length} events</span>
          <span>{byteLabel(flow.responseSize)}</span>
        </div>
        <div className="inspector-actions">
          <button
            type="button"
            className="inline-code-action"
            disabled={!rawContent.trim()}
            onClick={() => onCopy(rawContent, copyKey)}
            title="复制 EventStream 原文"
          >
            <Copy size={13} />
            <span>{copiedKey === copyKey ? "已复制" : "复制原文"}</span>
          </button>
          <button
            type="button"
            className="inline-code-action"
            disabled={!rawContent.trim()}
            onClick={() => onExpand("EventStream", rawContent, rawMeta)}
            title="放大查看 EventStream"
          >
            <Maximize2 size={13} />
            <span>放大查看</span>
          </button>
        </div>
      </div>

      {events.length ? (
        <div className="eventstream-grid">
          <div className="eventstream-list" role="listbox" aria-label="EventStream events">
            <div className="eventstream-list-head">
              <span>#</span>
              <span>Event</span>
              <span>Data</span>
              <span>ID</span>
            </div>
            {events.map((event, index) => (
              <button
                key={`${event.index}-${event.id}-${index}`}
                type="button"
                className={["eventstream-row", index === selectedIndex ? "selected" : ""].join(" ")}
                onClick={() => setSelectedIndex(index)}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span>{event.index}</span>
                <span>{event.event}</span>
                <span>{event.data || event.raw || "-"}</span>
                <span>{event.id || (event.complete ? "-" : "pending")}</span>
              </button>
            ))}
          </div>
          <div className="eventstream-detail">
            <div className="eventstream-detail-head">
              <div>
                <strong>{selectedEvent ? `${selectedEvent.event} #${selectedEvent.index}` : "Event"}</strong>
                {selectedEvent && !selectedEvent.complete ? <span>pending</span> : null}
              </div>
              <button
                type="button"
                className="inline-code-action compact"
                disabled={!selectedValue}
                onClick={() => onCopy(selectedValue, selectedCopyKey)}
                title="复制当前事件 data"
              >
                <Copy size={13} />
                <span>{copiedKey === selectedCopyKey ? "已复制" : "复制"}</span>
              </button>
            </div>
            {selectedFormatted ? (
              <InspectorPreview
                content={selectedFormatted.content}
                language={selectedFormatted.language}
                meta={rawMeta}
              />
            ) : (
              <div className="empty-line">Empty</div>
            )}
          </div>
        </div>
      ) : (
        <div className="eventstream-empty">
          <Radio size={15} />
          <span>{isOpen ? "等待服务器发送事件..." : "没有捕获到 EventStream 事件。"}</span>
        </div>
      )}
    </div>
  );
}

function PayloadSwitcher({
  flow,
  queryParams,
  fullRequestBody,
  fullResponseBody,
  copiedKey,
  copy,
  onCopy,
  onExpand,
  onCompare,
}: {
  flow: CaptureFlow;
  queryParams: Record<string, string | string[]>;
  fullRequestBody?: CaptureBodyContent;
  fullResponseBody?: CaptureBodyContent;
  copiedKey: string | null;
  copy: AppCopy;
  onCopy: (value: string, key: string) => void;
  onExpand: (title: string, value: unknown, meta?: InspectorPayloadMeta) => void;
  onCompare: () => void;
}) {
  const isEventStream = isEventStreamFlow(flow);
  const usableFullResponseBody = isEventStream ? undefined : fullResponseBody;
  const requestBodyValue = fullRequestBody?.content ?? flow.requestBodyPreview;
  const responseBodyValue = usableFullResponseBody?.content ?? flow.responseBodyPreview;
  const requestBodyMeta = fullRequestBody ? fullBodyMeta(fullRequestBody) : bodyPreviewMeta(flow, "request");
  const responseBodyMeta = usableFullResponseBody ? fullBodyMeta(usableFullResponseBody) : bodyPreviewMeta(flow, "response");
  const eventStreamEvents = useMemo(() => parseSseEvents(responseBodyValue || ""), [responseBodyValue]);
  const hasQueryParams = Object.keys(queryParams).length > 0;
  const hasRequestBody = Boolean(requestBodyValue);
  const hasRequestPayload = hasQueryParams || hasRequestBody;
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<PayloadTab>(() =>
    isEventStream ? "eventstream" : hasRequestPayload ? "request" : "response",
  );

  useEffect(() => {
    setActiveTab(isEventStream ? "eventstream" : hasRequestPayload ? "request" : "response");
  }, [flow.id]);

  useEffect(() => {
    if (!hasRequestPayload && activeTab === "request") {
      setActiveTab(isEventStream ? "eventstream" : "response");
    }
    if (!isEventStream && activeTab === "eventstream") {
      setActiveTab("response");
    }
  }, [activeTab, hasRequestPayload, isEventStream]);

  const requestPayload = {
    ...(hasQueryParams ? { queryParams } : {}),
    ...(hasRequestBody ? { requestBody: requestBodyValue } : {}),
  };
  const visibleActiveTab: PayloadTab = activeTab === "request" && !hasRequestPayload
    ? isEventStream
      ? "eventstream"
      : "response"
    : activeTab === "eventstream" && !isEventStream
      ? "response"
      : activeTab;
  const activeFullBody =
    visibleActiveTab === "request" ? fullRequestBody : visibleActiveTab === "response" ? usableFullResponseBody : undefined;
  const activePayload =
    visibleActiveTab === "request"
      ? requestPayload
      : visibleActiveTab === "eventstream"
        ? responseBodyValue
        : responseBodyValue;
  const activePayloadTitle =
    visibleActiveTab === "request"
      ? copy.payloadRequestTitle
      : visibleActiveTab === "eventstream"
        ? "EventStream"
        : copy.payloadResponseTitle;
  const activePayloadMeta = visibleActiveTab === "request" ? requestBodyMeta : responseBodyMeta;
  const activePayloadCopyKey =
    visibleActiveTab === "request"
      ? `request-payload-${flow.id}`
      : visibleActiveTab === "eventstream"
        ? `eventstream-${flow.id}`
        : `response-body-${flow.id}`;
  const activePayloadHasContent = visibleActiveTab === "request" ? hasRequestPayload : Boolean(responseBodyValue);
  const activePayloadCopyLabel = copiedKey === activePayloadCopyKey ? copy.copied : copy.copy;
  const bodyMetaLabel = activeFullBody?.complete
    ? `${copy.complete} ${byteLabel(activeFullBody.decodedSize || activeFullBody.content.length)}`
    : activeFullBody?.fromPreview
      ? copy.previewFallback
      : "";

  return (
    <section className={["detail-card", "payload-card", open ? "open" : "collapsed"].join(" ")}>
      <div className="detail-card-head payload-card-head">
        <div className="payload-title-area">
          <button
            type="button"
            className="detail-card-toggle payload-collapse-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            title={`${open ? "收起" : "展开"}${copy.payloadTabsLabel}`}
          >
            <ChevronRight size={15} className={open ? "open" : ""} />
          </button>
          <div className="payload-tabs" role="tablist" aria-label={copy.payloadTabsLabel}>
            {hasRequestPayload ? (
              <button
                type="button"
                className={visibleActiveTab === "request" ? "active" : ""}
                onClick={() => setActiveTab("request")}
              >
                {copy.payloadRequest}
              </button>
            ) : null}
            <button
              type="button"
              className={visibleActiveTab === "response" ? "active" : ""}
              onClick={() => setActiveTab("response")}
            >
              {copy.payloadResponse}
            </button>
            {isEventStream ? (
              <button
                type="button"
                className={visibleActiveTab === "eventstream" ? "active" : ""}
                onClick={() => setActiveTab("eventstream")}
              >
                EventStream
              </button>
            ) : null}
          </div>
          {bodyMetaLabel ? <span className="payload-body-state">{bodyMetaLabel}</span> : null}
        </div>
        <div className="inspector-actions">
          <button
            type="button"
            className="inline-code-action"
            disabled={!activePayloadHasContent}
            onClick={() => onCopy(serializeInspectorContent(activePayload), activePayloadCopyKey)}
            title={`${copy.copy}${activePayloadTitle}`}
          >
            <Copy size={13} />
            <span>{activePayloadCopyLabel}</span>
          </button>
          <button
            type="button"
            className="inline-code-action"
            disabled={!activePayloadHasContent}
            onClick={() => onExpand(activePayloadTitle, activePayload, activePayloadMeta)}
            title={`${copy.expand}${activePayloadTitle}`}
          >
            <Maximize2 size={13} />
            <span>{copy.expand}</span>
          </button>
          {hasRequestPayload ? (
            <button type="button" className="inline-code-action" onClick={onCompare} title={copy.payloadTabsLabel}>
              <Columns3 size={13} />
              <span>{copy.compare}</span>
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="detail-card-body">
          {visibleActiveTab === "request" ? (
            <div className="payload-pane">
              {hasQueryParams ? (
                <InspectorBlock
                  title={copy.queryParams}
                  value={queryParams}
                  copyKey={`query-params-${flow.id}`}
                  copiedKey={copiedKey}
                  onCopy={onCopy}
                  onExpand={onExpand}
                  showActions={false}
                  defaultOpen
                />
              ) : null}
              {hasRequestBody ? (
                <InspectorBlock
                  title={copy.requestBody}
                  value={requestBodyValue}
                  meta={requestBodyMeta}
                  copyKey={`request-body-${flow.id}`}
                  copiedKey={copiedKey}
                  onCopy={onCopy}
                  onExpand={onExpand}
                  showActions={false}
                  defaultOpen
                />
              ) : null}
            </div>
          ) : visibleActiveTab === "eventstream" ? (
            <EventStreamPanel
              events={eventStreamEvents}
              rawContent={responseBodyValue || ""}
              flow={flow}
              copiedKey={copiedKey}
              onCopy={onCopy}
              onExpand={onExpand}
            />
          ) : (
            <div className="payload-pane">
              <InspectorBlock
                title={copy.responseBody}
                value={responseBodyValue}
                meta={responseBodyMeta}
                copyKey={`response-body-${flow.id}`}
                copiedKey={copiedKey}
                onCopy={onCopy}
                onExpand={onExpand}
                showActions={false}
                defaultOpen
              />
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function parseQueryParams(query: string) {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  return Array.from(params.entries()).reduce<Record<string, string | string[]>>((acc, [key, value]) => {
    const current = acc[key];
    if (Array.isArray(current)) {
      current.push(value);
    } else if (typeof current === "string") {
      acc[key] = [current, value];
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function displayRequestName(flow: CaptureFlow) {
  if (flow.method === "CONNECT") {
    return flow.host;
  }

  const path = flow.path || "/";
  const cleanPath = path.replace(/\/+$/, "") || "/";
  const rawSegment = cleanPath === "/" ? flow.host : cleanPath.split("/").filter(Boolean).at(-1) || cleanPath;
  const lastSegment = safeDecode(rawSegment);
  const suffix = path.endsWith("/") && lastSegment !== flow.host ? `${lastSegment}/` : lastSegment;

  return `${suffix}${flow.query || ""}`;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeLookupText(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{L}\p{N}/_.?-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flowLookupText(flow: CaptureFlow) {
  return normalizeLookupText(
    [
      flow.method,
      flow.host,
      flow.path,
      flow.query,
      displayRequestName(flow),
      `${flow.host}${flow.path}${flow.query || ""}`,
      buildRequestUrl(flow),
      String(flow.statusCode || ""),
    ].join(" "),
  );
}

function mentionTokens(text: string) {
  return Array.from(text.matchAll(/@([^\s@]+)/g))
    .map((match) => normalizeLookupText(match[1] || ""))
    .filter(Boolean);
}

function flowMentionAliases(flow: CaptureFlow) {
  const cleanPathParts = (flow.path || "")
    .split("/")
    .map((part) => safeDecode(part))
    .filter(Boolean);
  return [
    displayRequestName(flow),
    cleanPathParts.at(-1) || "",
    flow.path,
    `${flow.path}${flow.query || ""}`,
    `${flow.host}${flow.path}${flow.query || ""}`,
    buildRequestUrl(flow),
    flow.id,
  ]
    .map(normalizeLookupText)
    .filter(Boolean);
}

function findFlowMentionedInText(text: string, candidates: CaptureFlow[]) {
  const normalizedText = normalizeLookupText(text);
  if (!normalizedText) {
    return null;
  }

  const tokens = mentionTokens(text);
  for (const token of tokens) {
    const matched = candidates.find((flow) =>
      flowMentionAliases(flow).some((alias) => alias === token || alias.endsWith(`/${token}`)),
    );
    if (matched) {
      return matched;
    }
  }

  return (
    candidates.find((flow) => {
      const requestName = normalizeLookupText(displayRequestName(flow));
      const path = normalizeLookupText(`${flow.path}${flow.query || ""}`);
      const fullPath = normalizeLookupText(`${flow.host}${flow.path}${flow.query || ""}`);
      return (
        (requestName.length >= 4 && normalizedText.includes(requestName)) ||
        (path.length >= 5 && normalizedText.includes(path)) ||
        (fullPath.length >= 8 && normalizedText.includes(fullPath))
      );
    }) || null
  );
}

function isFlowMentionStillInQuestion(flow: CaptureFlow, question: string) {
  const normalizedText = normalizeLookupText(question);
  if (!normalizedText) {
    return false;
  }
  const tokens = mentionTokens(question);
  const aliases = flowMentionAliases(flow);
  if (tokens.some((token) => aliases.some((alias) => alias === token || alias.endsWith(`/${token}`)))) {
    return true;
  }
  return aliases.some((alias) => alias.length >= 4 && normalizedText.includes(alias));
}

function buildFocusedAgentQuestion(question: string, flow: CaptureFlow | null) {
  if (!flow) {
    return question;
  }
  return [
    question,
    "",
    "用户在接口列表中显式点选了下面这个接口，请优先围绕它回答，不要改分析到同名或其它慢接口，除非明确说明是在对比：",
    `flowId: ${flow.id}`,
    `requestName: ${displayRequestName(flow)}`,
    `method: ${flow.method}`,
    `url: ${buildRequestUrl(flow)}`,
    `status: ${flow.statusCode ?? "-"}`,
    `durationMs: ${flow.durationMs ?? "-"}`,
  ].join("\n");
}

function prioritizeAgentFlows(flows: CaptureFlow[], focusedFlow: CaptureFlow | null) {
  if (!focusedFlow) {
    return flows;
  }
  return flows.map((flow) =>
    flow.id === focusedFlow.id
      ? {
          ...flow,
          tags: Array.from(new Set([...(Array.isArray(flow.tags) ? flow.tags : []), "selected", "selected-by-user"])),
        }
      : flow,
  );
}

function findLikelyFlowForQuestion(text: string, candidates: CaptureFlow[]) {
  const normalizedText = normalizeLookupText(text);
  if (!normalizedText || !candidates.length) {
    return null;
  }

  if (/报错|错误|失败|异常|error|fail|status|404|401|403|500|502/.test(normalizedText)) {
    return candidates.find((flow) => Boolean(flow.errorType) || Boolean(flow.statusCode && flow.statusCode >= 400)) || null;
  }

  if (/慢|耗时|瓶颈|卡|timeout|slow|duration|latency/.test(normalizedText)) {
    return (
      candidates
        .filter((flow) => flow.durationMs !== null)
        .sort((left, right) => Number(right.durationMs || 0) - Number(left.durationMs || 0))[0] || null
    );
  }

  if (/uid|user|用户|账号|账户|登录|login|account|current|profile|me/.test(normalizedText)) {
    return (
      candidates.find((flow) =>
        flowLookupText(flow).match(/current|login|auth|user|account|profile|session|me|subscriptions/),
      ) || null
    );
  }

  return null;
}

function fillTemplate(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function isWeakNetworkCommand(text: string) {
  return /弱网|弱网络|网络差|限速|延迟|丢包|slow network|throttle|latency|packet loss/i.test(text);
}

function isDisableWeakNetworkCommand(text: string) {
  return /关闭|取消|恢复|正常|disable|off|normal|restore/i.test(text) && isWeakNetworkCommand(text);
}

function isReplayCommand(text: string) {
  return /重放|重试|重新请求|再请求|重启请求|replay|repeat|retry/i.test(text);
}

function isApiTestCommand(text: string) {
  return /接口测试|测试接口|测试.*api|api.*test|test.*api|请求测试|测试.*请求/i.test(text);
}

function parseNumberNear(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1] || match[2]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

function weakNetworkProfileFromText(text: string): WeakNetworkProfile {
  const normalized = text.toLowerCase();
  const base = /重度|very slow|bad network|poor network/.test(normalized)
    ? { enabled: true, delayMs: 1800, downstreamKbps: 32, errorRate: 0.05 }
    : /轻度|light|slight/.test(normalized)
      ? { enabled: true, delayMs: 300, downstreamKbps: 256, errorRate: 0 }
      : quickWeakNetworkProfile;

  const delayMs = parseNumberNear(text, [/(\d+(?:\.\d+)?)\s*ms/i, /延迟\s*(\d+(?:\.\d+)?)/]);
  const downstreamKbps = parseNumberNear(text, [
    /(\d+(?:\.\d+)?)\s*(?:kb\/s|kbps|k\/s)/i,
    /下行\s*(\d+(?:\.\d+)?)/,
    /限速\s*(\d+(?:\.\d+)?)/,
  ]);
  const errorPercent = parseNumberNear(text, [/(\d+(?:\.\d+)?)\s*%/, /错误率\s*(\d+(?:\.\d+)?)/]);

  return {
    enabled: true,
    delayMs: Math.max(0, Math.round(delayMs ?? base.delayMs)),
    downstreamKbps: Math.max(0, Math.round(downstreamKbps ?? base.downstreamKbps)),
    errorRate: Math.min(1, Math.max(0, errorPercent === null ? base.errorRate : errorPercent / 100)),
  };
}

function buildApiTestAgentQuestion(question: string) {
  return [
    question,
    "",
    "这是接口测试任务：请先根据抓包里的真实 URL、query、headers、request body、response body/status 识别参数结构和基线行为，再设计 3-5 个低风险测试用例。",
    "请在 JSON 的 testCases 字段返回可执行用例。每个用例只写需要变更的 query/body/headers；前端会以当前请求为基线合并这些变更后发送。",
    "不要设计删除、扣费、批量写入、真实发送消息等破坏性用例；优先覆盖边界值、缺失字段、类型错误、权限/登录态、弱网或幂等性。",
  ].join("\n");
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonObject(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...base, ...patch }).map(([key, value]) => {
      const baseValue = base[key];
      if (isPlainJsonObject(baseValue) && isPlainJsonObject(value)) {
        return [key, mergeJsonObject(baseValue, value)];
      }
      return [key, value];
    }),
  );
}

function bodyFromTestCase(originalBody: string, testCase: AgentTestCase) {
  if (!Object.prototype.hasOwnProperty.call(testCase, "body")) {
    return originalBody;
  }
  if (testCase.body === null || testCase.body === undefined) {
    return "";
  }
  if (typeof testCase.body === "string") {
    return testCase.body;
  }

  const parsedOriginal = parseJsonLikeContent(originalBody)?.value;
  const body =
    isPlainJsonObject(parsedOriginal) && isPlainJsonObject(testCase.body)
      ? mergeJsonObject(parsedOriginal, testCase.body)
      : testCase.body;
  return JSON.stringify(body, null, 2);
}

function applyQueryPatch(url: string, query: AgentTestCase["query"]) {
  if (!query || !Object.keys(query).length) {
    return url;
  }
  try {
    const nextUrl = new URL(url);
    Object.entries(query).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        nextUrl.searchParams.delete(key);
      } else {
        nextUrl.searchParams.set(key, String(value));
      }
    });
    return nextUrl.toString();
  } catch {
    return url;
  }
}

function draftFromAgentTestCase(flow: CaptureFlow, testCase: AgentTestCase): RequestDraft {
  const baseDraft = flowToDraft(flow);
  const method = (testCase.method || baseDraft.method).trim().toUpperCase();
  const url = applyQueryPatch((testCase.url || baseDraft.url).trim(), testCase.query);
  const headers = {
    ...baseDraft.headers,
    ...Object.fromEntries(
      Object.entries(testCase.headers || {}).filter(([key, value]) => key.trim() && String(value).trim()),
    ),
  };
  return {
    method,
    url,
    headers,
    body: bodyFromTestCase(baseDraft.body, testCase),
  };
}

type ApiTestRunItem = {
  testCase: AgentTestCase;
  draft: RequestDraft | null;
  result: ReplayResult | null;
  error?: string;
};

function responseJsonSummary(responseBody: string) {
  const parsed = parseJsonLikeContent(responseBody)?.value;
  if (!isPlainJsonObject(parsed)) {
    return { code: undefined as unknown, message: "" };
  }
  const code = parsed.code;
  const message = typeof parsed.message === "string" ? parsed.message : "";
  return { code, message };
}

function textIncludesLoose(haystack: string, needle: string) {
  const normalizedNeedle = needle.trim().toLowerCase();
  if (!normalizedNeedle) {
    return true;
  }
  return haystack.toLowerCase().includes(normalizedNeedle);
}

function evaluateApiTestRunItem(item: ApiTestRunItem) {
  if (!item.result) {
    return {
      passed: false,
      actual: item.error || "No response",
    };
  }

  const expected = item.testCase.expected || "";
  const expectedLower = expected.toLowerCase();
  const status = item.result.statusCode;
  const responseBody = item.result.responseBodyPreview || "";
  const responseLower = responseBody.toLowerCase();
  const { code, message } = responseJsonSummary(responseBody);
  const codeNumber = typeof code === "number" ? code : typeof code === "string" ? Number(code) : NaN;
  const statusOrCodeChecks: boolean[] = [];
  const contentChecks: boolean[] = [];

  const familyMatches = Array.from(expectedLower.matchAll(/([2345])\s*xx/g));
  familyMatches.forEach((match) => {
    const family = Number(match[1]);
    if (status) {
      statusOrCodeChecks.push(Math.floor(status / 100) === family);
    }
  });

  const statusMatch = expectedLower.match(/(?:status|状态|状态码)[^\d]{0,8}(\d{3})/);
  if (statusMatch && status) {
    statusOrCodeChecks.push(status === Number(statusMatch[1]));
  }

  const notStatusMatch = expectedLower.match(/(?:非|不是|not)\s*(\d{3})/);
  if (notStatusMatch && status) {
    statusOrCodeChecks.push(status !== Number(notStatusMatch[1]));
  }

  if (/code[^，。,.;]*?(?:非|不是|not)\s*0|(?:非|不是|not)\s*0[^，。,.;]*?code/i.test(expected)) {
    statusOrCodeChecks.push(Number.isFinite(codeNumber) && codeNumber !== 0);
  }

  const codeMatch = expectedLower.match(/code[^\d-]{0,8}(-?\d+)/);
  if (codeMatch && Number.isFinite(codeNumber)) {
    statusOrCodeChecks.push(codeNumber === Number(codeMatch[1]));
  }

  const messageContainsMatch = expected.match(/message[^，。,.;]*(?:包含|contains)\s*["']?([^"',，。,.;\s]+)/i);
  if (messageContainsMatch) {
    contentChecks.push(textIncludesLoose(message || responseBody, messageContainsMatch[1]));
  }

  const bodyContainsMatch = expected.match(/(?:响应|body|response)[^，。,.;]*(?:包含|contains)\s*["']?([^"',，。,.;\s]+)/i);
  if (bodyContainsMatch) {
    contentChecks.push(textIncludesLoose(responseBody, bodyContainsMatch[1]));
  }

  let passed: boolean;
  if (statusOrCodeChecks.length || contentChecks.length) {
    passed =
      (statusOrCodeChecks.length ? statusOrCodeChecks.some(Boolean) : true) &&
      (contentChecks.length ? contentChecks.every(Boolean) : true);
  } else {
    passed = !item.result.errorType && Boolean(status && status < 500);
  }

  const preview = responseBody.replace(/\s+/g, " ").trim().slice(0, 100);
  const actual = [
    `status=${status ?? (item.result.errorType || "-")}`,
    Number.isFinite(codeNumber) ? `code=${codeNumber}` : "",
    message ? `message=${message}` : "",
    preview && !message ? `body=${preview}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return { passed, actual };
}

function evidenceMatchesFlow(
  evidence: NonNullable<NonNullable<AgentChatMessage["structured"]>["evidence"]>[number],
  flow: CaptureFlow,
) {
  const evidenceHost = normalizeLookupText(evidence.host || "");
  const evidencePath = normalizeLookupText(evidence.path || "");
  const evidenceTitle = normalizeLookupText(evidence.title || "");
  const flowHost = normalizeLookupText(flow.host);
  const flowPath = normalizeLookupText(`${flow.path}${flow.query || ""}`);
  const flowName = normalizeLookupText(displayRequestName(flow));
  const methodMatches = !evidence.method || evidence.method.toUpperCase() === flow.method.toUpperCase();
  const statusMatches =
    evidence.status === undefined ||
    evidence.status === null ||
    String(evidence.status) === String(flow.statusCode || "");
  const hostMatches = !evidenceHost || flowHost.includes(evidenceHost) || evidenceHost.includes(flowHost);
  const pathMatches =
    !evidencePath ||
    flowPath.includes(evidencePath) ||
    evidencePath.includes(flowPath) ||
    flowName.includes(evidencePath) ||
    evidenceTitle.includes(flowName);

  return methodMatches && statusMatches && hostMatches && pathMatches;
}

function findFlowFromStructuredAnswer(message: AgentChatMessage, candidates: CaptureFlow[]) {
  const evidence = message.structured?.evidence || [];
  for (const item of evidence) {
    const matched = candidates.find((flow) => evidenceMatchesFlow(item, flow));
    if (matched) {
      return matched;
    }
  }

  return findFlowMentionedInText(message.content, candidates);
}

function inferRequestType(flow: CaptureFlow) {
  if (flow.method === "CONNECT") {
    return "tunnel";
  }

  const contentType = String(flow.responseHeaders["content-type"] || "").toLowerCase();
  const accept = String(flow.requestHeaders.accept || "").toLowerCase();
  const fetchDest = String(flow.requestHeaders["sec-fetch-dest"] || "").toLowerCase();
  const path = flow.path.toLowerCase();

  if (fetchDest === "document" || contentType.includes("text/html")) return "doc";
  if (fetchDest === "script" || contentType.includes("javascript") || path.endsWith(".js")) return "script";
  if (fetchDest === "style" || contentType.includes("text/css") || path.endsWith(".css")) return "stylesheet";
  if (fetchDest === "image" || contentType.startsWith("image/")) return "img";
  if (fetchDest === "font" || contentType.includes("font")) return "font";
  if (fetchDest === "video" || contentType.startsWith("video/") || path.match(/\.(mp4|webm|mov)$/)) return "media";
  if (contentType.includes("json") || accept.includes("json") || fetchDest === "empty") return "xhr";
  if (flow.method !== "GET") return "xhr";
  return "fetch";
}

function headerValue(headers: Record<string, string>, name: string) {
  const target = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return found?.[1] || "";
}

function parseCookieHeader(value: string) {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const [name, ...rest] = part.split("=");
      const cleanName = name.trim();
      if (cleanName) {
        acc[cleanName] = rest.join("=").trim();
      }
      return acc;
    }, {});
}

function responseCookieRows(flow: CaptureFlow) {
  const raw = headerValue(flow.responseHeaders, "set-cookie");
  if (!raw) {
    return {};
  }

  return raw
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part, index) => {
      const firstPair = part.split(";")[0] || "";
      const [name, ...rest] = firstPair.split("=");
      acc[name.trim() || `set-cookie-${index + 1}`] = rest.join("=").trim() || part;
      return acc;
    }, {});
}

function flowRuleId(flow: CaptureFlow) {
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  return tags.find((tag) => tag.startsWith("rule:"))?.slice("rule:".length) || null;
}

function flowRuleHit(flow: CaptureFlow, rules: ProxyRule[]) {
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  const ruleId = flowRuleId(flow);
  const rule = ruleId ? rules.find((item) => item.id === ruleId) || null : null;
  const kind =
    tags.find((tag) => ["mock", "map-local", "breakpoint", "rewrite"].includes(tag)) ||
    rule?.kind ||
    (tags.includes("drop") ? "drop" : "");
  return {
    hit: Boolean(ruleId || kind),
    ruleId,
    rule,
    kind,
    label: kind ? `${kind}${ruleId ? ` · ${ruleId.slice(0, 10)}` : ""}` : "",
  };
}

function ruleHitCounts(flows: CaptureFlow[]) {
  return flows.reduce<Record<string, number>>((acc, flow) => {
    const ruleId = flowRuleId(flow);
    if (ruleId) {
      acc[ruleId] = (acc[ruleId] || 0) + 1;
    }
    return acc;
  }, {});
}

function matchesStatusFilter(flow: CaptureFlow, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "pending") return flow.statusCode === null;
  if (filter === "error") return Boolean(flow.errorType) || Boolean(flow.statusCode && flow.statusCode >= 400);
  const status = flow.statusCode || 0;
  if (filter === "2xx") return status >= 200 && status < 300;
  if (filter === "3xx") return status >= 300 && status < 400;
  if (filter === "4xx") return status >= 400 && status < 500;
  if (filter === "5xx") return status >= 500 && status < 600;
  return true;
}

function matchesTagFilter(flow: CaptureFlow, filter: TagFilter) {
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  if (filter === "all") return true;
  if (filter === "rule") return Boolean(flowRuleId(flow));
  if (filter === "slow") return (flow.durationMs || 0) > 1000;
  if (filter === "failure") return Boolean(flow.errorType) || Boolean(flow.statusCode && flow.statusCode >= 400);
  return tags.includes(filter);
}

function activeStructuredFilterCount(filters: StructuredFilters) {
  return Object.entries(filters).filter(([key, value]) => {
    if (key === "method" || key === "type") return value !== "all";
    return value !== "all";
  }).length;
}

function headersToRaw(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function rawRequest(flow: CaptureFlow) {
  const target = `${flow.path || "/"}${flow.query || ""}`;
  return `${flow.method} ${target} ${flow.protocol}\nHost: ${flow.host}\n${headersToRaw(flow.requestHeaders)}\n\n${flow.requestBodyPreview || ""}`;
}

function rawResponse(flow: CaptureFlow) {
  const status = flow.statusCode || "";
  return `${flow.protocol} ${status}\n${headersToRaw(flow.responseHeaders)}\n\n${flow.responseBodyPreview || ""}`;
}

function timingDetails(flow: CaptureFlow) {
  return {
    started: new Date(flow.startedAt).toLocaleString(),
    completed: flow.completedAt ? new Date(flow.completedAt).toLocaleString() : "Pending",
    durationMs: flow.durationMs ?? "-",
    requestBytes: flow.requestSize,
    responseBytes: flow.responseSize,
    capturedTotalBytes: flow.requestSize + flow.responseSize,
    note: "Proxy currently records total capture duration. DNS/connect/SSL phases are not separated yet.",
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function writeTextToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (!copied) {
      throw error;
    }
  }
}

type RequestExportKind = "curl" | "playwright" | "postman";

function exportKey(kind: RequestExportKind, flow: CaptureFlow) {
  return `${kind}-${flow.id}`;
}

function AgentThinkingCard({ copy, onCancel }: { copy: AppCopy; onCancel?: () => void }) {
  const steps = [copy.thinkingStepRequests, copy.thinkingStepEvidence, copy.thinkingStepAnswer];

  return (
    <div className="agent-thinking-card" role="status" aria-live="polite">
      <div className="agent-thinking-head">
        <span className="thinking-spinner" aria-hidden="true">
          <Loader2 size={16} />
        </span>
        <div>
          <strong>{copy.thinkingTitle}</strong>
          <span>{copy.thinkingHint}</span>
        </div>
        {onCancel ? (
          <button className="thinking-cancel" type="button" onClick={onCancel}>
            <X size={13} />
            <span>{copy.cancelAgent}</span>
          </button>
        ) : null}
      </div>
      <div className="thinking-steps" aria-hidden="true">
        {steps.map((step) => (
          <span key={step}>{step}</span>
        ))}
      </div>
    </div>
  );
}

function AgentTextAnswer({ content }: { content: string }) {
  const blocks = content
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    return <div className="empty-line">Empty</div>;
  }

  return (
    <div className="agent-text-answer">
      {blocks.map((block, index) => renderAgentTextBlock(block, index))}
    </div>
  );
}

function renderAgentTextBlock(block: string, index: number) {
  const lines = block
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const firstLine = lines[0] || "";
  const heading = firstLine.match(/^#{1,4}\s+(.+)$/);
  const allBullets = lines.length > 1 && lines.every((line) => /^[-*]\s+/.test(line));
  const allNumbered = lines.length > 1 && lines.every((line) => /^\d+[.)]\s+/.test(line));
  const looksLikeTable = lines.length > 1 && lines.every((line) => line.includes("|"));

  if (heading) {
    return <h4 key={`heading-${index}`}>{heading[1]}</h4>;
  }

  if (allBullets) {
    return (
      <ul key={`bullets-${index}`}>
        {lines.map((line, lineIndex) => (
          <li key={`${line}-${lineIndex}`}>{line.replace(/^[-*]\s+/, "")}</li>
        ))}
      </ul>
    );
  }

  if (allNumbered) {
    return (
      <ol key={`numbered-${index}`}>
        {lines.map((line, lineIndex) => (
          <li key={`${line}-${lineIndex}`}>{line.replace(/^\d+[.)]\s+/, "")}</li>
        ))}
      </ol>
    );
  }

  if (looksLikeTable) {
    return (
      <pre key={`table-${index}`} className="agent-text-table">
        {block}
      </pre>
    );
  }

  return (
    <p key={`paragraph-${index}`}>
      {lines.map((line, lineIndex) => (
        <span key={`${line}-${lineIndex}`}>
          {line}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}

function RequestContextAction({
  icon,
  label,
  hint,
  copied,
  copiedLabel,
  busy,
  primary,
  disabled,
  disabledReason,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  copied?: boolean;
  copiedLabel: string;
  busy?: boolean;
  primary?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const actionHint = disabled && disabledReason ? disabledReason : copied ? copiedLabel : hint;

  return (
    <button
      type="button"
      role="menuitem"
      className={["context-action", primary ? "primary" : "", copied ? "copied" : "", busy ? "busy" : ""]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled}
      onClick={onClick}
      title={actionHint}
    >
      <span className="context-action-icon">{busy ? <Loader2 size={14} /> : icon}</span>
      <span className="context-action-copy">
        <strong>{label}</strong>
        <small>{actionHint}</small>
      </span>
      {copied ? <Check size={14} className="context-action-check" /> : null}
    </button>
  );
}

function ReplayResultCard({
  result,
  copiedKey,
  onCopy,
  onExpand,
}: {
  result: ReplayResult;
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
  onExpand: (title: string, value: unknown, meta?: InspectorPayloadMeta) => void;
}) {
  const formattedBody = result.responseBodyPreview.trim()
    ? formatInspectorContent(result.responseBodyPreview)
    : null;
  const responseMeta = replayBodyPreviewMeta(result);
  const statusLabel = result.statusCode || result.errorType || "No response";

  return (
    <CollapsibleCard title="Replay Result" className="replay-result" defaultOpen={false}>
      <div className="replay-result-head">
        <div>
          <code>{result.url}</code>
        </div>
        <span className={`code ${statusTone(result.statusCode, result.errorType)}`}>{statusLabel}</span>
      </div>

      <dl className="facts replay-facts">
        <div>
          <dt>Method</dt>
          <dd>{result.method}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{result.durationMs} ms</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd>{byteLabel(result.responseSize)}</dd>
        </div>
      </dl>

      <div className="inspector-actions replay-actions">
        <button
          type="button"
          className="inline-code-action"
          onClick={() =>
            onCopy(serializeInspectorContent(result.responseHeaders), `replay-response-headers-${result.startedAt}`)
          }
        >
          <Copy size={13} />
          <span>
            {copiedKey === `replay-response-headers-${result.startedAt}` ? "已复制" : "响应头"}
          </span>
        </button>
        <button
          type="button"
          className="inline-code-action"
          disabled={!result.responseBodyPreview.trim()}
          onClick={() => onCopy(result.responseBodyPreview, `replay-response-body-${result.startedAt}`)}
        >
          <Copy size={13} />
          <span>{copiedKey === `replay-response-body-${result.startedAt}` ? "已复制" : "响应体"}</span>
        </button>
        <button
          type="button"
          className="inline-code-action"
          disabled={!result.responseBodyPreview.trim()}
          onClick={() => onExpand("Replay Response Body", result.responseBodyPreview, responseMeta)}
        >
          <Maximize2 size={13} />
          <span>放大查看</span>
        </button>
      </div>

      {result.errorType ? <div className="replay-error">{result.errorType}</div> : null}
      {formattedBody ? (
        <InspectorPreview content={formattedBody.content} language={formattedBody.language} meta={responseMeta} />
      ) : (
        <div className="empty-line">No replay response body</div>
      )}

      <p className="replay-note">Replay 使用后端保留的原始请求体；Copy as cURL/Playwright/Postman 仍使用可读 preview。</p>
    </CollapsibleCard>
  );
}

export function App() {
  const [language, setLanguage] = useState<AppLanguage>(() =>
    readStoredOption("dpa-language", ["zh", "en"] as const, "zh"),
  );
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(readInitialLayoutMode);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    readStoredOption("dpa-theme", ["graphite", "ocean", "ember", "paper"] as const, "graphite"),
  );
  const [layoutSizing, setLayoutSizing] = useState<Record<LayoutMode, LayoutSizing>>(readStoredLayoutSizing);
  const [resizingWorkspace, setResizingWorkspace] = useState<WorkspaceResizeTarget | null>(null);
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel>("agent");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<ProxyStatus>(emptyStatus);
  const [flows, setFlows] = useState<CaptureFlow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [domainInput, setDomainInput] = useState("");
  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [certTrustDialog, setCertTrustDialog] = useState<CertTrustDialog | null>(null);
  const [systemProxy, setSystemProxy] = useState<SystemProxyStatus | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentChatMessage[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentMentionedFlowId, setAgentMentionedFlowId] = useState<string | null>(null);
  const [agentAttachments, setAgentAttachments] = useState<AgentAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<{ flowId: string; result: ReplayResult } | null>(null);
  const [fullBodies, setFullBodies] = useState<Record<string, CaptureBodyContent>>({});
  const [requestMenu, setRequestMenu] = useState<{ flowId: string; x: number; y: number } | null>(null);
  const [requestColumns, setRequestColumns] = useState<RequestColumnVisibility>(readStoredRequestColumnVisibility);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [mobileSetupDialogOpen, setMobileSetupDialogOpen] = useState(false);
  const [aiSettingsDialogOpen, setAiSettingsDialogOpen] = useState(false);
  const [aiConfigDraft, setAiConfigDraft] = useState<
    Pick<AiConfigUpdate, "provider" | "baseUrl" | "model" | "visionModel">
  >({
    provider: "qwen",
    baseUrl: "",
    model: "",
    visionModel: "",
  });
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState("");
  const [clearAiApiKey, setClearAiApiKey] = useState(false);
  const [expandedInspector, setExpandedInspector] = useState<ExpandedInspectorViewModel | null>(null);
  const [compareInspector, setCompareInspector] = useState<{
    request: InspectorViewModel;
    response: InspectorViewModel;
  } | null>(null);
  const [proxyRules, setProxyRules] = useState<ProxyRule[]>([]);
  const [weakNetwork, setWeakNetwork] = useState<WeakNetworkProfile>(emptyWeakNetwork);
  const [breakpoints, setBreakpoints] = useState<BreakpointRequest[]>([]);
  const [ruleDraft, setRuleDraft] = useState<Omit<ProxyRule, "id" | "enabled">>(emptyRuleDraft);
  const [ruleHeadersText, setRuleHeadersText] = useState(JSON.stringify(emptyRuleDraft.headers, null, 2));
  const [repeatDraft, setRepeatDraft] = useState<RequestDraft | null>(null);
  const [breakpointEditDraft, setBreakpointEditDraft] = useState<BreakpointEditDraft | null>(null);
  const [repeatHeadersText, setRepeatHeadersText] = useState("{}");
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableHeight, setTableHeight] = useState(480);
  const [locatedFlowId, setLocatedFlowId] = useState<string | null>(null);
  const [activeAgentRunId, setActiveAgentRunId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
  const tableBodyRef = useRef<HTMLDivElement | null>(null);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const agentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const hasBootstrappedSessionRef = useRef(false);
  const locatedFlowTimerRef = useRef<number | null>(null);
  const bodyPrefetchKeysRef = useRef<Set<string>>(new Set());
  const activeAgentRunRef = useRef<{ id: string; cancelled: boolean; messageIds: string[] } | null>(null);
  const sidecarWindowRestoreRef = useRef<NativeWindowFrame | null>(null);

  const selectedFlow = flows.find((flow) => flow.id === selectedId) || flows[0] || null;
  const requestMenuFlow = requestMenu ? flows.find((flow) => flow.id === requestMenu.flowId) || null : null;
  const selectedQueryParams = selectedFlow ? parseQueryParams(selectedFlow.query) : {};
  const selectedRuleHit = selectedFlow ? flowRuleHit(selectedFlow, proxyRules) : null;
  const selectedRequestCookies = selectedFlow ? parseCookieHeader(headerValue(selectedFlow.requestHeaders, "cookie")) : {};
  const selectedResponseCookies = selectedFlow ? responseCookieRows(selectedFlow) : {};
  const selectedReplayResult =
    replayResult && selectedFlow && replayResult.flowId === selectedFlow.id ? replayResult.result : null;

  const filteredFlows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return flows.filter((flow) => {
      if (!term) {
        return true;
      }

      return [
        flow.method,
        flow.host,
        flow.path,
        flow.query,
        flow.source,
        flow.clientAddress || "",
        displayRequestName(flow),
        String(flow.statusCode || ""),
        flow.errorType,
        (Array.isArray(flow.tags) ? flow.tags : []).join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [flows, query]);

  const hitCountsByRule = useMemo(() => ruleHitCounts(flows), [flows]);

  const failedCount = flows.filter((flow) => flow.statusCode && flow.statusCode >= 400).length;
  const tunnelCount = flows.filter((flow) => flow.method === "CONNECT").length;
  const slowCount = flows.filter((flow) => (flow.durationMs || 0) > 1000).length;
  const activeRuleCount = proxyRules.filter((rule) => rule.enabled).length;
  const shouldShowSystemProxyBanner = Boolean(
    systemProxy?.supported &&
      ((status.running && !systemProxy.matchesProxy) || (!status.running && systemProxy.restoreRecommended)),
  );
  const requestRowHeight = layoutMode === "sidecar" ? 42 : 56;
  const requestOverscan = 6;
  const virtualStartIndex = Math.max(0, Math.floor(tableScrollTop / requestRowHeight) - requestOverscan);
  const virtualVisibleCount = Math.ceil(tableHeight / requestRowHeight) + requestOverscan * 2;
  const virtualFlows = filteredFlows.slice(virtualStartIndex, virtualStartIndex + virtualVisibleCount);
  const copy = copyByLanguage[language];
  const mobileSetupUrl = status.mobileSetupUrl || "";
  const mobileProxyAddress =
    status.proxyAddress || `${status.lanIp || "127.0.0.1"}:${status.port || config?.proxyPort || 9090}`;
  const mobileCertUrl = status.certDownloadUrl || "";
  const mobilePacUrl = status.pacUrl || "";
  const mobileIosProfileUrl = status.iosProfileUrl || "";
  const localizedQuickPrompts = quickPromptsByLanguage[language];
  const currentLayoutSizing = layoutSizing[layoutMode];
  const workspaceGridColumns =
    layoutMode === "sidecar"
      ? "240px minmax(0, 1fr)"
      : `${currentLayoutSizing.request}px minmax(0, 1fr) ${currentLayoutSizing.side}px`;
  const requestGridColumns = useMemo(() => requestColumnTemplate(requestColumns), [requestColumns]);
  const requestColumnLabels: Record<RequestColumnKey, string> = {
    status: copy.status,
    type: copy.type,
    size: copy.size,
    captured: copy.captureTime,
    duration: copy.time,
  };
  const aiProviderName = aiProviderDisplayName(config?.qwen.provider);
  const aiProviderPreset = findAiProviderPreset(config?.qwen.provider);
  const aiModelName = config?.qwen.model || aiProviderPreset.model || "Agent";
  const aiHeaderLabel = aiModelName === "Agent" ? aiProviderName : `${aiProviderName} · ${aiModelName}`;
  const aiDraftPreset = findAiProviderPreset(aiConfigDraft.provider);

  function updateLayoutSizing(mode: LayoutMode, nextSizing: LayoutSizing) {
    setLayoutSizing((current) => ({
      ...current,
      [mode]: {
        request: Math.round(nextSizing.request),
        side: Math.round(nextSizing.side),
      },
    }));
  }

  function startWorkspaceResize(target: WorkspaceResizeTarget, event: ReactPointerEvent<HTMLButtonElement>) {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const mode = layoutMode;
    const rect = workspace.getBoundingClientRect();
    const startSizing = layoutSizing[mode];
    const minRequest = layoutSizingBounds.minRequest;
    const minSide = layoutSizingBounds.minSide;
    const minMiddle = layoutSizingBounds.minMiddle;

    setResizingWorkspace(target);
    document.body.classList.add("workspace-is-resizing");

    const applyResize = (clientX: number) => {
      if (target === "request") {
        const maxRequest = rect.width - startSizing.side - minMiddle;
        updateLayoutSizing(mode, {
          ...startSizing,
          request: clampNumber(clientX - rect.left, minRequest, maxRequest),
        });
        return;
      }

      const maxSide = rect.width - startSizing.request - minMiddle;
      updateLayoutSizing(mode, {
        ...startSizing,
        side: clampNumber(rect.right - clientX, minSide, maxSide),
      });
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      applyResize(moveEvent.clientX);
    };
    const stopResize = () => {
      setResizingWorkspace(null);
      document.body.classList.remove("workspace-is-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function resetWorkspaceSizing() {
    updateLayoutSizing(layoutMode, defaultLayoutSizing[layoutMode]);
  }

  async function applyNativeWindowLayout(mode: LayoutMode) {
    if (typeof window === "undefined" || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      return;
    }

    try {
      const {
        LogicalPosition,
        LogicalSize,
        PhysicalPosition,
        PhysicalSize,
        currentMonitor,
        getCurrentWindow,
      } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();

      if (mode !== "sidecar") {
        const frame = sidecarWindowRestoreRef.current;
        if (!frame) {
          return;
        }
        sidecarWindowRestoreRef.current = null;
        await appWindow.setMinSize(null);
        if (frame.fullscreen) {
          await appWindow.setFullscreen(true);
          return;
        }
        await appWindow.setFullscreen(false).catch(() => undefined);
        await appWindow.unmaximize().catch(() => undefined);
        await appWindow.setPosition(new PhysicalPosition(frame.position.x, frame.position.y));
        await appWindow.setSize(new PhysicalSize(frame.size.width, frame.size.height));
        if (frame.maximized) {
          await appWindow.maximize();
        }
        return;
      }

      const [size, position, maximized, fullscreen, monitor, scaleFactor] = await Promise.all([
        appWindow.outerSize(),
        appWindow.outerPosition(),
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
        currentMonitor(),
        appWindow.scaleFactor(),
      ]);

      if (!sidecarWindowRestoreRef.current) {
        sidecarWindowRestoreRef.current = {
          size: { width: size.width, height: size.height },
          position: { x: position.x, y: position.y },
          maximized,
          fullscreen,
        };
      }

      await appWindow.setFullscreen(false).catch(() => undefined);
      await appWindow.unmaximize().catch(() => undefined);
      await appWindow.setMinSize(new LogicalSize(520, 560));

      const factor = monitor?.scaleFactor || scaleFactor || 1;
      const workArea = monitor?.workArea;
      const workWidth = (workArea?.size.width || size.width) / factor;
      const workHeight = (workArea?.size.height || size.height) / factor;
      const workX = (workArea?.position.x || 0) / factor;
      const workY = (workArea?.position.y || 0) / factor;
      const targetWidth = Math.max(520, Math.round(workWidth / 3));
      const targetHeight = Math.max(640, Math.round(workHeight));

      await appWindow.setSize(new LogicalSize(targetWidth, targetHeight));
      await appWindow.setPosition(new LogicalPosition(Math.round(workX + workWidth - targetWidth), Math.round(workY)));
      await appWindow.setFocus();
    } catch {
      // Web preview and older runtimes simply keep the CSS sidecar layout.
    }
  }

  function openAiSettingsDialog() {
    const qwen = config?.qwen;
    const provider = aiProviderSelectValue(qwen?.provider);
    const preset = findAiProviderPreset(provider);
    setAiConfigDraft({
      provider,
      baseUrl: qwen?.baseUrl || preset.baseUrl,
      model: qwen?.model || preset.model,
      visionModel: qwen?.visionModel || preset.visionModel,
    });
    setAiApiKeyDraft("");
    setClearAiApiKey(false);
    setAiSettingsDialogOpen(true);
  }

  async function saveAiSettings() {
    const apiKey = aiApiKeyDraft.trim();
    const nextConfig = await runAction("ai-settings", () =>
      desktopBackend.ai.updateConfig({
        settings: {
          provider: aiConfigDraft.provider,
          baseUrl: aiConfigDraft.baseUrl,
          model: aiConfigDraft.model,
          visionModel: aiConfigDraft.visionModel,
          apiKey: apiKey ? apiKey : null,
          clearApiKey: clearAiApiKey,
        },
      }),
    );
    if (nextConfig) {
      setConfig(nextConfig);
      setAiSettingsDialogOpen(false);
      setNotice(copy.aiSettingsSaved);
    }
  }

  function markLocatedFlow(flowId: string) {
    setLocatedFlowId(flowId);
    if (locatedFlowTimerRef.current) {
      window.clearTimeout(locatedFlowTimerRef.current);
    }
    locatedFlowTimerRef.current = window.setTimeout(() => {
      setLocatedFlowId((current) => (current === flowId ? null : current));
      locatedFlowTimerRef.current = null;
    }, 1800);
  }

  function scrollRequestTableToIndex(index: number) {
    const top = Math.max(0, index * requestRowHeight - requestRowHeight);
    setTableScrollTop(top);
    window.requestAnimationFrame(() => {
      tableBodyRef.current?.scrollTo({ top, behavior: "smooth" });
    });
  }

  function revealFlowInRequestList(flowId: string, options: { clearFilterIfHidden?: boolean } = {}) {
    const filteredIndex = filteredFlows.findIndex((flow) => flow.id === flowId);
    const allIndex = flows.findIndex((flow) => flow.id === flowId);
    if (allIndex < 0) {
      return;
    }

    setSelectedId(flowId);
    markLocatedFlow(flowId);

    if (filteredIndex >= 0) {
      scrollRequestTableToIndex(filteredIndex);
      return;
    }

    if (options.clearFilterIfHidden && query.trim()) {
      setQuery("");
      window.requestAnimationFrame(() => scrollRequestTableToIndex(allIndex));
    }
  }

  function insertFlowNameIntoAgentInput(flow: CaptureFlow) {
    const requestName = displayRequestName(flow);
    const token = `@${requestName}`;
    setSelectedId(flow.id);
    revealFlowInRequestList(flow.id);
    setUtilityPanel("agent");
    setAgentMentionedFlowId(flow.id);
    setAgentInput((current) => {
      const trimmedRight = current.replace(/\s+$/g, "");
      return `${trimmedRight}${trimmedRight ? " " : ""}${token} `;
    });
    window.requestAnimationFrame(() => agentInputRef.current?.focus());
  }

  async function refresh() {
    try {
      const [
        nextStatus,
        nextFlows,
        nextCertInfo,
        nextSystemProxy,
        nextRules,
        nextWeakNetwork,
        nextBreakpoints,
      ] = await Promise.all([
        desktopBackend.proxy.status(),
        desktopBackend.proxy.flows(),
        desktopBackend.cert.info(),
        desktopBackend.systemProxy.status().catch(() => null),
        desktopBackend.proxy.rules(),
        desktopBackend.proxy.weakNetwork(),
        desktopBackend.proxy.breakpoints(),
      ]);
      setStatus(nextStatus);
      setFlows(nextFlows);
      setCertInfo(nextCertInfo);
      setSystemProxy(nextSystemProxy);
      setProxyRules(nextRules.map(normalizeStoredRule));
      setWeakNetwork(nextWeakNetwork);
      setBreakpoints(nextBreakpoints);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }

  async function applyCaptureHosts() {
    await runAction("capture-hosts", async () => {
      const nextStatus = await desktopBackend.proxy.setCaptureHosts({ hosts: domainInput });
      setStatus(nextStatus);
      await desktopBackend.proxy.clear();
      setFlows([]);
      setSelectedId(null);
      setReplayResult(null);
      setFullBodies({});
      return nextStatus;
    });
  }

  async function applySystemProxy() {
    const nextSystemProxy = await runAction("system-proxy", () => desktopBackend.systemProxy.apply());
    if (nextSystemProxy) {
      setSystemProxy(nextSystemProxy);
    }
  }

  async function restoreSystemProxy() {
    const nextSystemProxy = await runAction("system-proxy-restore", () => desktopBackend.systemProxy.restore());
    if (nextSystemProxy) {
      setSystemProxy(nextSystemProxy);
    }
  }

  async function startProxyClosedLoop() {
    const result = await runAction("start", async () => {
      const nextStatus = await desktopBackend.proxy.start();
      try {
        const nextSystemProxy = await desktopBackend.systemProxy.apply();
        return { nextStatus, nextSystemProxy, systemProxyError: null };
      } catch (systemProxyError) {
        const nextSystemProxy = await desktopBackend.systemProxy.status().catch(() => null);
        return {
          nextStatus,
          nextSystemProxy,
          systemProxyError: systemProxyError instanceof Error ? systemProxyError.message : String(systemProxyError),
        };
      }
    });

    if (result) {
      setStatus(result.nextStatus);
      if (result.nextSystemProxy) {
        setSystemProxy(result.nextSystemProxy);
      }
      if (result.systemProxyError) {
        setError(`代理已启动，但系统代理接入失败：${result.systemProxyError}`);
      }
      await refresh();
    }
  }

  async function installRootCertificate() {
    const startedAt = performance.now();
    const waitForMinimumDuration = async () => {
      const remainingMs = 350 - (performance.now() - startedAt);
      if (remainingMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
      }
    };

    setBusyAction("install-cert");
    setError(null);
    setNotice(null);
    setCertTrustDialog(null);
    try {
      const nextCertInfo = await desktopBackend.cert.installRoot();
      await waitForMinimumDuration();
      setCertInfo(nextCertInfo);
      if (nextCertInfo.trusted) {
        setNotice("HeavenEye Agent 已完成根证书安装并设置信任，HTTPS 明文抓包可以正常使用。");
      } else {
        const message = nextCertInfo.message || "证书已处理，但系统仍报告未信任。请打开证书检查钥匙串信任状态。";
        setCertTrustDialog(
          buildCertTrustFailureDialog("证书仍未被系统信任", message, nextCertInfo.certPath || certInfo?.certPath || ""),
        );
      }
      await refresh();
    } catch (actionError) {
      await waitForMinimumDuration();
      const message = asErrorMessage(actionError);
      setCertTrustDialog(
        buildCertTrustFailureDialog("Agent 一键信任失败", message, certInfo?.certPath || ""),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function uninstallRootCertificate() {
    const nextCertInfo = await runAction("uninstall-cert", () => desktopBackend.cert.uninstallRoot(), {
      minimumMs: 350,
    });
    if (nextCertInfo) {
      setCertInfo(nextCertInfo);
      await refresh();
    }
  }

  async function recheckRootCertificate() {
    const nextCertInfo = await runAction("cert-info", () => desktopBackend.cert.info(), {
      minimumMs: 250,
    });
    if (!nextCertInfo) {
      return;
    }
    setCertInfo(nextCertInfo);
    if (nextCertInfo.trusted) {
      setCertTrustDialog(null);
      setNotice("HeavenEye Agent 已检测到根证书受信任，HTTPS 明文抓包可以正常使用。");
    } else {
      setCertTrustDialog(
        buildCertTrustFailureDialog("证书仍未被系统信任", nextCertInfo.message, nextCertInfo.certPath),
      );
    }
  }

  async function runAction<T>(name: string, action: () => Promise<T>, options: { minimumMs?: number } = {}) {
    const startedAt = performance.now();
    const waitForMinimumDuration = async () => {
      if (!options.minimumMs) {
        return;
      }
      const remainingMs = options.minimumMs - (performance.now() - startedAt);
      if (remainingMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
      }
    };

    setBusyAction(name);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      await waitForMinimumDuration();
      return result;
    } catch (actionError) {
      await waitForMinimumDuration();
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  function clearAgentComposer() {
    setAgentInput("");
    setAgentMentionedFlowId(null);
    setAgentAttachments([]);
  }

  function replaceAgentMessage(id: string, patch: Partial<AgentChatMessage>) {
    setAgentMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    );
  }

  function startAgentRun(messageId: string) {
    const run = { id: makeId("agent-run"), cancelled: false, messageIds: [messageId] };
    activeAgentRunRef.current = run;
    setActiveAgentRunId(run.id);
    return run.id;
  }

  function attachAgentRunMessage(runId: string | null, messageId: string) {
    const run = activeAgentRunRef.current;
    if (runId && run?.id === runId && !run.messageIds.includes(messageId)) {
      run.messageIds.push(messageId);
    }
  }

  function isAgentRunCancelled(runId: string | null) {
    const run = activeAgentRunRef.current;
    return !runId || !run || run.id !== runId || run.cancelled;
  }

  function finishAgentRun(runId: string | null) {
    const run = activeAgentRunRef.current;
    if (runId && run?.id === runId) {
      activeAgentRunRef.current = null;
      setActiveAgentRunId(null);
    }
  }

  function cancelAgentRun() {
    const run = activeAgentRunRef.current;
    if (!run || run.cancelled) {
      return;
    }
    run.cancelled = true;
    setBusyAction(null);
    setActiveAgentRunId(null);
    setAgentMessages((current) =>
      current.map((message) =>
        run.messageIds.includes(message.id) && message.status === "loading"
          ? {
              ...message,
              status: "cancelled",
              content: copy.agentCancelled,
            }
          : message,
      ),
    );
  }

  async function runLocalAgentCommand(
    question: string,
    attachments: AgentAttachment[],
    targetFlow: CaptureFlow | null,
  ) {
    if (isApiTestCommand(question)) {
      return false;
    }

    const shouldApplyWeakNetwork = isWeakNetworkCommand(question);
    const shouldReplay = isReplayCommand(question);
    if (!shouldApplyWeakNetwork && !shouldReplay) {
      return false;
    }

    const userMessage: AgentChatMessage = {
      id: makeId("user"),
      role: "user",
      content: question,
      attachments,
    };
    const pendingMessageId = makeId("assistant-local");
    const pendingMessage: AgentChatMessage = {
      id: pendingMessageId,
      role: "assistant",
      model: config?.qwen.model || "Agent",
      content: copy.thinkingTitle,
      status: "loading",
    };
    setAgentMessages((current) => [...current, userMessage, pendingMessage]);
    clearAgentComposer();

    const lines: string[] = [];
    if (shouldApplyWeakNetwork) {
      const profile = isDisableWeakNetworkCommand(question) ? emptyWeakNetwork : weakNetworkProfileFromText(question);
      const appliedProfile = await applyWeakNetwork(profile);
      if (appliedProfile?.enabled) {
        lines.push(
          fillTemplate(copy.agentWeakApplied, {
            delay: appliedProfile.delayMs,
            down: appliedProfile.downstreamKbps,
            error: Math.round(appliedProfile.errorRate * 100),
          }),
        );
      } else if (appliedProfile) {
        lines.push(copy.agentWeakDisabled);
      }
      setUtilityPanel("lab");
    }

    if (shouldReplay) {
      if (!targetFlow) {
        lines.push(copy.agentNoTargetRequest);
      } else {
        revealFlowInRequestList(targetFlow.id, { clearFilterIfHidden: true });
        const replay = await runAction(`agent-replay-${targetFlow.id}`, () =>
          desktopBackend.proxy.replay({ flow: targetFlow }),
        );
        if (replay) {
          setReplayResult({ flowId: targetFlow.id, result: replay });
          lines.push(
            fillTemplate(copy.agentReplayDone, {
              method: targetFlow.method,
              name: displayRequestName(targetFlow),
              status: replay.statusCode ?? (replay.errorType || "-"),
              duration: Math.round(replay.durationMs),
            }),
          );
        } else {
          lines.push(copy.agentReplayFailed);
        }
      }
    }

    replaceAgentMessage(pendingMessageId, {
      status: undefined,
      content: lines.filter(Boolean).join("\n\n") || copy.agentReplayFailed,
    });
    return true;
  }

  function formatApiTestResults(results: ApiTestRunItem[]) {
    const evaluated = results.map((item, index) => ({
      ...item,
      index,
      evaluation: evaluateApiTestRunItem(item),
    }));
    const passed = evaluated.filter((item) => item.evaluation.passed);
    const failed = evaluated.filter((item) => !item.evaluation.passed);
    const formatLine = (item: (typeof evaluated)[number]) => {
      const expected = item.testCase.expected ? ` · expected: ${item.testCase.expected}` : "";
      const target = item.draft ? ` · ${item.draft.method} ${item.draft.url}` : "";
      return `${item.index + 1}. ${item.testCase.name}: ${item.evaluation.actual}${expected}${target}`;
    };
    const section = (title: string, items: typeof evaluated) => [
      `${title} (${items.length})`,
      ...(items.length ? items.map(formatLine) : [`- ${copy.apiTestNoCasesInGroup}`]),
    ];

    return [
      fillTemplate(copy.agentApiTestDone, { count: results.length }),
      "",
      ...section(copy.apiTestPassedCases, passed),
      "",
      ...section(copy.apiTestFailedCases, failed),
    ].join("\n");
  }

  async function runAgentDesignedApiTests(flow: CaptureFlow | null, testCases: AgentTestCase[], runId: string | null) {
    const messageId = makeId("assistant-api-check");
    attachAgentRunMessage(runId, messageId);
    setAgentMessages((current) => [
      ...current,
      {
        id: messageId,
        role: "assistant",
        model: config?.qwen.model || "Agent",
        content: copy.agentApiTestRunning,
        status: "loading",
      },
    ]);

    if (!flow) {
      replaceAgentMessage(messageId, {
        status: undefined,
        content: copy.agentApiTestNoTarget,
      });
      finishAgentRun(runId);
      return;
    }

    const executableCases = testCases.filter((item) => item.name.trim()).slice(0, 5);
    if (!executableCases.length) {
      replaceAgentMessage(messageId, {
        status: undefined,
        content: copy.agentApiTestNoCases,
      });
      finishAgentRun(runId);
      return;
    }

    revealFlowInRequestList(flow.id, { clearFilterIfHidden: true });
    const results = await runAction(
      "agent-api-check",
      async () => {
        const executed: ApiTestRunItem[] = [];
        for (const testCase of executableCases) {
          if (isAgentRunCancelled(runId)) {
            break;
          }
          try {
            const draft = draftFromAgentTestCase(flow, testCase);
            const result = await desktopBackend.proxy.sendDraft({ draft });
            executed.push({ testCase, draft, result });
          } catch (testError) {
            executed.push({
              testCase,
              draft: null,
              result: null,
              error: testError instanceof Error ? testError.message : String(testError),
            });
          }
        }
        return executed;
      },
      { minimumMs: 420 },
    );

    if (isAgentRunCancelled(runId)) {
      return;
    }

    if (!results) {
      replaceAgentMessage(messageId, {
        status: "error",
        content: copy.agentApiTestFailed,
      });
      finishAgentRun(runId);
      return;
    }

    const lastResult = [...results].reverse().find((item) => item.result);
    if (lastResult?.result) {
      setReplayResult({ flowId: flow.id, result: lastResult.result });
    }

    replaceAgentMessage(messageId, {
      status: undefined,
      content: formatApiTestResults(results),
    });
    finishAgentRun(runId);
  }

  async function sendAgentQuestion(questionOverride?: string, attachmentOverride?: AgentAttachment[]) {
    const question = (questionOverride ?? agentInput).trim();
    const attachments = attachmentOverride ?? agentAttachments;
    if (busyAction !== null) {
      setError(copy.contextBusy);
      return;
    }
    if (!question) {
      setError("请输入要问 Agent 的问题。");
      return;
    }

    const explicitlyMentionedFlow =
      agentMentionedFlowId
        ? flows.find((flow) => flow.id === agentMentionedFlowId && isFlowMentionStillInQuestion(flow, question)) || null
        : null;
    const typedMentionFlow = findFlowMentionedInText(question, flows);
    const focusedFlow = explicitlyMentionedFlow || typedMentionFlow;
    const preselectedFlow = focusedFlow || findLikelyFlowForQuestion(question, flows);
    if (preselectedFlow) {
      revealFlowInRequestList(preselectedFlow.id, { clearFilterIfHidden: true });
    }
    if (await runLocalAgentCommand(question, attachments, focusedFlow || preselectedFlow || selectedFlow)) {
      return;
    }
    const focusedAgentQuestion = buildFocusedAgentQuestion(question, focusedFlow);
    const agentQuestion = isApiTestCommand(question)
      ? buildApiTestAgentQuestion(focusedAgentQuestion)
      : focusedAgentQuestion;
    const agentFlows = prioritizeAgentFlows(flows, focusedFlow);

    const userMessage: AgentChatMessage = {
      id: makeId("user"),
      role: "user",
      content: question,
      attachments,
    };
    const history = agentMessages;
    const pendingMessageId = makeId("assistant-loading");
    const pendingMessage: AgentChatMessage = {
      id: pendingMessageId,
      role: "assistant",
      model: config?.qwen.model || "Agent",
      content: copy.thinkingTitle,
      status: "loading",
    };
    const runId = startAgentRun(pendingMessageId);

    setAgentMessages((current) => [...current, userMessage, pendingMessage]);
    clearAgentComposer();

    const result = await runAction(
      "ask-agent",
      () =>
        desktopBackend.ai.askAgent({
          question: agentQuestion,
          flows: agentFlows,
          history,
          attachments,
        }),
      { minimumMs: 420 },
    );

    if (isAgentRunCancelled(runId)) {
      return;
    }

    if (result) {
      const assistantMessage: AgentChatMessage = {
        id: pendingMessageId,
        role: "assistant",
        model: result.model,
        content: result.content,
        structured: result.structured,
      };
      setAgentMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId ? assistantMessage : message,
        ),
      );
      const evidenceFlow =
        focusedFlow ||
        findFlowFromStructuredAnswer(assistantMessage, flows) ||
        findLikelyFlowForQuestion(`${question}\n${assistantMessage.content}`, flows);
      if (evidenceFlow) {
        revealFlowInRequestList(evidenceFlow.id, { clearFilterIfHidden: true });
      }
      if (isApiTestCommand(question)) {
        await runAgentDesignedApiTests(
          focusedFlow || preselectedFlow || evidenceFlow || selectedFlow,
          assistantMessage.structured?.testCases || [],
          runId,
        );
      } else {
        finishAgentRun(runId);
      }
    } else {
      setAgentMessages((current) =>
        current.map((message) =>
          message.id === pendingMessageId
            ? {
                id: pendingMessageId,
                role: "assistant",
                model: config?.qwen.model || "Agent",
                status: "error",
                content:
                  "这次 Agent 请求失败或超时了。当前我已经把后端改成只挑相关接口、限制上下文大小，并设置了超时；请重新提问一次。如果还是失败，先清空无关抓包或缩小问题范围。",
              }
            : message,
        ),
      );
      finishAgentRun(runId);
    }
  }

  async function addImageFiles(files: File[]) {
    if (!files.length) {
      return;
    }

    try {
      const nextAttachments = await Promise.all(
        files
          .filter((file) => file.type.startsWith("image/"))
          .slice(0, 4)
          .map(async (file) => {
            if (file.size > 4 * 1024 * 1024) {
              throw new Error(`${file.name} exceeds the 4 MB image limit.`);
            }
            return {
              id: makeId("image"),
              name: file.name,
              type: file.type,
              dataUrl: await readFileAsDataUrl(file),
            };
          }),
      );
      setAgentAttachments((current) => [...current, ...nextAttachments].slice(0, 4));
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : String(fileError));
    }
  }

  async function handleImageFiles(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    try {
      await addImageFiles(Array.from(files));
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    await addImageFiles(imageFiles);
  }

  function removeAttachment(id: string) {
    setAgentAttachments((current) => current.filter((item) => item.id !== id));
  }

  function startVoiceInput() {
    const speechWindow = window as unknown as {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };
    const SpeechRecognitionCtor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setError("当前 Electron/Chrome 环境不支持语音识别。可以先用系统语音输入，或直接键入问题。");
      return;
    }

    setError(null);
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as any[])
        .map((result) => result[0]?.transcript || "")
        .join("")
        .trim();
      if (transcript) {
        setAgentInput((current) => `${current}${current ? " " : ""}${transcript}`);
      }
    };
    recognition.onerror = (event: { error?: string }) => {
      setError(formatSpeechRecognitionError(event?.error));
    };
    recognition.onend = () => setIsListening(false);
    setIsListening(true);
    try {
      recognition.start();
    } catch (voiceError) {
      setIsListening(false);
      setError(
        voiceError instanceof Error
          ? `语音识别启动失败：${voiceError.message}。请检查系统设置里的麦克风与语音识别权限。`
          : formatSpeechRecognitionError(),
      );
    }
  }

  async function copyAgentValue(value: string, key: string) {
    try {
      await writeTextToClipboard(value);
      setError(null);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1400);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制失败");
    }
  }

  function openMobileSetupDialog() {
    if (!status.running) {
      setError(copy.mobileStartHint);
      return;
    }
    setMobileSetupDialogOpen(true);
  }

  async function openMobileSetupInBrowser() {
    const setupUrl = mobileSetupUrl || (status.running ? `http://${mobileProxyAddress}/mobile-setup` : "");
    if (!setupUrl) {
      setError(copy.mobileStartHint);
      return;
    }
    try {
      await desktopBackend.openUrl({ url: setupUrl });
      setError(null);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }

  function openInspectorWindow(title: string, value: unknown, meta?: InspectorPayloadMeta) {
    const requestLabel = selectedFlow
      ? `${selectedFlow.method} ${displayRequestName(selectedFlow)}`
      : "";
    const requestSubtitle = selectedFlow
      ? `${selectedFlow.host}${selectedFlow.path}${selectedFlow.query}`
      : "";
    setExpandedInspector({
      ...buildInspectorViewModel(title, value),
      meta,
      requestLabel,
      requestSubtitle,
    });
  }

  async function cacheFullBody(flow: CaptureFlow, direction: "request" | "response", reportError = false) {
    const key = bodyContentKey(flow.id, direction);
    if (fullBodies[key] && !fullBodies[key].fromPreview) {
      return;
    }
    const hasBody =
      direction === "request"
        ? Boolean(flow.requestBodyPreview || flow.requestSize)
        : Boolean(flow.responseBodyPreview || flow.responseSize);
    if (!hasBody || bodyPrefetchKeysRef.current.has(key)) {
      return;
    }

    bodyPrefetchKeysRef.current.add(key);
    try {
      const result = await desktopBackend.proxy.body({
        flowId: flow.id,
        direction,
      });
      setFullBodies((current) => ({
        ...current,
        [key]: result,
      }));
      if (reportError && !result.complete && result.omittedReason) {
        setError(result.omittedReason);
      }
    } catch (bodyError) {
      if (reportError) {
        setError(bodyError instanceof Error ? bodyError.message : String(bodyError));
      }
    } finally {
      bodyPrefetchKeysRef.current.delete(key);
    }
  }

  function openPayloadCompare(flow: CaptureFlow) {
    const fullRequestBody = fullBodies[bodyContentKey(flow.id, "request")];
    const fullResponseBody = fullBodies[bodyContentKey(flow.id, "response")];
    setCompareInspector({
      request: buildInspectorViewModel("传参", {
        query: parseQueryParams(flow.query),
        body: fullRequestBody?.content ?? flow.requestBodyPreview ?? "",
      }),
      response: buildInspectorViewModel("响应", fullResponseBody?.content ?? flow.responseBodyPreview ?? ""),
    });
  }

  function handleRequestContextMenu(event: ReactMouseEvent<HTMLButtonElement>, flow: CaptureFlow) {
    event.preventDefault();
    setSelectedId(flow.id);
    setRequestMenu({
      flowId: flow.id,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function copyRequestExport(flow: CaptureFlow, kind: RequestExportKind) {
    const value =
      kind === "curl"
        ? buildCurlCommand(flow)
        : kind === "playwright"
          ? buildPlaywrightSnippet(flow)
          : buildPostmanCollection(flow);

    copyAgentValue(value, exportKey(kind, flow));
  }

  async function replayFlow(flow: CaptureFlow) {
    setRequestMenu(null);
    const result = await runAction(`replay-${flow.id}`, () => desktopBackend.proxy.replay({ flow }));
    if (result) {
      setReplayResult({ flowId: flow.id, result });
    }
  }

  function openEditRepeat(flow: CaptureFlow) {
    const draft = flowToDraft(flow);
    setRepeatDraft(draft);
    setRepeatHeadersText(JSON.stringify(draft.headers, null, 2));
    setRequestMenu(null);
  }

  async function sendRepeatDraft() {
    if (!repeatDraft || !selectedFlow) {
      return;
    }

    let headers: Record<string, string>;
    try {
      headers = parseJsonObject(repeatHeadersText, "Headers");
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }

    const draft = { ...repeatDraft, headers };
    const result = await runAction(`repeat-${selectedFlow.id}`, () => desktopBackend.proxy.sendDraft({ draft }));
    if (result) {
      setReplayResult({ flowId: selectedFlow.id, result });
      setRepeatDraft(null);
    }
  }

  function normalizeWeakNetworkProfile(profile: WeakNetworkProfile): WeakNetworkProfile {
    return {
      enabled: profile.enabled,
      delayMs: Math.max(0, Math.round(Number(profile.delayMs) || 0)),
      downstreamKbps: Math.max(0, Math.round(Number(profile.downstreamKbps) || 0)),
      errorRate: Math.min(1, Math.max(0, Number(profile.errorRate) || 0)),
    };
  }

  async function applyWeakNetwork(profileOverride?: WeakNetworkProfile) {
    const profile = normalizeWeakNetworkProfile(profileOverride ?? weakNetwork);
    const result = await runAction("weak-network", () => desktopBackend.proxy.setWeakNetwork({ profile }));
    if (result) {
      setWeakNetwork(result);
    }
    return result;
  }

  async function applyQuickWeakNetwork() {
    await applyWeakNetwork(weakNetwork.enabled ? emptyWeakNetwork : quickWeakNetworkProfile);
    setUtilityPanel("lab");
  }

  async function addRule() {
    let headers: Record<string, string>;
    try {
      headers = parseJsonObject(ruleHeadersText, "Rule headers");
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }
    if (!ruleDraft.pattern.trim()) {
      setError("规则 pattern 不能为空。");
      return;
    }

    const nextRule: ProxyRule = {
      ...ruleDraft,
      id: makeId("rule"),
      enabled: true,
      pattern: ruleDraft.pattern.trim(),
      headers,
      statusCode: ruleDraft.statusCode ? Number(ruleDraft.statusCode) : null,
      delayMs: ruleDraft.delayMs ? Number(ruleDraft.delayMs) : null,
    };
    const result = await runAction("rules", () => desktopBackend.proxy.setRules({ rules: [nextRule, ...proxyRules] }));
    if (result) {
      setProxyRules(result.map(normalizeStoredRule));
    }
  }

  async function updateRule(rule: ProxyRule) {
    const nextRules = proxyRules.map((item) => (item.id === rule.id ? rule : item));
    const result = await runAction("rules", () => desktopBackend.proxy.setRules({ rules: nextRules }));
    if (result) {
      setProxyRules(result.map(normalizeStoredRule));
    }
  }

  async function deleteRule(ruleId: string) {
    const result = await runAction("rules", () =>
      desktopBackend.proxy.setRules({ rules: proxyRules.filter((rule) => rule.id !== ruleId) }),
    );
    if (result) {
      setProxyRules(result.map(normalizeStoredRule));
    }
  }

  function openBreakpointEditor(breakpoint: BreakpointRequest, action: BreakpointDecision["action"] = "continue") {
    const isResponse = breakpoint.direction === "response";
    setBreakpointEditDraft({
      breakpoint,
      action,
      requestMethod: breakpoint.method,
      requestUrl: breakpoint.url,
      requestHeadersText: JSON.stringify(breakpoint.headers || {}, null, 2),
      requestBody: breakpoint.body || breakpoint.bodyPreview || "",
      statusCode: breakpoint.statusCode ?? (action === "mock" ? 200 : null),
      responseHeadersText: JSON.stringify(
        isResponse
          ? breakpoint.responseHeaders || {}
          : { "content-type": "application/json; charset=utf-8" },
        null,
        2,
      ),
      responseBody:
        (isResponse ? breakpoint.responseBodyPreview : "") ||
        (action === "mock" ? JSON.stringify({ ok: true, breakpoint: true }, null, 2) : ""),
    });
  }

  async function submitBreakpointEdit() {
    if (!breakpointEditDraft) {
      return;
    }
    const { breakpoint, action } = breakpointEditDraft;
    let requestHeaders: Record<string, string> = {};
    let responseHeaders: Record<string, string> = {};
    try {
      requestHeaders = parseJsonObject(breakpointEditDraft.requestHeadersText, "Request headers");
      responseHeaders = parseJsonObject(breakpointEditDraft.responseHeadersText, "Response headers");
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }

    const result = await runAction(`breakpoint-${breakpoint.id}`, () =>
      desktopBackend.proxy.resolveBreakpoint({
        decision: {
          id: breakpoint.id,
          action,
          statusCode: breakpointEditDraft.statusCode,
          headers: responseHeaders,
          body: breakpointEditDraft.responseBody,
          requestMethod: breakpointEditDraft.requestMethod,
          requestUrl: breakpointEditDraft.requestUrl,
          requestHeaders,
          requestBody: breakpointEditDraft.requestBody,
        },
      }),
    );
    if (result) {
      setBreakpoints(result);
      setBreakpointEditDraft(null);
    }
  }

  async function resolveBreakpoint(breakpoint: BreakpointRequest, action: "continue" | "mock" | "drop") {
    if (action !== "drop") {
      openBreakpointEditor(breakpoint, action);
      return;
    }
    const result = await runAction(`breakpoint-${breakpoint.id}`, () =>
      desktopBackend.proxy.resolveBreakpoint({
        decision: {
          id: breakpoint.id,
          action,
          statusCode: null,
          headers: {},
          body: "",
          requestMethod: breakpoint.method,
          requestUrl: breakpoint.url,
          requestHeaders: breakpoint.headers,
          requestBody: breakpoint.body || breakpoint.bodyPreview || "",
        },
      }),
    );
    if (result) {
      setBreakpoints(result);
    }
  }

  function exportSession() {
    downloadJsonFile(sessionFileName("json"), buildSessionExport(flows, proxyRules, weakNetwork));
  }

  function exportHar() {
    downloadJsonFile(sessionFileName("har"), buildHarArchive(flows));
  }

  async function importSessionFile(file: File | null) {
    if (!file) {
      return;
    }
    try {
      const payload = JSON.parse(await file.text()) as {
        flows?: CaptureFlow[];
        rules?: ProxyRule[];
        weakNetwork?: WeakNetworkProfile;
      };
      if (!Array.isArray(payload.flows)) {
        throw new Error("Session 文件缺少 flows 数组。");
      }
      const importedFlows = await desktopBackend.proxy.importFlows({ flows: payload.flows.map(normalizeStoredFlow) });
      setFlows(importedFlows);
      if (Array.isArray(payload.rules)) {
        setProxyRules((await desktopBackend.proxy.setRules({ rules: payload.rules.map(normalizeStoredRule) })).map(normalizeStoredRule));
      }
      if (payload.weakNetwork) {
        setWeakNetwork(await desktopBackend.proxy.setWeakNetwork({ profile: payload.weakNetwork }));
      }
      setSelectedId(importedFlows[0]?.id ?? null);
      setReplayResult(null);
      setFullBodies({});
      setError(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      if (sessionInputRef.current) {
        sessionInputRef.current.value = "";
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const nextConfig = await desktopBackend.getConfig();
        if (cancelled) {
          return;
        }
        setConfig(nextConfig);
        setDomainInput(
          (nextConfig.captureHosts.length ? nextConfig.captureHosts : nextConfig.sslProxyHosts).join(", "),
        );

        const currentFlows = await desktopBackend.proxy.flows().catch(() => [] as CaptureFlow[]);
        const stored = readLocalSession();
        if (!cancelled && currentFlows.length === 0 && stored?.flows.length) {
          const importedFlows = await desktopBackend.proxy.importFlows({ flows: stored.flows });
          setFlows(importedFlows);
          setSelectedId(importedFlows[0]?.id ?? null);
          if (stored.rules.length) {
            setProxyRules((await desktopBackend.proxy.setRules({ rules: stored.rules })).map(normalizeStoredRule));
          }
          if (stored.weakNetwork) {
            setWeakNetwork(await desktopBackend.proxy.setWeakNetwork({ profile: stored.weakNetwork }));
          }
        }
      } catch (configError) {
        if (!cancelled) {
          setError(configError instanceof Error ? configError.message : String(configError));
        }
      } finally {
        if (!cancelled) {
          hasBootstrappedSessionRef.current = true;
          refresh();
        }
      }
    }

    bootstrap();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("dpa-language", language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem(requestColumnStorageKey, JSON.stringify(requestColumns));
  }, [requestColumns]);

  useEffect(() => {
    return () => {
      if (locatedFlowTimerRef.current) {
        window.clearTimeout(locatedFlowTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("dpa-layout", layoutMode);
    if (layoutMode === "agent" || layoutMode === "sidecar") {
      setUtilityPanel("agent");
    }
    void applyNativeWindowLayout(layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    window.localStorage.setItem("dpa-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem("dpa-layout-sizing", JSON.stringify(layoutSizing));
  }, [layoutSizing]);

  useEffect(() => {
    if (!hasBootstrappedSessionRef.current) {
      return;
    }
    writeLocalSession(flows, proxyRules, weakNetwork);
  }, [flows, proxyRules, weakNetwork]);

  useEffect(() => {
    if (!error || !shouldAutoClearError(error)) {
      return;
    }

    const timer = window.setTimeout(() => {
      setError((current) => (current === error ? null : current));
    }, 4200);

    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const element = messageListRef.current;
    if (!element) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth",
    });
  }, [agentMessages]);

  useEffect(() => {
    if (!requestMenu) {
      return;
    }

    const closeMenu = () => setRequestMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
    };
  }, [requestMenu]);

  useEffect(() => {
    if (!columnMenuOpen) {
      return;
    }

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && columnMenuRef.current?.contains(target)) {
        return;
      }
      setColumnMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColumnMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [columnMenuOpen]);

  useEffect(() => {
    const element = tableBodyRef.current;
    if (!element) {
      return;
    }
    const updateSize = () => setTableHeight(element.clientHeight || 480);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTableScrollTop(0);
    if (tableBodyRef.current) {
      tableBodyRef.current.scrollTop = 0;
    }
  }, [query]);

  useEffect(() => {
    if (!selectedFlow) {
      return;
    }
    void cacheFullBody(selectedFlow, "request");
    if (!isEventStreamFlow(selectedFlow)) {
      void cacheFullBody(selectedFlow, "response");
    }
  }, [selectedFlow?.id]);

  return (
    <main className={`app-shell layout-${layoutMode} theme-${themeMode}`} data-language={language}>
      <div className="toast-stack" aria-live="polite">
        {error ? (
          <section className="app-toast error-banner">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button type="button" className="banner-close" onClick={() => setError(null)} title="关闭错误提示">
              <X size={14} />
            </button>
          </section>
        ) : null}

        {notice ? (
          <section className="app-toast success-banner">
            <Check size={16} />
            <span>{notice}</span>
            <button type="button" className="banner-close" onClick={() => setNotice(null)} title="关闭提示">
              <X size={14} />
            </button>
          </section>
        ) : null}
      </div>

      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={appLogo} alt="" aria-hidden="true" />
          <div>
            <h1>HeavenEye Agent</h1>
            <span>
              AI智能流量抓包分析工具 · {aiHeaderLabel} · {copy[`${themeMode}` as keyof typeof copy]}
            </span>
          </div>
        </div>

        <div className="topbar-notice" aria-live="polite">
          {certInfo && !certInfo.trusted ? (
            <section className="cert-banner">
              <ShieldAlert size={16} />
              <div className="cert-banner-copy">
                <strong>HTTPS 证书未信任</strong>
                <span>
                  {certInfo.canInstall
                    ? "Agent 可自动安装并设置信任，macOS 会请求管理员授权。"
                    : "请打开根证书，并在系统钥匙串中手动设为始终信任。"}
                </span>
              </div>
              <div className="cert-actions">
                {certInfo.canInstall ? (
                  <button
                    className="inline-action cert-primary"
                    onClick={installRootCertificate}
                    disabled={busyAction !== null}
                    title="HeavenEye Agent 会把根证书加入系统钥匙串并设为 SSL 信任；需要输入 macOS 管理员密码。"
                  >
                    {busyAction === "install-cert" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <WandSparkles size={14} />
                    )}
                    <span>{busyAction === "install-cert" ? "配置中" : "Agent 一键信任"}</span>
                  </button>
                ) : null}
                <button
                  className="inline-action secondary"
                  onClick={() => runAction("open-cert", () => desktopBackend.cert.openRoot())}
                  disabled={busyAction !== null}
                  title={certInfo.certPath}
                >
                  <FolderOpen size={14} />
                  <span>打开证书</span>
                </button>
                {certInfo.canUninstall ? (
                  <button
                    className="inline-action danger"
                    onClick={uninstallRootCertificate}
                    disabled={busyAction !== null}
                    title="移除系统信任证书并清理本地生成的证书"
                  >
                    {busyAction === "uninstall-cert" ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                    <span>重置</span>
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {shouldShowSystemProxyBanner && systemProxy ? (
            <section className="proxy-banner">
              <Globe2 size={16} />
              {status.running ? (
                <span>
                  系统代理未接入当前抓包端口。{systemProxy.service ? `${systemProxy.service} ` : ""}
                  HTTP {formatProxySetting(systemProxy.http)} / HTTPS {formatProxySetting(systemProxy.https)} / SOCKS{" "}
                  {formatProxySetting(systemProxy.socks)}
                </span>
              ) : (
                <span>
                  检测到系统代理仍指向本应用端口，但抓包代理没有运行。先恢复原设置，浏览器就不会被残留代理卡住。
                </span>
              )}
              <div className="proxy-actions">
                {systemProxy.canRestore ? (
                  <button
                    className="inline-action secondary"
                    onClick={restoreSystemProxy}
                    disabled={busyAction !== null}
                    title="恢复接管前的系统代理设置"
                  >
                    <RefreshCcw size={14} />
                    <span>Restore</span>
                  </button>
                ) : null}
                {status.running ? (
                  <button
                    className="inline-action"
                    onClick={applySystemProxy}
                    disabled={busyAction !== null}
                    title={systemProxy.message}
                  >
                    <Check size={14} />
                    <span>Use {systemProxy.targetPort}</span>
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

        </div>

        <div className="toolbar">
          <div className={status.running ? "status-pill active" : "status-pill"}>
            <Circle size={10} fill="currentColor" />
            <span>{status.running ? mobileProxyAddress : copy.stopped}</span>
          </div>
          <button
            className="icon-button mobile-toolbar-button"
            onClick={openMobileSetupDialog}
            disabled={!status.running || busyAction !== null}
            title={mobileSetupUrl || copy.mobileStartHint}
          >
            <Smartphone size={16} />
            <span>{copy.mobileToolbar}</span>
          </button>
          <button
            className="icon-button primary"
            onClick={startProxyClosedLoop}
            disabled={status.running || busyAction !== null}
            title="Start proxy and connect system proxy"
          >
            <Play size={16} />
            <span>{copy.start}</span>
          </button>
          <button
            className="icon-button"
            onClick={() => runAction("stop", () => desktopBackend.proxy.stop())}
            disabled={!status.running || busyAction !== null}
            title="Stop proxy"
          >
            <Square size={15} />
            <span>{copy.stop}</span>
          </button>
          <button
              className="icon-button icon-only clear-toolbar-button"
              onClick={() =>
                runAction("clear", () => desktopBackend.proxy.clear()).then(() => {
                  setReplayResult(null);
                  setFullBodies({});
                  refresh();
                })
              }
              disabled={busyAction !== null}
              title="Clear session"
            >
            <Eraser size={16} />
          </button>
          <button className="icon-button session-toolbar-button" onClick={exportSession} disabled={busyAction !== null} title="Export session JSON">
            <Download size={16} />
            <span>{copy.session}</span>
          </button>
          <button className="icon-button har-toolbar-button" onClick={exportHar} disabled={busyAction !== null} title="Export HAR">
            <FileJson size={16} />
            <span>{copy.har}</span>
          </button>
          <button
            className="icon-button icon-only import-toolbar-button"
            onClick={() => sessionInputRef.current?.click()}
            disabled={busyAction !== null}
            title="Import session JSON"
          >
            <Upload size={16} />
          </button>
          <input
            ref={sessionInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => importSessionFile(event.target.files?.[0] ?? null)}
          />
        </div>
      </header>

      <section className="metric-row">
        <div className="mode-controls">
          <div className="segmented-control layout-control" aria-label={copy.layout}>
            <span className="segment-label">
              <Columns3 size={13} />
              {copy.layout}
            </span>
            {layoutModes.map((mode) => (
              <button
                key={mode}
                type="button"
                className={layoutMode === mode ? "active" : ""}
                onClick={() => setLayoutMode(mode)}
              >
                {mode === "agent"
                  ? copy.agentLayout
                  : mode === "classic"
                    ? copy.classicLayout
                    : copy.sidecarLayout}
              </button>
            ))}
          </div>
          <div className="segmented-control compact" aria-label={copy.language}>
            <Globe2 size={13} />
            <button type="button" className={language === "zh" ? "active" : ""} onClick={() => setLanguage("zh")}>
              中
            </button>
            <button type="button" className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>
              EN
            </button>
          </div>
          <div className="segmented-control theme-control" aria-label={copy.theme}>
            <span className="segment-label">
              <Palette size={13} />
              {copy.theme}
            </span>
            {(["graphite", "ocean", "ember", "paper"] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                className={themeMode === theme ? "active" : ""}
                onClick={() => setThemeMode(theme)}
              >
                {theme === "graphite"
                  ? copy.graphite
                  : theme === "ocean"
                    ? copy.ocean
                    : theme === "ember"
                      ? copy.ember
                      : copy.paper}
              </button>
            ))}
          </div>
        </div>

        <div className="metric-strip">
          <div className="metric">
            <span>{copy.total}</span>
            <strong>{flows.length}</strong>
          </div>
          <div className="metric">
            <span>{copy.failures}</span>
            <strong>{failedCount}</strong>
          </div>
          <div className="metric">
            <span>{copy.tunnels}</span>
            <strong>{tunnelCount}</strong>
          </div>
          <div className="metric">
            <span>{copy.slow}</span>
            <strong>{slowCount}</strong>
          </div>
          <div className="metric wide ai-config-metric">
            <span>{aiProviderName}</span>
            <strong>{config?.qwen.hasApiKey ? copy.ready : copy.missingKey}</strong>
            <button
              type="button"
              className="metric-action"
              onClick={openAiSettingsDialog}
              disabled={busyAction !== null}
              title={copy.aiSettings}
            >
              <SlidersHorizontal size={14} />
            </button>
          </div>
        </div>
      </section>

      <section
        ref={workspaceRef}
        className={resizingWorkspace ? `workspace resizing-${resizingWorkspace}` : "workspace"}
        style={{ gridTemplateColumns: workspaceGridColumns }}
      >
        <aside className="request-panel">
          <div className="panel-header">
            <div className="target-box">
              <Globe2 size={15} />
              <input
                value={domainInput}
                onChange={(event) => setDomainInput(event.target.value)}
                placeholder={copy.targetPlaceholder}
              />
              <button
                className="mini-button"
                onClick={applyCaptureHosts}
                disabled={busyAction !== null}
                title="Apply target domain"
              >
                <Check size={14} />
                <span>{copy.apply}</span>
              </button>
            </div>
            <div className="filter-row">
              <div className="search-box">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.filterPlaceholder}
                />
              </div>
              <button className="square-button" onClick={refresh} title="Refresh">
                <RefreshCcw size={15} />
              </button>
              <div className="column-menu-wrap" ref={columnMenuRef}>
                <button
                  type="button"
                  className={columnMenuOpen ? "square-button active" : "square-button"}
                  onClick={() => setColumnMenuOpen((current) => !current)}
                  title={copy.fields}
                  aria-haspopup="menu"
                  aria-expanded={columnMenuOpen}
                >
                  <Columns3 size={15} />
                </button>
                {columnMenuOpen ? (
                  <div className="column-menu" role="menu" aria-label={copy.showFields}>
                    <div className="column-menu-head">
                      <strong>{copy.showFields}</strong>
                      <button
                        type="button"
                        onClick={() => setRequestColumns(defaultRequestColumnVisibility)}
                        title={copy.resetFields}
                      >
                        {copy.resetFields}
                      </button>
                    </div>
                    {requestColumnKeys.map((key) => (
                      <label key={key} className="column-menu-option">
                        <input
                          type="checkbox"
                          checked={requestColumns[key]}
                          onChange={() =>
                            setRequestColumns((current) => ({
                              ...current,
                              [key]: !current[key],
                            }))
                          }
                        />
                        <span>{requestColumnLabels[key]}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="request-table">
            <div className="table-head" style={{ gridTemplateColumns: requestGridColumns }}>
              <span>{copy.name}</span>
              {requestColumns.status ? <span className="status-head">{copy.status}</span> : null}
              {requestColumns.type ? <span>{copy.type}</span> : null}
              {requestColumns.size ? <span className="numeric-head">{copy.size}</span> : null}
              {requestColumns.captured ? <span className="numeric-head">{copy.captureTime}</span> : null}
              {requestColumns.duration ? <span className="numeric-head">{copy.time}</span> : null}
            </div>
            <div
              className="table-body virtual-table-body"
              ref={tableBodyRef}
              onScroll={(event) => setTableScrollTop(event.currentTarget.scrollTop)}
            >
              {filteredFlows.length === 0 ? (
                <div className="request-empty">{copy.noCapturesHint}</div>
              ) : (
                <div
                  className="virtual-table-spacer"
                  style={{ height: filteredFlows.length * requestRowHeight }}
                >
                  <div
                    className="virtual-table-window"
                    style={{ transform: `translateY(${virtualStartIndex * requestRowHeight}px)` }}
                  >
                    {virtualFlows.map((flow) => {
                      const requestName = displayRequestName(flow);
                      const requestType = inferRequestType(flow);
                      const ruleHit = flowRuleHit(flow, proxyRules);
                      return (
                        <button
                          key={flow.id}
                          className={[
                            "flow-row",
                            flow.id === selectedFlow?.id ? "selected" : "",
                            flow.id === locatedFlowId ? "agent-located" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => setSelectedId(flow.id)}
                          onDoubleClick={() => insertFlowNameIntoAgentInput(flow)}
                          onContextMenu={(event) => handleRequestContextMenu(event, flow)}
                          title={buildRequestUrl(flow)}
                          style={{ gridTemplateColumns: requestGridColumns }}
                        >
                          <span className="name-cell">
                            <span className="name-line">
                              <span className="method-dot">{flow.method}</span>
                              <strong>{requestName}</strong>
                              {ruleHit.hit ? <span className="rule-hit-pill">{ruleHit.kind || "rule"}</span> : null}
                            </span>
                            <small>{flow.host}</small>
                          </span>
                          {requestColumns.status ? (
                            <span className={`code ${statusTone(flow.statusCode, flow.errorType)}`}>
                              {flow.statusCode || "-"}
                            </span>
                          ) : null}
                          {requestColumns.type ? <span className="type-cell">{requestType}</span> : null}
                          {requestColumns.size ? (
                            <span className="size-cell">
                              {flow.completedAt || isStreamingFlow(flow) ? compactByteLabel(flow.responseSize) : "-"}
                            </span>
                          ) : null}
                          {requestColumns.captured ? (
                            <span className="started-cell">
                              <Clock3 size={12} />
                              {formatTime(flow.startedAt)}
                            </span>
                          ) : null}
                          {requestColumns.duration ? (
                            <span className="duration-cell">
                              {flow.durationMs === null ? "-" : `${flow.durationMs} ms`}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="capture-note">
            {copy.captureNote} Session auto-saves locally.
          </div>
        </aside>

        <section className="detail-panel">
          {selectedFlow ? (
            <>
              <div className="detail-title">
                <div>
                  <span className="method-tag">{selectedFlow.method}</span>
                  <h2>
                    {selectedFlow.host}
                    {selectedFlow.path}
                    {selectedFlow.query}
                  </h2>
                </div>
                <div className="detail-actions">
                  {selectedRuleHit?.hit ? (
                    <span className="detail-rule-hit" title={selectedRuleHit.rule?.pattern || selectedRuleHit.ruleId || ""}>
                      Rule · {selectedRuleHit.kind || selectedRuleHit.rule?.kind || "hit"}
                    </span>
                  ) : null}
                  <span className={`code ${statusTone(selectedFlow.statusCode, selectedFlow.errorType)}`}>
                    {selectedFlow.statusCode || selectedFlow.errorType || "Pending"}
                  </span>
                </div>
              </div>

              <div className="request-action-bar">
                <button
                  type="button"
                  className="inline-code-action"
                  disabled={busyAction !== null || selectedFlow.method === "CONNECT"}
                  onClick={() => replayFlow(selectedFlow)}
                  title="重放当前请求"
                >
                  <Play size={13} />
                  <span>{busyAction === `replay-${selectedFlow.id}` ? "重放中" : "Replay"}</span>
                </button>
                <button
                  type="button"
                  className="inline-code-action"
                  disabled={busyAction !== null || selectedFlow.method === "CONNECT"}
                  onClick={() => openEditRepeat(selectedFlow)}
                  title="编辑请求后再次发送"
                >
                  <Repeat2 size={13} />
                  <span>Edit & Repeat</span>
                </button>
                <button
                  type="button"
                  className="inline-code-action"
                  onClick={() => copyRequestExport(selectedFlow, "curl")}
                  title="复制为 cURL"
                >
                  <Copy size={13} />
                  <span>{copiedKey === exportKey("curl", selectedFlow) ? "已复制" : "cURL"}</span>
                </button>
                <button
                  type="button"
                  className="inline-code-action"
                  onClick={() => copyRequestExport(selectedFlow, "playwright")}
                  title="Copy as Playwright"
                >
                  <Code2 size={13} />
                  <span>{copiedKey === exportKey("playwright", selectedFlow) ? "已复制" : "Playwright"}</span>
                </button>
                <button
                  type="button"
                  className="inline-code-action"
                  onClick={() => copyRequestExport(selectedFlow, "postman")}
                  title="Copy as Postman collection"
                >
                  <FileJson size={13} />
                  <span>{copiedKey === exportKey("postman", selectedFlow) ? "已复制" : "Postman"}</span>
                </button>
              </div>

              <div className="inspector-grid">
                <CollapsibleCard title="Overview" defaultOpen={false}>
                  <dl className="facts">
                    <div>
                      <dt>Protocol</dt>
                      <dd>{selectedFlow.protocol}</dd>
                    </div>
                    <div>
                      <dt>Scheme</dt>
                      <dd>{selectedFlow.scheme}</dd>
                    </div>
                    <div>
                      <dt>Port</dt>
                      <dd>{selectedFlow.port || "-"}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{selectedFlow.source || "-"}</dd>
                    </div>
                    <div>
                      <dt>Client</dt>
                      <dd>{selectedFlow.clientAddress || "-"}</dd>
                    </div>
                    <div>
                      <dt>Request</dt>
                      <dd>{byteLabel(selectedFlow.requestSize)}</dd>
                    </div>
                    <div>
                      <dt>Response</dt>
                      <dd>{byteLabel(selectedFlow.responseSize)}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>{selectedFlow.durationMs === null ? "-" : `${selectedFlow.durationMs} ms`}</dd>
                    </div>
                    <div>
                      <dt>Error</dt>
                      <dd>{selectedFlow.errorType || "-"}</dd>
                    </div>
                    <div>
                      <dt>Tags</dt>
                      <dd>{(Array.isArray(selectedFlow.tags) ? selectedFlow.tags : []).join(", ") || "-"}</dd>
                    </div>
                  </dl>
                </CollapsibleCard>
                {selectedRuleHit?.hit ? (
                  <CollapsibleCard title="Rule Hit" className="rule-hit-card" defaultOpen={false}>
                    <dl className="facts">
                      <div>
                        <dt>Action</dt>
                        <dd>{selectedRuleHit.kind || selectedRuleHit.rule?.kind || "-"}</dd>
                      </div>
                      <div>
                        <dt>Rule</dt>
                        <dd>{selectedRuleHit.rule?.pattern || selectedRuleHit.ruleId || "-"}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedRuleHit.rule?.statusCode || selectedFlow.statusCode || "-"}</dd>
                      </div>
                      <div>
                        <dt>Hits</dt>
                        <dd>{selectedRuleHit.ruleId ? hitCountsByRule[selectedRuleHit.ruleId] || 1 : 1}</dd>
                      </div>
                    </dl>
                  </CollapsibleCard>
                ) : null}
                {selectedReplayResult ? (
                  <ReplayResultCard
                    result={selectedReplayResult}
                    copiedKey={copiedKey}
                    onCopy={copyAgentValue}
                    onExpand={openInspectorWindow}
                  />
                ) : null}
                <PayloadSwitcher
                  flow={selectedFlow}
                  queryParams={selectedQueryParams}
                  fullRequestBody={fullBodies[bodyContentKey(selectedFlow.id, "request")]}
                  fullResponseBody={fullBodies[bodyContentKey(selectedFlow.id, "response")]}
                  copiedKey={copiedKey}
                  copy={copy}
                  onCopy={copyAgentValue}
                  onExpand={openInspectorWindow}
                  onCompare={() => openPayloadCompare(selectedFlow)}
                />
                <InspectorBlock
                  title="Request Headers"
                  value={selectedFlow.requestHeaders}
                  copyKey={`request-headers-${selectedFlow.id}`}
                  copiedKey={copiedKey}
                  onCopy={copyAgentValue}
                  onExpand={openInspectorWindow}
                />
                <InspectorBlock
                  title="Response Headers"
                  value={selectedFlow.responseHeaders}
                  copyKey={`response-headers-${selectedFlow.id}`}
                  copiedKey={copiedKey}
                  onCopy={copyAgentValue}
                  onExpand={openInspectorWindow}
                />

                <details className="advanced-details">
                  <summary>Advanced details</summary>
                  <div className="advanced-details-grid">
                    <InspectorBlock
                      title="Timing"
                      value={timingDetails(selectedFlow)}
                      copyKey={`timing-${selectedFlow.id}`}
                      copiedKey={copiedKey}
                      onCopy={copyAgentValue}
                      onExpand={openInspectorWindow}
                    />
                    <InspectorBlock
                      title="Request Cookies"
                      value={selectedRequestCookies}
                      copyKey={`request-cookies-${selectedFlow.id}`}
                      copiedKey={copiedKey}
                      onCopy={copyAgentValue}
                      onExpand={openInspectorWindow}
                    />
                    <InspectorBlock
                      title="Response Cookies"
                      value={selectedResponseCookies}
                      copyKey={`response-cookies-${selectedFlow.id}`}
                      copiedKey={copiedKey}
                      onCopy={copyAgentValue}
                      onExpand={openInspectorWindow}
                    />
                    <InspectorBlock
                      title="Raw Request"
                      value={rawRequest(selectedFlow)}
                      copyKey={`raw-request-${selectedFlow.id}`}
                      copiedKey={copiedKey}
                      onCopy={copyAgentValue}
                      onExpand={openInspectorWindow}
                    />
                    <InspectorBlock
                      title="Raw Response"
                      value={rawResponse(selectedFlow)}
                      copyKey={`raw-response-${selectedFlow.id}`}
                      copiedKey={copiedKey}
                      onCopy={copyAgentValue}
                      onExpand={openInspectorWindow}
                    />
                  </div>
                </details>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-card">
                <Radio size={22} />
                <strong>{copy.noCapturesTitle}</strong>
                <p>{copy.noCapturesHint}</p>
              </div>
            </div>
          )}
        </section>

        <aside className="agent-panel">
          <div className="agent-header">
            <Bot size={18} />
            <h2>{copy.agent}</h2>
          </div>

          <div className="agent-actions">
            <button
              className="icon-button primary"
              disabled={busyAction !== null}
              onClick={() =>
                runAction("test-ai", async () => {
                  const result = await desktopBackend.ai.testConnection();
                  setAgentMessages((current) => [
                    ...current,
                    {
                      id: makeId("assistant"),
                      role: "assistant",
                      model: result.model,
                      content: result.message,
                    },
                  ]);
                })
              }
            >
              <WandSparkles size={16} />
              <span>{copy.test}</span>
            </button>
            <button
              className="icon-button"
              disabled={busyAction !== null || flows.length === 0}
              onClick={() => sendAgentQuestion("分析今天所有失败和慢接口，按影响排序，给出证据请求和下一步排查建议")}
            >
              <Bug size={16} />
              <span>{copy.analyze}</span>
            </button>
            <button
              className="icon-button"
              disabled={busyAction !== null || flows.length === 0}
              onClick={() => sendAgentQuestion("基于当前抓包会话生成一份缺陷报告，包含复现步骤、实际结果、期望结果和关键接口证据")}
            >
              <ClipboardList size={16} />
              <span>{copy.report}</span>
            </button>
          </div>

          <div className="utility-tabs">
            <button
              type="button"
              className={utilityPanel === "agent" ? "active" : ""}
              onClick={() => setUtilityPanel("agent")}
            >
              <Bot size={14} />
              <span>{copy.agent}</span>
            </button>
            <button
              type="button"
              className={utilityPanel === "lab" ? "active" : ""}
              onClick={() => setUtilityPanel("lab")}
            >
              <SlidersHorizontal size={14} />
              <span>{copy.lab}</span>
              {activeRuleCount || breakpoints.length ? (
                <small>{activeRuleCount + breakpoints.length}</small>
              ) : null}
            </button>
          </div>

          <div className={utilityPanel === "lab" ? "network-lab utility-panel active" : "network-lab utility-panel"}>
            <div className="lab-title">
              <SlidersHorizontal size={15} />
              <strong>{copy.networkLab}</strong>
              <span>
                {activeRuleCount} {copy.activeRules}
              </span>
            </div>

            <section className="lab-section mobile-capture-section">
              <div className="mobile-capture-summary">
                <div>
                  <strong>{copy.mobileCapture}</strong>
                  <span>{copy.mobileCaptureHint}</span>
                </div>
                <span className={mobileSetupUrl ? "state-pill active" : "state-pill"}>
                  {mobileSetupUrl ? copy.mobileReady : copy.mobileUnavailable}
                </span>
              </div>

              {mobileSetupUrl ? (
                <div className="mobile-setup-grid">
                  <SetupQrCode value={mobileSetupUrl} label={copy.mobileSetupUrl} />
                  <div className="mobile-setup-details">
                    <label>
                      <span>{copy.mobileSetupUrl}</span>
                      <code>{mobileSetupUrl}</code>
                    </label>
                    <label>
                      <span>{copy.mobileProxy}</span>
                      <code>{mobileProxyAddress}</code>
                    </label>
                    <div className="mobile-action-row">
                      <button
                        className="inline-code-action primary"
                        type="button"
                        onClick={() => copyAgentValue(mobileSetupUrl, "mobile-setup-url")}
                      >
                        <Copy size={13} />
                        <span>{copiedKey === "mobile-setup-url" ? copy.copied : copy.mobileCopySetup}</span>
                      </button>
                      <button
                        className="inline-code-action"
                        type="button"
                        onClick={() => copyAgentValue(mobileProxyAddress, "mobile-proxy-address")}
                      >
                        <Copy size={13} />
                        <span>{copiedKey === "mobile-proxy-address" ? copy.copied : copy.mobileCopyProxy}</span>
                      </button>
                      {mobileCertUrl ? (
                        <button
                          className="inline-code-action"
                          type="button"
                          onClick={() => copyAgentValue(mobileCertUrl, "mobile-cert-url")}
                        >
                          <Download size={13} />
                          <span>{copiedKey === "mobile-cert-url" ? copy.copied : copy.mobileCopyCert}</span>
                        </button>
                      ) : null}
                      {mobilePacUrl ? (
                        <button
                          className="inline-code-action"
                          type="button"
                          onClick={() => copyAgentValue(mobilePacUrl, "mobile-pac-url")}
                        >
                          <Copy size={13} />
                          <span>{copiedKey === "mobile-pac-url" ? copy.copied : copy.mobileCopyPac}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="empty-line">{copy.mobileStartHint}</div>
              )}

              <details className="mobile-capture-advanced">
                <summary>{copy.advancedSettings}</summary>
                <div className="mobile-guide-list">
                  <div>
                    <Smartphone size={14} />
                    <strong>{copy.mobileIosTitle}</strong>
                    <span>{copy.mobileIosGuide}</span>
                    {mobileIosProfileUrl ? <code>{mobileIosProfileUrl}</code> : null}
                  </div>
                  <div>
                    <Smartphone size={14} />
                    <strong>{copy.mobileAndroidTitle}</strong>
                    <span>{copy.mobileAndroidGuide}</span>
                    {mobileCertUrl ? <code>{mobileCertUrl}</code> : null}
                  </div>
                  <p>{copy.mobileBoundary}</p>
                </div>
              </details>
            </section>

            <section className="lab-section weak-network-section">
              <div className="weak-network-summary">
                <div>
                  <strong>{copy.weakNetwork}</strong>
                  <span>{copy.weakNetworkHint}</span>
                </div>
                <span className={weakNetwork.enabled ? "state-pill active" : "state-pill"}>
                  {weakNetwork.enabled ? copy.weakNetworkOn : copy.weakNetworkOff}
                </span>
              </div>
              <div className="weak-network-actions">
                <button
                  className={weakNetwork.enabled ? "inline-code-action" : "inline-code-action primary"}
                  type="button"
                  onClick={applyQuickWeakNetwork}
                >
                  <SlidersHorizontal size={13} />
                  <span>{weakNetwork.enabled ? copy.disableWeakNetwork : copy.quickWeakNetwork}</span>
                </button>
                {weakNetwork.enabled ? (
                  <span className="muted-mini">
                    {weakNetwork.delayMs} ms · {weakNetwork.downstreamKbps} KB/s ·{" "}
                    {Math.round(weakNetwork.errorRate * 100)}%
                  </span>
                ) : null}
              </div>
              <details className="weak-network-advanced">
                <summary>{copy.advancedSettings}</summary>
                <div className="lab-grid">
                  <label>
                    <span>{copy.delayMs}</span>
                    <input
                      type="number"
                      min={0}
                      value={weakNetwork.delayMs}
                      onChange={(event) =>
                        setWeakNetwork((current) => ({ ...current, delayMs: Number(event.target.value) || 0 }))
                      }
                    />
                  </label>
                  <label>
                    <span>{copy.downKbps}</span>
                    <input
                      type="number"
                      min={0}
                      value={weakNetwork.downstreamKbps}
                      onChange={(event) =>
                        setWeakNetwork((current) => ({ ...current, downstreamKbps: Number(event.target.value) || 0 }))
                      }
                    />
                  </label>
                  <label>
                    <span>{copy.errorRate}</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={weakNetwork.errorRate}
                      onChange={(event) =>
                        setWeakNetwork((current) => ({ ...current, errorRate: Number(event.target.value) || 0 }))
                      }
                    />
                  </label>
                  <button className="inline-code-action" type="button" onClick={() => applyWeakNetwork()}>
                    <Check size={13} />
                    <span>{copy.applySettings}</span>
                  </button>
                </div>
              </details>
            </section>

            <section className="lab-section">
              <div className="lab-section-head">
                <span>{copy.rules}</span>
                <span className="muted-mini">{copy.ruleModeHint}</span>
              </div>
              <div className="rule-editor">
                <select
                  value={ruleDraft.kind}
                  onChange={(event) =>
                    setRuleDraft((current) => {
                      const kind = event.target.value as ProxyRule["kind"];
                      return { ...current, kind, direction: kind === "rewrite" ? "response" : current.direction };
                    })
                  }
                >
                  <option value="mock">{copy.ruleMock}</option>
                  <option value="rewrite">{copy.ruleRewrite}</option>
                  <option value="mapLocal">{copy.ruleMapLocal}</option>
                  <option value="breakpoint">{copy.ruleBreakpoint}</option>
                </select>
                <select
                  value={ruleDraft.direction}
                  onChange={(event) =>
                    setRuleDraft((current) => ({ ...current, direction: event.target.value as ProxyRule["direction"] }))
                  }
                >
                  <option value="request">{copy.ruleDirectionRequest}</option>
                  <option value="response">{copy.ruleDirectionResponse}</option>
                  <option value="both">{copy.ruleDirectionBoth}</option>
                </select>
                <input
                  value={ruleDraft.pattern}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, pattern: event.target.value }))}
                  placeholder={copy.urlPatternPlaceholder}
                />
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={ruleDraft.statusCode ?? ""}
                  onChange={(event) =>
                    setRuleDraft((current) => ({
                      ...current,
                      statusCode: event.target.value ? Number(event.target.value) : null,
                    }))
                  }
                  placeholder={copy.statusPlaceholder}
                />
                <input
                  value={ruleDraft.localPath}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, localPath: event.target.value }))}
                  placeholder={copy.localFilePlaceholder}
                />
                <input
                  value={ruleDraft.search}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, search: event.target.value }))}
                  placeholder={copy.rewriteSearchPlaceholder}
                />
                <input
                  value={ruleDraft.replace}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, replace: event.target.value }))}
                  placeholder={copy.rewriteReplacePlaceholder}
                />
                <textarea
                  value={ruleHeadersText}
                  onChange={(event) => setRuleHeadersText(event.target.value)}
                  placeholder='{"content-type":"application/json"}'
                />
                <textarea
                  value={ruleDraft.body}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, body: event.target.value }))}
                  placeholder={copy.mockBodyPlaceholder}
                />
                <button className="inline-code-action" type="button" onClick={addRule}>
                  <Check size={13} />
                  <span>{copy.addRule}</span>
                </button>
              </div>
              <div className="rule-list">
                {proxyRules.length === 0 ? <div className="empty-line">{copy.noActiveRules}</div> : null}
                {proxyRules.map((rule) => {
                  const hits = hitCountsByRule[rule.id] || 0;
                  return (
                    <div className={hits ? "rule-row has-hits" : "rule-row"} key={rule.id}>
                      <label className="toggle-line">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(event) => updateRule({ ...rule, enabled: event.target.checked })}
                        />
                        <span>{rule.kind}</span>
                      </label>
                      <strong title={rule.pattern}>
                        {rule.pattern}
                        <small>{rule.direction}</small>
                      </strong>
                      <span className="rule-hit-count">{hits ? `${hits} hits` : "0 hits"}</span>
                      <button type="button" title="Delete rule" onClick={() => deleteRule(rule.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {breakpoints.length ? (
              <section className="lab-section">
                <div className="lab-section-head">
                  <span>{copy.breakpoints}</span>
                  <span className="muted-mini">
                    {breakpoints.length} {copy.pending}
                  </span>
                </div>
                <div className="breakpoint-list">
                  {breakpoints.map((breakpoint) => (
                    <article key={breakpoint.id} className="breakpoint-card">
                      <div>
                        <PauseCircle size={14} />
                        <strong>
                          {breakpoint.direction === "response" ? copy.responseEdit : copy.requestEdit} · {breakpoint.method}
                        </strong>
                        <span title={breakpoint.url}>{breakpoint.url}</span>
                      </div>
                      <pre className="breakpoint-preview">
                        {breakpoint.direction === "response"
                          ? breakpoint.responseBodyPreview || JSON.stringify(breakpoint.responseHeaders || {}, null, 2)
                          : breakpoint.bodyPreview || JSON.stringify(breakpoint.headers || {}, null, 2)}
                      </pre>
                      <div className="breakpoint-actions">
                        <button type="button" onClick={() => resolveBreakpoint(breakpoint, "continue")}>
                          {copy.editContinue}
                        </button>
                        <button type="button" onClick={() => resolveBreakpoint(breakpoint, "mock")}>
                          {copy.mock200}
                        </button>
                        <button type="button" onClick={() => resolveBreakpoint(breakpoint, "drop")}>
                          {copy.dropRequest}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <div
            className={[
              "agent-chat utility-panel",
              utilityPanel === "agent" ? "active" : "",
              layoutMode === "agent" ? "has-voice" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {layoutMode === "agent" ? (
              <div className="voice-hero">
                <Mic size={18} />
                <div>
                  <strong>{copy.speakFirst}</strong>
                  <span>{copy.speakFirstHint}</span>
                </div>
              </div>
            ) : null}
            <div className="quick-prompts">
              {localizedQuickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  className="prompt-chip"
                  disabled={busyAction !== null}
                  onClick={() => sendAgentQuestion(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="message-list" ref={messageListRef}>
              {agentMessages.length === 0 ? (
                <div className="empty-line">
                  {copy.emptyChat}
                </div>
              ) : null}
              {agentMessages.map((message) => (
                <article
                  key={message.id}
                  className={["chat-message", message.role, message.status ? `is-${message.status}` : ""]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div className="chat-meta">
                    <span>{message.role === "user" ? "You" : message.model || config?.qwen.model || "Agent"}</span>
                    {message.attachments?.length ? <span>{message.attachments.length} image</span> : null}
                  </div>
                  {message.status === "loading" ? (
                    <AgentThinkingCard copy={copy} onCancel={activeAgentRunId ? cancelAgentRun : undefined} />
                  ) : message.role === "assistant" && message.structured ? (
                    <StructuredAgentAnswer
                      answer={message.structured}
                      copiedKey={copiedKey}
                      narrative={message.content}
                      onCopy={copyAgentValue}
                    />
                  ) : message.role === "assistant" ? (
                    <AgentTextAnswer content={message.content} />
                  ) : (
                    <pre>{message.content}</pre>
                  )}
                  {message.attachments?.length ? (
                    <div className="message-images">
                      {message.attachments.map((attachment) => (
                        <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} />
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
              {busyAction && busyAction !== "ask-agent" ? (
                <div className="inline-busy" role="status">
                  <Loader2 size={14} />
                  <span>Running {busyAction}...</span>
                </div>
              ) : null}
            </div>

            {agentAttachments.length ? (
              <div className="attachment-strip">
                {agentAttachments.map((attachment) => (
                  <div className="attachment-pill" key={attachment.id}>
                    <img src={attachment.dataUrl} alt={attachment.name} />
                    <span>{attachment.name}</span>
                    <button onClick={() => removeAttachment(attachment.id)} title="Remove image">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="agent-composer">
              <textarea
                ref={agentInputRef}
                value={agentInput}
                onChange={(event) => setAgentInput(event.target.value)}
                onPaste={handleComposerPaste}
                placeholder={copy.composerPlaceholder}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    sendAgentQuestion();
                  }
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => handleImageFiles(event.target.files)}
              />
              <div className="composer-actions">
                <button
                  className="square-button"
                  title="Attach screenshot"
                  disabled={busyAction !== null}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon size={15} />
                </button>
                <button
                  className={isListening ? "square-button active" : "square-button"}
                  title="Voice input"
                  disabled={busyAction !== null || isListening}
                  onClick={startVoiceInput}
                >
                  <Mic size={15} />
                </button>
                <button
                  className="square-button primary-send"
                  title="Send"
                  disabled={busyAction !== null || !agentInput.trim()}
                  onClick={() => sendAgentQuestion()}
                >
                  <SendHorizontal size={15} />
                </button>
              </div>
            </div>
          </div>
        </aside>
        <button
          type="button"
          className="workspace-resizer request-resizer"
          style={{ left: `${currentLayoutSizing.request}px` }}
          aria-label="拖动调整请求列表宽度"
          title="拖动调整请求列表宽度，双击恢复默认"
          onPointerDown={(event) => startWorkspaceResize("request", event)}
          onDoubleClick={resetWorkspaceSizing}
        />
        <button
          type="button"
          className="workspace-resizer side-resizer"
          style={{ right: `${currentLayoutSizing.side}px` }}
          aria-label={layoutMode === "agent" ? "拖动调整详情栏宽度" : "拖动调整 Agent 宽度"}
          title={layoutMode === "agent" ? "拖动调整详情栏宽度，双击恢复默认" : "拖动调整 Agent 宽度，双击恢复默认"}
          onPointerDown={(event) => startWorkspaceResize("side", event)}
          onDoubleClick={resetWorkspaceSizing}
        />
      </section>
      {aiSettingsDialogOpen ? (
        <div className="inspector-modal-backdrop" onClick={() => setAiSettingsDialogOpen(false)}>
          <section className="ai-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>{copy.aiSettings}</h2>
                <div className="inspector-modal-hint">{copy.aiSettingsHint}</div>
              </div>
              <button className="icon-button icon-only" type="button" onClick={() => setAiSettingsDialogOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="ai-settings-form">
              <label>
                <span>{copy.aiProvider}</span>
                <select
                  value={aiConfigDraft.provider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    const preset = findAiProviderPreset(provider);
                    setAiConfigDraft((current) =>
                      provider === "custom"
                        ? { ...current, provider }
                        : {
                            provider,
                            baseUrl: preset.baseUrl,
                            model: preset.model,
                            visionModel: preset.visionModel,
                          },
                    );
                  }}
                >
                  {aiProviderPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.aiBaseUrl}</span>
                <input
                  value={aiConfigDraft.baseUrl}
                  onChange={(event) => setAiConfigDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder={aiDraftPreset.baseUrl || "https://api.example.com/v1"}
                />
              </label>
              <label>
                <span>{copy.aiModel}</span>
                <input
                  value={aiConfigDraft.model}
                  onChange={(event) => setAiConfigDraft((current) => ({ ...current, model: event.target.value }))}
                  placeholder={aiDraftPreset.model || "model-name"}
                />
              </label>
              <label>
                <span>{copy.aiVisionModel}</span>
                <input
                  value={aiConfigDraft.visionModel}
                  onChange={(event) => setAiConfigDraft((current) => ({ ...current, visionModel: event.target.value }))}
                  placeholder={aiDraftPreset.visionModel || aiDraftPreset.model || "vision-model-name"}
                />
              </label>
              <label>
                <span>{copy.aiApiKey}</span>
                <input
                  type="password"
                  value={aiApiKeyDraft}
                  disabled={clearAiApiKey}
                  onChange={(event) => setAiApiKeyDraft(event.target.value)}
                  placeholder={copy.aiApiKeyPlaceholder}
                />
              </label>
              <div className="ai-key-state">
                <span>{config?.qwen.hasApiKey ? copy.aiKeyConfigured : copy.aiKeyNotConfigured}</span>
                <label>
                  <input
                    type="checkbox"
                    checked={clearAiApiKey}
                    onChange={(event) => {
                      setClearAiApiKey(event.target.checked);
                      if (event.target.checked) {
                        setAiApiKeyDraft("");
                      }
                    }}
                  />
                  <span>{copy.clearApiKey}</span>
                </label>
              </div>
            </div>

            <div className="modal-actions-row">
              <button
                className="inline-code-action"
                type="button"
                onClick={() => setAiSettingsDialogOpen(false)}
                disabled={busyAction === "ai-settings"}
              >
                <X size={13} />
                <span>{language === "zh" ? "取消" : "Cancel"}</span>
              </button>
              <button
                className="inline-code-action primary"
                type="button"
                onClick={saveAiSettings}
                disabled={busyAction === "ai-settings"}
              >
                {busyAction === "ai-settings" ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                <span>{copy.saveSettings}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {mobileSetupDialogOpen ? (
        <div className="inspector-modal-backdrop" onClick={() => setMobileSetupDialogOpen(false)}>
          <section className="mobile-setup-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>{copy.mobileModalTitle}</h2>
                <div className="inspector-modal-hint">{copy.mobileModalHint}</div>
              </div>
              <button className="icon-button icon-only" type="button" onClick={() => setMobileSetupDialogOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="mobile-modal-grid">
              <SetupQrCode value={mobileSetupUrl || `http://${mobileProxyAddress}/mobile-setup`} label={copy.mobileSetupUrl} />
              <div className="mobile-modal-fields">
                <label>
                  <span>{copy.mobileSetupUrl}</span>
                  <code>{mobileSetupUrl || `http://${mobileProxyAddress}/mobile-setup`}</code>
                </label>
                <label>
                  <span>{copy.mobileProxy}</span>
                  <code>{mobileProxyAddress}</code>
                </label>
                {mobileCertUrl ? (
                  <label>
                    <span>{copy.mobileCert}</span>
                    <code>{mobileCertUrl}</code>
                  </label>
                ) : null}
                {mobilePacUrl ? (
                  <label>
                    <span>{copy.mobilePac}</span>
                    <code>{mobilePacUrl}</code>
                  </label>
                ) : null}
              </div>
            </div>

            <div className="mobile-modal-actions">
              <button
                className="inline-code-action primary"
                type="button"
                onClick={() => copyAgentValue(mobileSetupUrl || `http://${mobileProxyAddress}/mobile-setup`, "mobile-modal-setup")}
              >
                <Copy size={13} />
                <span>{copiedKey === "mobile-modal-setup" ? copy.copied : copy.mobileCopySetup}</span>
              </button>
              <button
                className="inline-code-action"
                type="button"
                onClick={() => copyAgentValue(mobileProxyAddress, "mobile-modal-proxy")}
              >
                <Copy size={13} />
                <span>{copiedKey === "mobile-modal-proxy" ? copy.copied : copy.mobileCopyProxy}</span>
              </button>
              <button className="inline-code-action" type="button" onClick={openMobileSetupInBrowser}>
                <QrCode size={13} />
                <span>{copy.mobileOpenBrowser}</span>
              </button>
            </div>

            <div className="mobile-modal-guides">
              <article>
                <strong>{copy.mobileIosTitle}</strong>
                <p>{copy.mobileIosGuide}</p>
                {mobileIosProfileUrl ? <code>{mobileIosProfileUrl}</code> : null}
              </article>
              <article>
                <strong>{copy.mobileAndroidTitle}</strong>
                <p>{copy.mobileAndroidGuide}</p>
                {mobileCertUrl ? <code>{mobileCertUrl}</code> : null}
              </article>
              <p>{copy.mobileBoundary}</p>
            </div>
          </section>
        </div>
      ) : null}
      {certTrustDialog ? (
        <div className="inspector-modal-backdrop" onClick={() => setCertTrustDialog(null)}>
          <section className="cert-trust-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>{certTrustDialog.title}</h2>
                <div className="inspector-modal-hint">HeavenEye Agent 没有完成 macOS 根证书信任配置。</div>
              </div>
              <button className="icon-button icon-only" type="button" onClick={() => setCertTrustDialog(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="cert-trust-body">
              <section className="cert-trust-summary">
                <AlertTriangle size={18} />
                <div>
                  <strong>{certTrustDialog.message}</strong>
                  <p>{certTrustDialog.hint}</p>
                </div>
              </section>

              {certTrustDialog.certPath ? (
                <label className="cert-trust-field">
                  <span>根证书路径</span>
                  <code>{certTrustDialog.certPath}</code>
                </label>
              ) : null}

              {certTrustDialog.command ? (
                <label className="cert-trust-field">
                  <span>终端手动信任命令</span>
                  <pre>{certTrustDialog.command}</pre>
                </label>
              ) : null}

              <label className="cert-trust-field">
                <span>完整错误</span>
                <pre>{certTrustDialog.detail}</pre>
              </label>

              <div className="cert-trust-steps">
                <strong>可选处理方式</strong>
                <ol>
                  <li>点击“重试一键信任”，在 macOS 弹窗里输入管理员密码。</li>
                  <li>如果仍然失败，复制终端命令执行，再回到 HeavenEye Agent 重新检测。</li>
                  <li>也可以点击“打开证书”，在钥匙串访问中把 HeavenEye Agent CA 设置为始终信任。</li>
                </ol>
              </div>
            </div>

            <div className="modal-actions-row cert-trust-actions">
              <button
                className="inline-code-action"
                type="button"
                onClick={() => copyAgentValue(certTrustDialog.detail, "cert-trust-error")}
              >
                <Copy size={13} />
                <span>{copiedKey === "cert-trust-error" ? copy.copied : "复制错误"}</span>
              </button>
              {certTrustDialog.command ? (
                <button
                  className="inline-code-action"
                  type="button"
                  onClick={() => copyAgentValue(certTrustDialog.command, "cert-trust-command")}
                >
                  <Copy size={13} />
                  <span>{copiedKey === "cert-trust-command" ? copy.copied : "复制命令"}</span>
                </button>
              ) : null}
              <button
                className="inline-code-action"
                type="button"
                onClick={() => runAction("open-cert", () => desktopBackend.cert.openRoot())}
                disabled={busyAction !== null}
              >
                <FolderOpen size={13} />
                <span>打开证书</span>
              </button>
              <button
                className="inline-code-action"
                type="button"
                onClick={recheckRootCertificate}
                disabled={busyAction !== null}
              >
                {busyAction === "cert-info" ? <Loader2 size={13} className="spin" /> : <RefreshCcw size={13} />}
                <span>重新检测</span>
              </button>
              <button
                className="inline-code-action primary"
                type="button"
                onClick={installRootCertificate}
                disabled={busyAction !== null}
              >
                {busyAction === "install-cert" ? <Loader2 size={13} className="spin" /> : <WandSparkles size={13} />}
                <span>重试一键信任</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {requestMenu && requestMenuFlow
        ? (() => {
            const menuWidth = 360;
            const menuHeight = 472;
            const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
            const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
            const canReplay = requestMenuFlow.method !== "CONNECT";
            const replayBusy = busyAction === `replay-${requestMenuFlow.id}`;
            const disabledReason = busyAction !== null ? copy.contextBusy : copy.contextConnectDisabled;

            return (
              <div
                className="request-context-menu"
                role="menu"
                aria-label={copy.contextMenuTitle}
                style={{
                  left: Math.max(12, Math.min(requestMenu.x, viewportWidth - menuWidth - 12)),
                  top: Math.max(12, Math.min(requestMenu.y, viewportHeight - menuHeight - 12)),
                }}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <div className="request-context-title">
                  <div className="context-method-row">
                    <span className="method-dot">{requestMenuFlow.method}</span>
                    <span className={`code ${statusTone(requestMenuFlow.statusCode, requestMenuFlow.errorType)}`}>
                      {requestMenuFlow.statusCode || "-"}
                    </span>
                    <span>{requestMenuFlow.durationMs === null ? "-" : `${requestMenuFlow.durationMs} ms`}</span>
                  </div>
                  <strong>{displayRequestName(requestMenuFlow)}</strong>
                  <small>{requestMenuFlow.host}</small>
                </div>

                <div className="context-menu-section">
                  <span>{copy.contextMenuTitle}</span>
                  <RequestContextAction
                    primary
                    busy={replayBusy}
                    icon={<Play size={14} />}
                    label={replayBusy ? copy.contextReplaying : copy.contextReplay}
                    hint={copy.contextReplayHint}
                    copiedLabel={copy.contextCopied}
                    disabled={busyAction !== null || !canReplay}
                    disabledReason={disabledReason}
                    onClick={() => replayFlow(requestMenuFlow)}
                  />
                  <RequestContextAction
                    icon={<Repeat2 size={14} />}
                    label={copy.contextEdit}
                    hint={copy.contextEditHint}
                    copiedLabel={copy.contextCopied}
                    disabled={busyAction !== null || !canReplay}
                    disabledReason={disabledReason}
                    onClick={() => openEditRepeat(requestMenuFlow)}
                  />
                </div>

                <div className="context-menu-section">
                  <span>{copy.contextCopySection}</span>
                  <RequestContextAction
                    icon={<Copy size={14} />}
                    label={copy.contextCopyCurl}
                    hint={copy.contextCopyCurlHint}
                    copiedLabel={copy.contextCopied}
                    copied={copiedKey === exportKey("curl", requestMenuFlow)}
                    onClick={() => copyRequestExport(requestMenuFlow, "curl")}
                  />
                  <RequestContextAction
                    icon={<Code2 size={14} />}
                    label={copy.contextCopyPlaywright}
                    hint={copy.contextCopyPlaywrightHint}
                    copiedLabel={copy.contextCopied}
                    copied={copiedKey === exportKey("playwright", requestMenuFlow)}
                    onClick={() => copyRequestExport(requestMenuFlow, "playwright")}
                  />
                  <RequestContextAction
                    icon={<FileJson size={14} />}
                    label={copy.contextCopyPostman}
                    hint={copy.contextCopyPostmanHint}
                    copiedLabel={copy.contextCopied}
                    copied={copiedKey === exportKey("postman", requestMenuFlow)}
                    onClick={() => copyRequestExport(requestMenuFlow, "postman")}
                  />
                </div>
              </div>
            );
          })()
        : null}
      {breakpointEditDraft ? (
        <div className="inspector-modal-backdrop" onClick={() => setBreakpointEditDraft(null)}>
          <section className="repeat-modal breakpoint-edit-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>{copy.breakpointEditor}</h2>
                <div className="inspector-modal-hint">{breakpointEditDraft.breakpoint.url}</div>
              </div>
              <button type="button" className="inline-code-action" onClick={() => setBreakpointEditDraft(null)}>
                <X size={13} />
                <span>关闭</span>
              </button>
            </div>
            <div className="repeat-form">
              <label>
                <span>Action</span>
                <select
                  value={breakpointEditDraft.action}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) =>
                      current && { ...current, action: event.target.value as BreakpointDecision["action"] },
                    )
                  }
                >
                  <option value="continue">{copy.continueRequest}</option>
                  <option value="mock">{copy.mock200}</option>
                  <option value="drop">{copy.dropRequest}</option>
                </select>
              </label>
              <label>
                <span>Status</span>
                <input
                  type="number"
                  min={100}
                  max={599}
                  value={breakpointEditDraft.statusCode ?? ""}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) =>
                      current && { ...current, statusCode: event.target.value ? Number(event.target.value) : null },
                    )
                  }
                />
              </label>
              <label>
                <span>Method</span>
                <input
                  value={breakpointEditDraft.requestMethod}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) => current && { ...current, requestMethod: event.target.value })
                  }
                />
              </label>
              <label>
                <span>URL</span>
                <input
                  value={breakpointEditDraft.requestUrl}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) => current && { ...current, requestUrl: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Request Headers JSON</span>
                <textarea
                  value={breakpointEditDraft.requestHeadersText}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) =>
                      current && { ...current, requestHeadersText: event.target.value },
                    )
                  }
                />
              </label>
              <label>
                <span>Request Body</span>
                <textarea
                  value={breakpointEditDraft.requestBody}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) => current && { ...current, requestBody: event.target.value })
                  }
                />
              </label>
              <label>
                <span>Response Headers JSON</span>
                <textarea
                  value={breakpointEditDraft.responseHeadersText}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) =>
                      current && { ...current, responseHeadersText: event.target.value },
                    )
                  }
                />
              </label>
              <label>
                <span>Response Body</span>
                <textarea
                  value={breakpointEditDraft.responseBody}
                  onChange={(event) =>
                    setBreakpointEditDraft((current) => current && { ...current, responseBody: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="repeat-actions">
              <button type="button" className="icon-button" onClick={() => setBreakpointEditDraft(null)}>
                <X size={15} />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="icon-button primary"
                onClick={submitBreakpointEdit}
                disabled={busyAction !== null}
              >
                <Play size={15} />
                <span>{busyAction?.startsWith("breakpoint-") ? "Sending" : "Apply"}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {repeatDraft ? (
        <div className="inspector-modal-backdrop" onClick={() => setRepeatDraft(null)}>
          <section className="repeat-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>Edit & Repeat</h2>
                <div className="inspector-modal-hint">修改 method、URL、headers 或 body 后直接发送一次。</div>
              </div>
              <button type="button" className="inline-code-action" onClick={() => setRepeatDraft(null)}>
                <X size={13} />
                <span>关闭</span>
              </button>
            </div>
            <div className="repeat-form">
              <label>
                <span>Method</span>
                <input
                  value={repeatDraft.method}
                  onChange={(event) => setRepeatDraft((current) => current && { ...current, method: event.target.value })}
                />
              </label>
              <label>
                <span>URL</span>
                <input
                  value={repeatDraft.url}
                  onChange={(event) => setRepeatDraft((current) => current && { ...current, url: event.target.value })}
                />
              </label>
              <label>
                <span>Headers JSON</span>
                <textarea value={repeatHeadersText} onChange={(event) => setRepeatHeadersText(event.target.value)} />
              </label>
              <label>
                <span>Body</span>
                <textarea
                  value={repeatDraft.body}
                  onChange={(event) => setRepeatDraft((current) => current && { ...current, body: event.target.value })}
                />
              </label>
            </div>
            <div className="repeat-actions">
              <button type="button" className="icon-button" onClick={() => setRepeatDraft(null)}>
                <X size={15} />
                <span>Cancel</span>
              </button>
              <button type="button" className="icon-button primary" onClick={sendRepeatDraft} disabled={busyAction !== null}>
                <Play size={15} />
                <span>{busyAction?.startsWith("repeat-") ? "Sending" : "Send"}</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {expandedInspector ? (
        <div className="inspector-modal-backdrop" onClick={() => setExpandedInspector(null)}>
          <section className="inspector-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>{expandedInspector.title}</h2>
                {expandedInspector.requestLabel ? (
                  <div className="inspector-modal-request">
                    <strong>{expandedInspector.requestLabel}</strong>
                    {expandedInspector.requestSubtitle ? <span>{expandedInspector.requestSubtitle}</span> : null}
                  </div>
                ) : null}
                <div className="inspector-modal-hint">已按 {expandedInspector.language.toUpperCase()} 格式展示</div>
              </div>
              <div className="inspector-actions">
                <button
                  type="button"
                  className="inline-code-action"
                  onClick={() =>
                    copyAgentValue(
                      expandedInspector.content,
                      `expanded-inspector-${expandedInspector.title}-${expandedInspector.language}`,
                    )
                  }
                >
                  <Copy size={13} />
                  <span>
                    {copiedKey === `expanded-inspector-${expandedInspector.title}-${expandedInspector.language}`
                      ? "已复制"
                      : "复制"}
                  </span>
                </button>
                <button type="button" className="inline-code-action" onClick={() => setExpandedInspector(null)}>
                  <X size={13} />
                  <span>关闭</span>
                </button>
              </div>
            </div>
            <InspectorViewer
              title={expandedInspector.title}
              content={expandedInspector.content}
              language={expandedInspector.language}
              meta={expandedInspector.meta}
            />
          </section>
        </div>
      ) : null}
      {compareInspector ? (
        <div className="inspector-modal-backdrop" onClick={() => setCompareInspector(null)}>
          <section className="compare-modal" onClick={(event) => event.stopPropagation()}>
            <div className="inspector-modal-head">
              <div>
                <h2>传参与响应对比</h2>
                <div className="inspector-modal-hint">左侧是请求传参，右侧是响应内容。</div>
              </div>
              <button type="button" className="inline-code-action" onClick={() => setCompareInspector(null)}>
                <X size={13} />
                <span>关闭</span>
              </button>
            </div>
            <div className="compare-grid">
              <section>
                <h3>{compareInspector.request.title}</h3>
                <InspectorViewer
                  title={compareInspector.request.title}
                  content={compareInspector.request.content}
                  language={compareInspector.request.language}
                />
              </section>
              <section>
                <h3>{compareInspector.response.title}</h3>
                <InspectorViewer
                  title={compareInspector.response.title}
                  content={compareInspector.response.content}
                  language={compareInspector.response.language}
                />
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const MAX_AGENT_FLOWS = 14;
const MAX_BODY_CHARS = 1800;
const MAX_JSON_CONTEXT_NODES = 90;
const AI_TIMEOUT_MS = 60000;
const IDENTITY_KEY_PATTERN =
  /^(uid|user_id|userid|userId|account_id|accountId|account|username|user_name|email|phone|mobile|tenant_id|tenantId|id)$/;
const TEXT_CONTENT_PATTERN = /json|text|xml|graphql|javascript|event-stream/i;

function truncate(value = "", limit = MAX_BODY_CHARS) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function safeDate(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    return "";
  }
}

function isSameLocalDay(timestamp, reference = Date.now()) {
  const left = new Date(timestamp);
  const right = new Date(reference);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function bodyForContext(flow, direction) {
  const headers = direction === "response" ? flow.responseHeaders : flow.requestHeaders;
  const body = direction === "response" ? flow.responseBodyPreview : flow.requestBodyPreview;
  const contentType = String(headers?.["content-type"] || headers?.["Content-Type"] || "");
  if (!body) {
    return "";
  }
  const isRequestForm = direction === "request" && /form/i.test(contentType);
  if (!TEXT_CONTENT_PATTERN.test(contentType) && !isRequestForm && !/^[\s\r\n]*[\[{]/.test(body)) {
    return `[${direction} body omitted: non-text content ${contentType || "unknown"}]`;
  }
  const jsonSummary = body.length > MAX_BODY_CHARS ? summarizeJsonBodyForContext(body) : null;
  if (jsonSummary) {
    return jsonSummary;
  }
  return truncate(body);
}

function headersForContext(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers)
      .slice(0, 30)
      .map(([key, value]) => [key, truncate(value, 1600)]),
  );
}

function stripIrrelevantDisclaimer(content = "") {
  const text = String(content || "");
  if (/^\s*[\[{]/.test(text)) {
    return text.trim();
  }
  const blocks = text.split(/\n{2,}/);
  const disclaimerPattern = /免责声明|合规|严禁|禁止提供|不能提供|敏感信息|生产环境|泄露凭证|测试环境安全|确保.*安全/;
  const kept = blocks.filter((block) => {
    const trimmed = block.trim();
    if (!trimmed) {
      return false;
    }
    return !disclaimerPattern.test(trimmed);
  });
  return kept.join("\n\n").trim() || text.trim();
}

function extractJsonObject(text = "") {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function asText(value, limit = 3000) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
}

function normalizeStructuredAnswer(parsed, fallbackContent = "") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      summary: asText(fallbackContent),
      highlights: [],
      evidence: [],
      analysis: [],
    };
  }

  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights
        .map((item) => ({
          label: asText(item?.label, 80),
          value: asText(item?.value ?? item?.copyValue, 4000),
          kind: asText(item?.kind, 30) || "other",
          source: asText(item?.source, 220),
        }))
        .filter((item) => item.label && item.value)
        .slice(0, 12)
    : [];

  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence
        .map((item) => ({
          title: asText(item?.title, 140),
          time: asText(item?.time, 80),
          method: asText(item?.method, 20),
          status: item?.status ?? "",
          host: asText(item?.host, 180),
          path: asText(item?.path, 300),
          fields: Array.isArray(item?.fields)
            ? item.fields
                .map((field) => ({
                  label: asText(field?.label, 120),
                  value: asText(field?.value, 4000),
                }))
                .filter((field) => field.label && field.value)
                .slice(0, 12)
            : [],
        }))
        .slice(0, 8)
    : [];

  const analysis = Array.isArray(parsed.analysis)
    ? parsed.analysis.map((item) => asText(item, 500)).filter(Boolean).slice(0, 8)
    : [];
  const testCases = Array.isArray(parsed.testCases || parsed.test_cases)
    ? (parsed.testCases || parsed.test_cases)
        .map((item) => ({
          name: asText(item?.name || item?.title, 120),
          purpose: asText(item?.purpose, 500),
          method: asText(item?.method, 20),
          url: asText(item?.url, 1000),
          headers:
            item?.headers && typeof item.headers === "object" && !Array.isArray(item.headers)
              ? Object.fromEntries(
                  Object.entries(item.headers)
                    .map(([key, value]) => [key, asText(value, 1000)])
                    .filter(([key, value]) => key && value),
                )
              : undefined,
          query:
            item?.query && typeof item.query === "object" && !Array.isArray(item.query)
              ? item.query
              : undefined,
          body: item?.body,
          expected: asText(item?.expected, 800),
        }))
        .filter((item) => item.name)
        .slice(0, 5)
    : [];

  return {
    summary: asText(parsed.summary || parsed.answer || fallbackContent, 1000),
    highlights,
    evidence,
    analysis,
    testCases,
  };
}

function formatStructuredContent(answer) {
  const lines = [];
  if (answer.summary) {
    lines.push(answer.summary);
  }
  if (answer.highlights?.length) {
    lines.push(
      ["关键结果:", ...answer.highlights.map((item) => `${item.label}: ${item.value}`)].join("\n"),
    );
  }
  if (answer.evidence?.length) {
    lines.push(
      [
        "证据:",
        ...answer.evidence.map((item) => {
          const request = [item.method, item.status, item.host, item.path].filter(Boolean).join(" ");
          const fields = item.fields?.length
            ? ` fields=${item.fields.map((field) => `${field.label}:${field.value}`).join(", ")}`
            : "";
          return `- ${item.time || ""} ${request}${fields}`.trim();
        }),
      ].join("\n"),
    );
  }
  if (answer.analysis?.length) {
    lines.push(["分析:", ...answer.analysis.map((item) => `- ${item}`)].join("\n"));
  }
  if (answer.testCases?.length) {
    lines.push(
      [
        "接口测试用例:",
        ...answer.testCases.map((item) => {
          const target = [item.method, item.url].filter(Boolean).join(" ");
          const expected = item.expected ? ` expected=${item.expected}` : "";
          return `- ${item.name} ${target}${expected}`.trim();
        }),
      ].join("\n"),
    );
  }
  return lines.filter(Boolean).join("\n\n");
}

function summarizeFlow(flow) {
  const name = `${flow.method} ${flow.host}${flow.path}${flow.query || ""}`;
  return {
    id: flow.id,
    time: safeDate(flow.startedAt),
    method: flow.method,
    statusCode: flow.statusCode,
    name,
    host: flow.host,
    path: flow.path,
    query: flow.query,
    url: `${flow.scheme || "https"}://${flow.host}${flow.path}${flow.query || ""}`,
    durationMs: flow.durationMs,
    requestSize: flow.requestSize,
    responseSize: flow.responseSize,
    errorType: flow.errorType,
    tags: flow.tags,
    requestHeaders: headersForContext(flow.requestHeaders),
    responseHeaders: headersForContext(flow.responseHeaders),
    requestBody: bodyForContext(flow, "request"),
    responseBody: bodyForContext(flow, "response"),
  };
}

function tryParseJson(text) {
  if (!text || !/^[\s\r\n]*[\[{]/.test(text)) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonPrimitivePreview(value) {
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) {
    return truncate(String(value), 240);
  }
  return "";
}

function collectJsonContextNodes(value, path = "$", depth = 0, result = []) {
  if (result.length >= MAX_JSON_CONTEXT_NODES) {
    return result;
  }

  if (Array.isArray(value)) {
    result.push({ path, type: "array", length: value.length });
    if (depth < 3) {
      value.slice(0, 8).forEach((item, index) => collectJsonContextNodes(item, `${path}[${index}]`, depth + 1, result));
    }
    return result;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    result.push({
      path,
      type: "object",
      keyCount: keys.length,
      keys: keys.slice(0, 24),
    });
    if (depth < 3) {
      Object.entries(value)
        .slice(0, 28)
        .forEach(([key, item]) => collectJsonContextNodes(item, `${path}.${key}`, depth + 1, result));
    }
    return result;
  }

  result.push({
    path,
    type: value === null ? "null" : typeof value,
    value: jsonPrimitivePreview(value),
  });
  return result;
}

function summarizeJsonBodyForContext(body) {
  const parsed = tryParseJson(body);
  if (!parsed) {
    return null;
  }

  return JSON.stringify(
    {
      mode: "json_tree_summary",
      note:
        "Large JSON body summarized as a DevTools-like tree. Use nodes, key counts, lengths, and identityHints instead of assuming the body only contains the first raw characters.",
      originalPreviewChars: body.length,
      nodes: collectJsonContextNodes(parsed),
    },
    null,
    2,
  );
}

function collectIdentityHintsFromValue(value, path = "", result = []) {
  if (!value || result.length > 80) {
    return result;
  }
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((item, index) => collectIdentityHintsFromValue(item, `${path}[${index}]`, result));
    return result;
  }
  if (typeof value !== "object") {
    return result;
  }

  for (const [key, nextValue] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (IDENTITY_KEY_PATTERN.test(key) && ["string", "number", "boolean"].includes(typeof nextValue)) {
      result.push({
        field: nextPath,
        value: String(nextValue).slice(0, 240),
      });
    }
    if (nextValue && typeof nextValue === "object") {
      collectIdentityHintsFromValue(nextValue, nextPath, result);
    }
  }
  return result;
}

function extractIdentityHints(flow) {
  const bodies = [
    { source: "request", body: flow.requestBodyPreview },
    { source: "response", body: flow.responseBodyPreview },
  ];
  return bodies.flatMap(({ source, body }) => {
    const parsed = tryParseJson(body);
    if (!parsed) {
      return [];
    }
    return collectIdentityHintsFromValue(parsed).slice(0, 20).map((hint) => ({
      ...hint,
      source,
      flowId: flow.id,
      request: `${flow.method} ${flow.host}${flow.path}${flow.query || ""}`,
      statusCode: flow.statusCode,
      time: safeDate(flow.startedAt),
    }));
  });
}

function uniqueFlows(flows) {
  const seen = new Set();
  return flows.filter((flow) => {
    if (!flow?.id || seen.has(flow.id)) {
      return false;
    }
    seen.add(flow.id);
    return true;
  });
}

function questionTerms(question = "") {
  const text = String(question).toLowerCase();
  return {
    identity: /uid|user|用户|账号|账户|登录|login|account|current|profile|me/.test(text),
    failure: /报错|错误|失败|异常|error|fail|status|502|500|404|401|403/.test(text),
    slow: /慢|耗时|瓶颈|卡|timeout|slow|duration|latency/.test(text),
    today: /今天|今日|today/.test(text),
  };
}

function scoreFlowForQuestion(flow, question = "") {
  const terms = questionTerms(question);
  const haystack = `${flow.method} ${flow.host} ${flow.path} ${flow.query} ${flow.statusCode || ""}`.toLowerCase();
  const isStaticAsset = /\.(png|jpe?g|svg|gif|webp|css|js|woff2?|ttf|mp4|webm|mov|m4a|mp3)$/i.test(flow.path);
  let score = Number(flow.startedAt || 0) / 1000000000000;
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  const selected = tags.some((tag) => ["selected", "selected-by-user"].includes(String(tag)));

  if (selected || String(question || "").includes(String(flow.id || ""))) score += 10000;
  if (flow.path && String(question || "").toLowerCase().includes(String(flow.path).toLowerCase())) score += 800;
  if (flow.host && String(question || "").toLowerCase().includes(String(flow.host).toLowerCase())) score += 200;

  if (terms.identity && /current|login|auth|user|account|profile|session|me|entitlements/.test(haystack)) score += 120;
  if (terms.identity && extractIdentityHints(flow).length) score += 160;
  if (terms.failure && (flow.statusCode >= 400 || flow.errorType)) score += 180;
  if (terms.slow && Number(flow.durationMs || 0) > 1000) score += 120;
  if (terms.today && isSameLocalDay(flow.startedAt)) score += 40;
  if (/json|xhr|api/.test(haystack)) score += 20;
  if (isStaticAsset && !(flow.statusCode >= 400 || terms.slow)) score -= 120;
  if (flow.responseBodyPreview && /^[\s\r\n]*[\[{]/.test(flow.responseBodyPreview)) score += 45;
  if (flow.requestBodyPreview && /^[\s\r\n]*[\[{]/.test(flow.requestBodyPreview)) score += 35;

  return score;
}

function buildAgentContext(flows = [], question = "") {
  const sorted = flows
    .slice()
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
  const todayFlows = sorted.filter((flow) => isSameLocalDay(flow.startedAt));
  const failedFlows = sorted.filter((flow) => flow.statusCode >= 400 || flow.errorType);
  const slowFlows = sorted.filter((flow) => Number(flow.durationMs || 0) > 1000);
  const rankedFlows = sorted
    .map((flow) => ({ flow, score: scoreFlowForQuestion(flow, question) }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.flow);
  const selected = uniqueFlows([
    ...rankedFlows,
    ...failedFlows,
    ...slowFlows,
    ...todayFlows.slice(0, 20),
    ...sorted.slice(0, 20),
  ]).slice(0, MAX_AGENT_FLOWS);

  return {
    generatedAt: new Date().toISOString(),
    scope:
      "当前上下文只包含本次应用内存中的抓包会话。用户说“今天”时，优先使用 startedAt 属于本地今天的请求；如果没有历史持久化数据，不要声称覆盖浏览器外的全部历史。",
    totals: {
      all: flows.length,
      today: todayFlows.length,
      failed: failedFlows.length,
      failedToday: todayFlows.filter((flow) => flow.statusCode >= 400 || flow.errorType).length,
      slow: slowFlows.length,
      slowToday: todayFlows.filter((flow) => Number(flow.durationMs || 0) > 1000).length,
    },
    identityHints: selected.flatMap(extractIdentityHints).slice(0, 80),
    flows: selected.map(summarizeFlow),
  };
}

function normalizeHistory(history = []) {
  return history
    .filter((item) => ["user", "assistant"].includes(item?.role) && item.content)
    .slice(-4)
    .map((item) => ({
      role: item.role,
      content: String(item.content).slice(0, 1000),
    }));
}

function buildUserContent(question, context, attachments = []) {
  const prompt = `用户问题：${question}\n\n抓包上下文：\n${JSON.stringify(context, null, 2)}`;
  const images = attachments
    .filter((item) => item?.dataUrl && String(item.type || "").startsWith("image/"))
    .slice(0, 4);

  if (!images.length) {
    return prompt;
  }

  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
      },
    })),
  ];
}

class QwenClient {
  constructor({ apiKey, baseUrl, model, visionModel }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.visionModel = visionModel || "qwen3-vl-plus";
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new Error("QWEN_API_KEY is not configured. Add it to .env.local.");
    }
  }

  async chat(messages, options = {}) {
    this.assertConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || AI_TIMEOUT_MS);
    let response;

    try {
      const model = options.model || this.model;
      const body = {
        model,
        messages,
        temperature: options.temperature ?? 0.2,
      };
      if (options.enableThinking !== undefined) {
        body.enable_thinking = options.enableThinking;
      }

      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Qwen request timed out. Try narrowing the question or clearing unrelated captures.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Qwen request failed: ${response.status} ${bodyText}`);
    }

    const payload = JSON.parse(bodyText);
    return {
      model: payload.model || this.model,
      content: stripIrrelevantDisclaimer(payload.choices?.[0]?.message?.content || ""),
      usage: payload.usage || null,
    };
  }

  async testConnection() {
    const result = await this.chat(
      [
        {
          role: "system",
          content: "You are a concise diagnostics assistant.",
        },
        {
          role: "user",
          content: "Reply with one short Chinese sentence confirming the Qwen connection works.",
        },
      ],
      { temperature: 0, enableThinking: false },
    );

    return {
      ok: true,
      model: result.model,
      message: result.content,
      usage: result.usage,
    };
  }

  async analyzeFailures(flows) {
    const relevantFlows = (flows || [])
      .filter((flow) => flow.statusCode >= 400 || flow.errorType || flow.durationMs > 1000)
      .slice(0, 30);

    if (!relevantFlows.length) {
      return {
        model: this.model,
        content: "当前会话没有明显失败请求或慢请求。",
        usage: null,
      };
    }

    return this.chat(
      [
        {
          role: "system",
          content:
            "你是面向开发和测试团队的本地抓包调试 Agent。你需要基于抓包流量给出简洁、证据明确、可复现的诊断结论。不要编造不存在的字段，不要输出与抓包证据无关的免责声明。",
        },
        {
          role: "user",
          content: `请分析这些失败或慢请求，输出：1. 主要结论 2. 证据请求 3. 可能原因 4. 建议下一步。\n\n${JSON.stringify(
            relevantFlows,
            null,
            2,
          )}`,
        },
      ],
      { enableThinking: false },
    );
  }

  async compareFlows(left, right) {
    return this.chat(
      [
        {
          role: "system",
          content:
            "你是 HTTP 请求差异分析助手。请比较两个抓包请求的关键差异，重点关注 method、url、headers、query、body、status、response 和 timing。",
        },
        {
          role: "user",
          content: `请比较这两个请求，指出可能导致行为不同的差异。\n\nA:\n${JSON.stringify(
            left,
            null,
            2,
          )}\n\nB:\n${JSON.stringify(right, null, 2)}`,
        },
      ],
      { enableThinking: false },
    );
  }

  async generateBugReport(flows, note) {
    const relevantFlows = (flows || [])
      .filter((flow) => flow.statusCode >= 400 || flow.errorType || flow.tags?.includes("selected"))
      .slice(0, 20);

    return this.chat(
      [
        {
          role: "system",
          content:
            "你是 QA 缺陷报告助手。请把本地抓包证据整理成 Markdown 缺陷报告，包含标题、摘要、环境、复现步骤、实际结果、期望结果、关键请求、初步判断。不要输出与抓包证据无关的免责声明，不要编造不存在的字段。",
        },
        {
          role: "user",
          content: `补充说明：${note || "无"}\n\n抓包请求：\n${JSON.stringify(relevantFlows, null, 2)}`,
        },
      ],
      { enableThinking: false },
    );
  }

  async askAgent({ question, flows = [], history = [], attachments = [] }) {
    const trimmedQuestion = String(question || "").trim();
    if (!trimmedQuestion) {
      return {
        model: this.model,
        content: "请输入你想分析的问题，例如“帮我找一下最新登录账号的 uid”。",
        usage: null,
      };
    }

    const hasImages = attachments.some((item) => item?.dataUrl && String(item.type || "").startsWith("image/"));
    const context = buildAgentContext(flows, trimmedQuestion);
    const result = await this.chat(
      [
        {
          role: "system",
          content:
            "你是 HeavenEye Agent（天眼抓包 Agent），一个运行在用户本机、面向研发和测试的抓包调试助手。你的职责是替代用户手动翻浏览器 F12 Network：只基于本地抓包上下文和图片证据回答，不要编造，不要输出与抓包证据无关的免责声明、合规说明、风险提醒或注意事项。用户询问账号、uid、token、header、cookie、报错接口、慢接口时，如果抓包上下文中真实存在对应字段，就按字段原文和证据接口列出；如果上下文不足，就明确说明还没有捕获到哪些接口。用户要求接口测试时，先基于真实 request 参数、headers、body 和 response 设计低风险用例，再把可执行的参数变体放入 testCases；每个用例必须相对原请求可发送，不要生成破坏性、扣费、删除、批量写入类用例。必须返回严格 JSON，不要 Markdown，不要代码块。JSON 结构为：{\"summary\":\"一句话结论，优先回答用户最关心的问题\",\"highlights\":[{\"label\":\"账号|密码|Token|UID|报错接口|慢接口等\",\"value\":\"可复制的核心值\",\"kind\":\"uid|account|password|token|error|url|field|status|time|other\",\"source\":\"字段来源，如 requestBody.email 或 responseBody.data.token\"}],\"evidence\":[{\"title\":\"证据名称\",\"time\":\"请求时间\",\"method\":\"GET/POST\",\"status\":200,\"host\":\"域名\",\"path\":\"路径和 query\",\"fields\":[{\"label\":\"字段路径\",\"value\":\"字段值\"}]}],\"analysis\":[\"简短分析或下一步\"],\"testCases\":[{\"name\":\"用例名\",\"purpose\":\"为什么测\",\"method\":\"GET/POST，可省略则沿用原请求\",\"url\":\"完整 URL，可省略则沿用原请求\",\"headers\":{\"x-demo\":\"value，可省略\"},\"query\":{\"key\":\"value，可省略\"},\"body\":{\"字段\":\"值；可省略或字符串\"},\"expected\":\"预期状态/字段/行为\"}]}。非接口测试问题不要返回 testCases，接口测试最多 5 个用例。",
        },
        ...normalizeHistory(history),
        {
          role: "user",
          content: buildUserContent(trimmedQuestion, context, attachments),
        },
      ],
      {
        model: hasImages ? this.visionModel : this.model,
        temperature: 0.1,
        enableThinking: false,
      },
    );

    const parsed = extractJsonObject(result.content);
    const structured = parsed ? normalizeStructuredAnswer(parsed, result.content) : null;
    return {
      ...result,
      content: structured ? formatStructuredContent(structured) : result.content,
      structured,
    };
  }
}

module.exports = { QwenClient };

const MAX_AGENT_FLOWS = 8;
const MAX_BODY_CHARS = 1000;
const MAX_JSON_CONTEXT_NODES = 48;
const MAX_EVIDENCE_CANDIDATES = 10;
const MAX_AGENT_SEARCH_FLOWS = 100;
const SEARCH_BATCH_SIZE = 10;
const MAX_SEARCH_BATCHES = 10;
const MAX_FINAL_CONTEXT_FLOWS = 4;
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
      .slice(0, 20)
      .map(([key, value]) => [key, truncate(value, 800)]),
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

function normalizeSearchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./?=&:-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowSignalTerm(term) {
  return [
    "这个",
    "这条",
    "当前",
    "刚才",
    "上面",
    "下面",
    "这里",
    "这页",
    "截图",
    "页面",
    "接口",
    "请求",
    "数据",
    "问题",
    "帮我",
    "一下",
    "this",
    "that",
    "current",
    "page",
    "request",
    "api",
  ].includes(term);
}

function pushSearchTerm(terms, seen, value) {
  const term = normalizeSearchText(value);
  if (term.length < 2 || isLowSignalTerm(term)) return;
  if (/^\d+$/.test(term) && term.length < 3) return;
  if (!seen.has(term)) {
    seen.add(term);
    terms.push(term);
  }
}

function tokenizeSearchText(value, terms, seen) {
  normalizeSearchText(value)
    .split(/\s+/)
    .filter(Boolean)
    .forEach((token) => pushSearchTerm(terms, seen, token));

  [
    "自动布局",
    "固定布局",
    "layout_key",
    "layer_config",
    "template_id",
    "task_id",
    "uid",
    "登录",
    "账号",
    "上传",
    "上传文件",
    "文件上传",
    "upload",
    "file upload",
    "报错",
    "失败",
    "eventstream",
    "text/event-stream",
  ].forEach((phrase) => {
    if (String(value || "").toLowerCase().includes(phrase.toLowerCase())) {
      pushSearchTerm(terms, seen, phrase);
    }
  });
}

function parseStringList(parsed, keys, maxItems = 40) {
  const result = [];
  const seen = new Set();
  keys.forEach((key) => {
    if (!Array.isArray(parsed?.[key])) return;
    parsed[key].forEach((item) => {
      if (typeof item !== "string" || result.length >= maxItems) return;
      pushSearchTerm(result, seen, item);
    });
  });
  return result;
}

function parseVisualSearchProfile(content = "") {
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const intent = typeof parsed.intent === "string" ? parsed.intent : typeof parsed.userIntent === "string" ? parsed.userIntent : "";
  const terms = parseStringList(parsed, ["terms", "keywords", "businessTerms"], 40);
  const phrases = parseStringList(parsed, ["phrases", "exactPhrases"], 20);
  const domains = parseStringList(parsed, ["domains", "hosts"], 12);
  const paths = parseStringList(parsed, ["paths", "pathFragments", "endpoints"], 20);
  const fields = parseStringList(parsed, ["fields", "fieldNames", "jsonPaths"], 24);
  const searchIn = parseStringList(parsed, ["searchIn", "sections"], 12);
  const excludeTerms = parseStringList(parsed, ["excludeTerms", "excludes"], 20);
  const methods = parseStringList(parsed, ["methods", "method"], 8)
    .map((method) => method.toUpperCase())
    .filter((method) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method));
  const statusCodes = Array.isArray(parsed.statusCodes || parsed.statuses)
    ? (parsed.statusCodes || parsed.statuses)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 100 && value <= 599)
        .slice(0, 12)
    : [];
  const seen = new Set(terms);
  [summary, intent, phrases.join(" "), domains.join(" "), paths.join(" "), fields.join(" ")].forEach((value) =>
    tokenizeSearchText(value, terms, seen),
  );
  return terms.length || summary || intent
    ? {
        summary,
        intent,
        terms: terms.slice(0, 60),
        phrases,
        domains,
        paths,
        fields,
        methods,
        statusCodes,
        searchIn,
        excludeTerms,
        wantsLatest: parsed.wantsLatest ?? parsed.latest ?? true,
      }
    : null;
}

function buildTextSearchProfile(question = "", historyText = "") {
  const terms = [];
  const seen = new Set();
  tokenizeSearchText(question, terms, seen);
  tokenizeSearchText(historyText, terms, seen);
  return {
    summary: "",
    intent: truncate(question, 300),
    terms: terms.slice(0, 60),
    phrases: [],
    domains: [],
    paths: [],
    fields: [],
    methods: [],
    statusCodes: [],
    searchIn: [],
    excludeTerms: [],
    wantsLatest: true,
  };
}

function appendProfileTerms(profile, newTerms = []) {
  const seen = new Set(profile.terms || []);
  newTerms.forEach((term) => pushSearchTerm(profile.terms, seen, term));
  profile.terms = (profile.terms || []).slice(0, 80);
}

function profileTerms(profile = {}) {
  const terms = [];
  const seen = new Set();
  [
    profile.intent || "",
    profile.summary || "",
    (profile.terms || []).join(" "),
    (profile.phrases || []).join(" "),
    (profile.domains || []).join(" "),
    (profile.paths || []).join(" "),
    (profile.fields || []).join(" "),
  ].forEach((value) => tokenizeSearchText(value, terms, seen));
  return terms.slice(0, 80);
}

function profileValue(profile = {}) {
  return {
    intent: profile.intent || "",
    summary: profile.summary || "",
    terms: profile.terms || [],
    phrases: profile.phrases || [],
    domains: profile.domains || [],
    paths: profile.paths || [],
    fields: profile.fields || [],
    methods: profile.methods || [],
    statusCodes: profile.statusCodes || [],
    searchIn: profile.searchIn || [],
    excludeTerms: profile.excludeTerms || [],
    wantsLatest: profile.wantsLatest !== false,
  };
}

function historySearchText(history = []) {
  return history
    .filter((item) => ["user", "assistant"].includes(item?.role) && item.content)
    .slice(-6)
    .map((item) => truncate(item.content, 500))
    .join("\n");
}

function buildEvidenceSearchTerms(question = "", historyText = "", profile = null) {
  const terms = [];
  const seen = new Set();
  tokenizeSearchText(question, terms, seen);
  tokenizeSearchText(historyText, terms, seen);
  if (profile) {
    (profile.terms || []).forEach((term) => pushSearchTerm(terms, seen, term));
    [
      profile.intent || "",
      profile.summary || "",
      (profile.phrases || []).join(" "),
      (profile.domains || []).join(" "),
      (profile.paths || []).join(" "),
      (profile.fields || []).join(" "),
    ].forEach((value) => tokenizeSearchText(value, terms, seen));
  }
  return terms.slice(0, 60);
}

function flowSectionText(flow, section) {
  if (section === "host") return normalizeSearchText(flow.host);
  if (section === "path") return normalizeSearchText(flow.path);
  if (section === "query") return normalizeSearchText(flow.query);
  if (section === "headers") return normalizeSearchText(`${JSON.stringify(flow.requestHeaders || {})} ${JSON.stringify(flow.responseHeaders || {})}`);
  if (section === "body") return normalizeSearchText(`${truncate(flow.requestBodyPreview || "", 3000)} ${truncate(flow.responseBodyPreview || "", 3000)}`);
  return normalizeSearchText(`${flow.method} ${flow.host} ${flow.path} ${flow.query} ${flow.errorType || ""}`);
}

function flowHeaderValue(headers = {}, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? String(found[1] || "") : "";
}

function flowUrl(flow = {}) {
  return `${flow.scheme || "https"}://${flow.host || ""}${flow.path || ""}${flow.query || ""}`;
}

function flowSseText(flow = {}) {
  return (flow.sseEvents || [])
    .slice(0, 16)
    .map((event) => `event:${event.event || ""} id:${event.id || ""} data:${truncate(event.data || "", 500)}`)
    .join("\n");
}

function searchSections(flow) {
  return [
    ["url", flowUrl(flow), 54],
    ["methodStatus", `${flow.method || ""} ${flow.statusCode || ""} ${flow.errorType || ""}`, 26],
    ["host", flow.host || "", 46],
    ["path", `${flow.path || ""}${flow.query || ""}`, 62],
    ["requestHeaders", JSON.stringify(flow.requestHeaders || {}), 22],
    ["responseHeaders", JSON.stringify(flow.responseHeaders || {}), 18],
    ["requestBody", truncate(flow.requestBodyPreview || "", 2500), 44],
    ["responseBody", truncate(flow.responseBodyPreview || "", 2500), 34],
    ["sse", flowSseText(flow), 42],
  ];
}

function compactText(value = "", limit = 320) {
  return truncate(String(value || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim(), limit);
}

function searchSnippets(flow, terms = [], maxItems = 5) {
  const effectiveTerms = terms.length ? terms : normalizeSearchText(`${flow.host || ""} ${flow.path || ""} ${flow.query || ""}`).split(/\s+/);
  const snippets = [];
  searchSections(flow).forEach(([section, text]) => {
    if (snippets.length >= maxItems || !String(text || "").trim()) return;
    const normalized = normalizeSearchText(text);
    const matched = effectiveTerms.find((term) => term.length >= 2 && normalized.includes(term));
    if (matched) {
      snippets.push({ section, term: matched, text: compactText(text) });
    }
  });
  return snippets;
}

function isStaticOrMediaFlow(flow = {}) {
  const path = String(flow.path || "").toLowerCase();
  const responseType = flowHeaderValue(flow.responseHeaders, "content-type").toLowerCase();
  return (
    /\.(png|jpe?g|svg|gif|webp|css|js|woff2?|ttf|mp4|webm|mov|m4a|mp3)$/i.test(path) ||
    responseType.startsWith("image/") ||
    responseType.startsWith("video/") ||
    responseType.includes("font")
  );
}

function isStaticResourceIntent(question = "", profile = {}) {
  const text = normalizeSearchText(`${question} ${profile.intent || ""} ${profile.summary || ""} ${(profile.terms || []).join(" ")}`);
  if (isUploadQuestion(text) || /提交|创建|保存/.test(text)) return false;
  return /图片|视频|封面|头像|静态资源|image|video|cover|avatar|asset|resource/.test(text);
}

function rankSearchCandidates(flows = [], question = "", historyText = "", profile = {}, hasImages = false, seen = new Set()) {
  const pool = flows
    .slice()
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
    .slice(0, MAX_AGENT_SEARCH_FLOWS);
  const terms = buildEvidenceSearchTerms(question, historyText, profile);
  profileTerms(profile).forEach((term) => {
    if (!terms.includes(term)) terms.push(term);
  });
  terms.splice(90);
  const staticResourceIntent = isStaticResourceIntent(question, profile);

  return pool
    .filter((flow) => !seen.has(flow.id))
    .map((flow) => {
      const match = matchFlowAgainstTerms(flow, terms, question);
      let score = match.score;
      const reasons = [...match.reasons];
      const normalizedUrl = normalizeSearchText(flowUrl(flow));
      const normalizedHeaders = flowSectionText(flow, "headers");
      const normalizedBody = flowSectionText(flow, "body");

      (profile.domains || []).forEach((domain) => {
        if (normalizeSearchText(flow.host || "").includes(domain) || normalizedUrl.includes(domain)) {
          score += 90;
          reasons.push(`domain matched \`${domain}\``);
        }
      });
      (profile.paths || []).forEach((path) => {
        if (normalizedUrl.includes(path)) {
          score += 120;
          reasons.push(`path matched \`${path}\``);
        }
      });
      (profile.phrases || []).forEach((phrase) => {
        if (normalizedUrl.includes(phrase) || normalizedHeaders.includes(phrase) || normalizedBody.includes(phrase)) {
          score += 85;
          reasons.push(`phrase matched \`${phrase}\``);
        }
      });
      (profile.fields || []).forEach((field) => {
        if (normalizedHeaders.includes(field) || normalizedBody.includes(field)) {
          score += 76;
          reasons.push(`field matched \`${field}\``);
        }
      });
      if ((profile.methods || []).some((method) => method.toUpperCase() === String(flow.method || "").toUpperCase())) {
        score += 48;
        reasons.push("method matched intent");
      }
      if ((profile.statusCodes || []).includes(Number(flow.statusCode))) {
        score += 42;
        reasons.push("status matched intent");
      }
      (profile.excludeTerms || []).forEach((term) => {
        if (normalizedUrl.includes(term) || normalizedHeaders.includes(term) || normalizedBody.includes(term)) {
          score -= 70;
          reasons.push(`excluded term \`${term}\``);
        }
      });
      if (hasImages && score <= 0 && !isStaticOrMediaFlow(flow)) {
        score = 0.5;
        reasons.push("recent fallback within screenshot search window");
      }
      if (!terms.length && score <= 0) {
        score = 0.4;
        reasons.push("recent fallback without extracted terms");
      }
      if (isStaticOrMediaFlow(flow) && !staticResourceIntent) {
        score -= 160;
        reasons.push("static/media resource downranked");
      }
      if (profile.wantsLatest !== false) {
        score += Number(flow.startedAt || 0) / 1000000000000;
      }
      return { flow, score, reasons, snippets: searchSnippets(flow, terms) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.flow.startedAt || 0) - Number(left.flow.startedAt || 0));
}

function nextSearchBatch(flows, question, historyText, profile, hasImages, seen, limit = SEARCH_BATCH_SIZE) {
  return rankSearchCandidates(flows, question, historyText, profile, hasImages, seen).slice(0, limit);
}

function candidateCard(candidate, rank) {
  const flow = candidate.flow;
  return {
    rank,
    score: Math.round(candidate.score * 10) / 10,
    matchReasons: candidate.reasons.slice(0, 10),
    snippets: candidate.snippets,
    flow: {
      id: flow.id,
      time: safeDate(flow.startedAt),
      method: flow.method,
      statusCode: flow.statusCode,
      host: flow.host,
      path: flow.path,
      query: flow.query,
      url: flowUrl(flow),
      durationMs: flow.durationMs,
      requestContentType: flowHeaderValue(flow.requestHeaders, "content-type"),
      responseContentType: flowHeaderValue(flow.responseHeaders, "content-type"),
      requestSize: flow.requestSize,
      responseSize: flow.responseSize,
      errorType: flow.errorType,
      tags: flow.tags,
      isSse: isSseFlow(flow),
      isStaticOrMedia: isStaticOrMediaFlow(flow),
    },
  };
}

function isUploadQuestion(question = "") {
  return /上传|上传文件|文件上传|传文件|upload|file upload|attachment|multipart/i.test(String(question || ""));
}

function isUploadFlow(flow = {}) {
  const method = String(flow.method || "").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) return false;
  const contentType = String(flow.requestHeaders?.["content-type"] || flow.requestHeaders?.["Content-Type"] || "").toLowerCase();
  const haystack = normalizeSearchText(
    `${flow.host || ""} ${flow.path || ""} ${flow.query || ""} ${contentType} ${truncate(flow.requestBodyPreview || "", 500)} ${truncate(flow.responseBodyPreview || "", 500)}`,
  );
  return (
    contentType.includes("multipart") ||
    contentType.includes("octet-stream") ||
    /upload|file|files|attachment|material|avatar|image|cover|media|object|oss|cos|s3/.test(haystack)
  );
}

function matchFlowAgainstTerms(flow, terms, question = "") {
  const sections = [
    ["path", 36],
    ["query", 30],
    ["host", 28],
    ["body", 16],
    ["headers", 12],
    ["meta", 10],
  ];
  let score = 0;
  const reasons = [];
  terms.forEach((term) => {
    let best = null;
    sections.forEach(([section, weight]) => {
      if (flowSectionText(flow, section).includes(term) && (!best || weight > best.weight)) {
        best = { section, weight };
      }
    });
    if (best) {
      score += best.weight;
      if (reasons.length < 12) reasons.push(`${best.section} matched \`${term}\``);
    }
  });

  const termsByQuestion = questionTerms(question);
  const haystack = normalizeSearchText(`${flow.host} ${flow.path} ${flow.query} ${flow.errorType || ""}`);
  if (termsByQuestion.identity && /(account|user|login)/.test(haystack)) {
    score += 18;
    reasons.push("identity intent matched account/user/login endpoint");
  }
  if (termsByQuestion.failure && (flow.statusCode >= 400 || flow.errorType)) {
    score += 24;
    reasons.push("failure intent matched failing request");
  }
  if (termsByQuestion.slow && Number(flow.durationMs || 0) > 1000) {
    score += 18;
    reasons.push("slow intent matched high duration");
  }
  if (termsByQuestion.streaming && isSseFlow(flow)) {
    score += 80;
    reasons.push("streaming intent matched SSE/EventStream");
  }
  if (isUploadQuestion(question) && isUploadFlow(flow)) {
    score += 120;
    reasons.push("upload intent matched file-like request");
  }
  if ((Array.isArray(flow.tags) ? flow.tags : []).some((tag) => ["selected", "selected-by-user"].includes(String(tag))) || String(question).includes(String(flow.id || ""))) {
    score += 10000;
    reasons.push("explicitly targeted by user");
  }
  if (/json|xhr|api/.test(haystack)) score += 4;
  return { score, reasons };
}

function retrieveEvidenceCandidates(flows = [], question = "", historyText = "", profile = null, hasImages = false) {
  const terms = buildEvidenceSearchTerms(question, historyText, profile);
  const candidates = flows
    .map((flow) => {
      const match = matchFlowAgainstTerms(flow, terms, question);
      return { flow, ...match, snippets: searchSnippets(flow, terms) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.flow.startedAt || 0) - Number(left.flow.startedAt || 0));

  const seen = new Set(candidates.map((candidate) => candidate.flow.id));
  if (hasImages && candidates.length < MAX_EVIDENCE_CANDIDATES) {
    flows
      .slice()
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))
      .forEach((flow) => {
        if (candidates.length >= MAX_EVIDENCE_CANDIDATES || seen.has(flow.id)) return;
        const path = String(flow.path || "").toLowerCase();
        if (/\.(png|jpe?g|svg|gif|webp|css|js|woff2?|ttf)$/i.test(path)) return;
        seen.add(flow.id);
        candidates.push({ flow, score: 1, reasons: ["recent fallback for screenshot matching"], snippets: [] });
      });
  }

  return candidates.slice(0, MAX_EVIDENCE_CANDIDATES);
}

function evidenceCandidateValue(candidate, index) {
  return {
    rank: index + 1,
    score: Math.round(candidate.score * 10) / 10,
    matchReasons: candidate.reasons,
    snippets: candidate.snippets,
    flow: summarizeFlow(candidate.flow),
  };
}

function parseSearchBatchDecision(content = "", candidates = []) {
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidateIds = new Set(candidates.map((item) => item?.flow?.id).filter(Boolean));
  const selected = parsed.selectedFlowId || parsed.selected_flow_id || parsed.flowId || null;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
  return {
    selectedFlowId: selected && candidateIds.has(selected) ? selected : null,
    confidence,
    sufficient: Boolean(parsed.sufficient ?? (selected && confidence >= 0.72)),
    reason: asText(parsed.reason, 300),
    refineTerms: Array.isArray(parsed.refineTerms || parsed.refine_terms)
      ? (parsed.refineTerms || parsed.refine_terms).map((item) => normalizeSearchText(item)).filter(Boolean).slice(0, 12)
      : [],
  };
}

function heuristicBatchDecision(batch = []) {
  const best = batch[0];
  if (!best) return { selectedFlowId: null, confidence: 0, sufficient: false, reason: "no candidates", refineTerms: [] };
  const sufficient = best.score >= 180;
  return {
    selectedFlowId: sufficient ? best.flow.id : null,
    confidence: sufficient ? 0.74 : 0,
    sufficient,
    reason: sufficient ? `fallback selected highest scoring candidate (${best.score.toFixed(1)})` : "fallback found no strong candidate",
    refineTerms: [],
  };
}

function buildFinalAgentContext(flows = [], question = "", historyText = "", hasImages = false, profile = {}, resolution = {}) {
  const sorted = flows.slice().sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
  const focusedFlow = flows.find((flow) => (flow.tags || []).some((tag) => ["selected", "selected-by-user"].includes(String(tag))));
  const selectedFlow = flows.find((flow) => flow.id === resolution.selectedFlowId);
  const related = [];
  const relatedSeen = new Set();
  if (selectedFlow) {
    related.push(summarizeFlow(selectedFlow));
    relatedSeen.add(selectedFlow.id);
  }
  (resolution.batches || []).some((batch) => {
    (batch.candidates || []).some((candidate) => {
      if (related.length >= MAX_FINAL_CONTEXT_FLOWS) return true;
      const id = candidate?.flow?.id;
      if (!id || relatedSeen.has(id)) return false;
      const flow = flows.find((item) => item.id === id);
      if (flow) {
        related.push(summarizeFlow(flow));
        relatedSeen.add(id);
      }
      return false;
    });
    return related.length >= MAX_FINAL_CONTEXT_FLOWS;
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: "当前上下文只包含本次应用内存中的抓包会话；隐藏搜索器最多检查最近 100 条请求，每批 10 条。",
    question,
    hasScreenshot: hasImages,
    historyContext: truncate(historyText, 1200),
    focusedFlow: focusedFlow ? summarizeFlow(focusedFlow) : null,
    searchIntent: profileValue(profile),
    searchResult: {
      selectedFlowId: resolution.selectedFlowId || null,
      selectedConfidence: resolution.selectedConfidence || 0,
      searchedCount: resolution.searchedCount || 0,
      stoppedReason: resolution.stoppedReason || "",
      batches: resolution.batches || [],
    },
    selectedFlow: selectedFlow ? summarizeFlow(selectedFlow) : null,
    relatedFlowDetails: related,
    identityHints: selectedFlow ? extractIdentityHints(selectedFlow).slice(0, 40) : [],
    totals: {
      allPassedToAgent: flows.length,
      searchedWindow: Math.min(sorted.length, MAX_AGENT_SEARCH_FLOWS),
      failed: sorted.filter((flow) => flow.statusCode >= 400 || flow.errorType).length,
      slow: sorted.filter((flow) => Number(flow.durationMs || 0) > 1000).length,
      sse: sorted.filter(isSseFlow).length,
      today: sorted.filter((flow) => isSameLocalDay(flow.startedAt)).length,
    },
  };
}

function buildFinalUserContent(question, context) {
  return `用户问题：${question}\n\n隐藏搜索器已经完成截图/文字意图提取、候选检索和分批判断。请只基于下面上下文回答，不要重新假设当前选中接口。\n\n${JSON.stringify(context, null, 2)}`;
}

function questionTerms(question = "") {
  const text = String(question).toLowerCase();
  return {
    identity: /uid|user|用户|账号|账户|登录|login|account|current|profile|me/.test(text),
    failure: /报错|错误|失败|异常|error|fail|status|502|500|404|401|403/.test(text),
    slow: /慢|耗时|瓶颈|卡|timeout|slow|duration|latency/.test(text),
    today: /今天|今日|today/.test(text),
    streaming: /sse|eventstream|event stream|server-sent|server sent|text\/event-stream|stream|流式|事件流/.test(text),
  };
}

function isSseFlow(flow) {
  const tags = Array.isArray(flow.tags) ? flow.tags : [];
  const responseType = String(flow.responseHeaders?.["content-type"] || flow.responseHeaders?.["Content-Type"] || "").toLowerCase();
  const accept = String(flow.requestHeaders?.accept || flow.requestHeaders?.Accept || "").toLowerCase();
  return (
    tags.some((tag) => ["sse", "streaming-response"].includes(String(tag))) ||
    responseType.includes("text/event-stream") ||
    accept.includes("text/event-stream") ||
    String(flow.responseBodyPreview || "").startsWith("data:") ||
    String(flow.responseBodyPreview || "").includes("\ndata:")
  );
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
  if (terms.streaming && isSseFlow(flow)) score += 1200;
  if (isUploadQuestion(question) && isUploadFlow(flow)) score += 260;
  if (terms.today && isSameLocalDay(flow.startedAt)) score += 40;
  if (/json|xhr|api/.test(haystack)) score += 20;
  if (isStaticAsset && !(flow.statusCode >= 400 || terms.slow)) score -= 120;
  if (flow.responseBodyPreview && /^[\s\r\n]*[\[{]/.test(flow.responseBodyPreview)) score += 45;
  if (flow.requestBodyPreview && /^[\s\r\n]*[\[{]/.test(flow.requestBodyPreview)) score += 35;

  return score;
}

function summarizeFlowIndex(flow) {
  return {
    id: flow.id,
    time: safeDate(flow.startedAt),
    method: flow.method,
    statusCode: flow.statusCode,
    host: flow.host,
    path: flow.path,
    query: flow.query,
    url: `${flow.scheme || "https"}://${flow.host}${flow.path}${flow.query || ""}`,
    durationMs: flow.durationMs,
    tags: flow.tags,
  };
}

function buildAgentContext(flows = [], question = "", options = {}) {
  const sorted = flows
    .slice()
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
  const todayFlows = sorted.filter((flow) => isSameLocalDay(flow.startedAt));
  const failedFlows = sorted.filter((flow) => flow.statusCode >= 400 || flow.errorType);
  const slowFlows = sorted.filter((flow) => Number(flow.durationMs || 0) > 1000);
  const sseFlows = sorted.filter(isSseFlow);
  const hasImages = Boolean(options.hasImages);
  const historyText = options.historyText || "";
  const visualProfile = options.visualProfile || null;
  const evidenceCandidates = retrieveEvidenceCandidates(flows, question, historyText, visualProfile, hasImages);
  const rankedFlows = sorted
    .map((flow) => ({ flow, score: scoreFlowForQuestion(flow, question) }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.flow);
  const terms = questionTerms(question);
  const selected = uniqueFlows([
    ...evidenceCandidates.map((candidate) => candidate.flow),
    ...rankedFlows,
    ...(terms.streaming ? sseFlows : []),
    ...failedFlows,
    ...slowFlows,
    ...todayFlows.slice(0, 20),
    ...sorted.slice(0, 20),
  ]).slice(0, MAX_AGENT_FLOWS);
  const focusedFlow = selected.find((flow) =>
    (Array.isArray(flow.tags) ? flow.tags : []).some((tag) => ["selected", "selected-by-user"].includes(String(tag))),
  );
  const recentLimit = hasImages ? 24 : 32;
  const searchTerms = buildEvidenceSearchTerms(question, historyText, visualProfile);

  return {
    generatedAt: new Date().toISOString(),
    scope:
      "当前上下文只包含本次应用内存中的抓包会话。用户说“今天”时，优先使用 startedAt 属于本地今天的请求；如果没有历史持久化数据，不要声称覆盖浏览器外的全部历史。",
    matchingPolicy: hasImages
      ? "本轮有截图：先从截图 OCR/视觉内容提取关键词，再搜索 candidateFlows、recentFlowIndex、flows 和 sseFlows；优先从 candidateFlows 里选择 startedAt 最新且 host/path/query/body/header 字段匹配最多的接口。不要默认使用当前 UI 选中请求；只有 focusedFlow 非空时才表示用户明确指定接口。"
      : "没有截图时，根据用户本轮文字和历史追问语境匹配接口；不要默认使用当前 UI 选中请求。只有 focusedFlow 非空时才表示用户明确指定接口。",
    focusedFlow: focusedFlow ? summarizeFlow(focusedFlow) : null,
    visualSearchProfile: visualProfile
      ? {
          summary: visualProfile.summary,
          terms: visualProfile.terms,
        }
      : null,
    retriever: {
      mode: "application_high_recall_then_ai_rerank",
      searchTerms,
      candidateCount: evidenceCandidates.length,
      policy:
        "candidateFlows 是应用侧高召回证据池。最终回答必须优先从 candidateFlows 选择证据；如果 candidateFlows 只有 recent fallback 或为空，必须说明未找到强匹配，不要改用无关旧接口。",
    },
    totals: {
      all: flows.length,
      today: todayFlows.length,
      failed: failedFlows.length,
      failedToday: todayFlows.filter((flow) => flow.statusCode >= 400 || flow.errorType).length,
      slow: slowFlows.length,
      slowToday: todayFlows.filter((flow) => Number(flow.durationMs || 0) > 1000).length,
      sse: sseFlows.length,
      sseToday: todayFlows.filter(isSseFlow).length,
    },
    recentFlowIndex: sorted.slice(0, recentLimit).map(summarizeFlowIndex),
    candidateFlows: evidenceCandidates.map(evidenceCandidateValue),
    sseFlows: sseFlows.slice(0, 12).map(summarizeFlow),
    identityHints: selected.flatMap(extractIdentityHints).slice(0, 80),
    flows: selected.map(summarizeFlow),
  };
}

function normalizeHistory(history = []) {
  return history
    .filter((item) => ["user", "assistant"].includes(item?.role) && item.content)
    .slice(-3)
    .map((item) => ({
      role: item.role,
      content: String(item.content).slice(0, 600),
    }));
}

function buildUserContent(question, context, attachments = []) {
  const images = attachments
    .filter((item) => item?.dataUrl && String(item.type || "").startsWith("image/"))
    .slice(0, 1);
  const imageInstruction = images.length
    ? "本轮包含截图。请先提取截图中的可见文字、页面标题、域名、接口路径、字段名和业务关键词；再用这些关键词搜索抓包上下文，优先从 candidateFlows 里选择 startedAt 最新且匹配条件最多的接口作为证据。不要默认使用当前 UI 选中请求。\n\n"
    : "";
  const prompt = `用户问题：${question}\n\n${imageInstruction}抓包上下文：\n${JSON.stringify(context, null, 2)}`;

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

  async extractVisualSearchProfile(question, historyText = "", attachments = []) {
    const images = attachments
      .filter((item) => item?.dataUrl && String(item.type || "").startsWith("image/"))
      .slice(0, 4);
    if (!images.length) return null;

    try {
      const content = [
        {
          type: "text",
          text: `请读取截图，并结合用户问题提取用于匹配网络抓包接口的检索意图。只返回 JSON，不要 Markdown。\n用户问题：${question}\n最近对话摘要：${truncate(historyText, 800)}\nJSON 结构：{"intent":"用户真正想找的接口或字段","summary":"截图可见内容一句话","terms":["业务关键词"],"phrases":["需要精确匹配的短语"],"domains":["截图可见域名或品牌域名"],"paths":["接口路径片段"],"fields":["请求/响应字段名"],"methods":["GET/POST/PUT/PATCH/DELETE，可空"],"statusCodes":[200],"searchIn":["url","query","requestHeaders","requestBody","responseHeaders","responseBody","sse"],"excludeTerms":["应排除的静态资源/无关词"],"wantsLatest":true}。terms/phrases 总数不超过 40；去掉泛词如 页面、请求、接口、数据；如果用户只是问截图中的某个动作，例如上传文件，intent 要写成“找发起上传动作的业务 API”，而不是图片/视频静态资源。`,
        },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ];
      const result = await this.chat(
        [
          {
            role: "system",
            content: "你只负责从截图和用户问题提取网络证据检索意图，必须输出严格 JSON。",
          },
          {
            role: "user",
            content,
          },
        ],
        {
          model: this.visionModel,
          temperature: 0,
          enableThinking: false,
        },
      );
      return parseVisualSearchProfile(result.content);
    } catch {
      return null;
    }
  }

  async judgeSearchBatch(question, historyText, profile, batchIndex, candidates) {
    try {
      const payload = {
        question,
        historyContext: truncate(historyText, 1200),
        searchIntent: profileValue(profile),
        batch: {
          index: batchIndex,
          size: candidates.length,
          candidates,
        },
        rules: [
          "只能从 candidates 中选择 selectedFlowId；不确定就返回 null。",
          "优先选择与截图/用户真实意图匹配、时间最新、且 path/query/body/header 命中最多的接口。",
          "媒体静态资源、图片、视频、字体、JS/CSS 只有在用户明确问资源本身时才选择；问上传/提交/业务动作时优先选择发起动作的 API。",
          "如果本批没有强匹配，返回 sufficient=false，并给出 refineTerms 供下一批搜索。",
        ],
      };
      const result = await this.chat(
        [
          {
            role: "system",
            content:
              '你是抓包证据检索裁判。你只判断这一批候选接口哪条最符合用户意图，不做最终回答。必须输出严格 JSON，不要 Markdown。JSON 结构：{"selectedFlowId":"候选 id 或 null","confidence":0到1,"sufficient":true或false,"reason":"一句话理由","refineTerms":["下一批搜索词，可空"]}。',
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
        {
          model: this.model,
          temperature: 0,
          enableThinking: false,
        },
      );
      return parseSearchBatchDecision(result.content, candidates);
    } catch {
      return null;
    }
  }

  async resolveAgentEvidence(question, historyText, flows, hasImages, profile) {
    const focusedFlow = (flows || []).find((flow) =>
      (flow.tags || []).some((tag) => ["selected", "selected-by-user"].includes(String(tag))),
    );
    if (focusedFlow) {
      return {
        selectedFlowId: focusedFlow.id,
        selectedConfidence: 1,
        searchedCount: 1,
        stoppedReason: "explicit_flow",
        batches: [
          {
            batch: 1,
            decision: {
              selectedFlowId: focusedFlow.id,
              confidence: 1,
              sufficient: true,
              reason: "用户本轮明确指定了该接口。",
              refineTerms: [],
            },
            candidates: [
              candidateCard(
                {
                  flow: focusedFlow,
                  score: 10000,
                  reasons: ["explicitly targeted by user"],
                  snippets: searchSnippets(focusedFlow, profileTerms(profile), 4),
                },
                1,
              ),
            ],
          },
        ],
      };
    }

    const seen = new Set();
    const batches = [];
    let searchedCount = 0;
    for (let batchIndex = 0; batchIndex < MAX_SEARCH_BATCHES && searchedCount < MAX_AGENT_SEARCH_FLOWS; batchIndex += 1) {
      const batch = nextSearchBatch(flows, question, historyText, profile, hasImages, seen, SEARCH_BATCH_SIZE);
      if (!batch.length) break;
      batch.forEach((candidate) => seen.add(candidate.flow.id));
      searchedCount += batch.length;
      const cards = batch.map((candidate, index) => candidateCard(candidate, index + 1));
      const decision = (await this.judgeSearchBatch(question, historyText, profile, batchIndex + 1, cards)) || heuristicBatchDecision(batch);
      appendProfileTerms(profile, decision.refineTerms);
      batches.push({
        batch: batchIndex + 1,
        decision: {
          selectedFlowId: decision.selectedFlowId,
          confidence: decision.confidence,
          sufficient: decision.sufficient,
          reason: decision.reason,
          refineTerms: decision.refineTerms,
        },
        candidates: cards,
      });
      if (decision.selectedFlowId && decision.sufficient && decision.confidence >= 0.72) {
        return {
          selectedFlowId: decision.selectedFlowId,
          selectedConfidence: decision.confidence,
          searchedCount,
          stoppedReason: "model_selected",
          batches,
        };
      }
    }
    return {
      selectedFlowId: null,
      selectedConfidence: 0,
      searchedCount,
      stoppedReason: searchedCount >= MAX_AGENT_SEARCH_FLOWS ? "max_100_reached" : "no_strong_match",
      batches,
    };
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
    const historyText = historySearchText(history);
    const searchProfile =
      (await this.extractVisualSearchProfile(trimmedQuestion, historyText, attachments)) ||
      buildTextSearchProfile(trimmedQuestion, historyText);
    const searchResult = await this.resolveAgentEvidence(trimmedQuestion, historyText, flows, hasImages, searchProfile);
    const context = buildFinalAgentContext(flows, trimmedQuestion, historyText, hasImages, searchProfile, searchResult);
    const result = await this.chat(
      [
        {
          role: "system",
          content:
            "你是 HeavenEye Agent（天眼抓包 Agent），一个运行在用户本机、面向研发和测试的抓包调试助手。你的职责是替代用户手动翻浏览器 F12 Network：只基于本地抓包上下文、截图提取结果和搜索器证据回答，不要编造，不要输出与抓包证据无关的免责声明、合规说明、风险提醒或注意事项。不要把当前 UI 选中的请求当作默认焦点；只有上下文里的 focusedFlow 非空，才表示用户本轮明确指定接口。searchResult 是应用底层隐藏搜索器和模型分批判断后的结果：如果 selectedFlow 非空，优先围绕 selectedFlow 回答；如果 selectedFlow 为空，必须说明截图/问题显示的意图，以及最多 100 条检索范围内没有找到强匹配接口，不要改用无关旧接口。历史对话只作为追问语境，上一轮助手结论不是证据。用户询问账号、uid、token、header、cookie、报错接口、慢接口时，如果 selectedFlow 或 searchBatches 中真实存在对应字段，就按字段原文和证据接口列出；如果上下文不足，就明确说明还缺少哪些接口。用户要求接口测试时，先基于真实 request 参数、headers、body 和 response 设计低风险用例，再把可执行的参数变体放入 testCases；每个用例必须相对原请求可发送，不要生成破坏性、扣费、删除、批量写入类用例。必须返回严格 JSON，不要 Markdown，不要代码块。JSON 结构为：{\"summary\":\"一句话结论，优先回答用户最关心的问题\",\"highlights\":[{\"label\":\"账号|密码|Token|UID|报错接口|慢接口等\",\"value\":\"可复制的核心值\",\"kind\":\"uid|account|password|token|error|url|field|status|time|other\",\"source\":\"字段来源，如 requestBody.email 或 responseBody.data.token\"}],\"evidence\":[{\"title\":\"证据名称\",\"time\":\"请求时间\",\"method\":\"GET/POST\",\"status\":200,\"host\":\"域名\",\"path\":\"路径和 query\",\"fields\":[{\"label\":\"字段路径\",\"value\":\"字段值\"}]}],\"analysis\":[\"简短分析或下一步\"],\"testCases\":[{\"name\":\"用例名\",\"purpose\":\"为什么测\",\"method\":\"GET/POST，可省略则沿用原请求\",\"url\":\"完整 URL，可省略则沿用原请求\",\"headers\":{\"x-demo\":\"value，可省略\"},\"query\":{\"key\":\"value，可省略\"},\"body\":{\"字段\":\"值；可省略或字符串\"},\"expected\":\"预期状态/字段/行为\"}]}。非接口测试问题不要返回 testCases，接口测试最多 5 个用例。",
        },
        ...normalizeHistory(history),
        {
          role: "user",
          content: buildFinalUserContent(trimmedQuestion, context),
        },
      ],
      {
        model: this.model,
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

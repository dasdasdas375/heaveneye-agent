import type { CaptureFlow } from "../types";

const skippedReplayHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "accept-encoding",
]);

function defaultPortForScheme(scheme: string) {
  return scheme.toLowerCase() === "http" ? 80 : 443;
}

function requestHost(flow: CaptureFlow) {
  if (!flow.port || flow.port === defaultPortForScheme(flow.scheme)) {
    return flow.host;
  }

  return `${flow.host}:${flow.port}`;
}

export function buildRequestUrl(flow: CaptureFlow) {
  const scheme = flow.scheme || "https";
  const path = flow.path.startsWith("/") ? flow.path : `/${flow.path || ""}`;
  return `${scheme}://${requestHost(flow)}${path}${flow.query || ""}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function copyableHeaders(flow: CaptureFlow) {
  return Object.fromEntries(
    Object.entries(flow.requestHeaders).filter(([key, value]) => {
      const normalized = key.toLowerCase();
      return Boolean(value) && !normalized.startsWith(":") && !skippedReplayHeaders.has(normalized);
    }),
  );
}

function looksLikeJsonBody(flow: CaptureFlow) {
  const contentType = String(flow.requestHeaders["content-type"] || "").toLowerCase();
  return contentType.includes("json") || /^[\s\r\n]*[{[]/.test(flow.requestBodyPreview);
}

function jsonLiteral(value: unknown, indent = 2) {
  return JSON.stringify(value, null, indent);
}

function indentBlock(value: string, spaces: number) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function javascriptString(value: string) {
  return JSON.stringify(value);
}

function playwrightBodyLiteral(flow: CaptureFlow) {
  const body = flow.requestBodyPreview;
  if (!body.trim()) {
    return null;
  }

  if (looksLikeJsonBody(flow)) {
    try {
      return jsonLiteral(JSON.parse(body), 6);
    } catch {
      return javascriptString(body);
    }
  }

  return javascriptString(body);
}

export function buildCurlCommand(flow: CaptureFlow) {
  const lines = [`curl -X ${flow.method} ${shellQuote(buildRequestUrl(flow))}`];

  Object.entries(copyableHeaders(flow)).forEach(([key, value]) => {
    lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
  });

  if (flow.requestBodyPreview.trim()) {
    lines.push(`  --data-raw ${shellQuote(flow.requestBodyPreview)}`);
  }

  return lines.join(" \\\n");
}

export function buildPlaywrightSnippet(flow: CaptureFlow) {
  const headers = copyableHeaders(flow);
  const body = playwrightBodyLiteral(flow);
  const requestName = `${flow.method} ${flow.host}${flow.path}`;
  const lines = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test(${javascriptString(`replay ${requestName}`)}, async ({ request }) => {`,
    `  const response = await request.fetch(${javascriptString(buildRequestUrl(flow))}, {`,
    `    method: ${javascriptString(flow.method)},`,
  ];

  if (Object.keys(headers).length) {
    lines.push("    headers: {");
    Object.entries(headers).forEach(([key, value]) => {
      lines.push(`      ${javascriptString(key)}: ${javascriptString(value)},`);
    });
    lines.push("    },");
  }

  if (body) {
    if (body.startsWith("{") || body.startsWith("[")) {
      lines.push("    data:");
      lines.push(`${indentBlock(body, 6)},`);
    } else {
      lines.push(`    data: ${body},`);
    }
  }

  lines.push("    failOnStatusCode: false,");
  lines.push("  });");
  lines.push("");
  lines.push("  console.log(response.status(), await response.text());");
  lines.push("  expect(response.status()).toBeLessThan(500);");
  lines.push("});");

  return lines.join("\n");
}

function postmanUrl(flow: CaptureFlow) {
  const rawQuery = flow.query.startsWith("?") ? flow.query.slice(1) : flow.query;
  const params = new URLSearchParams(rawQuery);
  const query = Array.from(params.entries()).map(([key, value]) => ({ key, value }));
  const path = flow.path
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  return {
    raw: buildRequestUrl(flow),
    protocol: flow.scheme || "https",
    host: flow.host.split("."),
    path,
    ...(query.length ? { query } : {}),
  };
}

function postmanBody(flow: CaptureFlow) {
  if (!flow.requestBodyPreview.trim()) {
    return undefined;
  }

  return {
    mode: "raw",
    raw: flow.requestBodyPreview,
    options: {
      raw: {
        language: looksLikeJsonBody(flow) ? "json" : "text",
      },
    },
  };
}

export function buildPostmanCollection(flow: CaptureFlow) {
  const headers = Object.entries(copyableHeaders(flow)).map(([key, value]) => ({ key, value }));
  const collection = {
    info: {
      name: `Replay ${flow.method} ${flow.host}${flow.path}`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: `${flow.method} ${flow.path || "/"}`,
        request: {
          method: flow.method,
          header: headers,
          url: postmanUrl(flow),
          ...(postmanBody(flow) ? { body: postmanBody(flow) } : {}),
        },
      },
    ],
  };

  return `${JSON.stringify(collection, null, 2)}\n`;
}

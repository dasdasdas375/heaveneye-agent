import type { CaptureFlow, ProxyRule, WeakNetworkProfile } from "../types";
import { buildRequestUrl } from "./request-export";

type HeaderList = Array<{ name: string; value: string }>;

function headersToList(headers: Record<string, string>): HeaderList {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryToList(query: string) {
  return Array.from(new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).entries()).map(
    ([name, value]) => ({ name, value }),
  );
}

function mimeType(headers: Record<string, string>) {
  return headers["content-type"] || headers["Content-Type"] || "";
}

export function buildSessionExport(
  flows: CaptureFlow[],
  rules: ProxyRule[],
  weakNetwork: WeakNetworkProfile,
) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: "HeavenEye Agent",
    rules,
    weakNetwork,
    flows,
  };
}

export function buildHarArchive(flows: CaptureFlow[]) {
  return {
    log: {
      version: "1.2",
      creator: {
        name: "HeavenEye Agent",
        version: "0.1.0",
      },
      pages: [],
      entries: flows
        .slice()
        .reverse()
        .map((flow) => ({
          startedDateTime: new Date(flow.startedAt).toISOString(),
          time: flow.durationMs ?? 0,
          request: {
            method: flow.method,
            url: buildRequestUrl(flow),
            httpVersion: flow.protocol,
            cookies: [],
            headers: headersToList(flow.requestHeaders),
            queryString: queryToList(flow.query),
            headersSize: -1,
            bodySize: flow.requestSize,
            postData: flow.requestBodyPreview
              ? {
                  mimeType: mimeType(flow.requestHeaders),
                  text: flow.requestBodyPreview,
                }
              : undefined,
          },
          response: {
            status: flow.statusCode ?? 0,
            statusText: flow.errorType || "",
            httpVersion: flow.protocol,
            cookies: [],
            headers: headersToList(flow.responseHeaders),
            content: {
              size: flow.responseSize,
              mimeType: mimeType(flow.responseHeaders),
              text: flow.responseBodyPreview,
            },
            redirectURL: flow.responseHeaders.location || "",
            headersSize: -1,
            bodySize: flow.responseSize,
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: -1,
            connect: -1,
            send: 0,
            wait: flow.durationMs ?? 0,
            receive: 0,
            ssl: -1,
          },
          serverIPAddress: "",
          connection: "",
          comment: flow.tags.join(", "),
        })),
    },
  };
}

import { describe, expect, it } from "vitest";

import {
  buildCurlCommand,
  buildPlaywrightSnippet,
  buildPostmanCollection,
  buildRequestUrl,
} from "../src/lib/request-export";
import type { CaptureFlow } from "../src/types";

function makeFlow(overrides: Partial<CaptureFlow> = {}): CaptureFlow {
  return {
    id: "flow-1",
    startedAt: 1710000000000,
    completedAt: 1710000000100,
    method: "POST",
    scheme: "https",
    host: "api.example.com",
    port: null,
    path: "/v1/login",
    query: "?debug=true",
    statusCode: 200,
    protocol: "HTTP/2",
    source: "mitm",
    durationMs: 100,
    requestHeaders: {
      ":authority": "api.example.com",
      accept: "application/json",
      "accept-encoding": "gzip",
      "content-length": "17",
      "content-type": "application/json",
      cookie: "sid=abc",
    },
    responseHeaders: {
      "content-type": "application/json",
    },
    requestBodyPreview: '{"phone":"123"}',
    responseBodyPreview: '{"ok":true}',
    requestSize: 17,
    responseSize: 11,
    errorType: "",
    tags: ["ssl-decrypted"],
    ...overrides,
  };
}

describe("request export builders", () => {
  it("builds URLs with non-default ports", () => {
    expect(buildRequestUrl(makeFlow({ scheme: "http", port: 8080 }))).toBe(
      "http://api.example.com:8080/v1/login?debug=true",
    );
  });

  it("builds cURL without transport-only headers", () => {
    const command = buildCurlCommand(makeFlow());

    expect(command).toContain("curl -X POST 'https://api.example.com/v1/login?debug=true'");
    expect(command).toContain("-H 'accept: application/json'");
    expect(command).toContain("-H 'cookie: sid=abc'");
    expect(command).toContain("--data-raw '{\"phone\":\"123\"}'");
    expect(command).not.toContain("content-length");
    expect(command).not.toContain("accept-encoding");
    expect(command).not.toContain(":authority");
  });

  it("builds a Playwright replay snippet", () => {
    const snippet = buildPlaywrightSnippet(makeFlow());

    expect(snippet).toContain("import { test, expect } from '@playwright/test';");
    expect(snippet).toContain('await request.fetch("https://api.example.com/v1/login?debug=true"');
    expect(snippet).toContain('"content-type": "application/json"');
    expect(snippet).toContain('"phone": "123"');
    expect(snippet).toContain("failOnStatusCode: false");
  });

  it("builds a Postman collection with raw json body", () => {
    const collection = JSON.parse(buildPostmanCollection(makeFlow()));

    expect(collection.info.schema).toContain("collection/v2.1.0");
    expect(collection.item[0].request.method).toBe("POST");
    expect(collection.item[0].request.url.query).toEqual([{ key: "debug", value: "true" }]);
    expect(collection.item[0].request.body.raw).toBe('{"phone":"123"}');
    expect(collection.item[0].request.body.options.raw.language).toBe("json");
  });
});

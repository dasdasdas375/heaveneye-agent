import { describe, expect, it } from "vitest";

const { redactFlow, redactText } = await import("../electron/services/sanitizer.cjs");

describe("sanitizer", () => {
  it("redacts common secrets from text", () => {
    expect(redactText("access_token: abc123 email test@example.com phone 13800138000")).toContain(
      "[REDACTED]",
    );
    expect(redactText("access_token: abc123 email test@example.com phone 13800138000")).toContain(
      "[REDACTED_EMAIL]",
    );
    expect(redactText("access_token: abc123 email test@example.com phone 13800138000")).toContain(
      "[REDACTED_PHONE]",
    );
  });

  it("redacts sensitive headers in captured flows", () => {
    const flow = redactFlow({
      requestHeaders: {
        authorization: "Bearer secret",
        accept: "application/json",
      },
      responseHeaders: {
        "set-cookie": "sid=secret",
      },
      requestBodyPreview: "",
      responseBodyPreview: "",
    });

    expect(flow.requestHeaders.authorization).toBe("[REDACTED]");
    expect(flow.requestHeaders.accept).toBe("application/json");
    expect(flow.responseHeaders["set-cookie"]).toBe("[REDACTED]");
  });
});


import { describe, expect, it } from "vitest";

const { hostMatchesPattern, normalizeCaptureHosts } = await import("../electron/services/proxy-service.cjs");

describe("capture host matching", () => {
  it("normalizes URLs and comma separated capture hosts", () => {
    expect(normalizeCaptureHosts(["https://app.example.test/, *.example.com"])).toEqual([
      "app.example.test",
      "*.example.com",
    ]);
  });

  it("matches app related hosts from one target domain", () => {
    expect(hostMatchesPattern("app.example.test", "app.example.test")).toBe(true);
    expect(hostMatchesPattern("static.example.test", "app.example.test")).toBe(true);
    expect(hostMatchesPattern("assets.example.test", "app.example.test")).toBe(true);
    expect(hostMatchesPattern("cdn.example.test", "app.example.test")).toBe(true);
  });

  it("does not match unrelated hosts", () => {
    expect(hostMatchesPattern("google.com", "app.example.test")).toBe(false);
    expect(hostMatchesPattern("telemetry.example.net", "app.example.test")).toBe(false);
  });
});


import { describe, expect, it } from "vitest";

const { createDesktopBackend } = await import("../src/lib/desktop");

describe("desktop bridge", () => {
  it("prefers Tauri invoke handlers when available", async () => {
    const backend = createDesktopBackend({
      loadTauriInvoke: async () => async (command: string) => {
        if (command === "get_config") {
          return {
            proxyPort: 8081,
            certDir: "/tmp/certs",
            captureHosts: ["app.example.test"],
            sslProxyHosts: ["app.example.test"],
            qwen: {
              baseUrl: "https://example.com",
              model: "qwen-test",
              visionModel: "qwen-vl-test",
              hasApiKey: true,
            },
          };
        }
        throw new Error(`Unexpected Tauri command: ${command}`);
      },
    });

    await expect(backend.getConfig()).resolves.toMatchObject({
      proxyPort: 8081,
      qwen: { model: "qwen-test" },
    });
  });

  it("does not fall back to the Electron preload API when Tauri is unavailable", async () => {
    const backend = createDesktopBackend({
      loadTauriInvoke: async () => {
        throw new Error("tauri api is unavailable");
      },
    });

    await expect(backend.getConfig()).rejects.toThrow(/desktop backend/i);
  });

  it("throws a helpful error when no desktop backend is available", async () => {
    const backend = createDesktopBackend({
      loadTauriInvoke: async () => {
        throw new Error("tauri api is unavailable");
      },
    });

    await expect(backend.getConfig()).rejects.toThrow(/desktop backend/i);
  });

  it("rejects when the Tauri core api is present but does not expose invoke", async () => {
    const backend = createDesktopBackend({
      loadTauriInvoke: async () => undefined as any,
    });

    await expect(backend.getConfig()).rejects.toThrow(/desktop backend/i);
  });

  it("normalizes invoke errors caused by missing Tauri internals", async () => {
    const backend = createDesktopBackend({
      loadTauriInvoke: async () =>
        (async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'invoke')");
        }) as any,
    });

    await expect(backend.getConfig()).rejects.toThrow(/desktop backend/i);
  });
});

import http from "node:http";
import http2 from "node:http2";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

const { CaptureStore } = await import("../electron/services/capture-store.cjs");
const { ProxyService } = await import("../electron/services/proxy-service.cjs");

function listen(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function listenHttp2(server: http2.Http2Server) {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeHttp2(server: http2.Http2Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("proxy body preview", () => {
  it("decompresses gzip-js request bodies for readable previews", async () => {
    const target = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await listen(target);

    const targetPort = (target.address() as { port: number }).port;
    const store = new CaptureStore();
    const proxy = new ProxyService({ captureStore: store, defaultPort: 0 });
    await proxy.start(0);
    const proxyPort = (proxy.server.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ event: "capture", ok: true })));
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "POST",
          path: `http://127.0.0.1:${targetPort}/s/?compression=gzip-js`,
          headers: {
            host: `127.0.0.1:${targetPort}`,
            "content-type": "text/plain",
            "content-length": String(body.length),
          },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end(body);
    });

    const [flow] = store.list();
    expect(flow.requestBodyPreview).toContain('"event":"capture"');

    await proxy.stop();
    await close(target);
  });

  it("captures HTTP/2 MITM POST streams with readable request and response previews", async () => {
    const target = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, received: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    await listen(target);

    const targetPort = (target.address() as { port: number }).port;
    const store = new CaptureStore();
    const proxy = new ProxyService({ captureStore: store, defaultPort: 0 });
    await proxy.start(0);
    await listenHttp2(proxy.mitmHttp2Server);
    const http2Port = (proxy.mitmHttp2Server.address() as { port: number }).port;

    const responseBody = await new Promise<string>((resolve, reject) => {
      const client = http2.connect(`http://127.0.0.1:${http2Port}`);
      const chunks: Buffer[] = [];
      const req = client.request({
        ":method": "POST",
        ":scheme": "http",
        ":authority": `127.0.0.1:${targetPort}`,
        ":path": "/demo-agent/api/ppt_orchestrator/convert-to-layer-config-v2",
        "content-type": "application/json",
      });

      req.on("response", (headers) => {
        expect(headers[":status"]).toBe(200);
      });
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        client.close();
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
      client.on("error", reject);
      req.end(JSON.stringify({ presentationId: "7213cf55-fec5-4ad9-9e9c-5030bd2e057b" }));
    });

    expect(responseBody).toContain("7213cf55");

    const [flow] = store.list();
    expect(flow.method).toBe("POST");
    expect(flow.protocol).toBe("HTTP/2");
    expect(flow.path).toBe("/demo-agent/api/ppt_orchestrator/convert-to-layer-config-v2");
    expect(flow.requestBodyPreview).toContain("presentationId");
    expect(flow.responseBodyPreview).toContain("received");
    expect(flow.tags).toContain("h2");

    await closeHttp2(proxy.mitmHttp2Server);
    await proxy.stop();
    await close(target);
  });

  it("stores full decoded response bodies for on-demand inspection", async () => {
    const largeText = "x".repeat(170 * 1024);
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, largeText, marker: "full-body-tail" }));
    });
    await listen(target);

    const targetPort = (target.address() as { port: number }).port;
    const store = new CaptureStore();
    const proxy = new ProxyService({ captureStore: store, defaultPort: 0 });
    await proxy.start(0);
    const proxyPort = (proxy.server.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: `http://127.0.0.1:${targetPort}/large-json`,
          headers: {
            host: `127.0.0.1:${targetPort}`,
            accept: "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });

    const [flow] = store.list();
    expect(flow.responseBodyPreviewTruncated).toBe(true);
    expect(flow.responseBodyPreview).not.toContain("full-body-tail");

    const fullBody = proxy.bodyContent(flow.id, "response");
    expect(fullBody.complete).toBe(true);
    expect(fullBody.fromPreview).toBe(false);
    expect(fullBody.content).toContain("full-body-tail");

    await proxy.stop();
    await close(target);
  });
});

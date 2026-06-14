const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const zlib = require("node:zlib");

const BODY_PREVIEW_LIMIT = 128 * 1024;
const BODY_TEXT_CACHE_DIR = path.join(os.tmpdir(), "heaveneye-agent-body-cache");

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : String(value ?? ""),
    ]),
  );
}

function stripHopByHopHeaders(headers) {
  const blocked = new Set([
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  return Object.fromEntries(
    Object.entries(headers || {}).filter(([key, value]) => !blocked.has(key.toLowerCase()) && value !== undefined),
  );
}

function stripHttp2RequestHeaders(headers) {
  return Object.fromEntries(
    Object.entries(stripHopByHopHeaders(headers)).filter(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return !normalizedKey.startsWith(":") && normalizedKey !== "http2-settings" && value !== undefined;
    }),
  );
}

function stripHttp2ResponseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(stripHopByHopHeaders(headers)).filter(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return normalizedKey !== "http2-settings" && !normalizedKey.startsWith(":") && value !== undefined;
    }),
  );
}

function bufferPreview(chunks, headers = {}, options = {}) {
  const buffer = Buffer.concat(chunks);
  const decodedBuffer = decodeBodyBuffer(buffer, headers, options);
  if (isBinaryPreview(headers, decodedBuffer)) {
    return {
      size: buffer.length,
      decodedSize: decodedBuffer.length,
      preview: binaryPreviewMessage(headers, decodedBuffer.length),
      previewTruncated: false,
      textPath: "",
    };
  }
  return {
    size: buffer.length,
    decodedSize: decodedBuffer.length,
    preview: decodedBuffer.subarray(0, BODY_PREVIEW_LIMIT).toString("utf8"),
    previewTruncated: decodedBuffer.length > BODY_PREVIEW_LIMIT,
    textPath: storeTextBody(decodedBuffer),
  };
}

function textContentType(headers = {}) {
  const contentType = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("graphql") ||
    contentType.includes("event-stream")
  );
}

function isBinaryPreview(headers = {}, decodedBuffer = Buffer.alloc(0)) {
  if (decodedBuffer.length === 0) {
    return false;
  }
  if (textContentType(headers)) {
    return false;
  }
  const probe = decodedBuffer.subarray(0, Math.min(decodedBuffer.length, 2048));
  let suspicious = 0;
  for (const byte of probe) {
    if (byte === 0 || (byte < 9 && byte !== 7) || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / probe.length > 0.08;
}

function binaryPreviewMessage(headers = {}, decodedSize = 0) {
  const contentType = headers["content-type"] || headers["Content-Type"] || "application/octet-stream";
  return `[binary body omitted]\ncontent-type: ${contentType}\ndecoded-size: ${decodedSize} bytes`;
}

function storeTextBody(decodedBuffer) {
  if (!decodedBuffer.length) {
    return "";
  }
  try {
    fs.mkdirSync(BODY_TEXT_CACHE_DIR, { recursive: true });
    const filePath = path.join(BODY_TEXT_CACHE_DIR, `${Date.now()}-${crypto.randomUUID()}.body.txt`);
    fs.writeFileSync(filePath, decodedBuffer);
    return filePath;
  } catch {
    return "";
  }
}

function deleteTextBody(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function decodeBodyBuffer(buffer, headers = {}, options = {}) {
  const encoding = String(
    options.encoding || headers["content-encoding"] || headers["Content-Encoding"] || "",
  ).toLowerCase();
  if (!encoding || buffer.length === 0) {
    return buffer;
  }

  try {
    if (encoding.includes("br")) {
      return zlib.brotliDecompressSync(buffer);
    }
    if (encoding.includes("gzip")) {
      return zlib.gunzipSync(buffer);
    }
    if (encoding.includes("deflate")) {
      return zlib.inflateSync(buffer);
    }
  } catch {
    return buffer;
  }

  return buffer;
}

function requestBodyEncodingFromUrl(targetUrl) {
  const compression = targetUrl.searchParams.get("compression") || "";
  if (compression.toLowerCase().includes("gzip")) {
    return "gzip";
  }
  return "";
}

function buildTargetUrl(req) {
  if (/^https?:\/\//i.test(req.url || "")) {
    return new URL(req.url);
  }

  const host = req.headers.host;
  if (!host) {
    throw new Error("Missing Host header");
  }

  return new URL(`http://${host}${req.url || "/"}`);
}

function buildMitmTargetUrl(req) {
  if (/^https?:\/\//i.test(req.url || "")) {
    return new URL(req.url);
  }

  const target = req.socket.__mitmTarget;
  if (!target?.host) {
    throw new Error("Missing MITM target host");
  }

  const hostWithPort = target.port === 443 ? target.host : `${target.host}:${target.port}`;
  return new URL(`https://${hostWithPort}${req.url || "/"}`);
}

function buildHttp2TargetUrl(headers) {
  const authority = String(headers[":authority"] || headers.host || "");
  if (!authority) {
    throw new Error("Missing HTTP/2 :authority header");
  }

  const scheme = String(headers[":scheme"] || "https");
  const path = String(headers[":path"] || "/");
  return new URL(`${scheme}://${authority}${path}`);
}

function closeServer(server) {
  if (!server || !server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function hostMatchesPattern(host, pattern) {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeCaptureHost(pattern);
  if (!normalizedHost || !normalizedPattern) {
    return false;
  }
  if (normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }
  if (normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`)) {
    return true;
  }

  const rootDomain = getLikelyRootDomain(normalizedPattern);
  if (rootDomain && (normalizedHost === rootDomain || normalizedHost.endsWith(`.${rootDomain}`))) {
    return true;
  }

  const brand = rootDomain?.split(".")[0];
  if (brand && brand.length >= 4) {
    return (
      normalizedHost.startsWith(`${brand}-`) ||
      normalizedHost.includes(`.${brand}-`) ||
      normalizedHost.includes(`-${brand}.`) ||
      normalizedHost.includes(`-${brand}-`)
    );
  }

  return false;
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/:\d+$/, "");
}

function normalizeCaptureHost(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      return normalizeHost(new URL(value).hostname);
    }
  } catch {
    // Keep the manual parsing fallback.
  }

  return normalizeHost(value.replace(/^https?:\/\//i, "").split("/")[0]);
}

function normalizeCaptureHosts(hosts = []) {
  return hosts
    .flatMap((host) => String(host || "").split(/[,\n\s]+/))
    .map(normalizeCaptureHost)
    .filter(Boolean);
}

function getLikelyRootDomain(host) {
  const cleanHost = normalizeHost(host).replace(/^\*\./, "");
  const parts = cleanHost.split(".").filter(Boolean);
  if (parts.length < 2) {
    return "";
  }

  return parts.slice(-2).join(".");
}

function compactError(error, fallback) {
  return [fallback, error.code, error.reason || error.message]
    .filter(Boolean)
    .join(":")
    .slice(0, 180);
}

class ProxyService {
  constructor({ captureStore, certificateService, defaultPort, sslProxyHosts = [], captureHosts = [] }) {
    this.captureStore = captureStore;
    this.certificateService = certificateService;
    this.defaultPort = defaultPort;
    this.captureHosts = normalizeCaptureHosts(captureHosts.length ? captureHosts : sslProxyHosts);
    this.server = null;
    this.mitmHttpServer = null;
    this.mitmHttp2Server = null;
    this.openSockets = new Set();
    this.port = null;
    this.running = false;
  }

  async start(port = this.defaultPort) {
    if (this.running) {
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Proxy error: ${error.message}`);
      });
    });

    this.server.on("connect", (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });
    this.server.on("connection", (socket) => this.trackSocket(socket));

    this.mitmHttpServer = http.createServer((req, res) => {
      this.handleMitmHttpRequest(req, res).catch((error) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`MITM proxy error: ${error.message}`);
      });
    });

    this.mitmHttp2Server = http2.createServer();
    this.mitmHttp2Server.on("stream", (stream, headers) => {
      this.handleMitmHttp2Stream(stream, headers).catch((error) => {
        if (!stream.destroyed) {
          try {
            stream.respond({ ":status": 502, "content-type": "text/plain; charset=utf-8" });
            stream.end(`HTTP/2 MITM proxy error: ${error.message}`);
          } catch {
            stream.destroy(error);
          }
        }
      });
    });
    this.mitmHttp2Server.on("sessionError", () => {});
    this.mitmHttp2Server.on("streamError", () => {});

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    this.port = port;
    this.running = true;
  }

  async stop() {
    if (!this.server) {
      this.running = false;
      this.port = null;
      return;
    }

    const server = this.server;
    this.server = null;

    for (const socket of this.openSockets) {
      socket.destroy();
    }
    this.openSockets.clear();

    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    const mitmHttpServer = this.mitmHttpServer;
    const mitmHttp2Server = this.mitmHttp2Server;
    this.mitmHttpServer = null;
    this.mitmHttp2Server = null;

    mitmHttpServer?.closeAllConnections?.();
    mitmHttp2Server?.closeAllConnections?.();

    await Promise.all([closeServer(server), closeServer(mitmHttpServer), closeServer(mitmHttp2Server)]);

    this.running = false;
    this.port = null;
  }

  status() {
    return {
      running: this.running,
      port: this.port || this.defaultPort,
      mode: "http-proxy",
      httpsMitm: this.captureHosts.length > 0,
      captureHosts: this.captureHosts,
      sslProxyHosts: this.captureHosts,
      rootCertificatePath: this.certificateService?.getRootCertificateInfo().certPath || null,
    };
  }

  setCaptureHosts(hosts) {
    this.captureHosts = normalizeCaptureHosts(Array.isArray(hosts) ? hosts : [hosts]);
    return this.status();
  }

  trackSocket(socket) {
    this.openSockets.add(socket);
    socket.on("close", () => {
      this.openSockets.delete(socket);
    });
    return socket;
  }

  async handleHttpRequest(req, res) {
    const targetUrl = buildTargetUrl(req);
    return this.forwardRequest(req, res, targetUrl, Date.now(), [], this.shouldCaptureHost(targetUrl.hostname));
  }

  async handleMitmHttpRequest(req, res) {
    const targetUrl = buildMitmTargetUrl(req);
    return this.forwardRequest(req, res, targetUrl, Date.now(), ["ssl-decrypted"], true);
  }

  async handleMitmHttp2Stream(stream, headers) {
    const startedAt = Date.now();
    const targetUrl = buildHttp2TargetUrl(headers);
    const method = String(headers[":method"] || "GET").toUpperCase();
    const requestChunks = [];

    stream.on("data", (chunk) => requestChunks.push(chunk));

    await new Promise((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      stream.on("aborted", () => reject(new Error("HTTP/2 stream aborted")));
    });

    const requestHeaders = normalizeHeaders(headers);
    const requestBody = bufferPreview(requestChunks, requestHeaders, {
      encoding: requestBodyEncodingFromUrl(targetUrl),
    });
    const flow = this.captureStore.createFlow({
      startedAt,
      method,
      scheme: targetUrl.protocol.replace(":", ""),
      host: targetUrl.hostname,
      port: Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)),
      path: targetUrl.pathname,
      query: targetUrl.search,
      protocol: "HTTP/2",
      requestHeaders,
      requestBodyPreview: requestBody.preview,
      requestBodyTextPath: requestBody.textPath,
      requestBodyPreviewTruncated: requestBody.previewTruncated,
      requestBodyDecodedSize: requestBody.decodedSize,
      requestSize: requestBody.size,
      tags: ["ssl-decrypted", "h2"],
    });

    const upstreamClient = targetUrl.protocol === "https:" ? https : http;
    const upstreamReq = upstreamClient.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: {
          ...stripHttp2RequestHeaders(headers),
          host: targetUrl.host,
        },
      },
      (upstreamRes) => {
        const responseChunks = [];
        const responseHeaders = normalizeHeaders(upstreamRes.headers);

        if (!stream.destroyed) {
          stream.respond({
            ":status": upstreamRes.statusCode || 502,
            ...stripHttp2ResponseHeaders(upstreamRes.headers),
          });
        }

        upstreamRes.on("data", (chunk) => {
          responseChunks.push(chunk);
          if (!stream.destroyed) {
            stream.write(chunk);
          }
        });

        upstreamRes.on("end", () => {
          if (!stream.destroyed) {
            stream.end();
          }
          const responseBody = bufferPreview(responseChunks, responseHeaders);
          this.captureStore.updateFlow(flow.id, {
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            statusCode: upstreamRes.statusCode || null,
            responseHeaders,
            responseBodyPreview: responseBody.preview,
            responseBodyTextPath: responseBody.textPath,
            responseBodyPreviewTruncated: responseBody.previewTruncated,
            responseBodyDecodedSize: responseBody.decodedSize,
            responseSize: responseBody.size,
            errorType: upstreamRes.statusCode >= 400 ? "http_error" : "",
          });
        });
      },
    );

    upstreamReq.on("error", (error) => {
      this.captureStore.updateFlow(flow.id, {
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        statusCode: 502,
        errorType: error.code || "proxy_error",
        responseBodyPreview: error.message,
      });

      if (!stream.destroyed) {
        try {
          stream.respond({ ":status": 502, "content-type": "text/plain; charset=utf-8" });
          stream.end(error.message);
        } catch {
          stream.destroy(error);
        }
      }
    });

    if (requestChunks.length) {
      upstreamReq.write(Buffer.concat(requestChunks));
    }
    upstreamReq.end();
  }

  async forwardRequest(req, res, targetUrl, startedAt = Date.now(), tags = [], shouldCapture = true) {
    const requestChunks = [];

    req.on("data", (chunk) => requestChunks.push(chunk));

    await new Promise((resolve, reject) => {
      req.on("end", resolve);
      req.on("error", reject);
    });

    const requestBody = bufferPreview(requestChunks, req.headers, {
      encoding: requestBodyEncodingFromUrl(targetUrl),
    });
    const upstreamClient = targetUrl.protocol === "https:" ? https : http;
    const requestHeaders = normalizeHeaders(req.headers);

    const flow = shouldCapture
      ? this.captureStore.createFlow({
          startedAt,
          method: req.method || "GET",
          scheme: targetUrl.protocol.replace(":", ""),
          host: targetUrl.hostname,
          port: Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)),
          path: targetUrl.pathname,
          query: targetUrl.search,
          protocol: req.httpVersion ? `HTTP/${req.httpVersion}` : "HTTP/1.1",
          requestHeaders,
          requestBodyPreview: requestBody.preview,
          requestBodyTextPath: requestBody.textPath,
          requestBodyPreviewTruncated: requestBody.previewTruncated,
          requestBodyDecodedSize: requestBody.decodedSize,
          requestSize: requestBody.size,
          tags,
        })
      : null;

    const upstreamReq = upstreamClient.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        method: req.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: {
          ...stripHopByHopHeaders(req.headers),
          host: targetUrl.host,
        },
      },
      (upstreamRes) => {
        const responseChunks = [];
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

        upstreamRes.on("data", (chunk) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });

        upstreamRes.on("end", () => {
          res.end();
          if (flow) {
            const responseHeaders = normalizeHeaders(upstreamRes.headers);
            const responseBody = bufferPreview(responseChunks, responseHeaders);
            this.captureStore.updateFlow(flow.id, {
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              statusCode: upstreamRes.statusCode || null,
              responseHeaders,
              responseBodyPreview: responseBody.preview,
              responseBodyTextPath: responseBody.textPath,
              responseBodyPreviewTruncated: responseBody.previewTruncated,
              responseBodyDecodedSize: responseBody.decodedSize,
              responseSize: responseBody.size,
              errorType: upstreamRes.statusCode >= 400 ? "http_error" : "",
            });
          }
        });
      },
    );

    upstreamReq.on("error", (error) => {
      if (flow) {
        this.captureStore.updateFlow(flow.id, {
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          statusCode: 502,
          errorType: error.code || "proxy_error",
          responseBodyPreview: error.message,
        });
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(error.message);
    });

    if (requestChunks.length) {
      upstreamReq.write(Buffer.concat(requestChunks));
    }
    upstreamReq.end();
  }

  handleConnect(req, clientSocket, head) {
    const startedAt = Date.now();
    const [host, portText] = String(req.url || "").split(":");
    const port = Number(portText || 443);

    if (this.shouldMitmHost(host)) {
      this.handleMitmConnect({ req, clientSocket, head, host, port, startedAt });
      return;
    }

    const shouldCapture = this.shouldCaptureHost(host);
    const flow = shouldCapture
      ? this.captureStore.createFlow({
          startedAt,
          method: "CONNECT",
          scheme: "https",
          host,
          port,
          path: "/",
          protocol: "CONNECT",
          requestHeaders: normalizeHeaders(req.headers),
          tags: ["encrypted-tunnel"],
        })
      : null;

    const upstreamSocket = this.trackSocket(net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    }));

    let closed = false;
    const closeFlow = (errorType = "") => {
      if (closed) {
        return;
      }
      closed = true;
      if (flow) {
        this.captureStore.updateFlow(flow.id, {
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          statusCode: errorType ? 502 : 200,
          errorType,
        });
      }
    };

    upstreamSocket.on("error", (error) => {
      closeFlow(error.code || "connect_error");
      clientSocket.end();
    });

    clientSocket.on("error", () => {
      upstreamSocket.end();
    });

    upstreamSocket.on("close", () => closeFlow());
  }

  shouldMitmHost(host) {
    if (!host || !this.certificateService || !this.shouldCaptureHost(host)) {
      return false;
    }
    return true;
  }

  shouldCaptureHost(host) {
    if (!this.captureHosts.length) {
      return true;
    }
    return this.captureHosts.some((pattern) => hostMatchesPattern(host, pattern));
  }

  bodyContent(flowId, direction = "response") {
    const flow =
      typeof this.captureStore.get === "function"
        ? this.captureStore.get(flowId)
        : this.captureStore.list().find((item) => item.id === flowId);
    if (!flow) {
      throw new Error("Flow not found");
    }
    const isRequest = direction === "request";
    const textPath = isRequest ? flow.requestBodyTextPath : flow.responseBodyTextPath;
    const preview = isRequest ? flow.requestBodyPreview || "" : flow.responseBodyPreview || "";
    const headers = isRequest ? flow.requestHeaders || {} : flow.responseHeaders || {};
    const size = isRequest ? flow.requestSize || 0 : flow.responseSize || 0;
    const decodedSize = isRequest
      ? flow.requestBodyDecodedSize || Buffer.byteLength(preview)
      : flow.responseBodyDecodedSize || Buffer.byteLength(preview);
    const previewTruncated = Boolean(isRequest ? flow.requestBodyPreviewTruncated : flow.responseBodyPreviewTruncated);
    const contentType = headers["content-type"] || headers["Content-Type"] || "";
    const binaryOmitted = preview.startsWith("[binary body omitted]");

    if (textPath) {
      try {
        return {
          flowId,
          direction: isRequest ? "request" : "response",
          content: fs.readFileSync(textPath, "utf8"),
          contentType,
          size,
          decodedSize,
          fromPreview: false,
          complete: true,
          omittedReason: "",
        };
      } catch {
        // Fall back to the captured preview below.
      }
    }

    return {
      flowId,
      direction: isRequest ? "request" : "response",
      content: preview,
      contentType,
      size,
      decodedSize,
      fromPreview: true,
      complete: !previewTruncated && !binaryOmitted,
      omittedReason: binaryOmitted
        ? "Binary body is not stored as text."
        : previewTruncated
          ? "Full body cache is unavailable; showing captured preview."
          : "",
    };
  }

  handleMitmConnect({ req, clientSocket, head, host, port, startedAt }) {
    let closed = false;
    const closeFlow = (errorType = "") => {
      if (closed) {
        return;
      }
      closed = true;
      if (errorType) {
        this.captureStore.createFlow({
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          method: "CONNECT",
          scheme: "https",
          host,
          port,
          path: "/",
          statusCode: 502,
          protocol: "CONNECT",
          requestHeaders: normalizeHeaders(req.headers),
          errorType,
          tags: ["mitm-error"],
        });
      }
    };

    try {
      const certPair = this.certificateService.getCertificateForHost(host);
      const secureContext = tls.createSecureContext(certPair);

      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext,
        // Force browser traffic through the stable HTTP/1.1 MITM path. If we
        // advertise h2 here, real CONNECT+TLS clients can negotiate HTTP/2 and
        // hang before the request reaches the capture store.
        ALPNProtocols: ["http/1.1"],
      });
      this.trackSocket(tlsSocket);
      tlsSocket.__mitmTarget = { host, port };

      if (head && head.length) {
        tlsSocket.unshift(head);
      }

      tlsSocket.on("secure", () => {
        if (tlsSocket.alpnProtocol === "h2") {
          this.mitmHttp2Server.emit("connection", tlsSocket);
          return;
        }
        this.mitmHttpServer.emit("connection", tlsSocket);
      });
      tlsSocket.on("error", (error) => closeFlow(compactError(error, "tls_error")));
      tlsSocket.on("close", () => closeFlow());
    } catch (error) {
      closeFlow(compactError(error, "mitm_setup_error"));
      clientSocket.end();
    }
  }
}

module.exports = {
  ProxyService,
  hostMatchesPattern,
  normalizeCaptureHosts,
};

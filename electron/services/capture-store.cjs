const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");

function deleteBodyFile(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function publicFlow(flow) {
  const { requestBodyTextPath, responseBodyTextPath, ...rest } = flow;
  return rest;
}

class CaptureStore extends EventEmitter {
  constructor() {
    super();
    this.flows = [];
  }

  createFlow(partial) {
    const now = Date.now();
    const flow = {
      id: crypto.randomUUID(),
      startedAt: now,
      completedAt: null,
      method: "GET",
      scheme: "http",
      host: "",
      port: null,
      path: "/",
      query: "",
      statusCode: null,
      protocol: "HTTP/1.1",
      source: "proxy",
      durationMs: null,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: "",
      requestBodyTextPath: "",
      requestBodyPreviewTruncated: false,
      requestBodyDecodedSize: 0,
      responseBodyPreview: "",
      responseBodyTextPath: "",
      responseBodyPreviewTruncated: false,
      responseBodyDecodedSize: 0,
      requestSize: 0,
      responseSize: 0,
      errorType: "",
      tags: [],
      ...partial,
    };

    this.flows.unshift(flow);
    if (this.flows.length > 500) {
      const removed = this.flows.splice(500);
      removed.forEach((item) => {
        deleteBodyFile(item.requestBodyTextPath);
        deleteBodyFile(item.responseBodyTextPath);
      });
    }
    this.emit("changed", flow);
    return flow;
  }

  updateFlow(id, patch) {
    const flow = this.flows.find((item) => item.id === id);
    if (!flow) {
      return null;
    }

    Object.assign(flow, patch);
    this.emit("changed", flow);
    return flow;
  }

  list() {
    return this.flows.slice(0, 500).map(publicFlow);
  }

  get(id) {
    return this.flows.find((item) => item.id === id) || null;
  }

  clear() {
    this.flows.forEach((flow) => {
      deleteBodyFile(flow.requestBodyTextPath);
      deleteBodyFile(flow.responseBodyTextPath);
    });
    this.flows = [];
    this.emit("cleared");
  }
}

module.exports = { CaptureStore };

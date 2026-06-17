export type SseEventRow = {
  index: number;
  event: string;
  id: string;
  retry: string;
  data: string;
  raw: string;
  arrivedAt?: number;
  complete: boolean;
};

export type SseEventSummaryField = {
  label: string;
  value: string;
};

export type SseEventDataSummary = {
  kind: "empty" | "json" | "text";
  shape: string;
  signal: string;
  summary: string;
  fields: SseEventSummaryField[];
};

export type SseEventDataParseResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    };

const primaryFieldKeys = [
  "stage",
  "current_stage",
  "currentStage",
  "phase",
  "status",
  "state",
  "type",
  "event",
  "action",
  "step",
  "progress",
  "percent",
  "stages",
  "message",
  "msg",
  "error",
  "code",
  "task_id",
  "taskId",
  "input_type",
  "inputType",
  "id",
];

const detailFieldKeys = [
  "task_id",
  "taskId",
  "id",
  "request_id",
  "requestId",
  "trace_id",
  "traceId",
  "input_type",
  "inputType",
  "stage",
  "current_stage",
  "currentStage",
  "phase",
  "status",
  "state",
  "step",
  "progress",
  "percent",
  "stages",
  "message",
  "msg",
  "error",
  "code",
];

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateMiddle(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  if (limit <= 3) {
    return value.slice(0, limit);
  }
  const head = Math.ceil((limit - 3) * 0.62);
  const tail = Math.max(limit - 3 - head, 0);
  return `${value.slice(0, head)}...${tail ? value.slice(-tail) : ""}`;
}

function previewString(value: string, limit = 96) {
  return truncateMiddle(collapseWhitespace(value), limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatJsonValue(value: unknown, limit = 96): string {
  if (typeof value === "string") {
    return previewString(value, limit);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const prefix = `${value.length} items`;
    const primitiveItems = value
      .filter((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 3)
      .map((item) => formatJsonValue(item, 32));
    return primitiveItems.length ? `${prefix}: ${primitiveItems.join(", ")}` : prefix;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return `${keys.length} keys${keys[0] ? ` {${keys[0]}}` : ""}`;
  }
  return previewString(String(value), limit);
}

function jsonShape(value: unknown) {
  if (Array.isArray(value)) {
    return `array ${value.length} items`;
  }
  if (isRecord(value)) {
    return `object ${Object.keys(value).length} keys`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function uniqueFields(fields: SseEventSummaryField[]) {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = field.label.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectObjectSummaryFields(record: Record<string, unknown>) {
  const preferred = detailFieldKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => ({
      label: key,
      value: formatJsonValue(record[key], 120),
    }));
  const fallback = Object.keys(record)
    .filter((key) => !detailFieldKeys.includes(key))
    .slice(0, 4)
    .map((key) => ({
      label: key,
      value: formatJsonValue(record[key], 96),
    }));

  return uniqueFields([...preferred, ...fallback]).slice(0, 8);
}

function pickSignalField(record: Record<string, unknown>, fields: SseEventSummaryField[]) {
  const primaryKey = primaryFieldKeys.find((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (primaryKey) {
    return {
      label: primaryKey,
      value: formatJsonValue(record[primaryKey], 72),
    };
  }
  return fields[0] || null;
}

export function parseSseEventData(data: string): SseEventDataParseResult {
  const trimmed = data.trim();
  if (!trimmed) {
    return { ok: false };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(trimmed),
    };
  } catch {
    return { ok: false };
  }
}

export function summarizeSseEventData(data: string): SseEventDataSummary {
  const trimmed = data.trim();
  if (!trimmed) {
    return {
      kind: "empty",
      shape: "empty",
      signal: "empty",
      summary: "empty data",
      fields: [],
    };
  }

  const parsed = parseSseEventData(trimmed);
  if (!parsed.ok) {
    const summary = previewString(trimmed, 180);
    return {
      kind: "text",
      shape: "text",
      signal: summary || "text",
      summary: summary || "text data",
      fields: [],
    };
  }

  const value = parsed.value;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const fields = collectObjectSummaryFields(value);
    const signalField = pickSignalField(value, fields);
    const summaryParts = [`${keys.length} keys`, ...fields.slice(0, 4).map((field) => `${field.label}: ${field.value}`)];

    return {
      kind: "json",
      shape: jsonShape(value),
      signal: signalField ? `${signalField.label}: ${signalField.value}` : `${keys.length} keys`,
      summary: summaryParts.join(" | "),
      fields,
    };
  }

  if (Array.isArray(value)) {
    const firstRecord = value.find(isRecord);
    const fields = firstRecord ? collectObjectSummaryFields(firstRecord).map((field) => ({
      label: `first.${field.label}`,
      value: field.value,
    })) : [];
    const firstPreview = value.length ? formatJsonValue(value[0], 96) : "";

    return {
      kind: "json",
      shape: jsonShape(value),
      signal: `${value.length} items`,
      summary: firstPreview ? `${value.length} items | first: ${firstPreview}` : `${value.length} items`,
      fields,
    };
  }

  const primitive = formatJsonValue(value, 140);
  return {
    kind: "json",
    shape: jsonShape(value),
    signal: primitive,
    summary: primitive,
    fields: [],
  };
}

export function parseSseEvents(content: string): SseEventRow[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.trim() || normalized.startsWith("[streaming response open]")) {
    return [];
  }

  const rows: SseEventRow[] = [];
  let eventName = "message";
  let id = "";
  let retry = "";
  let dataLines: string[] = [];
  let rawLines: string[] = [];

  const flush = (complete: boolean) => {
    if (!rawLines.length && !dataLines.length && eventName === "message" && !id && !retry) {
      return;
    }
    rows.push({
      index: rows.length + 1,
      event: eventName || "message",
      id,
      retry,
      data: dataLines.join("\n"),
      raw: rawLines.join("\n"),
      complete,
    });
    eventName = "message";
    id = "";
    retry = "";
    dataLines = [];
    rawLines = [];
  };

  for (const line of normalized.split("\n")) {
    if (line === "") {
      flush(true);
      continue;
    }
    rawLines.push(line);
    if (line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      eventName = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id") {
      id = value;
    } else if (field === "retry") {
      retry = value;
    }
  }

  flush(false);
  return rows;
}

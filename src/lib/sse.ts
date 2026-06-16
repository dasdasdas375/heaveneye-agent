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

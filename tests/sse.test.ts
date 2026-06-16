import { describe, expect, it } from "vitest";
import { parseSseEvents } from "../src/lib/sse";

describe("parseSseEvents", () => {
  it("parses named server-sent events", () => {
    const events = parseSseEvents(
      'event: progress\nid: 1\ndata: {"percent":30}\n\n' +
        'event: done\nid: 2\ndata: {"ok":true}\n\n',
    );

    expect(events).toMatchObject([
      { index: 1, event: "progress", id: "1", data: '{"percent":30}', complete: true },
      { index: 2, event: "done", id: "2", data: '{"ok":true}', complete: true },
    ]);
  });

  it("joins multiline data and defaults to message", () => {
    const events = parseSseEvents("data: first\ndata: second\nretry: 1000\n\n");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "message",
      retry: "1000",
      data: "first\nsecond",
      complete: true,
    });
  });

  it("keeps incomplete trailing events visible", () => {
    const events = parseSseEvents("event: progress\ndata: still-running");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "progress",
      data: "still-running",
      complete: false,
    });
  });

  it("does not treat the open placeholder as an event", () => {
    expect(parseSseEvents("[streaming response open]\ncontent-type: text/event-stream")).toEqual([]);
  });
});

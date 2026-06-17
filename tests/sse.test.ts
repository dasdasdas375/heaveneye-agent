import { describe, expect, it } from "vitest";
import { parseSseEvents, summarizeSseEventData } from "../src/lib/sse";

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

  it("summarizes structured JSON event data", () => {
    const summary = summarizeSseEventData(
      JSON.stringify({
        task_id: "f067d39e-9232-4063-99cc-b98c2c4f3e6d",
        input_type: "file",
        stages: ["parsing", "planning_summary", "planning_outline"],
        status: "running",
      }),
    );

    expect(summary).toMatchObject({
      kind: "json",
      shape: "object 4 keys",
      signal: "status: running",
    });
    expect(summary.summary).toContain("task_id: f067d39e");
    expect(summary.summary).toContain("stages: 3 items");
    expect(summary.fields).toEqual(
      expect.arrayContaining([
        { label: "task_id", value: "f067d39e-9232-4063-99cc-b98c2c4f3e6d" },
        { label: "input_type", value: "file" },
        { label: "stages", value: "3 items: parsing, planning_summary, planning_outline" },
      ]),
    );
  });

  it("summarizes plain text event data", () => {
    const summary = summarizeSseEventData("first token\nsecond token");

    expect(summary).toMatchObject({
      kind: "text",
      shape: "text",
      signal: "first token second token",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  buildInspectorViewModel,
  buildInspectorDocumentHtml,
  findInspectorSearchMatches,
  formatInspectorContent,
  highlightTextFragments,
  listInspectorMatches,
  moveInspectorMatchIndex,
  serializeInspectorContent,
  tokenizeInspectorContent,
} from "../src/lib/inspector";

describe("inspector utils", () => {
  it("serializes objects as formatted json for copying", () => {
    expect(serializeInspectorContent({ token: "abc", count: 2 })).toBe('{\n  "token": "abc",\n  "count": 2\n}');
  });

  it("formats json strings as parsed json", () => {
    expect(formatInspectorContent('{"ok":true,"items":[1,2]}')).toEqual({
      content: '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
      language: "json",
    });
  });

  it("keeps plain text bodies readable when they are not json", () => {
    expect(formatInspectorContent("plain text response")).toEqual({
      content: "plain text response",
      language: "text",
    });
  });

  it("builds a popup page with escaped title and formatted content", () => {
    const html = buildInspectorDocumentHtml("Response Headers", { server: "cloudfront", vary: "Accept-Encoding" });

    expect(html).toContain("<title>Response Headers</title>");
    expect(html).toContain("&quot;server&quot;: &quot;cloudfront&quot;");
    expect(html).toContain("language-json");
  });

  it("builds an inline inspector model with formatted json content", () => {
    expect(buildInspectorViewModel("Response Body", '{"ok":true}')).toEqual({
      title: "Response Body",
      content: '{\n  "ok": true\n}',
      language: "json",
    });
  });

  it("tokenizes json content for syntax-highlighted display", () => {
    expect(tokenizeInspectorContent('{\n  "ok": true,\n  "count": 2\n}', "json")).toEqual([
      [{ text: "{", kind: "punctuation" }],
      [
        { text: '  ', kind: "whitespace" },
        { text: '"ok"', kind: "key" },
        { text: ": ", kind: "punctuation" },
        { text: "true", kind: "literal" },
        { text: ",", kind: "punctuation" },
      ],
      [
        { text: '  ', kind: "whitespace" },
        { text: '"count"', kind: "key" },
        { text: ": ", kind: "punctuation" },
        { text: "2", kind: "number" },
      ],
      [{ text: "}", kind: "punctuation" }],
    ]);
  });

  it("finds case-insensitive fuzzy matches across all inspector lines", () => {
    expect(findInspectorSearchMatches('{\n  "host": "app.example.test",\n  "x-host": "edge"\n}', "host")).toEqual({
      totalMatches: 2,
      rangesByLine: [[], [{ start: 3, end: 7 }], [{ start: 5, end: 9 }], []],
    });
  });

  it("splits line fragments for highlighted keyword rendering", () => {
    expect(highlightTextFragments('"app.example.test"', [{ start: 5, end: 11 }], 0)).toEqual([
      { text: '"app.', highlighted: false },
      { text: "exampl", highlighted: true },
      { text: 'e.test"', highlighted: false },
    ]);
  });

  it("lists all searchable matches with line and offset metadata", () => {
    expect(
      listInspectorMatches({
        totalMatches: 2,
        rangesByLine: [[], [{ start: 3, end: 7 }], [{ start: 5, end: 9 }], []],
      }),
    ).toEqual([
      { lineIndex: 1, matchIndex: 0, start: 3, end: 7 },
      { lineIndex: 2, matchIndex: 0, start: 5, end: 9 },
    ]);
  });

  it("wraps current match index when navigating previous and next", () => {
    expect(moveInspectorMatchIndex(0, 3, "previous")).toBe(2);
    expect(moveInspectorMatchIndex(2, 3, "next")).toBe(0);
    expect(moveInspectorMatchIndex(-1, 3, "next")).toBe(0);
  });
});

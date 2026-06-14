type InspectorLanguage = "json" | "text";

export type InspectorContent = {
  content: string;
  language: InspectorLanguage;
};

export type InspectorViewModel = InspectorContent & {
  title: string;
};

export type InspectorTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "punctuation"
  | "whitespace"
  | "text";

export type InspectorToken = {
  text: string;
  kind: InspectorTokenKind;
};

export type InspectorSearchRange = {
  start: number;
  end: number;
};

export type InspectorTextFragment = {
  text: string;
  highlighted: boolean;
};

export type InspectorMatch = InspectorSearchRange & {
  lineIndex: number;
  matchIndex: number;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type JsonLikeParseResult = {
  value: unknown;
  content: string;
};

function firstJsonStart(value: string) {
  const objectIndex = value.indexOf("{");
  const arrayIndex = value.indexOf("[");
  if (objectIndex < 0) {
    return arrayIndex;
  }
  if (arrayIndex < 0) {
    return objectIndex;
  }
  return Math.min(objectIndex, arrayIndex);
}

function completeJsonLikeCandidate(value: string) {
  const start = firstJsonStart(value);
  if (start < 0) {
    return null;
  }

  let candidate = value.slice(start).replace(/\u0000/g, "").trim();
  if (!candidate) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaping = false;
  let lastBalancedEnd = -1;

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if ((char === "}" || char === "]") && stack[stack.length - 1] === char) {
      stack.pop();
      if (!stack.length) {
        lastBalancedEnd = index;
      }
    }
  }

  if (lastBalancedEnd >= 0) {
    return candidate.slice(0, lastBalancedEnd + 1);
  }

  if (inString) {
    candidate += "\"";
  }

  candidate = candidate
    .replace(/[:,]\s*$/g, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/,\s*$/g, "");

  const closers = [...stack].reverse().join("");
  return `${candidate}${closers}`;
}

export function parseJsonLikeContent(value: string): JsonLikeParseResult | null {
  const trimmed = value.replace(/^\uFEFF/, "").trim();
  if (!trimmed || !/^[\s\r\n]*[\[{]/.test(trimmed)) {
    return null;
  }

  const parsed = tryParseJson(trimmed);
  if (parsed !== null) {
    return {
      value: parsed,
      content: JSON.stringify(parsed, null, 2),
    };
  }

  const completed = completeJsonLikeCandidate(trimmed);
  if (!completed || completed === trimmed) {
    return null;
  }

  const repaired = tryParseJson(completed);
  if (repaired === null) {
    return null;
  }

  return {
    value: repaired,
    content: JSON.stringify(repaired, null, 2),
  };
}

export function serializeInspectorContent(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function formatInspectorContent(value: unknown): InspectorContent {
  if (typeof value === "string") {
    const parsed = parseJsonLikeContent(value);
    if (parsed) {
      return {
        content: parsed.content,
        language: "json",
      };
    }
    return {
      content: value,
      language: "text",
    };
  }

  return {
    content: JSON.stringify(value, null, 2),
    language: "json",
  };
}

export function buildInspectorDocumentHtml(title: string, value: unknown) {
  const { content, language } = formatInspectorContent(value);
  const escapedTitle = escapeHtml(title);
  const escapedContent = escapeHtml(content);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101214;
      color: #ecf0f3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #101214;
    }
    main {
      display: grid;
      gap: 16px;
      min-height: 100vh;
      padding: 24px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 26px;
    }
    .hint {
      color: #8d9aa7;
      font-size: 12px;
      line-height: 18px;
    }
    pre {
      margin: 0;
      padding: 18px;
      border: 1px solid #2b3036;
      border-radius: 8px;
      background: #14191e;
      color: #c6d1db;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 20px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapedTitle}</h1>
      <div class="hint">language-${language}</div>
    </header>
    <pre class="language-${language}">${escapedContent}</pre>
  </main>
</body>
</html>`;
}

export function buildInspectorViewModel(title: string, value: unknown): InspectorViewModel {
  return {
    title,
    ...formatInspectorContent(value),
  };
}

export function tokenizeInspectorContent(content: string, language: InspectorLanguage): InspectorToken[][] {
  if (language !== "json") {
    return content.split("\n").map((line) => [{ text: line, kind: "text" }]);
  }

  return content.split("\n").map((line) => {
    const tokens: InspectorToken[] = [];
    let rest = line;

    while (rest.length > 0) {
      const whitespaceMatch = rest.match(/^\s+/);
      if (whitespaceMatch) {
        tokens.push({ text: whitespaceMatch[0], kind: "whitespace" });
        rest = rest.slice(whitespaceMatch[0].length);
        continue;
      }

      const keyMatch = rest.match(/^"([^"\\]|\\.)*"(?=:\s)/);
      if (keyMatch) {
        tokens.push({ text: keyMatch[0], kind: "key" });
        rest = rest.slice(keyMatch[0].length);
        continue;
      }

      const stringMatch = rest.match(/^"([^"\\]|\\.)*"/);
      if (stringMatch) {
        tokens.push({ text: stringMatch[0], kind: "string" });
        rest = rest.slice(stringMatch[0].length);
        continue;
      }

      const numberMatch = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (numberMatch) {
        tokens.push({ text: numberMatch[0], kind: "number" });
        rest = rest.slice(numberMatch[0].length);
        continue;
      }

      const literalMatch = rest.match(/^(true|false|null)/);
      if (literalMatch) {
        tokens.push({ text: literalMatch[0], kind: "literal" });
        rest = rest.slice(literalMatch[0].length);
        continue;
      }

      const punctuationMatch = rest.match(/^[:[\]{}., ]+/);
      if (punctuationMatch) {
        tokens.push({ text: punctuationMatch[0], kind: "punctuation" });
        rest = rest.slice(punctuationMatch[0].length);
        continue;
      }

      tokens.push({ text: rest[0], kind: "text" });
      rest = rest.slice(1);
    }

    return tokens;
  });
}

function normalizeSearchTerms(query: string) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function findInspectorSearchMatches(content: string, query: string) {
  const lines = content.split("\n");
  const terms = normalizeSearchTerms(query);

  if (!terms.length) {
    return {
      totalMatches: 0,
      rangesByLine: lines.map(() => [] as InspectorSearchRange[]),
    };
  }

  let totalMatches = 0;
  const rangesByLine = lines.map((line) => {
    const lowerLine = line.toLowerCase();
    const ranges: InspectorSearchRange[] = [];

    for (const term of terms) {
      let startIndex = 0;
      while (startIndex < lowerLine.length) {
        const matchIndex = lowerLine.indexOf(term, startIndex);
        if (matchIndex === -1) {
          break;
        }
        ranges.push({ start: matchIndex, end: matchIndex + term.length });
        totalMatches += 1;
        startIndex = matchIndex + term.length;
      }
    }

    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    return ranges;
  });

  return {
    totalMatches,
    rangesByLine,
  };
}

export function highlightTextFragments(
  text: string,
  ranges: InspectorSearchRange[],
  startOffset = 0,
): InspectorTextFragment[] {
  if (!text.length) {
    return [];
  }

  const fragments: InspectorTextFragment[] = [];
  let cursor = 0;
  const tokenStart = startOffset;
  const tokenEnd = startOffset + text.length;

  for (const range of ranges) {
    const overlapStart = Math.max(range.start, tokenStart);
    const overlapEnd = Math.min(range.end, tokenEnd);

    if (overlapStart >= overlapEnd) {
      continue;
    }

    const localStart = overlapStart - tokenStart;
    const localEnd = overlapEnd - tokenStart;

    if (localStart > cursor) {
      fragments.push({ text: text.slice(cursor, localStart), highlighted: false });
    }
    fragments.push({ text: text.slice(localStart, localEnd), highlighted: true });
    cursor = localEnd;
  }

  if (cursor < text.length) {
    fragments.push({ text: text.slice(cursor), highlighted: false });
  }

  return fragments.length ? fragments : [{ text, highlighted: false }];
}

export function listInspectorMatches(searchMatches: {
  totalMatches: number;
  rangesByLine: InspectorSearchRange[][];
}): InspectorMatch[] {
  return searchMatches.rangesByLine.flatMap((ranges, lineIndex) =>
    ranges.map((range, matchIndex) => ({
      lineIndex,
      matchIndex,
      ...range,
    })),
  );
}

export function moveInspectorMatchIndex(
  currentIndex: number,
  totalMatches: number,
  direction: "previous" | "next",
) {
  if (totalMatches <= 0) {
    return -1;
  }
  if (currentIndex < 0) {
    return direction === "previous" ? totalMatches - 1 : 0;
  }
  return direction === "previous"
    ? (currentIndex - 1 + totalMatches) % totalMatches
    : (currentIndex + 1) % totalMatches;
}

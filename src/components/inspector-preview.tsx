import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  findInspectorSearchMatches,
  highlightTextFragments,
  listInspectorMatches,
  moveInspectorMatchIndex,
  parseJsonLikeContent,
  tokenizeInspectorContent,
} from "../lib/inspector";
import type { InspectorSearchRange } from "../lib/inspector";

type InspectorLanguage = "json" | "text";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonSearchField = "key" | "summary" | "value";

type JsonSearchMatch = InspectorSearchRange & {
  path: string;
  field: JsonSearchField;
  matchIndex: number;
  ancestorPaths: string[];
  childLimitHints: Record<string, number>;
};

type JsonSearchBuckets = Partial<Record<JsonSearchField, JsonSearchMatch[]>>;

export type InspectorPayloadMeta = {
  mode?: "preview" | "body";
  previewBytes?: number;
  decodedBytes?: number;
  capturedBytes?: number;
  truncated?: boolean;
};

const inlineTextLineLimit = 180;
const fullTextLineLimit = 900;
const jsonInlineDepth = 2;
const jsonFullDepth = 2;
const maxInitialExpandedNodes = 140;
const defaultChildLimit = 80;
const nestedChildLimit = 36;

function tryParseJson(content: string): JsonValue | null {
  return (parseJsonLikeContent(content)?.value as JsonValue | undefined) ?? null;
}

function isContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object";
}

function containerEntries(value: JsonValue[] | { [key: string]: JsonValue }) {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
}

function childPath(path: string, key: string) {
  return `${path}/${encodeURIComponent(key)}`;
}

function collectExpandedPaths(value: JsonValue, maxDepth: number) {
  const paths = new Set<string>();
  let count = 0;

  function walk(item: JsonValue, path: string, depth: number) {
    if (!isContainer(item) || depth > maxDepth || count >= maxInitialExpandedNodes) {
      return;
    }
    paths.add(path);
    count += 1;
    if (depth === maxDepth) {
      return;
    }
    for (const [key, child] of containerEntries(item)) {
      walk(child, childPath(path, key), depth + 1);
      if (count >= maxInitialExpandedNodes) {
        return;
      }
    }
  }

  walk(value, "$", 0);
  return paths;
}

function byteLabel(value?: number) {
  if (!value || value < 0) {
    return "0 B";
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function payloadMetaText(meta?: InspectorPayloadMeta) {
  if (!meta) {
    return "";
  }
  const parts = [`${meta.mode === "body" ? "body" : "preview"} ${byteLabel(meta.previewBytes)}`];
  if (meta.decodedBytes && meta.decodedBytes !== meta.previewBytes) {
    parts.push(`decoded ${byteLabel(meta.decodedBytes)}`);
  }
  if (meta.capturedBytes && meta.capturedBytes !== meta.decodedBytes) {
    parts.push(`captured ${byteLabel(meta.capturedBytes)}`);
  }
  return parts.join(" / ");
}

function primitiveClass(value: JsonValue) {
  if (value === null || typeof value === "boolean") {
    return "json-literal";
  }
  if (typeof value === "number") {
    return "json-number";
  }
  return "json-string";
}

function displayJsonKey(key: string, parentIsArray = false) {
  if (parentIsArray && /^\d+$/.test(key)) {
    return key;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function primitivePreview(value: JsonValue, limit = 72) {
  if (typeof value === "string") {
    const trimmed = value.length > limit ? `${value.slice(0, limit)}...` : value;
    return `"${trimmed.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function primitiveSearchText(value: JsonValue) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function findSearchRanges(value: string, query: string): InspectorSearchRange[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const haystack = value.toLowerCase();
  const ranges: InspectorSearchRange[] = [];
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) {
      break;
    }
    ranges.push({ start: index, end: index + needle.length });
    start = index + Math.max(needle.length, 1);
  }
  return ranges;
}

function collectJsonSearchMatches(value: JsonValue, query: string): JsonSearchMatch[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const matches: JsonSearchMatch[] = [];

  function addMatches(
    text: string,
    path: string,
    field: JsonSearchField,
    ancestorPaths: string[],
    childLimitHints: Record<string, number>,
  ) {
    findSearchRanges(text, trimmedQuery).forEach((range) => {
      matches.push({
        ...range,
        path,
        field,
        matchIndex: matches.length,
        ancestorPaths,
        childLimitHints,
      });
    });
  }

  function walk(
    item: JsonValue,
    path: string,
    name: string | undefined,
    parentIsArray: boolean,
    ancestorPaths: string[],
    childLimitHints: Record<string, number>,
  ) {
    if (name !== undefined) {
      addMatches(displayJsonKey(name, parentIsArray), path, "key", ancestorPaths, childLimitHints);
    }

    if (!isContainer(item)) {
      addMatches(primitiveSearchText(item), path, "value", ancestorPaths, childLimitHints);
      return;
    }

    addMatches(inlineJsonPreview(item), path, "summary", ancestorPaths, childLimitHints);

    const entries = containerEntries(item);
    const isArray = Array.isArray(item);
    entries.forEach(([key, child], index) => {
      const nextPath = childPath(path, key);
      walk(child, nextPath, key, isArray, [...ancestorPaths, path], {
        ...childLimitHints,
        [path]: index + 1,
      });
    });
  }

  walk(value, "$", undefined, false, [], {});
  return matches;
}

function groupJsonSearchMatches(matches: JsonSearchMatch[]) {
  const byPath = new Map<string, JsonSearchBuckets>();
  matches.forEach((match) => {
    const bucket = byPath.get(match.path) || {};
    bucket[match.field] = [...(bucket[match.field] || []), match];
    byPath.set(match.path, bucket);
  });
  return byPath;
}

function renderJsonHighlightedText(
  text: string,
  matches: JsonSearchMatch[] | undefined,
  activeMatchIndex: number,
  activeMatchRef: (node: HTMLElement | null) => void,
) {
  if (!matches?.length) {
    return text;
  }

  const sorted = [...matches].sort((left, right) => left.start - right.start || left.end - right.end);
  const nodes: ReactNode[] = [];
  let cursor = 0;

  sorted.forEach((match) => {
    if (match.start > cursor) {
      nodes.push(text.slice(cursor, match.start));
    }
    const active = match.matchIndex === activeMatchIndex;
    nodes.push(
      <mark
        key={`${match.field}-${match.start}-${match.end}-${match.matchIndex}`}
        ref={active ? activeMatchRef : undefined}
        className={active ? "json-hit active" : "json-hit"}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function inlineJsonPreview(value: JsonValue, depth = 0): string {
  if (!isContainer(value)) {
    return primitivePreview(value, depth > 0 ? 52 : 72);
  }

  if (Array.isArray(value)) {
    if (depth >= 1) {
      return `Array(${value.length})`;
    }
    const visible = value.slice(0, 4).map((item) => inlineJsonPreview(item, depth + 1));
    return `[${visible.join(", ")}${value.length > visible.length ? ", ..." : ""}]`;
  }

  const entries = Object.entries(value);
  if (depth >= 2) {
    return `{${entries.length} keys}`;
  }
  const visible = entries.slice(0, depth === 0 ? 6 : 4).map(([key, item]) => {
    const nextValue = isContainer(item) && Array.isArray(item) ? `Array(${item.length})` : inlineJsonPreview(item, depth + 1);
    return `${displayJsonKey(key)}: ${nextValue}`;
  });
  return `{${visible.join(", ")}${entries.length > visible.length ? ", ..." : ""}}`;
}

function PrimitiveValue({
  value,
  matches,
  activeMatchIndex,
  activeMatchRef,
}: {
  value: JsonValue;
  matches?: JsonSearchMatch[];
  activeMatchIndex: number;
  activeMatchRef: (node: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (typeof value === "string") {
    const long = value.length > 420;
    const forceExpanded = Boolean(matches?.length);
    const displayValue = long && !expanded && !forceExpanded ? `${value.slice(0, 420)}...` : value;
    return (
      <>
        <span className="json-string">
          "
          {renderJsonHighlightedText(displayValue, matches, activeMatchIndex, activeMatchRef)}
          "
        </span>
        {long && !forceExpanded ? (
          <button type="button" className="json-inline-toggle" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </>
    );
  }
  return (
    <span className={primitiveClass(value)}>
      {renderJsonHighlightedText(primitiveSearchText(value), matches, activeMatchIndex, activeMatchRef)}
    </span>
  );
}

function JsonNode({
  name,
  value,
  depth,
  path,
  expandedPaths,
  childLimits,
  onToggle,
  onShowMore,
  searchBuckets,
  activeMatchIndex,
  activeMatchRef,
  parentIsArray = false,
}: {
  name?: string;
  value: JsonValue;
  depth: number;
  path: string;
  expandedPaths: Set<string>;
  childLimits: Record<string, number>;
  onToggle: (path: string) => void;
  onShowMore: (path: string, nextLimit: number) => void;
  searchBuckets: Map<string, JsonSearchBuckets>;
  activeMatchIndex: number;
  activeMatchRef: (node: HTMLElement | null) => void;
  parentIsArray?: boolean;
}) {
  const rowMatches = searchBuckets.get(path);
  const hasRowMatch = Boolean(rowMatches?.key?.length || rowMatches?.summary?.length || rowMatches?.value?.length);
  const isActiveRow = Boolean(
    rowMatches &&
      Object.values(rowMatches).some((matches) =>
        matches?.some((match) => match.matchIndex === activeMatchIndex),
      ),
  );

  if (!isContainer(value)) {
    return (
      <div
        className={["json-row primitive", hasRowMatch ? "has-match" : "", isActiveRow ? "active-match" : ""]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: depth * 14 }}
      >
        {name !== undefined ? (
          <span className="json-key">
            {renderJsonHighlightedText(displayJsonKey(name, parentIsArray), rowMatches?.key, activeMatchIndex, activeMatchRef)}:
          </span>
        ) : null}
        <PrimitiveValue
          value={value}
          matches={rowMatches?.value}
          activeMatchIndex={activeMatchIndex}
          activeMatchRef={activeMatchRef}
        />
      </div>
    );
  }

  const entries = containerEntries(value);
  const isArray = Array.isArray(value);
  const isExpanded = expandedPaths.has(path);
  const childLimit = childLimits[path] ?? (depth <= 1 ? defaultChildLimit : nestedChildLimit);
  const visibleEntries = entries.slice(0, childLimit);
  const remaining = entries.length - visibleEntries.length;

  return (
    <div className="json-node">
      <button
        type="button"
        className={["json-row container", hasRowMatch ? "has-match" : "", isActiveRow ? "active-match" : ""]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: depth * 14 }}
        aria-expanded={isExpanded}
        onClick={() => onToggle(path)}
      >
        <ChevronRight size={14} className={isExpanded ? "open" : ""} />
        {name !== undefined ? (
          <span className="json-key">
            {renderJsonHighlightedText(displayJsonKey(name, parentIsArray), rowMatches?.key, activeMatchIndex, activeMatchRef)}:
          </span>
        ) : null}
        <span className="json-count">
          {isArray ? `${entries.length} items` : `${entries.length} keys`}
        </span>
        <span className="json-summary">
          {renderJsonHighlightedText(inlineJsonPreview(value), rowMatches?.summary, activeMatchIndex, activeMatchRef)}
        </span>
      </button>
      {isExpanded ? (
        <div className="json-children">
          {visibleEntries.map(([key, child]) => (
            <JsonNode
              key={childPath(path, key)}
              name={key}
              value={child}
              depth={depth + 1}
              path={childPath(path, key)}
              expandedPaths={expandedPaths}
              childLimits={childLimits}
              onToggle={onToggle}
              onShowMore={onShowMore}
              searchBuckets={searchBuckets}
              activeMatchIndex={activeMatchIndex}
              activeMatchRef={activeMatchRef}
              parentIsArray={isArray}
            />
          ))}
          {remaining > 0 ? (
            <button
              type="button"
              className="json-show-more"
              style={{ marginLeft: (depth + 1) * 14 }}
              onClick={() => onShowMore(path, Math.min(entries.length, childLimit + defaultChildLimit))}
            >
              显示更多 {Math.min(defaultChildLimit, remaining)} 项，剩余 {remaining}
            </button>
          ) : null}
          <div className="json-row closing" style={{ paddingLeft: depth * 14 }}>
            <span className="json-brace">{isArray ? "]" : "}"}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function JsonInspector({
  content,
  variant,
  meta,
}: {
  content: string;
  variant: "inline" | "full";
  meta?: InspectorPayloadMeta;
}) {
  const parsed = useMemo(() => tryParseJson(content), [content]);
  const initialDepth = variant === "full" ? jsonFullDepth : jsonInlineDepth;
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    parsed === null ? new Set() : collectExpandedPaths(parsed, initialDepth),
  );
  const [childLimits, setChildLimits] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const activeMatchElementRef = useRef<HTMLElement | null>(null);
  const jsonSearchMatches = useMemo(
    () => (parsed === null ? [] : collectJsonSearchMatches(parsed, searchQuery)),
    [parsed, searchQuery],
  );
  const searchBuckets = useMemo(() => groupJsonSearchMatches(jsonSearchMatches), [jsonSearchMatches]);

  useEffect(() => {
    setExpandedPaths(parsed === null ? new Set() : collectExpandedPaths(parsed, initialDepth));
    setChildLimits({});
  }, [parsed, initialDepth]);

  useEffect(() => {
    setActiveMatchIndex(jsonSearchMatches.length ? 0 : -1);
  }, [searchQuery, jsonSearchMatches.length]);

  useEffect(() => {
    if (parsed === null || searchQuery.trim()) {
      return;
    }
    setExpandedPaths(collectExpandedPaths(parsed, initialDepth));
    setChildLimits({});
  }, [parsed, initialDepth, searchQuery]);

  useEffect(() => {
    const activeMatch = jsonSearchMatches[activeMatchIndex];
    if (!activeMatch) {
      return;
    }

    setExpandedPaths((current) => {
      const next = new Set(current);
      activeMatch.ancestorPaths.forEach((path) => next.add(path));
      return next;
    });
    setChildLimits((current) => {
      const next = { ...current };
      Object.entries(activeMatch.childLimitHints).forEach(([path, limit]) => {
        next[path] = Math.max(next[path] || 0, limit);
      });
      return next;
    });
  }, [activeMatchIndex, jsonSearchMatches]);

  useEffect(() => {
    if (activeMatchIndex < 0) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      activeMatchElementRef.current?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMatchIndex, expandedPaths, childLimits]);

  if (parsed === null) {
    return <TextInspector content={content} language="text" variant={variant} meta={meta} />;
  }

  const metaText = payloadMetaText(meta);

  return (
    <div className={variant === "full" ? "json-inspector full" : "json-inspector inline"}>
      <div className="json-toolbar">
        <div className="inspector-viewer-meta">
          <span className="inspector-chip accent">JSON</span>
          {metaText ? <span className={meta?.truncated ? "inspector-chip warn" : "inspector-chip"}>{metaText}</span> : null}
          {meta?.truncated ? <span className="inspector-chip warn">preview truncated</span> : null}
        </div>
        {variant === "full" ? (
          <label className="inspector-viewer-search">
            <Search size={14} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索 JSON 内容"
            />
            <span className="inspector-search-count">
              {jsonSearchMatches.length ? `${activeMatchIndex + 1}/${jsonSearchMatches.length}` : "0 matches"}
            </span>
            <button
              type="button"
              className="inline-code-action compact"
              disabled={!jsonSearchMatches.length}
              onClick={() =>
                setActiveMatchIndex((current) => moveInspectorMatchIndex(current, jsonSearchMatches.length, "previous"))
              }
            >
              上一处
            </button>
            <button
              type="button"
              className="inline-code-action compact"
              disabled={!jsonSearchMatches.length}
              onClick={() =>
                setActiveMatchIndex((current) => moveInspectorMatchIndex(current, jsonSearchMatches.length, "next"))
              }
            >
              下一处
            </button>
          </label>
        ) : null}
      </div>
      <div className="json-tree-surface">
        <JsonNode
          value={parsed}
          depth={0}
          path="$"
          expandedPaths={expandedPaths}
          childLimits={childLimits}
          searchBuckets={searchBuckets}
          activeMatchIndex={activeMatchIndex}
          activeMatchRef={(node) => {
            activeMatchElementRef.current = node;
          }}
          onToggle={(path) =>
            setExpandedPaths((current) => {
              const next = new Set(current);
              if (next.has(path)) {
                next.delete(path);
              } else {
                next.add(path);
              }
              return next;
            })
          }
          onShowMore={(path, nextLimit) =>
            setChildLimits((current) => ({
              ...current,
              [path]: nextLimit,
            }))
          }
        />
      </div>
    </div>
  );
}

function TextInspector({
  content,
  language,
  variant,
  meta,
}: {
  content: string;
  language: InspectorLanguage;
  variant: "inline" | "full";
  meta?: InspectorPayloadMeta;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showFull, setShowFull] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const activeMatchRef = useRef<HTMLDivElement | null>(null);
  const lineLimit = variant === "full" ? fullTextLineLimit : inlineTextLineLimit;
  const allLines = useMemo(() => content.split("\n"), [content]);
  const isLimited = !showFull && allLines.length > lineLimit;
  const visibleContent = useMemo(
    () => (isLimited ? allLines.slice(0, lineLimit).join("\n") : content),
    [allLines, content, isLimited, lineLimit],
  );
  const lines = useMemo(() => tokenizeInspectorContent(visibleContent, language), [visibleContent, language]);
  const searchMatches = useMemo(
    () => findInspectorSearchMatches(visibleContent, searchQuery),
    [visibleContent, searchQuery],
  );
  const matchList = useMemo(() => listInspectorMatches(searchMatches), [searchMatches]);
  const metaText = payloadMetaText(meta);

  useEffect(() => {
    setActiveMatchIndex(matchList.length ? 0 : -1);
  }, [searchQuery, visibleContent, matchList.length]);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [activeMatchIndex]);

  return (
    <div className={variant === "full" ? "text-inspector full" : "text-inspector inline"}>
      <div className="inspector-viewer-toolbar">
        <div className="inspector-viewer-meta">
          <span className="inspector-chip accent">{language.toUpperCase()}</span>
          <span className="inspector-chip">{allLines.length} lines</span>
          {metaText ? <span className={meta?.truncated ? "inspector-chip warn" : "inspector-chip"}>{metaText}</span> : null}
          {meta?.truncated ? <span className="inspector-chip warn">preview truncated</span> : null}
          {isLimited ? <span className="inspector-chip warn">showing first {lineLimit}</span> : null}
        </div>
        {variant === "full" ? (
          <label className="inspector-viewer-search">
            <Search size={14} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="检索当前已渲染内容"
            />
            <span className="inspector-search-count">
              {matchList.length ? `${activeMatchIndex + 1}/${matchList.length}` : "0 matches"}
            </span>
            <button
              type="button"
              className="inline-code-action compact"
              disabled={!matchList.length}
              onClick={() =>
                setActiveMatchIndex((current) => moveInspectorMatchIndex(current, matchList.length, "previous"))
              }
            >
              上一处
            </button>
            <button
              type="button"
              className="inline-code-action compact"
              disabled={!matchList.length}
              onClick={() => setActiveMatchIndex((current) => moveInspectorMatchIndex(current, matchList.length, "next"))}
            >
              下一处
            </button>
          </label>
        ) : null}
      </div>
      <div className={`inspector-code-surface language-${language}`}>
        {lines.map((line, index) => (
          <div
            key={`line-${index}`}
            className={searchMatches.rangesByLine[index].length ? "inspector-code-line has-match" : "inspector-code-line"}
          >
            <span className="inspector-line-number">{index + 1}</span>
            <code className="inspector-line-content">
              {line.length ? (
                (() => {
                  let lineOffset = 0;
                  return line.map((token, tokenIndex) => {
                    const tokenStart = lineOffset;
                    const fragments = highlightTextFragments(
                      token.text,
                      searchMatches.rangesByLine[index],
                      lineOffset,
                    );
                    lineOffset += token.text.length;

                    return (
                      <span key={`${index}-${tokenIndex}`} className={`token-${token.kind}`}>
                        {fragments.map((fragment, fragmentIndex) => {
                          const fragmentStart =
                            tokenStart +
                            fragments.slice(0, fragmentIndex).reduce((sum, item) => sum + item.text.length, 0);
                          const fragmentEnd = fragmentStart + fragment.text.length;
                          const globalMatchIndex = fragment.highlighted
                            ? matchList.findIndex(
                                (match) =>
                                  match.lineIndex === index &&
                                  match.start === fragmentStart &&
                                  match.end === fragmentEnd,
                              )
                            : -1;

                          return (
                            <mark
                              key={`${index}-${tokenIndex}-${fragmentIndex}`}
                              ref={globalMatchIndex === activeMatchIndex ? activeMatchRef : undefined}
                              className={
                                fragment.highlighted
                                  ? globalMatchIndex === activeMatchIndex
                                    ? "inspector-hit active"
                                    : "inspector-hit"
                                  : "inspector-fragment"
                              }
                            >
                              {fragment.text}
                            </mark>
                          );
                        })}
                      </span>
                    );
                  });
                })()
              ) : (
                <span className="token-text"> </span>
              )}
            </code>
          </div>
        ))}
        {allLines.length > lineLimit ? (
          <div className="inspector-show-full">
            <button type="button" className="inline-code-action" onClick={() => setShowFull((current) => !current)}>
              {showFull ? "收起长文本" : `显示全部 ${allLines.length} 行`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InspectorPreview({
  content,
  language,
  meta,
}: {
  content: string;
  language: InspectorLanguage;
  meta?: InspectorPayloadMeta;
}) {
  if (language === "json") {
    return <JsonInspector content={content} variant="inline" meta={meta} />;
  }
  return <TextInspector content={content} language={language} variant="inline" meta={meta} />;
}

export function InspectorViewer({
  title,
  content,
  language,
  meta,
}: {
  title: string;
  content: string;
  language: InspectorLanguage;
  meta?: InspectorPayloadMeta;
}) {
  return (
    <div className="inspector-viewer" aria-label={title}>
      {language === "json" ? (
        <JsonInspector content={content} variant="full" meta={meta} />
      ) : (
        <TextInspector content={content} language={language} variant="full" meta={meta} />
      )}
    </div>
  );
}

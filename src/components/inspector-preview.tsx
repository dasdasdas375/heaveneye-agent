import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  findInspectorSearchMatches,
  highlightTextFragments,
  listInspectorMatches,
  moveInspectorMatchIndex,
  parseJsonLikeContent,
  tokenizeInspectorContent,
} from "../lib/inspector";

type InspectorLanguage = "json" | "text";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

function PrimitiveValue({ value }: { value: JsonValue }) {
  const [expanded, setExpanded] = useState(false);
  if (typeof value === "string") {
    const long = value.length > 420;
    const displayValue = long && !expanded ? `${value.slice(0, 420)}...` : value;
    return (
      <>
        <span className="json-string">"{displayValue}"</span>
        {long ? (
          <button type="button" className="json-inline-toggle" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : "展开"}
          </button>
        ) : null}
      </>
    );
  }
  return <span className={primitiveClass(value)}>{String(value)}</span>;
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
  parentIsArray?: boolean;
}) {
  if (!isContainer(value)) {
    return (
      <div className="json-row primitive" style={{ paddingLeft: depth * 14 }}>
        {name !== undefined ? <span className="json-key">{displayJsonKey(name, parentIsArray)}:</span> : null}
        <PrimitiveValue value={value} />
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
        className="json-row container"
        style={{ paddingLeft: depth * 14 }}
        aria-expanded={isExpanded}
        onClick={() => onToggle(path)}
      >
        <ChevronRight size={14} className={isExpanded ? "open" : ""} />
        {name !== undefined ? <span className="json-key">{displayJsonKey(name, parentIsArray)}:</span> : null}
        <span className="json-count">
          {isArray ? `${entries.length} items` : `${entries.length} keys`}
        </span>
        <span className="json-summary">{inlineJsonPreview(value)}</span>
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

  useEffect(() => {
    setExpandedPaths(parsed === null ? new Set() : collectExpandedPaths(parsed, initialDepth));
    setChildLimits({});
  }, [parsed, initialDepth]);

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
      </div>
      <div className="json-tree-surface">
        <JsonNode
          value={parsed}
          depth={0}
          path="$"
          expandedPaths={expandedPaths}
          childLimits={childLimits}
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

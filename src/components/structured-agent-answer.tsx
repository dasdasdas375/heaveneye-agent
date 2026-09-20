import { Copy } from "lucide-react";

import type { AgentStructuredAnswer } from "../types";

function normalizedCopyValue(value: string) {
  return value.trim().replace(/\s+/g, "");
}

export function StructuredAgentAnswer({
  answer, copiedKey, narrative, onCopy,
}: {
  answer: AgentStructuredAnswer;
  copiedKey: string | null;
  narrative?: string;
  onCopy: (value: string, key: string) => void;
}) {
  const highlights = answer.highlights || [];
  const evidence = answer.evidence || [];
  const testCases = answer.testCases || [];
  // Streaming text and structured analysis can be two copies of the same answer.
  // Prefer the original text, including for previously saved conversations.
  const body = narrative?.trim() || [answer.summary, ...new Set(answer.analysis || [])]
    .filter((item, index) => item && (index === 0 || item !== answer.summary)).join("\n\n");
  const paragraphs = body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const highlightedValues = new Set(highlights.map((item) => normalizedCopyValue(item.value)).filter(Boolean));
  const sources = highlights.filter((item) => item.source);

  return (
    <div className="structured-answer">
      {paragraphs.length ? (
        <section className="answer-section answer-narrative" aria-label="回答">
          {paragraphs.map((paragraph, index) => (
            <p className={index === 0 ? "answer-conclusion" : undefined} key={index}>{paragraph}</p>
          ))}
        </section>
      ) : null}

      {highlights.length || evidence.length ? (
        <details className="answer-sources">
          <summary>查看接口与字段证据{evidence.length ? `（${evidence.length}）` : ""}</summary>
          <div className="answer-points">
            {highlights.map((item, index) => {
              const copyKey = `highlight-${index}-${item.label}`;
              return (
                <button key={copyKey} type="button" className={`answer-point ${item.kind || "other"}`}
                  onClick={() => onCopy(item.value, copyKey)} title="点击复制">
                  <span className="highlight-label">{item.label}</span>
                  <strong>{item.value}</strong>
                  <span className="copy-status">{copiedKey === copyKey ? "已复制" : "复制"}<Copy size={12} /></span>
                </button>
              );
            })}
          </div>
          <div className="evidence-list">
            {evidence.map((item, index) => (
              <EvidenceCard key={`${item.host}-${item.path}-${index}`} item={item} index={index}
                sources={sources} highlightedValues={highlightedValues} copiedKey={copiedKey} onCopy={onCopy} />
            ))}
          </div>
        </details>
      ) : null}

      {testCases.length ? (
        <section className="answer-detail-block">
          <div className="answer-detail-title">测试用例</div>
          <div className="test-case-list">
            {testCases.map((item, index) => (
              <article className="test-case-card" key={`${item.name}-${index}`}>
                <strong>{item.name}</strong>
                {item.purpose ? <p>{item.purpose}</p> : null}
                <div>{[item.method, item.url].filter(Boolean).join(" ") || "沿用原请求"}</div>
                {item.expected ? <small>{item.expected}</small> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EvidenceCard({
  item,
  index,
  sources,
  highlightedValues,
  copiedKey,
  onCopy,
}: {
  item: NonNullable<AgentStructuredAnswer["evidence"]>[number];
  index: number;
  sources: NonNullable<AgentStructuredAnswer["highlights"]>;
  highlightedValues: Set<string>;
  copiedKey: string | null;
  onCopy: (value: string, key: string) => void;
}) {
  const interfaceInfo = [
    { label: "请求时间", value: item.time || "" },
    { label: "接口", value: `${item.host || ""}${item.path || ""}` },
  ].filter((row) => row.value);
  const uniqueFields = (item.fields || []).filter(
    (field) => !highlightedValues.has(normalizedCopyValue(field.value)),
  );
  const statusLabel = [item.method, item.status].filter(Boolean).join(" ");

  return (
    <details className="evidence-item" open={index === 0}>
      <summary className="evidence-head">
        <span>{item.title || "接口来源"}</span>
        {statusLabel ? <code>{statusLabel}</code> : null}
      </summary>

      <div className="evidence-meta">
        {interfaceInfo.map((row) => {
          const copyKey = `evidence-meta-${index}-${row.label}`;
          return (
            <button key={row.label} type="button" onClick={() => onCopy(String(row.value), copyKey)}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
              <small>{copiedKey === copyKey ? "已复制" : "复制"}</small>
            </button>
          );
        })}
      </div>

      {sources.length ? (
        <div className="field-sources">
          <span>字段来源</span>
          <div>
            {sources.map((source, sourceIndex) => (
              <code key={`${source.label}-${source.source}-${sourceIndex}`}>
                {source.label}: {source.source}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      {uniqueFields.length ? (
        <div className="evidence-fields">
          {uniqueFields.map((field, fieldIndex) => {
            const copyKey = `evidence-${index}-${fieldIndex}-${field.label}`;
            return (
              <button
                key={copyKey}
                type="button"
                onClick={() => onCopy(field.value, copyKey)}
                title="点击复制字段值"
              >
                <span>{field.label}</span>
                <strong>{field.value}</strong>
                <small>{copiedKey === copyKey ? "已复制" : "复制"}</small>
              </button>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}

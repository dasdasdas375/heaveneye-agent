import { Copy } from "lucide-react";

import type { AgentStructuredAnswer } from "../types";

function normalizedCopyValue(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function buildNarrativeParagraphs(narrative: string | undefined, summary: string | undefined) {
  return (narrative || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && part !== (summary || "").trim());
}

export function StructuredAgentAnswer({
  answer,
  copiedKey,
  narrative,
  onCopy,
}: {
  answer: AgentStructuredAnswer;
  copiedKey: string | null;
  narrative?: string;
  onCopy: (value: string, key: string) => void;
}) {
  const highlights = answer.highlights || [];
  const evidence = answer.evidence || [];
  const analysis = answer.analysis || [];
  const testCases = answer.testCases || [];
  const highlightedValues = new Set(highlights.map((item) => normalizedCopyValue(item.value)).filter(Boolean));
  const sources = highlights.filter((item) => item.source);
  const narrativeParagraphs = buildNarrativeParagraphs(narrative, answer.summary);
  const leadAnalysis = highlights.length ? [] : analysis.slice(0, 3);
  const detailAnalysis = highlights.length ? analysis : analysis.slice(leadAnalysis.length);
  const hasLead = Boolean(highlights.length || leadAnalysis.length || answer.summary);
  const hasDetail = Boolean(narrativeParagraphs.length || detailAnalysis.length || evidence.length || testCases.length);

  return (
    <div className="structured-answer">
      {hasLead ? (
        <section className="answer-section answer-lead">
          <div className="answer-section-title">回答要点</div>
          {answer.summary ? <p className="answer-summary">{answer.summary}</p> : null}
          <div className="answer-points">
            {highlights.map((item, index) => {
              const copyKey = `highlight-${index}-${item.label}`;
              return (
                <button
                  key={copyKey}
                  type="button"
                  className={`answer-point ${item.kind || "other"}`}
                  onClick={() => onCopy(item.value, copyKey)}
                  title="点击复制"
                >
                  <span className="highlight-label">{item.label}</span>
                  <strong>{item.value}</strong>
                  <span className="copy-status">
                    {copiedKey === copyKey ? "已复制" : "复制"}
                    <Copy size={12} />
                  </span>
                </button>
              );
            })}
            {!highlights.length && leadAnalysis.length ? (
              <ul className="analysis-list is-compact">
                {leadAnalysis.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {hasDetail ? (
        <section className="answer-section answer-detail-flow">
          <div className="answer-section-title">详解</div>
          {narrativeParagraphs.length ? (
            <div className="answer-narrative">
              {narrativeParagraphs.map((paragraph, index) => (
                <p key={`${paragraph}-${index}`}>{paragraph}</p>
              ))}
            </div>
          ) : null}

          {detailAnalysis.length ? (
            <div className="answer-detail-block">
              <div className="answer-detail-title">判断与建议</div>
              <ul className="analysis-list">
                {detailAnalysis.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {testCases.length ? (
            <div className="answer-detail-block">
              <div className="answer-detail-title">测试用例</div>
              <div className="test-case-list">
                {testCases.map((item, index) => (
                  <article className="test-case-card" key={`${item.name}-${index}`}>
                    <strong>{item.name}</strong>
                    {item.purpose ? <p>{item.purpose}</p> : null}
                    <div>
                      {[item.method, item.url].filter(Boolean).join(" ") || "沿用原请求"}
                    </div>
                    {item.expected ? <small>{item.expected}</small> : null}
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {evidence.length ? (
            <div className="answer-detail-block">
              <div className="answer-detail-title">证据接口</div>
              <div className="evidence-list">
                {evidence.map((item, index) => (
                  <EvidenceCard
                    key={`${item.host}-${item.path}-${index}`}
                    item={item}
                    index={index}
                    sources={sources}
                    highlightedValues={highlightedValues}
                    copiedKey={copiedKey}
                    onCopy={onCopy}
                  />
                ))}
              </div>
            </div>
          ) : null}
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

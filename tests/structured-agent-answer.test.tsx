import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StructuredAgentAnswer } from "../src/components/structured-agent-answer";
import type { AgentStructuredAnswer } from "../src/types";

describe("structured agent answer", () => {
  it("renders key points before detailed explanation", () => {
    const answer: AgentStructuredAnswer = {
      summary: "今日没有失败接口，但视频渲染链路存在明显慢请求。",
      highlights: [
        { label: "最慢 API", value: "POST /demo-compose/api/chat_video/{vid}/get_result (2459ms)" },
        { label: "最慢资源", value: "GET media.example.test/.../video_generation.mp4 (8989ms)" },
      ],
      analysis: [
        "主瓶颈集中在大文件传输和媒体资源加载。",
        "接口本身无失败，但需要优先排查 CDN 缓存命中率。",
      ],
      evidence: [
        {
          title: "证据接口",
          time: "10:24:51",
          method: "POST",
          status: 200,
          host: "api.example.test",
          path: "/demo-compose/api/chat_video/{vid}/get_result",
          fields: [{ label: "duration", value: "2459ms" }],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <StructuredAgentAnswer answer={answer} copiedKey={null} narrative="先给结论，再给排查建议。" onCopy={() => undefined} />,
    );

    expect(markup).toContain("回答要点");
    expect(markup).toContain("详解");
    expect(markup.indexOf("回答要点")).toBeLessThan(markup.indexOf("详解"));
    expect(markup).toContain("先给结论，再给排查建议。");
    expect(markup).toContain("最慢 API");
    expect(markup).toContain("证据接口");
  });

  it("keeps highlight values out of duplicated evidence fields", () => {
    const answer: AgentStructuredAnswer = {
      highlights: [{ label: "uid", value: "u_123456" }],
      evidence: [
        {
          title: "登录接口",
          host: "app.example.test",
          path: "/api/login",
          fields: [
            { label: "uid", value: "u_123456" },
            { label: "device", value: "ios" },
          ],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <StructuredAgentAnswer answer={answer} copiedKey={null} onCopy={() => undefined} />,
    );

    expect(markup).toContain("u_123456");
    expect(markup).toContain("device");
    expect(markup).not.toContain('title="点击复制字段值"><span>uid</span><strong>u_123456</strong>');
  });
});

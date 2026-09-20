import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StructuredAgentAnswer } from "../src/components/structured-agent-answer";
import type { AgentStructuredAnswer } from "../src/types";

describe("structured agent answer", () => {
  it("does not repeat streamed sentences as summary and analysis", () => {
    const conclusion = "当前登录账号的 ID 为 1。";
    const proof = "依据：\n- GET /api/auth/me 返回 200，responseBody.user.id = 1。";
    const markup = renderToStaticMarkup(
      <StructuredAgentAnswer answer={{ summary: conclusion, analysis: [conclusion, proof] }}
        copiedKey={null} narrative={`${conclusion}\n\n${proof}`} onCopy={() => undefined} />,
    );
    expect(markup.split(conclusion)).toHaveLength(2);
    expect(markup.split("responseBody.user.id = 1")).toHaveLength(2);
    expect(markup).not.toContain("详解");
  });

  it("keeps structured-only next steps and test cases", () => {
    const markup = renderToStaticMarkup(
      <StructuredAgentAnswer answer={{ summary: "证据不足", analysis: ["证据不足", "请重新抓取登录请求"],
        testCases: [{ name: "缺少参数", expected: "返回 400" }] }} copiedKey={null} onCopy={() => undefined} />,
    );
    expect(markup.split("证据不足")).toHaveLength(2);
    expect(markup).toContain("请重新抓取登录请求");
    expect(markup).toContain("缺少参数");
    expect(markup).toContain("返回 400");
  });

  it("renders one narrative with evidence collapsed by default", () => {
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

    expect(markup).toContain('<details class="answer-sources">');
    expect(markup).not.toContain("判断与建议");
    expect(markup).not.toContain(answer.summary);
    expect(markup).not.toContain(answer.analysis![0]);
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

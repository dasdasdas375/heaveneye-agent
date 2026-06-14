import { describe, expect, it } from "vitest";

import { formatSpeechRecognitionError, shouldAutoClearError } from "../src/lib/ui-errors";

describe("ui error utils", () => {
  it("treats speech recognition failures as transient", () => {
    expect(shouldAutoClearError("语音识别失败，请检查麦克风权限或直接输入文字。")).toBe(true);
  });

  it("keeps long-running backend and certificate errors visible", () => {
    expect(shouldAutoClearError("Root CA is not trusted. HTTPS target requests will fail as CONNECT 502 until it is trusted.")).toBe(
      false,
    );
    expect(shouldAutoClearError("No desktop backend is available. Start the app through Tauri or Electron preload.")).toBe(
      false,
    );
  });

  it("formats speech recognition errors with actionable reason codes", () => {
    expect(formatSpeechRecognitionError("not-allowed")).toContain("麦克风或语音识别权限被拒绝");
    expect(formatSpeechRecognitionError("audio-capture")).toContain("没有可用的麦克风输入设备");
    expect(formatSpeechRecognitionError("network")).toContain("语音识别服务不可用");
  });
});

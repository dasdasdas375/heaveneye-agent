const transientErrorPatterns = [
  /语音识别失败/i,
  /不支持语音识别/i,
  /复制失败/i,
  /浏览器拦截了新窗口/i,
  /AI API Key is not configured/i,
  /Qwen API Key is not configured/i,
  /QWEN_API_KEY is not configured/i,
  /Open AI settings/i,
];

const speechRecognitionReasonMap: Record<string, string> = {
  "not-allowed": "麦克风或语音识别权限被拒绝",
  "service-not-allowed": "系统未允许当前应用使用语音识别服务",
  "audio-capture": "没有可用的麦克风输入设备",
  network: "语音识别服务不可用",
  aborted: "语音识别被中断",
  "no-speech": "没有检测到语音输入",
};

export function shouldAutoClearError(message: string) {
  return transientErrorPatterns.some((pattern) => pattern.test(message));
}

export function formatSpeechRecognitionError(errorCode?: string) {
  const reason = errorCode ? speechRecognitionReasonMap[errorCode] ?? `未知错误：${errorCode}` : "未知错误";
  return `语音识别失败：${reason}。请检查系统设置里的麦克风与语音识别权限，或直接输入文字。`;
}

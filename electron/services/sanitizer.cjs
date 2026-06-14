const SENSITIVE_HEADER_PATTERN = /authorization|cookie|set-cookie|token|secret|password|session/i;
const TOKEN_PATTERN = /(access_token|refresh_token|id_token|token|password|secret)["'=:\s]+([^"',\s}]+)/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CN_PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_PATTERN.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

function redactText(value = "") {
  if (!value) {
    return "";
  }

  return String(value)
    .replace(TOKEN_PATTERN, "$1: [REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(CN_PHONE_PATTERN, "[REDACTED_PHONE]");
}

function redactFlow(flow) {
  if (!flow) {
    return flow;
  }

  return {
    ...flow,
    requestHeaders: redactHeaders(flow.requestHeaders),
    responseHeaders: redactHeaders(flow.responseHeaders),
    requestBodyPreview: redactText(flow.requestBodyPreview),
    responseBodyPreview: redactText(flow.responseBodyPreview),
  };
}

module.exports = { redactFlow, redactHeaders, redactText };


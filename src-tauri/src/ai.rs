use crate::models::{
    AgentAttachment, AgentChatMessage, AgentEvidence, AgentEvidenceField, AgentHighlight,
    AgentStructuredAnswer, AgentTestCase, AiResult, AiUsage, AppConfig, CaptureFlow,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_AGENT_FLOWS: usize = 14;
const MAX_BODY_CHARS: usize = 1800;
const MAX_JSON_CONTEXT_NODES: usize = 90;

#[derive(Clone)]
pub struct AiService {
    config: AppConfig,
    client: Client,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    model: Option<String>,
    choices: Option<Vec<ChatChoice>>,
    usage: Option<AiUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: Option<ChatMessageContent>,
}

#[derive(Deserialize)]
struct ChatMessageContent {
    content: Option<Value>,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    model: Option<String>,
    content: Option<Vec<AnthropicContentBlock>>,
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    usage_metadata: Option<GeminiUsage>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiUsage {
    prompt_token_count: Option<u32>,
    candidates_token_count: Option<u32>,
    total_token_count: Option<u32>,
}

impl AiService {
    pub fn new(config: &AppConfig) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            config: config.clone(),
            client,
        })
    }

    pub async fn test_connection(&self) -> Result<Value, String> {
        let result = self
            .chat(
                vec![
                    chat_message("system", Value::String("You are a concise diagnostics assistant.".into())),
                    chat_message(
                        "user",
                        Value::String(
                            "Reply with one short Chinese sentence confirming the AI connection works.".into(),
                        ),
                    ),
                ],
                json!({ "temperature": 0.0, "enable_thinking": false }),
            )
            .await?;

        Ok(json!({
            "ok": true,
            "model": result.model,
            "message": result.content,
            "usage": result.usage
        }))
    }

    pub async fn analyze_failures(&self, flows: Vec<CaptureFlow>) -> Result<AiResult, String> {
        let relevant_flows: Vec<CaptureFlow> = flows
            .into_iter()
            .filter(|flow| {
                flow.status_code.unwrap_or_default() >= 400
                    || !flow.error_type.is_empty()
                    || flow.duration_ms.unwrap_or_default() > 1000
            })
            .take(30)
            .collect();

        if relevant_flows.is_empty() {
            return Ok(AiResult {
                model: self.config.qwen.model.clone(),
                content: "当前会话没有明显失败请求或慢请求。".into(),
                structured: None,
                usage: None,
            });
        }

        self.chat(
            vec![
                chat_message(
                    "system",
                    Value::String(
                        "你是面向开发和测试团队的本地抓包调试 Agent。你需要基于抓包流量给出简洁、证据明确、可复现的诊断结论。不要编造不存在的字段，不要输出与抓包证据无关的免责声明。".into(),
                    ),
                ),
                chat_message(
                    "user",
                    Value::String(format!(
                        "请分析这些失败或慢请求，输出：1. 主要结论 2. 证据请求 3. 可能原因 4. 建议下一步。\n\n{}",
                        serde_json::to_string_pretty(&relevant_flows).unwrap_or_else(|_| "[]".into())
                    )),
                ),
            ],
            json!({ "enable_thinking": false }),
        )
        .await
    }

    pub async fn compare_flows(
        &self,
        left: CaptureFlow,
        right: CaptureFlow,
    ) -> Result<AiResult, String> {
        self.chat(
            vec![
                chat_message(
                    "system",
                    Value::String(
                        "你是 HTTP 请求差异分析助手。请比较两个抓包请求的关键差异，重点关注 method、url、headers、query、body、status、response 和 timing。".into(),
                    ),
                ),
                chat_message(
                    "user",
                    Value::String(format!(
                        "请比较这两个请求，指出可能导致行为不同的差异。\n\nA:\n{}\n\nB:\n{}",
                        serde_json::to_string_pretty(&left).unwrap_or_else(|_| "{}".into()),
                        serde_json::to_string_pretty(&right).unwrap_or_else(|_| "{}".into())
                    )),
                ),
            ],
            json!({ "enable_thinking": false }),
        )
        .await
    }

    pub async fn generate_bug_report(
        &self,
        flows: Vec<CaptureFlow>,
        note: Option<String>,
    ) -> Result<AiResult, String> {
        let relevant_flows: Vec<CaptureFlow> = flows
            .into_iter()
            .filter(|flow| {
                flow.status_code.unwrap_or_default() >= 400
                    || !flow.error_type.is_empty()
                    || flow.tags.iter().any(|tag| tag == "selected")
            })
            .take(20)
            .collect();

        self.chat(
            vec![
                chat_message(
                    "system",
                    Value::String(
                        "你是 QA 缺陷报告助手。请把本地抓包证据整理成 Markdown 缺陷报告，包含标题、摘要、环境、复现步骤、实际结果、期望结果、关键请求、初步判断。不要输出与抓包证据无关的免责声明，不要编造不存在的字段。".into(),
                    ),
                ),
                chat_message(
                    "user",
                    Value::String(format!(
                        "补充说明：{}\n\n抓包请求：\n{}",
                        note.unwrap_or_else(|| "无".into()),
                        serde_json::to_string_pretty(&relevant_flows).unwrap_or_else(|_| "[]".into())
                    )),
                ),
            ],
            json!({ "enable_thinking": false }),
        )
        .await
    }

    pub async fn ask_agent(
        &self,
        question: String,
        flows: Vec<CaptureFlow>,
        history: Vec<AgentChatMessage>,
        attachments: Vec<AgentAttachment>,
    ) -> Result<AiResult, String> {
        let trimmed_question = question.trim().to_string();
        if trimmed_question.is_empty() {
            return Ok(AiResult {
                model: self.config.qwen.model.clone(),
                content: "请输入你想分析的问题，例如“帮我找一下最新登录账号的 uid”。".into(),
                structured: None,
                usage: None,
            });
        }

        let has_images = attachments
            .iter()
            .any(|item| item.data_url.starts_with("data:image/"));
        let context = build_agent_context(&flows, &trimmed_question);
        let result = self
            .chat(
                [
                    vec![chat_message(
                        "system",
                        Value::String(
                            "你是 HeavenEye Agent（天眼抓包 Agent），一个运行在用户本机、面向研发和测试的抓包调试助手。你的职责是替代用户手动翻浏览器 F12 Network：只基于本地抓包上下文和图片证据回答，不要编造，不要输出与抓包证据无关的免责声明、合规说明、风险提醒或注意事项。如果图片证据显示 Chrome F12 Network/EventStream 中存在 SSE，而抓包上下文没有对应 flow，必须明确区分“浏览器 F12 证明页面有 SSE”和“HeavenEye 当前上下文未捕获到这条 SSE”，不要简单回答“没有 SSE”。用户询问账号、uid、token、header、cookie、报错接口、慢接口时，如果抓包上下文中真实存在对应字段，就按字段原文和证据接口列出；如果上下文不足，就明确说明还没有捕获到哪些接口。用户要求接口测试时，先基于真实 request 参数、headers、body 和 response 设计低风险用例，再把可执行的参数变体放入 testCases；每个用例必须相对原请求可发送，不要生成破坏性、扣费、删除、批量写入类用例。必须返回严格 JSON，不要 Markdown，不要代码块。JSON 结构为：{\"summary\":\"一句话结论，优先回答用户最关心的问题\",\"highlights\":[{\"label\":\"账号|密码|Token|UID|报错接口|慢接口等\",\"value\":\"可复制的核心值\",\"kind\":\"uid|account|password|token|error|url|field|status|time|other\",\"source\":\"字段来源，如 requestBody.email 或 responseBody.data.token\"}],\"evidence\":[{\"title\":\"证据名称\",\"time\":\"请求时间\",\"method\":\"GET/POST\",\"status\":200,\"host\":\"域名\",\"path\":\"路径和 query\",\"fields\":[{\"label\":\"字段路径\",\"value\":\"字段值\"}]}],\"analysis\":[\"简短分析或下一步\"],\"testCases\":[{\"name\":\"用例名\",\"purpose\":\"为什么测\",\"method\":\"GET/POST，可省略则沿用原请求\",\"url\":\"完整 URL，可省略则沿用原请求\",\"headers\":{\"x-demo\":\"value，可省略\"},\"query\":{\"key\":\"value，可省略\"},\"body\":{\"字段\":\"值；可省略或字符串\"},\"expected\":\"预期状态/字段/行为\"}]}。highlights 必须只放用户最需要复制的核心元素，并放在最前；evidence 只说明这些值从哪个接口、什么时间、什么状态取到，fields 只放未在 highlights 重复展示的补充字段；非接口测试问题不要返回 testCases，接口测试最多 5 个用例。".into(),
                        ),
                    )],
                    normalize_history(history),
                    vec![chat_message(
                        "user",
                        build_user_content(&trimmed_question, &context, &attachments),
                    )],
                ]
                .concat(),
                json!({
                    "model": if has_images { self.config.qwen.vision_model.clone() } else { self.config.qwen.model.clone() },
                    "temperature": 0.1,
                    "enable_thinking": false
                }),
            )
            .await?;

        let parsed = extract_json_object(&result.content);
        let structured = normalize_structured_answer(parsed, &result.content);
        Ok(AiResult {
            model: result.model,
            content: format_structured_content(&structured),
            structured: Some(structured),
            usage: result.usage,
        })
    }

    async fn chat(&self, messages: Vec<Value>, options: Value) -> Result<AiResult, String> {
        if self.config.qwen.api_key.trim().is_empty() {
            return Err("AI API Key is not configured. Open AI settings and save a key.".into());
        }

        let model = options
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.qwen.model)
            .to_string();

        match ai_provider_kind(&self.config.qwen.provider) {
            "anthropic" => return self.chat_anthropic(messages, options, model).await,
            "gemini" => return self.chat_gemini(messages, options, model).await,
            _ => {}
        }

        let mut body = json!({
            "model": model,
            "messages": messages,
            "temperature": options.get("temperature").cloned().unwrap_or_else(|| json!(0.2))
        });
        if provider_supports_enable_thinking(&self.config.qwen.provider) {
            if let Some(enable_thinking) = options.get("enable_thinking") {
                body["enable_thinking"] = enable_thinking.clone();
            }
        }

        let response = self
            .client
            .post(format!(
                "{}/chat/completions",
                self.config.qwen.base_url.trim_end_matches('/')
            ))
            .header("authorization", format!("Bearer {}", self.config.qwen.api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "AI request timed out. Try narrowing the question or clearing unrelated captures.".to_string()
                } else {
                    error.to_string()
                }
            })?;

        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("AI request failed: {} {}", status.as_u16(), text));
        }

        let payload: ChatCompletionResponse =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        let content = payload
            .choices
            .and_then(|choices| choices.into_iter().next())
            .and_then(|choice| choice.message)
            .and_then(|message| message.content)
            .map(content_to_text)
            .unwrap_or_default();

        Ok(AiResult {
            model: payload
                .model
                .unwrap_or_else(|| self.config.qwen.model.clone()),
            content: strip_irrelevant_disclaimer(&content),
            structured: None,
            usage: payload.usage,
        })
    }

    async fn chat_anthropic(
        &self,
        messages: Vec<Value>,
        options: Value,
        model: String,
    ) -> Result<AiResult, String> {
        let (system, messages) = to_anthropic_messages(messages);
        let mut body = json!({
            "model": model,
            "max_tokens": 4096,
            "messages": messages,
            "temperature": options.get("temperature").cloned().unwrap_or_else(|| json!(0.2))
        });
        if !system.is_empty() {
            body["system"] = Value::String(system);
        }

        let response = self
            .client
            .post(format!("{}/messages", self.config.qwen.base_url.trim_end_matches('/')))
            .header("x-api-key", self.config.qwen.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "AI request timed out. Try narrowing the question or clearing unrelated captures.".to_string()
                } else {
                    error.to_string()
                }
            })?;

        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("AI request failed: {} {}", status.as_u16(), text));
        }
        let payload: AnthropicResponse =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        let content = payload
            .content
            .unwrap_or_default()
            .into_iter()
            .filter_map(|block| block.text)
            .collect::<Vec<_>>()
            .join("\n");
        let usage = payload.usage.map(|usage| AiUsage {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: match (usage.input_tokens, usage.output_tokens) {
                (Some(input), Some(output)) => Some(input + output),
                _ => None,
            },
        });

        Ok(AiResult {
            model: payload
                .model
                .unwrap_or_else(|| self.config.qwen.model.clone()),
            content: strip_irrelevant_disclaimer(&content),
            structured: None,
            usage,
        })
    }

    async fn chat_gemini(
        &self,
        messages: Vec<Value>,
        options: Value,
        model: String,
    ) -> Result<AiResult, String> {
        let (system_instruction, contents) = to_gemini_contents(messages);
        let mut body = json!({
            "contents": contents,
            "generationConfig": {
                "temperature": options.get("temperature").cloned().unwrap_or_else(|| json!(0.2))
            }
        });
        if let Some(system_instruction) = system_instruction {
            body["systemInstruction"] = json!({ "parts": [{ "text": system_instruction }] });
        }

        let endpoint = format!(
            "{}/models/{}:generateContent?key={}",
            self.config.qwen.base_url.trim_end_matches('/'),
            model,
            self.config.qwen.api_key.trim()
        );
        let response = self
            .client
            .post(endpoint)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "AI request timed out. Try narrowing the question or clearing unrelated captures.".to_string()
                } else {
                    error.to_string()
                }
            })?;

        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("AI request failed: {} {}", status.as_u16(), text));
        }
        let payload: GeminiResponse =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        let content = payload
            .candidates
            .unwrap_or_default()
            .into_iter()
            .filter_map(|candidate| candidate.content)
            .flat_map(|content| content.parts.unwrap_or_default())
            .filter_map(|part| part.text)
            .collect::<Vec<_>>()
            .join("\n");
        let usage = payload.usage_metadata.map(|usage| AiUsage {
            prompt_tokens: usage.prompt_token_count,
            completion_tokens: usage.candidates_token_count,
            total_tokens: usage.total_token_count,
        });

        Ok(AiResult {
            model: self.config.qwen.model.clone(),
            content: strip_irrelevant_disclaimer(&content),
            structured: None,
            usage,
        })
    }
}

fn ai_provider_kind(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => "anthropic",
        "google" | "gemini" => "gemini",
        _ => "openai-compatible",
    }
}

fn provider_supports_enable_thinking(provider: &str) -> bool {
    matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "qwen" | "dashscope"
    )
}

fn to_anthropic_messages(messages: Vec<Value>) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut result = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        if role == "system" {
            system.push(content_to_text(content));
            continue;
        }
        result.push(json!({
            "role": if role == "assistant" { "assistant" } else { "user" },
            "content": to_anthropic_content_blocks(content)
        }));
    }
    (system.join("\n\n"), result)
}

fn to_anthropic_content_blocks(content: Value) -> Vec<Value> {
    match content {
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        Value::Array(items) => items
            .into_iter()
            .filter_map(
                |item| match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text" => item
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|text| json!({ "type": "text", "text": text })),
                    "image_url" => item
                        .get("image_url")
                        .and_then(|image| image.get("url"))
                        .and_then(Value::as_str)
                        .and_then(parse_data_url)
                        .map(|(media_type, data)| {
                            json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data
                                }
                            })
                        }),
                    _ => None,
                },
            )
            .collect(),
        other => vec![json!({ "type": "text", "text": content_to_text(other) })],
    }
}

fn to_gemini_contents(messages: Vec<Value>) -> (Option<String>, Vec<Value>) {
    let mut system = Vec::new();
    let mut contents = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        if role == "system" {
            system.push(content_to_text(content));
            continue;
        }
        contents.push(json!({
            "role": if role == "assistant" { "model" } else { "user" },
            "parts": to_gemini_parts(content)
        }));
    }
    let system_instruction = if system.is_empty() {
        None
    } else {
        Some(system.join("\n\n"))
    };
    (system_instruction, contents)
}

fn to_gemini_parts(content: Value) -> Vec<Value> {
    match content {
        Value::String(text) => vec![json!({ "text": text })],
        Value::Array(items) => items
            .into_iter()
            .filter_map(
                |item| match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text" => item
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|text| json!({ "text": text })),
                    "image_url" => item
                        .get("image_url")
                        .and_then(|image| image.get("url"))
                        .and_then(Value::as_str)
                        .and_then(parse_data_url)
                        .map(|(media_type, data)| {
                            json!({
                                "inlineData": {
                                    "mimeType": media_type,
                                    "data": data
                                }
                            })
                        }),
                    _ => None,
                },
            )
            .collect(),
        other => vec![json!({ "text": content_to_text(other) })],
    }
}

fn parse_data_url(value: &str) -> Option<(String, String)> {
    let rest = value.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if !meta.to_ascii_lowercase().contains(";base64") {
        return None;
    }
    let media_type = meta
        .split(';')
        .next()
        .filter(|item| !item.is_empty())
        .unwrap_or("image/png")
        .to_string();
    Some((media_type, data.to_string()))
}

fn chat_message(role: &str, content: Value) -> Value {
    json!({
        "role": role,
        "content": content
    })
}

fn content_to_text(value: Value) -> String {
    match value {
        Value::String(text) => text,
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let sliced = value.chars().take(limit).collect::<String>();
    format!(
        "{sliced}\n...[truncated {} chars]",
        value.chars().count().saturating_sub(limit)
    )
}

fn safe_date(timestamp: u64) -> String {
    let seconds = timestamp / 1000;
    format!("unix:{seconds}")
}

fn is_same_local_day(timestamp: u64, reference: u64) -> bool {
    let day = timestamp / 86_400_000;
    let ref_day = reference / 86_400_000;
    day == ref_day
}

fn body_for_context(flow: &CaptureFlow, direction: &str) -> String {
    let (headers, body) = if direction == "response" {
        (&flow.response_headers, &flow.response_body_preview)
    } else {
        (&flow.request_headers, &flow.request_body_preview)
    };
    let content_type = headers
        .get("content-type")
        .or_else(|| headers.get("Content-Type"))
        .cloned()
        .unwrap_or_default();
    if body.is_empty() {
        return String::new();
    }
    let is_request_form = direction == "request" && content_type.contains("form");
    if !text_content_pattern(&content_type) && !is_request_form && !looks_like_json(body) {
        return format!(
            "[{direction} body omitted: non-text content {}]",
            if content_type.is_empty() {
                "unknown"
            } else {
                &content_type
            }
        );
    }
    if body.chars().count() > MAX_BODY_CHARS {
        if let Some(summary) = summarize_json_body_for_context(body) {
            return summary;
        }
    }
    truncate(body, MAX_BODY_CHARS)
}

fn headers_for_context(headers: &std::collections::HashMap<String, String>) -> Value {
    let mut map = serde_json::Map::new();
    for (index, (key, value)) in headers.iter().enumerate() {
        if index >= 30 {
            break;
        }
        map.insert(key.clone(), Value::String(truncate(value, 1600)));
    }
    Value::Object(map)
}

fn strip_irrelevant_disclaimer(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return trimmed.to_string();
    }
    let disclaimer_keywords = [
        "免责声明",
        "合规",
        "严禁",
        "禁止提供",
        "敏感信息",
        "生产环境",
        "泄露凭证",
    ];
    let blocks: Vec<String> = trimmed
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .filter(|block| {
            !disclaimer_keywords
                .iter()
                .any(|keyword| block.contains(keyword))
        })
        .map(str::to_string)
        .collect();
    if blocks.is_empty() {
        trimmed.to_string()
    } else {
        blocks.join("\n\n")
    }
}

fn extract_json_object(text: &str) -> Option<Value> {
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).ok().or_else(|| {
        let start = cleaned.find('{')?;
        let end = cleaned.rfind('}')?;
        serde_json::from_str(&cleaned[start..=end]).ok()
    })
}

fn as_text(value: Option<&Value>, limit: usize) -> String {
    let text = match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    truncate(&text, limit)
}

fn normalize_structured_answer(
    parsed: Option<Value>,
    fallback_content: &str,
) -> AgentStructuredAnswer {
    let Some(Value::Object(parsed)) = parsed else {
        return AgentStructuredAnswer {
            summary: Some(truncate(fallback_content, 1000)),
            highlights: Some(Vec::new()),
            evidence: Some(Vec::new()),
            analysis: Some(Vec::new()),
            test_cases: Some(Vec::new()),
        };
    };

    let highlights = parsed
        .get("highlights")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let label = as_text(item.get("label"), 80);
                    let value = as_text(item.get("value").or_else(|| item.get("copyValue")), 4000);
                    if label.is_empty() || value.is_empty() {
                        return None;
                    }
                    Some(AgentHighlight {
                        label,
                        value,
                        kind: Some(as_text(item.get("kind"), 30)).filter(|value| !value.is_empty()),
                        source: Some(as_text(item.get("source"), 220))
                            .filter(|value| !value.is_empty()),
                    })
                })
                .take(12)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let evidence = parsed
        .get("evidence")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| AgentEvidence {
                    title: Some(as_text(item.get("title"), 140)).filter(|value| !value.is_empty()),
                    time: Some(as_text(item.get("time"), 80)).filter(|value| !value.is_empty()),
                    method: Some(as_text(item.get("method"), 20)).filter(|value| !value.is_empty()),
                    status: item.get("status").cloned(),
                    host: Some(as_text(item.get("host"), 180)).filter(|value| !value.is_empty()),
                    path: Some(as_text(item.get("path"), 300)).filter(|value| !value.is_empty()),
                    fields: item.get("fields").and_then(Value::as_array).map(|fields| {
                        fields
                            .iter()
                            .filter_map(|field| {
                                let label = as_text(field.get("label"), 120);
                                let value = as_text(field.get("value"), 4000);
                                if label.is_empty() || value.is_empty() {
                                    return None;
                                }
                                Some(AgentEvidenceField { label, value })
                            })
                            .take(12)
                            .collect::<Vec<_>>()
                    }),
                })
                .take(8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let analysis = parsed
        .get("analysis")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| truncate(&content_to_text(item.clone()), 500))
                .filter(|item| !item.is_empty())
                .take(8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let test_cases = parsed
        .get("testCases")
        .or_else(|| parsed.get("test_cases"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = as_text(item.get("name").or_else(|| item.get("title")), 120);
                    if name.is_empty() {
                        return None;
                    }
                    let headers = item
                        .get("headers")
                        .and_then(Value::as_object)
                        .map(|headers| {
                            headers
                                .iter()
                                .filter_map(|(key, value)| {
                                    let header_value = as_text(Some(value), 1000);
                                    if key.trim().is_empty() || header_value.is_empty() {
                                        return None;
                                    }
                                    Some((key.clone(), header_value))
                                })
                                .collect()
                        });
                    let query = item.get("query").and_then(Value::as_object).map(|query| {
                        query
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect()
                    });
                    Some(AgentTestCase {
                        name,
                        purpose: Some(as_text(item.get("purpose"), 500))
                            .filter(|value| !value.is_empty()),
                        method: Some(as_text(item.get("method"), 20))
                            .filter(|value| !value.is_empty()),
                        url: Some(as_text(item.get("url"), 1000)).filter(|value| !value.is_empty()),
                        headers,
                        query,
                        body: item.get("body").cloned(),
                        expected: Some(as_text(item.get("expected"), 800))
                            .filter(|value| !value.is_empty()),
                    })
                })
                .take(5)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    AgentStructuredAnswer {
        summary: Some(
            parsed
                .get("summary")
                .or_else(|| parsed.get("answer"))
                .map(|value| truncate(&content_to_text(value.clone()), 1000))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| truncate(fallback_content, 1000)),
        ),
        highlights: Some(highlights),
        evidence: Some(evidence),
        analysis: Some(analysis),
        test_cases: Some(test_cases),
    }
}

fn format_structured_content(answer: &AgentStructuredAnswer) -> String {
    let mut lines = Vec::new();
    if let Some(summary) = &answer.summary {
        if !summary.is_empty() {
            lines.push(summary.clone());
        }
    }

    if let Some(highlights) = &answer.highlights {
        if !highlights.is_empty() {
            let mut block = vec!["关键结果:".to_string()];
            for item in highlights {
                block.push(format!("{}: {}", item.label, item.value));
            }
            lines.push(block.join("\n"));
        }
    }

    if let Some(evidence) = &answer.evidence {
        if !evidence.is_empty() {
            let mut block = vec!["证据:".to_string()];
            for item in evidence {
                let status = item
                    .status
                    .as_ref()
                    .map(|value| content_to_text(value.clone()))
                    .unwrap_or_default();
                let request = [
                    item.method.clone().unwrap_or_default(),
                    status,
                    item.host.clone().unwrap_or_default(),
                    item.path.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
                let fields = item
                    .fields
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|field| format!("{}:{}", field.label, field.value))
                    .collect::<Vec<_>>()
                    .join(", ");
                if fields.is_empty() {
                    block.push(
                        format!("- {} {}", item.time.clone().unwrap_or_default(), request)
                            .trim()
                            .to_string(),
                    );
                } else {
                    block.push(
                        format!(
                            "- {} {} fields={}",
                            item.time.clone().unwrap_or_default(),
                            request,
                            fields
                        )
                        .trim()
                        .to_string(),
                    );
                }
            }
            lines.push(block.join("\n"));
        }
    }

    if let Some(analysis) = &answer.analysis {
        if !analysis.is_empty() {
            let mut block = vec!["分析:".to_string()];
            for item in analysis {
                block.push(format!("- {item}"));
            }
            lines.push(block.join("\n"));
        }
    }

    if let Some(test_cases) = &answer.test_cases {
        if !test_cases.is_empty() {
            let mut block = vec!["接口测试用例:".to_string()];
            for item in test_cases {
                let target = [
                    item.method.clone().unwrap_or_default(),
                    item.url.clone().unwrap_or_default(),
                ]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
                let expected = item
                    .expected
                    .as_ref()
                    .map(|value| format!(" expected={value}"))
                    .unwrap_or_default();
                block.push(
                    format!("- {} {}{}", item.name, target, expected)
                        .trim()
                        .to_string(),
                );
            }
            lines.push(block.join("\n"));
        }
    }

    lines.join("\n\n")
}

fn text_content_pattern(content_type: &str) -> bool {
    let lowered = content_type.to_ascii_lowercase();
    [
        "json",
        "text",
        "xml",
        "graphql",
        "javascript",
        "event-stream",
    ]
    .iter()
    .any(|item| lowered.contains(item))
}

fn looks_like_json(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

fn try_parse_json(text: &str) -> Option<Value> {
    if !looks_like_json(text) {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn json_primitive_preview(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(truncate(text, 240)),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => Some(String::new()),
    }
}

fn collect_json_context_nodes(value: &Value, path: &str, depth: usize, result: &mut Vec<Value>) {
    if result.len() >= MAX_JSON_CONTEXT_NODES {
        return;
    }

    match value {
        Value::Array(items) => {
            result.push(json!({
                "path": path,
                "type": "array",
                "length": items.len()
            }));
            if depth < 3 {
                for (index, item) in items.iter().take(8).enumerate() {
                    collect_json_context_nodes(
                        item,
                        &format!("{path}[{index}]"),
                        depth + 1,
                        result,
                    );
                    if result.len() >= MAX_JSON_CONTEXT_NODES {
                        return;
                    }
                }
            }
        }
        Value::Object(map) => {
            let keys = map.keys().take(24).cloned().collect::<Vec<_>>();
            result.push(json!({
                "path": path,
                "type": "object",
                "keyCount": map.len(),
                "keys": keys
            }));
            if depth < 3 {
                for (key, item) in map.iter().take(28) {
                    collect_json_context_nodes(item, &format!("{path}.{key}"), depth + 1, result);
                    if result.len() >= MAX_JSON_CONTEXT_NODES {
                        return;
                    }
                }
            }
        }
        _ => {
            result.push(json!({
                "path": path,
                "type": match value {
                    Value::Null => "null",
                    Value::String(_) => "string",
                    Value::Number(_) => "number",
                    Value::Bool(_) => "boolean",
                    _ => "unknown",
                },
                "value": json_primitive_preview(value)
            }));
        }
    }
}

fn summarize_json_body_for_context(body: &str) -> Option<String> {
    let parsed = try_parse_json(body)?;
    let mut nodes = Vec::new();
    collect_json_context_nodes(&parsed, "$", 0, &mut nodes);
    Some(
        json!({
            "mode": "json_tree_summary",
            "note": "Large JSON body summarized as a DevTools-like tree. Use nodes, key counts, lengths, and identityHints instead of assuming the body only contains the first raw characters.",
            "originalPreviewChars": body.chars().count(),
            "nodes": nodes
        })
        .to_string(),
    )
}

fn collect_identity_hints(value: &Value, path: &str, result: &mut Vec<Value>) {
    if result.len() > 80 {
        return;
    }
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().take(30).enumerate() {
                collect_identity_hints(item, &format!("{path}[{index}]"), result);
            }
        }
        Value::Object(map) => {
            for (key, next_value) in map {
                let next_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                let key_matches = [
                    "uid",
                    "user_id",
                    "userid",
                    "userId",
                    "account_id",
                    "accountId",
                    "account",
                    "username",
                    "user_name",
                    "email",
                    "phone",
                    "mobile",
                    "tenant_id",
                    "tenantId",
                    "id",
                ]
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(key));
                if key_matches
                    && matches!(
                        next_value,
                        Value::String(_) | Value::Number(_) | Value::Bool(_)
                    )
                {
                    result.push(json!({
                        "field": next_path,
                        "value": truncate(&content_to_text(next_value.clone()), 240)
                    }));
                }
                if next_value.is_object() || next_value.is_array() {
                    collect_identity_hints(next_value, &next_path, result);
                }
            }
        }
        _ => {}
    }
}

fn extract_identity_hints(flow: &CaptureFlow) -> Vec<Value> {
    [
        ("request", flow.request_body_preview.clone()),
        ("response", flow.response_body_preview.clone()),
    ]
    .into_iter()
    .flat_map(|(source, body)| {
        try_parse_json(&body)
            .map(|parsed| {
                let mut items = Vec::new();
                collect_identity_hints(&parsed, "", &mut items);
                items
                    .into_iter()
                    .take(20)
                    .map(|hint| {
                        let mut hint = hint;
                        if let Value::Object(ref mut map) = hint {
                            map.insert("source".into(), Value::String(source.to_string()));
                            map.insert("flowId".into(), Value::String(flow.id.clone()));
                            map.insert(
                                "request".into(),
                                Value::String(format!(
                                    "{} {}{}{}",
                                    flow.method, flow.host, flow.path, flow.query
                                )),
                            );
                            map.insert(
                                "statusCode".into(),
                                flow.status_code.map(Value::from).unwrap_or(Value::Null),
                            );
                            map.insert("time".into(), Value::String(safe_date(flow.started_at)));
                        }
                        hint
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    })
    .collect()
}

fn summarize_flow(flow: &CaptureFlow) -> Value {
    json!({
        "id": flow.id,
        "time": safe_date(flow.started_at),
        "method": flow.method,
        "statusCode": flow.status_code,
        "name": format!("{} {}{}{}", flow.method, flow.host, flow.path, flow.query),
        "host": flow.host,
        "path": flow.path,
        "query": flow.query,
        "url": format!("{}://{}{}{}", if flow.scheme.is_empty() { "https" } else { &flow.scheme }, flow.host, flow.path, flow.query),
        "durationMs": flow.duration_ms,
        "requestSize": flow.request_size,
        "responseSize": flow.response_size,
        "errorType": flow.error_type,
        "tags": flow.tags,
        "requestHeaders": headers_for_context(&flow.request_headers),
        "responseHeaders": headers_for_context(&flow.response_headers),
        "requestBody": body_for_context(flow, "request"),
        "responseBody": body_for_context(flow, "response")
    })
}

fn is_sse_flow(flow: &CaptureFlow) -> bool {
    let tags_match = flow
        .tags
        .iter()
        .any(|tag| tag == "sse" || tag == "streaming-response");
    let response_type = flow
        .response_headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.to_ascii_lowercase())
        .unwrap_or_default();
    let accept = flow
        .request_headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("accept"))
        .map(|(_, value)| value.to_ascii_lowercase())
        .unwrap_or_default();

    tags_match
        || response_type.contains("text/event-stream")
        || accept.contains("text/event-stream")
        || flow.response_body_preview.starts_with("data:")
        || flow.response_body_preview.contains("\ndata:")
}

fn question_terms(question: &str) -> (bool, bool, bool, bool, bool) {
    let text = question.to_ascii_lowercase();
    (
        [
            "uid", "user", "用户", "账号", "账户", "登录", "login", "account", "current",
            "profile", "me",
        ]
        .iter()
        .any(|term| text.contains(term)),
        [
            "报错", "错误", "失败", "异常", "error", "fail", "status", "502", "500", "404", "401",
            "403",
        ]
        .iter()
        .any(|term| text.contains(term)),
        [
            "慢", "耗时", "瓶颈", "卡", "timeout", "slow", "duration", "latency",
        ]
        .iter()
        .any(|term| text.contains(term)),
        ["今天", "今日", "today"]
            .iter()
            .any(|term| text.contains(term)),
        [
            "sse",
            "eventstream",
            "event stream",
            "server-sent",
            "server sent",
            "text/event-stream",
            "stream",
            "流式",
            "事件流",
        ]
        .iter()
        .any(|term| text.contains(term)),
    )
}

fn score_flow_for_question(flow: &CaptureFlow, question: &str, now: u64) -> f64 {
    let (identity, failure, slow, today, streaming) = question_terms(question);
    let haystack = format!(
        "{} {} {} {} {}",
        flow.method,
        flow.host,
        flow.path,
        flow.query,
        flow.status_code.unwrap_or_default()
    )
    .to_ascii_lowercase();
    let is_static_asset = [
        ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".css", ".js", ".woff", ".woff2", ".ttf",
        ".mp4", ".webm", ".mov", ".m4a", ".mp3",
    ]
    .iter()
    .any(|suffix| flow.path.to_ascii_lowercase().ends_with(suffix));
    let mut score = flow.started_at as f64 / 1_000_000_000_000f64;
    let question_lower = question.to_ascii_lowercase();
    let selected = flow
        .tags
        .iter()
        .any(|tag| tag == "selected" || tag == "selected-by-user");

    if selected || question.contains(&flow.id) {
        score += 10000.0;
    }
    if !flow.path.is_empty() && question_lower.contains(&flow.path.to_ascii_lowercase()) {
        score += 800.0;
    }
    if !flow.host.is_empty() && question_lower.contains(&flow.host.to_ascii_lowercase()) {
        score += 200.0;
    }

    if identity
        && [
            "current",
            "login",
            "auth",
            "user",
            "account",
            "profile",
            "session",
            "me",
            "entitlements",
        ]
        .iter()
        .any(|term| haystack.contains(term))
    {
        score += 120.0;
    }
    if identity && !extract_identity_hints(flow).is_empty() {
        score += 160.0;
    }
    if failure && (flow.status_code.unwrap_or_default() >= 400 || !flow.error_type.is_empty()) {
        score += 180.0;
    }
    if slow && flow.duration_ms.unwrap_or_default() > 1000 {
        score += 120.0;
    }
    if streaming && is_sse_flow(flow) {
        score += 1200.0;
    }
    if is_sse_flow(flow) {
        score += 80.0;
    }
    if today && is_same_local_day(flow.started_at, now) {
        score += 40.0;
    }
    if ["json", "xhr", "api"]
        .iter()
        .any(|term| haystack.contains(term))
    {
        score += 20.0;
    }
    if is_static_asset && !(flow.status_code.unwrap_or_default() >= 400 || slow) {
        score -= 120.0;
    }
    if looks_like_json(&flow.response_body_preview) {
        score += 45.0;
    }
    if looks_like_json(&flow.request_body_preview) {
        score += 35.0;
    }
    score
}

fn build_agent_context(flows: &[CaptureFlow], question: &str) -> Value {
    let mut sorted = flows.to_vec();
    sorted.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    let today_flows: Vec<CaptureFlow> = sorted
        .iter()
        .filter(|flow| is_same_local_day(flow.started_at, now))
        .cloned()
        .collect();
    let failed_flows: Vec<CaptureFlow> = sorted
        .iter()
        .filter(|flow| flow.status_code.unwrap_or_default() >= 400 || !flow.error_type.is_empty())
        .cloned()
        .collect();
    let slow_flows: Vec<CaptureFlow> = sorted
        .iter()
        .filter(|flow| flow.duration_ms.unwrap_or_default() > 1000)
        .cloned()
        .collect();
    let sse_flows: Vec<CaptureFlow> = sorted
        .iter()
        .filter(|flow| is_sse_flow(flow))
        .cloned()
        .collect();
    let mut ranked = sorted.clone();
    ranked.sort_by(|left, right| {
        score_flow_for_question(right, question, now)
            .partial_cmp(&score_flow_for_question(left, question, now))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for flow in ranked
        .into_iter()
        .chain(sse_flows.clone())
        .chain(failed_flows.clone())
        .chain(slow_flows.clone())
        .chain(today_flows.iter().take(20).cloned())
        .chain(sorted.iter().take(20).cloned())
    {
        if seen.insert(flow.id.clone()) {
            selected.push(flow);
        }
        if selected.len() >= MAX_AGENT_FLOWS {
            break;
        }
    }

    json!({
        "generatedAt": safe_date(now),
        "scope": "当前上下文只包含本次应用内存中的抓包会话。用户说“今天”时，优先使用 startedAt 属于本地今天的请求；如果没有历史持久化数据，不要声称覆盖浏览器外的全部历史。",
        "totals": {
            "all": flows.len(),
            "today": today_flows.len(),
            "failed": failed_flows.len(),
            "failedToday": today_flows.iter().filter(|flow| flow.status_code.unwrap_or_default() >= 400 || !flow.error_type.is_empty()).count(),
            "slow": slow_flows.len(),
            "slowToday": today_flows.iter().filter(|flow| flow.duration_ms.unwrap_or_default() > 1000).count(),
            "sse": sse_flows.len(),
            "sseToday": today_flows.iter().filter(|flow| is_sse_flow(flow)).count()
        },
        "sseFlows": sse_flows.iter().take(12).map(summarize_flow).collect::<Vec<_>>(),
        "identityHints": selected.iter().flat_map(extract_identity_hints).take(80).collect::<Vec<_>>(),
        "flows": selected.iter().map(summarize_flow).collect::<Vec<_>>()
    })
}

fn normalize_history(history: Vec<AgentChatMessage>) -> Vec<Value> {
    history
        .into_iter()
        .filter(|item| {
            (item.role == "user" || item.role == "assistant") && !item.content.is_empty()
        })
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|item| chat_message(&item.role, Value::String(truncate(&item.content, 1000))))
        .collect()
}

fn build_user_content(question: &str, context: &Value, attachments: &[AgentAttachment]) -> Value {
    let prompt = format!(
        "用户问题：{question}\n\n抓包上下文：\n{}",
        serde_json::to_string_pretty(context).unwrap_or_else(|_| "{}".into())
    );
    let images: Vec<&AgentAttachment> = attachments
        .iter()
        .filter(|item| item.data_url.starts_with("data:image/"))
        .take(4)
        .collect();
    if images.is_empty() {
        return Value::String(prompt);
    }

    let mut items = vec![json!({ "type": "text", "text": prompt })];
    for image in images {
        items.push(json!({
            "type": "image_url",
            "image_url": { "url": image.data_url }
        }));
    }
    Value::Array(items)
}

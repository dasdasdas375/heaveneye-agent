use crate::models::{
    AgentAttachment, AgentChatMessage, AgentEvidence, AgentEvidenceField, AgentHighlight,
    AgentStructuredAnswer, AgentTestCase, AiResult, AiUsage, AppConfig, CaptureFlow,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_BODY_CHARS: usize = 1000;
const MAX_JSON_CONTEXT_NODES: usize = 48;
const MAX_AGENT_SEARCH_FLOWS: usize = 100;
const SEARCH_BATCH_SIZE: usize = 10;
const MAX_SEARCH_BATCHES: usize = 10;
const MAX_FINAL_CONTEXT_FLOWS: usize = 4;
#[cfg(test)]
const MAX_AGENT_FLOWS: usize = 8;
#[cfg(test)]
const MAX_EVIDENCE_CANDIDATES: usize = 10;

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

#[derive(Clone, Default)]
struct EvidenceSearchProfile {
    summary: String,
    intent: String,
    terms: Vec<String>,
    phrases: Vec<String>,
    domains: Vec<String>,
    paths: Vec<String>,
    fields: Vec<String>,
    methods: Vec<String>,
    status_codes: Vec<u16>,
    search_in: Vec<String>,
    exclude_terms: Vec<String>,
    wants_latest: bool,
}

#[derive(Clone)]
struct EvidenceCandidate {
    flow: CaptureFlow,
    score: f64,
    reasons: Vec<String>,
    snippets: Vec<Value>,
}

#[derive(Clone, Default)]
struct SearchBatchDecision {
    selected_flow_id: Option<String>,
    confidence: f64,
    sufficient: bool,
    reason: String,
    refine_terms: Vec<String>,
}

#[derive(Clone, Default)]
struct SearchResolution {
    selected_flow_id: Option<String>,
    selected_confidence: f64,
    batches: Vec<Value>,
    searched_count: usize,
    stopped_reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub stream_id: String,
    pub phase: String,
    pub delta: String,
    pub done: bool,
    pub model: Option<String>,
    pub error: Option<String>,
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
        let history_search_text = history_search_text(&history);
        let mut search_profile = self
            .extract_visual_search_profile(&trimmed_question, &history_search_text, &attachments)
            .await
            .unwrap_or_else(|| build_text_search_profile(&trimmed_question, &history_search_text));
        let search_result = self
            .resolve_agent_evidence(
                &trimmed_question,
                &history_search_text,
                &flows,
                has_images,
                &mut search_profile,
            )
            .await;
        let context = build_final_agent_context(
            &flows,
            &trimmed_question,
            &history_search_text,
            has_images,
            &search_profile,
            &search_result,
        );
        let result = self
            .chat(
                [
                    vec![chat_message(
                        "system",
                        Value::String(
                            "你是 HeavenEye Agent（天眼抓包 Agent），一个运行在用户本机、面向研发和测试的抓包调试助手。你的职责是替代用户手动翻浏览器 F12 Network：只基于本地抓包上下文、截图提取结果和搜索器证据回答，不要编造，不要输出与抓包证据无关的免责声明、合规说明、风险提醒或注意事项。不要把当前 UI 选中的请求当作默认焦点；只有上下文里的 focusedFlow 非空，才表示用户本轮明确指定接口。searchResult 是应用底层隐藏搜索器和模型分批判断后的结果：如果 selectedFlow 非空，优先围绕 selectedFlow 回答；如果 selectedFlow 为空，必须说明截图/问题显示的意图，以及最多 100 条检索范围内没有找到强匹配接口，不要改用无关旧接口。历史对话只作为追问语境，上一轮助手结论不是证据。用户询问账号、uid、token、header、cookie、报错接口、慢接口时，如果 selectedFlow 或 searchBatches 中真实存在对应字段，就按字段原文和证据接口列出；如果上下文不足，就明确说明还缺少哪些接口。用户要求接口测试时，先基于真实 request 参数、headers、body 和 response 设计低风险用例，再把可执行的参数变体放入 testCases；每个用例必须相对原请求可发送，不要生成破坏性、扣费、删除、批量写入类用例。必须返回严格 JSON，不要 Markdown，不要代码块。JSON 结构为：{\"summary\":\"一句话结论，优先回答用户最关心的问题\",\"highlights\":[{\"label\":\"账号|密码|Token|UID|报错接口|慢接口等\",\"value\":\"可复制的核心值\",\"kind\":\"uid|account|password|token|error|url|field|status|time|other\",\"source\":\"字段来源，如 requestBody.email 或 responseBody.data.token\"}],\"evidence\":[{\"title\":\"证据名称\",\"time\":\"请求时间\",\"method\":\"GET/POST\",\"status\":200,\"host\":\"域名\",\"path\":\"路径和 query\",\"fields\":[{\"label\":\"字段路径\",\"value\":\"字段值\"}]}],\"analysis\":[\"简短分析或下一步\"],\"testCases\":[{\"name\":\"用例名\",\"purpose\":\"为什么测\",\"method\":\"GET/POST，可省略则沿用原请求\",\"url\":\"完整 URL，可省略则沿用原请求\",\"headers\":{\"x-demo\":\"value，可省略\"},\"query\":{\"key\":\"value，可省略\"},\"body\":{\"字段\":\"值；可省略或字符串\"},\"expected\":\"预期状态/字段/行为\"}]}。highlights 必须只放用户最需要复制的核心元素，并放在最前；evidence 只说明这些值从哪个接口、什么时间、什么状态取到，fields 只放未在 highlights 重复展示的补充字段；非接口测试问题不要返回 testCases，接口测试最多 5 个用例。".into(),
                        ),
                    )],
                    normalize_history(history),
                    vec![chat_message(
                        "user",
                        build_final_user_content(&trimmed_question, &context),
                    )],
                ]
                .concat(),
                json!({
                    "model": self.config.qwen.model.clone(),
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

    pub async fn ask_agent_stream<F>(
        &self,
        stream_id: String,
        question: String,
        flows: Vec<CaptureFlow>,
        history: Vec<AgentChatMessage>,
        attachments: Vec<AgentAttachment>,
        emit: F,
    ) -> Result<AiResult, String>
    where
        F: Fn(AgentStreamEvent) + Send + Sync,
    {
        let trimmed_question = question.trim().to_string();
        if trimmed_question.is_empty() {
            let result = AiResult {
                model: self.config.qwen.model.clone(),
                content: "请输入你想分析的问题，例如“帮我找一下最新登录账号的 uid”。".into(),
                structured: None,
                usage: None,
            };
            emit_agent_stream_event(
                &emit,
                &stream_id,
                "answer",
                &result.content,
                true,
                Some(&result.model),
                None,
            );
            return Ok(result);
        }

        if ai_provider_kind(&self.config.qwen.provider) != "openai-compatible" {
            emit_agent_stream_event(
                &emit,
                &stream_id,
                "search",
                "当前 AI Provider 暂不支持实时流式，正在使用兼容模式生成完整回答...",
                false,
                Some(&self.config.qwen.model),
                None,
            );
            let result = self
                .ask_agent(trimmed_question, flows, history, attachments)
                .await?;
            emit_agent_stream_event(
                &emit,
                &stream_id,
                "answer",
                &result.content,
                true,
                Some(&result.model),
                None,
            );
            return Ok(result);
        }

        emit_agent_stream_event(
            &emit,
            &stream_id,
            "search",
            "正在读取截图并检索最相关的抓包接口...",
            false,
            Some(&self.config.qwen.model),
            None,
        );

        let has_images = attachments
            .iter()
            .any(|item| item.data_url.starts_with("data:image/"));
        let history_search_text = history_search_text(&history);
        let mut search_profile = self
            .extract_visual_search_profile(&trimmed_question, &history_search_text, &attachments)
            .await
            .unwrap_or_else(|| build_text_search_profile(&trimmed_question, &history_search_text));
        let search_result = self
            .resolve_agent_evidence(
                &trimmed_question,
                &history_search_text,
                &flows,
                has_images,
                &mut search_profile,
            )
            .await;
        let context = build_final_agent_context(
            &flows,
            &trimmed_question,
            &history_search_text,
            has_images,
            &search_profile,
            &search_result,
        );

        emit_agent_stream_event(
            &emit,
            &stream_id,
            "search",
            "已定位候选证据，正在生成回答...",
            false,
            Some(&self.config.qwen.model),
            None,
        );

        let messages = [
            vec![chat_message(
                "system",
                Value::String(agent_stream_text_system_prompt().into()),
            )],
            normalize_history(history),
            vec![chat_message(
                "user",
                build_final_user_content(&trimmed_question, &context),
            )],
        ]
        .concat();

        let model = self.config.qwen.model.clone();
        let stream_result = self
            .chat_openai_stream(
                messages,
                json!({
                    "model": model,
                    "temperature": 0.1,
                    "enable_thinking": false
                }),
                |delta| {
                    emit_agent_stream_event(
                        &emit,
                        &stream_id,
                        "answer",
                        delta,
                        false,
                        Some(&self.config.qwen.model),
                        None,
                    );
                },
            )
            .await;

        match stream_result {
            Ok(mut result) => {
                let structured =
                    build_stream_structured_answer(&result.content, &flows, &search_result);
                result.structured = Some(structured);
                emit_agent_stream_event(
                    &emit,
                    &stream_id,
                    "done",
                    "",
                    true,
                    Some(&result.model),
                    None,
                );
                Ok(result)
            }
            Err(error) => {
                emit_agent_stream_event(
                    &emit,
                    &stream_id,
                    "error",
                    "",
                    true,
                    Some(&self.config.qwen.model),
                    Some(&error),
                );
                Err(error)
            }
        }
    }

    async fn resolve_agent_evidence(
        &self,
        question: &str,
        history_text: &str,
        flows: &[CaptureFlow],
        has_images: bool,
        profile: &mut EvidenceSearchProfile,
    ) -> SearchResolution {
        let focused_flow = flows.iter().find(|flow| {
            flow.tags
                .iter()
                .any(|tag| tag == "selected" || tag == "selected-by-user")
        });
        if let Some(flow) = focused_flow {
            return SearchResolution {
                selected_flow_id: Some(flow.id.clone()),
                selected_confidence: 1.0,
                batches: vec![json!({
                    "batch": 1,
                    "decision": {
                        "selectedFlowId": flow.id,
                        "confidence": 1.0,
                        "sufficient": true,
                        "reason": "用户本轮明确指定了该接口。"
                    },
                    "candidates": [candidate_card(&EvidenceCandidate {
                        flow: flow.clone(),
                        score: 10_000.0,
                        reasons: vec!["explicitly targeted by user".into()],
                        snippets: search_snippets(flow, &profile_terms(profile), 4),
                    }, 1)]
                })],
                searched_count: 1,
                stopped_reason: "explicit_flow".into(),
            };
        }

        let mut seen = HashSet::new();
        let mut batches = Vec::new();
        let mut searched_count = 0usize;

        for batch_index in 0..MAX_SEARCH_BATCHES {
            if searched_count >= MAX_AGENT_SEARCH_FLOWS {
                break;
            }
            let batch = next_search_batch(
                flows,
                question,
                history_text,
                profile,
                has_images,
                &seen,
                SEARCH_BATCH_SIZE,
            );
            if batch.is_empty() {
                break;
            }

            for candidate in &batch {
                seen.insert(candidate.flow.id.clone());
            }
            searched_count += batch.len();
            let cards = batch
                .iter()
                .enumerate()
                .map(|(index, candidate)| candidate_card(candidate, index + 1))
                .collect::<Vec<_>>();

            let decision = self
                .judge_search_batch(question, history_text, profile, batch_index + 1, &cards)
                .await
                .unwrap_or_else(|| heuristic_batch_decision(&batch));
            append_profile_terms(profile, &decision.refine_terms);

            batches.push(json!({
                "batch": batch_index + 1,
                "decision": {
                    "selectedFlowId": decision.selected_flow_id,
                    "confidence": decision.confidence,
                    "sufficient": decision.sufficient,
                    "reason": decision.reason,
                    "refineTerms": decision.refine_terms
                },
                "candidates": cards
            }));

            if let Some(selected_id) = decision.selected_flow_id {
                if decision.sufficient && decision.confidence >= 0.72 {
                    return SearchResolution {
                        selected_flow_id: Some(selected_id),
                        selected_confidence: decision.confidence,
                        batches,
                        searched_count,
                        stopped_reason: "model_selected".into(),
                    };
                }
            }
        }

        SearchResolution {
            selected_flow_id: None,
            selected_confidence: 0.0,
            batches,
            searched_count,
            stopped_reason: if searched_count >= MAX_AGENT_SEARCH_FLOWS {
                "max_100_reached".into()
            } else {
                "no_strong_match".into()
            },
        }
    }

    async fn judge_search_batch(
        &self,
        question: &str,
        history_text: &str,
        profile: &EvidenceSearchProfile,
        batch_index: usize,
        candidates: &[Value],
    ) -> Option<SearchBatchDecision> {
        let payload = json!({
            "question": question,
            "historyContext": truncate(history_text, 1200),
            "searchIntent": profile_value(profile),
            "batch": {
                "index": batch_index,
                "size": candidates.len(),
                "candidates": candidates
            },
            "rules": [
                "只能从 candidates 中选择 selectedFlowId；不确定就返回 null。",
                "优先选择与截图/用户真实意图匹配、时间最新、且 path/query/body/header 命中最多的接口。",
                "媒体静态资源、图片、视频、字体、JS/CSS 只有在用户明确问资源本身时才选择；问上传/提交/业务动作时优先选择发起动作的 API。",
                "如果本批没有强匹配，返回 sufficient=false，并给出 refineTerms 供下一批搜索。"
            ]
        });
        let result = self
            .chat(
                vec![
                    chat_message(
                        "system",
                        Value::String(
                            "你是抓包证据检索裁判。你只判断这一批候选接口哪条最符合用户意图，不做最终回答。必须输出严格 JSON，不要 Markdown。JSON 结构：{\"selectedFlowId\":\"候选 id 或 null\",\"confidence\":0到1,\"sufficient\":true或false,\"reason\":\"一句话理由\",\"refineTerms\":[\"下一批搜索词，可空\"]}。".into(),
                        ),
                    ),
                    chat_message("user", Value::String(payload.to_string())),
                ],
                json!({
                    "model": self.config.qwen.model.clone(),
                    "temperature": 0.0,
                    "enable_thinking": false
                }),
            )
            .await
            .ok()?;
        parse_search_batch_decision(&result.content, candidates)
    }

    async fn extract_visual_search_profile(
        &self,
        question: &str,
        history_text: &str,
        attachments: &[AgentAttachment],
    ) -> Option<EvidenceSearchProfile> {
        let images: Vec<&AgentAttachment> = attachments
            .iter()
            .filter(|item| item.data_url.starts_with("data:image/"))
            .take(4)
            .collect();
        if images.is_empty() {
            return None;
        }

        let mut content = vec![json!({
            "type": "text",
            "text": format!(
                "请读取截图，并结合用户问题提取用于匹配网络抓包接口的检索意图。只返回 JSON，不要 Markdown。\n用户问题：{question}\n最近对话摘要：{}\nJSON 结构：{{\"intent\":\"用户真正想找的接口或字段\", \"summary\":\"截图可见内容一句话\", \"terms\":[\"业务关键词\"], \"phrases\":[\"需要精确匹配的短语\"], \"domains\":[\"截图可见域名或品牌域名\"], \"paths\":[\"接口路径片段\"], \"fields\":[\"请求/响应字段名\"], \"methods\":[\"GET/POST/PUT/PATCH/DELETE，可空\"], \"statusCodes\":[200], \"searchIn\":[\"url\",\"query\",\"requestHeaders\",\"requestBody\",\"responseHeaders\",\"responseBody\",\"sse\"], \"excludeTerms\":[\"应排除的静态资源/无关词\"], \"wantsLatest\":true}}。terms/phrases 总数不超过 40；去掉泛词如 页面、请求、接口、数据；如果用户只是问截图中的某个动作，例如上传文件，intent 要写成“找发起上传动作的业务 API”，而不是图片/视频静态资源。",
                truncate(history_text, 800)
            )
        })];
        for image in images {
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": image.data_url }
            }));
        }

        let result = self
            .chat(
                vec![
                    chat_message(
                        "system",
                        Value::String(
                            "你只负责从截图和用户问题提取网络证据检索意图，必须输出严格 JSON。"
                                .into(),
                        ),
                    ),
                    chat_message("user", Value::Array(content)),
                ],
                json!({
                    "model": self.config.qwen.vision_model.clone(),
                    "temperature": 0.0,
                    "enable_thinking": false
                }),
            )
            .await
            .ok()?;

        parse_visual_search_profile(&result.content)
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

    async fn chat_openai_stream<F>(
        &self,
        messages: Vec<Value>,
        options: Value,
        mut on_delta: F,
    ) -> Result<AiResult, String>
    where
        F: FnMut(&str),
    {
        if self.config.qwen.api_key.trim().is_empty() {
            return Err("AI API Key is not configured. Open AI settings and save a key.".into());
        }

        let model = options
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.qwen.model)
            .to_string();
        let mut body = json!({
            "model": model,
            "messages": messages,
            "temperature": options.get("temperature").cloned().unwrap_or_else(|| json!(0.2)),
            "stream": true
        });
        if provider_supports_enable_thinking(&self.config.qwen.provider) {
            if let Some(enable_thinking) = options.get("enable_thinking") {
                body["enable_thinking"] = enable_thinking.clone();
            }
        }

        let mut response = self
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
        if !status.is_success() {
            let text = response.text().await.map_err(|error| error.to_string())?;
            return Err(format!("AI request failed: {} {}", status.as_u16(), text));
        }

        let mut buffer = String::new();
        let mut content = String::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(line_end) = buffer.find('\n') {
                let mut line = buffer.drain(..=line_end).collect::<String>();
                line = line.trim().to_string();
                if line.is_empty() || line.starts_with(':') {
                    continue;
                }
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Some(delta) = stream_delta_from_openai_data(data) {
                        if !delta.is_empty() {
                            content.push_str(&delta);
                            on_delta(&delta);
                        }
                    }
                }
            }
        }
        let trailing = buffer.trim();
        if let Some(data) = trailing.strip_prefix("data:") {
            if let Some(delta) = stream_delta_from_openai_data(data.trim()) {
                if !delta.is_empty() {
                    content.push_str(&delta);
                    on_delta(&delta);
                }
            }
        }

        Ok(AiResult {
            model,
            content: strip_irrelevant_disclaimer(&content),
            structured: None,
            usage: None,
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

fn stream_delta_from_openai_data(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta").or_else(|| choice.get("message")))
        .and_then(|delta| delta.get("content"))
        .and_then(|content| match content {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            Value::Array(_) => Some(content_to_text(content.clone())),
            other => Some(other.to_string()),
        })
}

fn emit_agent_stream_event<F>(
    emit: &F,
    stream_id: &str,
    phase: &str,
    delta: &str,
    done: bool,
    model: Option<&str>,
    error: Option<&str>,
) where
    F: Fn(AgentStreamEvent) + Send + Sync,
{
    emit(AgentStreamEvent {
        stream_id: stream_id.to_string(),
        phase: phase.to_string(),
        delta: delta.to_string(),
        done,
        model: model.map(str::to_string),
        error: error.map(str::to_string),
    });
}

fn agent_stream_text_system_prompt() -> &'static str {
    "你是 HeavenEye Agent（天眼抓包 Agent），一个运行在用户本机、面向研发和测试的抓包调试助手。请用中文直接回答用户问题，不要输出 JSON，不要 Markdown 代码块。只基于上下文里的 searchIntent、searchResult、selectedFlow、relatedFlowDetails 和 identityHints 回答，不要编造。\n\n强制要求：\n1. 绝对不要只输出“接口用途 / 关键证据 / 简短判断”这类空标题；每个标题后必须有具体内容。若证据不足，直接说缺什么证据。\n2. 如果 selectedFlow 非空，并且用户问“这个接口做什么/用途是什么”，第一句话必须写成：“这个接口是 METHOD PATH，用于……”。用途要从 path、query、requestBody、responseBody、字段名、返回 data/name/description/code/message 等证据综合判断。\n3. 回答必须包含至少 2 条具体证据，例如 status、host、path、query、响应 code/message、data.id/name/description、关键请求参数或响应字段。证据字段和值要写出来。\n4. 如果 selectedFlow 为空，说明最多 100 条内没有找到强匹配接口，并给出下一步该如何重新抓包或缩小范围。\n5. 回答要短，但不能空；优先给结论，然后给证据和判断。"
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
        if index >= 20 {
            break;
        }
        map.insert(key.clone(), Value::String(truncate(value, 800)));
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

fn normalize_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.' | '?' | '=' | '&' | ':') {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_low_signal_term(term: &str) -> bool {
    matches!(
        term,
        "这个"
            | "这条"
            | "当前"
            | "刚才"
            | "上面"
            | "下面"
            | "这里"
            | "这页"
            | "截图"
            | "页面"
            | "接口"
            | "请求"
            | "数据"
            | "问题"
            | "帮我"
            | "一下"
            | "this"
            | "that"
            | "current"
            | "page"
            | "request"
            | "api"
    )
}

fn push_search_term(terms: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    let normalized = normalize_search_text(value);
    if normalized.chars().count() < 2 || is_low_signal_term(&normalized) {
        return;
    }
    if normalized.chars().all(|ch| ch.is_ascii_digit()) && normalized.len() < 3 {
        return;
    }
    if seen.insert(normalized.clone()) {
        terms.push(normalized);
    }
}

fn tokenize_search_text(value: &str, terms: &mut Vec<String>, seen: &mut HashSet<String>) {
    for token in normalize_search_text(value).split_whitespace() {
        push_search_term(terms, seen, token);
    }

    for phrase in [
        "自动布局",
        "固定布局",
        "layout_key",
        "layer_config",
        "template_id",
        "task_id",
        "uid",
        "登录",
        "账号",
        "上传",
        "上传文件",
        "文件上传",
        "upload",
        "file upload",
        "报错",
        "失败",
        "eventstream",
        "text/event-stream",
    ] {
        if value.to_lowercase().contains(&phrase.to_lowercase()) {
            push_search_term(terms, seen, phrase);
        }
    }
}

fn parse_string_list(parsed: &Value, keys: &[&str], max_items: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for key in keys {
        if let Some(items) = parsed.get(*key).and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.as_str() {
                    push_search_term(&mut result, &mut seen, text);
                    if result.len() >= max_items {
                        return result;
                    }
                }
            }
        }
    }
    result
}

fn parse_method_list(parsed: &Value) -> Vec<String> {
    parse_string_list(parsed, &["methods", "method"], 8)
        .into_iter()
        .map(|method| method.to_ascii_uppercase())
        .filter(|method| matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE"))
        .collect()
}

fn parse_status_codes(parsed: &Value) -> Vec<u16> {
    parsed
        .get("statusCodes")
        .or_else(|| parsed.get("statuses"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_u64()
                        .and_then(|value| u16::try_from(value).ok())
                        .or_else(|| item.as_str().and_then(|text| text.parse::<u16>().ok()))
                })
                .take(12)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parse_visual_search_profile(content: &str) -> Option<EvidenceSearchProfile> {
    let parsed = extract_json_object(content)?;
    let summary = parsed
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let intent = parsed
        .get("intent")
        .or_else(|| parsed.get("userIntent"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut terms = parse_string_list(&parsed, &["terms", "keywords", "businessTerms"], 40);
    let phrases = parse_string_list(&parsed, &["phrases", "exactPhrases"], 20);
    let domains = parse_string_list(&parsed, &["domains", "hosts"], 12);
    let paths = parse_string_list(&parsed, &["paths", "pathFragments", "endpoints"], 20);
    let fields = parse_string_list(&parsed, &["fields", "fieldNames", "jsonPaths"], 24);
    let search_in = parse_string_list(&parsed, &["searchIn", "sections"], 12);
    let exclude_terms = parse_string_list(&parsed, &["excludeTerms", "excludes"], 20);
    let methods = parse_method_list(&parsed);
    let status_codes = parse_status_codes(&parsed);
    let wants_latest = parsed
        .get("wantsLatest")
        .or_else(|| parsed.get("latest"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let mut seen = terms.iter().cloned().collect::<HashSet<_>>();
    let profile_text_sources = vec![
        summary.clone(),
        intent.clone(),
        phrases.join(" "),
        domains.join(" "),
        paths.join(" "),
        fields.join(" "),
    ];
    for value in profile_text_sources {
        tokenize_search_text(&value, &mut terms, &mut seen);
    }
    terms.truncate(60);

    if terms.is_empty()
        && phrases.is_empty()
        && domains.is_empty()
        && paths.is_empty()
        && fields.is_empty()
        && summary.is_empty()
        && intent.is_empty()
    {
        None
    } else {
        Some(EvidenceSearchProfile {
            summary,
            intent,
            terms,
            phrases,
            domains,
            paths,
            fields,
            methods,
            status_codes,
            search_in,
            exclude_terms,
            wants_latest,
        })
    }
}

fn build_text_search_profile(question: &str, history_text: &str) -> EvidenceSearchProfile {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    tokenize_search_text(question, &mut terms, &mut seen);
    tokenize_search_text(history_text, &mut terms, &mut seen);
    terms.truncate(60);

    EvidenceSearchProfile {
        summary: String::new(),
        intent: truncate(question, 300),
        terms,
        wants_latest: true,
        ..Default::default()
    }
}

fn append_profile_terms(profile: &mut EvidenceSearchProfile, new_terms: &[String]) {
    let mut seen = profile.terms.iter().cloned().collect::<HashSet<_>>();
    for term in new_terms {
        push_search_term(&mut profile.terms, &mut seen, term);
    }
    profile.terms.truncate(80);
}

fn profile_terms(profile: &EvidenceSearchProfile) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for source in [
        profile.intent.clone(),
        profile.summary.clone(),
        profile.terms.join(" "),
        profile.phrases.join(" "),
        profile.domains.join(" "),
        profile.paths.join(" "),
        profile.fields.join(" "),
    ] {
        tokenize_search_text(&source, &mut terms, &mut seen);
    }
    terms.truncate(80);
    terms
}

fn profile_value(profile: &EvidenceSearchProfile) -> Value {
    json!({
        "intent": profile.intent,
        "summary": profile.summary,
        "terms": profile.terms,
        "phrases": profile.phrases,
        "domains": profile.domains,
        "paths": profile.paths,
        "fields": profile.fields,
        "methods": profile.methods,
        "statusCodes": profile.status_codes,
        "searchIn": profile.search_in,
        "excludeTerms": profile.exclude_terms,
        "wantsLatest": profile.wants_latest
    })
}

fn history_search_text(history: &[AgentChatMessage]) -> String {
    history
        .iter()
        .rev()
        .filter(|item| item.role == "user" || item.role == "assistant")
        .take(6)
        .map(|item| truncate(&item.content, 500))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_evidence_search_terms(
    question: &str,
    history_text: &str,
    profile: Option<&EvidenceSearchProfile>,
) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    tokenize_search_text(question, &mut terms, &mut seen);
    tokenize_search_text(history_text, &mut terms, &mut seen);

    if let Some(profile) = profile {
        for source in [
            profile.intent.clone(),
            profile.summary.clone(),
            profile.phrases.join(" "),
            profile.domains.join(" "),
            profile.paths.join(" "),
            profile.fields.join(" "),
        ] {
            tokenize_search_text(&source, &mut terms, &mut seen);
        }
        for term in &profile.terms {
            push_search_term(&mut terms, &mut seen, term);
        }
    }

    terms.truncate(60);
    terms
}

fn is_upload_question(question: &str) -> bool {
    let text = question.to_ascii_lowercase();
    [
        "上传",
        "上传文件",
        "文件上传",
        "传文件",
        "upload",
        "file upload",
        "attachment",
        "multipart",
    ]
    .iter()
    .any(|term| text.contains(term))
}

fn is_upload_flow(flow: &CaptureFlow) -> bool {
    let method = flow.method.to_ascii_uppercase();
    if !matches!(method.as_str(), "POST" | "PUT" | "PATCH") {
        return false;
    }
    let content_type = flow
        .request_headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.to_ascii_lowercase())
        .unwrap_or_default();
    let haystack = normalize_search_text(&format!(
        "{} {} {} {} {} {}",
        flow.host,
        flow.path,
        flow.query,
        content_type,
        truncate(&flow.request_body_preview, 500),
        truncate(&flow.response_body_preview, 500)
    ));
    content_type.contains("multipart")
        || content_type.contains("octet-stream")
        || [
            "upload",
            "file",
            "files",
            "attachment",
            "material",
            "avatar",
            "image",
            "cover",
            "media",
            "object",
            "oss",
            "cos",
            "s3",
        ]
        .iter()
        .any(|term| haystack.contains(term))
}

fn flow_section_text(flow: &CaptureFlow, section: &str) -> String {
    match section {
        "host" => normalize_search_text(&flow.host),
        "path" => normalize_search_text(&flow.path),
        "query" => normalize_search_text(&flow.query),
        "headers" => normalize_search_text(&format!(
            "{} {}",
            serde_json::to_string(&flow.request_headers).unwrap_or_default(),
            serde_json::to_string(&flow.response_headers).unwrap_or_default()
        )),
        "body" => normalize_search_text(&format!(
            "{} {}",
            truncate(&flow.request_body_preview, 3000),
            truncate(&flow.response_body_preview, 3000)
        )),
        _ => normalize_search_text(&format!(
            "{} {} {} {} {}",
            flow.method, flow.host, flow.path, flow.query, flow.error_type
        )),
    }
}

fn header_value(headers: &std::collections::HashMap<String, String>, name: &str) -> String {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

fn flow_url(flow: &CaptureFlow) -> String {
    format!(
        "{}://{}{}{}",
        if flow.scheme.is_empty() {
            "https"
        } else {
            &flow.scheme
        },
        flow.host,
        flow.path,
        flow.query
    )
}

fn flow_sse_text(flow: &CaptureFlow) -> String {
    flow.sse_events
        .iter()
        .take(16)
        .map(|event| {
            format!(
                "event:{} id:{} data:{}",
                event.event,
                event.id,
                truncate(&event.data, 500)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn search_sections(flow: &CaptureFlow) -> Vec<(&'static str, String, f64)> {
    vec![
        ("url", flow_url(flow), 54.0),
        (
            "methodStatus",
            format!(
                "{} {} {}",
                flow.method,
                flow.status_code.unwrap_or_default(),
                flow.error_type
            ),
            26.0,
        ),
        ("host", flow.host.clone(), 46.0),
        ("path", format!("{}{}", flow.path, flow.query), 62.0),
        (
            "requestHeaders",
            serde_json::to_string(&flow.request_headers).unwrap_or_default(),
            22.0,
        ),
        (
            "responseHeaders",
            serde_json::to_string(&flow.response_headers).unwrap_or_default(),
            18.0,
        ),
        (
            "requestBody",
            truncate(&flow.request_body_preview, 2500),
            44.0,
        ),
        (
            "responseBody",
            truncate(&flow.response_body_preview, 2500),
            34.0,
        ),
        ("sse", flow_sse_text(flow), 42.0),
    ]
}

fn compact_text(value: &str, limit: usize) -> String {
    truncate(
        &value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("\\n", " "),
        limit,
    )
}

fn search_snippets(flow: &CaptureFlow, terms: &[String], max_items: usize) -> Vec<Value> {
    let mut snippets = Vec::new();
    let terms = if terms.is_empty() {
        let mut fallback = Vec::new();
        let mut seen = HashSet::new();
        tokenize_search_text(
            &format!("{} {} {}", flow.host, flow.path, flow.query),
            &mut fallback,
            &mut seen,
        );
        fallback
    } else {
        terms.to_vec()
    };

    for (section, text, _) in search_sections(flow) {
        if text.trim().is_empty() {
            continue;
        }
        let normalized = normalize_search_text(&text);
        let matched = terms
            .iter()
            .find(|term| term.len() >= 2 && normalized.contains(term.as_str()));
        if let Some(term) = matched {
            snippets.push(json!({
                "section": section,
                "term": term,
                "text": compact_text(&text, 320)
            }));
        }
        if snippets.len() >= max_items {
            break;
        }
    }
    snippets
}

fn is_static_or_media_flow(flow: &CaptureFlow) -> bool {
    let path = flow.path.to_ascii_lowercase();
    let response_type = header_value(&flow.response_headers, "content-type").to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".css", ".js", ".woff", ".woff2", ".ttf",
        ".mp4", ".webm", ".mov", ".m4a", ".mp3",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
        || response_type.starts_with("image/")
        || response_type.starts_with("video/")
        || response_type.contains("font")
}

fn is_static_resource_intent(question: &str, profile: &EvidenceSearchProfile) -> bool {
    let text = normalize_search_text(&format!(
        "{} {} {} {}",
        question,
        profile.intent,
        profile.summary,
        profile.terms.join(" ")
    ));
    if is_upload_question(&text)
        || text.contains("提交")
        || text.contains("创建")
        || text.contains("保存")
    {
        return false;
    }
    [
        "图片",
        "视频",
        "封面",
        "头像",
        "静态资源",
        "image",
        "video",
        "cover",
        "avatar",
        "asset",
        "resource",
    ]
    .iter()
    .any(|term| text.contains(term))
}

fn rank_search_candidates(
    flows: &[CaptureFlow],
    question: &str,
    history_text: &str,
    profile: &EvidenceSearchProfile,
    has_images: bool,
    seen: &HashSet<String>,
) -> Vec<EvidenceCandidate> {
    let mut pool = flows.to_vec();
    pool.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    pool.truncate(MAX_AGENT_SEARCH_FLOWS);

    let mut terms = build_evidence_search_terms(question, history_text, Some(profile));
    for term in profile_terms(profile) {
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms.truncate(90);
    let static_resource_intent = is_static_resource_intent(question, profile);

    let mut candidates = pool
        .into_iter()
        .filter(|flow| !seen.contains(&flow.id))
        .map(|flow| {
            let (mut score, mut reasons) = match_flow_against_terms(&flow, &terms, question);
            let normalized_url = normalize_search_text(&flow_url(&flow));
            let normalized_headers = flow_section_text(&flow, "headers");
            let normalized_body = flow_section_text(&flow, "body");

            for domain in &profile.domains {
                if normalize_search_text(&flow.host).contains(domain)
                    || normalized_url.contains(domain)
                {
                    score += 90.0;
                    reasons.push(format!("domain matched `{domain}`"));
                }
            }
            for path in &profile.paths {
                if normalized_url.contains(path) {
                    score += 120.0;
                    reasons.push(format!("path matched `{path}`"));
                }
            }
            for phrase in &profile.phrases {
                if normalized_url.contains(phrase)
                    || normalized_headers.contains(phrase)
                    || normalized_body.contains(phrase)
                {
                    score += 85.0;
                    reasons.push(format!("phrase matched `{phrase}`"));
                }
            }
            for field in &profile.fields {
                if normalized_body.contains(field) || normalized_headers.contains(field) {
                    score += 76.0;
                    reasons.push(format!("field matched `{field}`"));
                }
            }
            if !profile.methods.is_empty()
                && profile
                    .methods
                    .iter()
                    .any(|method| method.eq_ignore_ascii_case(&flow.method))
            {
                score += 48.0;
                reasons.push("method matched intent".into());
            }
            if !profile.status_codes.is_empty()
                && flow
                    .status_code
                    .map(|status| profile.status_codes.contains(&status))
                    .unwrap_or(false)
            {
                score += 42.0;
                reasons.push("status matched intent".into());
            }
            for term in &profile.exclude_terms {
                if normalized_url.contains(term)
                    || normalized_headers.contains(term)
                    || normalized_body.contains(term)
                {
                    score -= 70.0;
                    reasons.push(format!("excluded term `{term}`"));
                }
            }
            if has_images && score <= 0.0 && !is_static_or_media_flow(&flow) {
                score = 0.5;
                reasons.push("recent fallback within screenshot search window".into());
            }
            if terms.is_empty() && score <= 0.0 {
                score = 0.4;
                reasons.push("recent fallback without extracted terms".into());
            }
            if is_static_or_media_flow(&flow) && !static_resource_intent {
                score -= 160.0;
                reasons.push("static/media resource downranked".into());
            }
            if profile.wants_latest {
                score += flow.started_at as f64 / 1_000_000_000_000f64;
            }
            let snippets = search_snippets(&flow, &terms, 5);
            EvidenceCandidate {
                flow,
                score,
                reasons,
                snippets,
            }
        })
        .filter(|candidate| candidate.score > 0.0)
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.flow.started_at.cmp(&left.flow.started_at))
    });
    candidates
}

fn next_search_batch(
    flows: &[CaptureFlow],
    question: &str,
    history_text: &str,
    profile: &EvidenceSearchProfile,
    has_images: bool,
    seen: &HashSet<String>,
    limit: usize,
) -> Vec<EvidenceCandidate> {
    let mut candidates =
        rank_search_candidates(flows, question, history_text, profile, has_images, seen);
    candidates.truncate(limit);
    candidates
}

fn candidate_card(candidate: &EvidenceCandidate, rank: usize) -> Value {
    let flow = &candidate.flow;
    json!({
        "rank": rank,
        "score": (candidate.score * 10.0).round() / 10.0,
        "matchReasons": candidate.reasons.iter().take(10).cloned().collect::<Vec<_>>(),
        "snippets": candidate.snippets,
        "flow": {
            "id": flow.id,
            "time": safe_date(flow.started_at),
            "method": flow.method,
            "statusCode": flow.status_code,
            "host": flow.host,
            "path": flow.path,
            "query": flow.query,
            "url": flow_url(flow),
            "durationMs": flow.duration_ms,
            "requestContentType": header_value(&flow.request_headers, "content-type"),
            "responseContentType": header_value(&flow.response_headers, "content-type"),
            "requestSize": flow.request_size,
            "responseSize": flow.response_size,
            "errorType": flow.error_type,
            "tags": flow.tags,
            "isSse": is_sse_flow(flow),
            "isStaticOrMedia": is_static_or_media_flow(flow)
        }
    })
}

fn match_flow_against_terms(
    flow: &CaptureFlow,
    terms: &[String],
    question: &str,
) -> (f64, Vec<String>) {
    let sections = [
        ("path", 36.0),
        ("query", 30.0),
        ("host", 28.0),
        ("body", 16.0),
        ("headers", 12.0),
        ("meta", 10.0),
    ];
    let mut score = 0.0;
    let mut reasons = Vec::new();

    for term in terms {
        if term.len() < 2 {
            continue;
        }
        let mut best: Option<(&str, f64)> = None;
        for (section, weight) in sections {
            if flow_section_text(flow, section).contains(term) {
                if best
                    .map(|(_, best_weight)| weight > best_weight)
                    .unwrap_or(true)
                {
                    best = Some((section, weight));
                }
            }
        }
        if let Some((section, weight)) = best {
            score += weight;
            if reasons.len() < 12 {
                reasons.push(format!("{section} matched `{term}`"));
            }
        }
    }

    let (identity, failure, slow, _today, streaming) = question_terms(question);
    let haystack = normalize_search_text(&format!(
        "{} {} {} {}",
        flow.host, flow.path, flow.query, flow.error_type
    ));
    if identity
        && (haystack.contains("account") || haystack.contains("user") || haystack.contains("login"))
    {
        score += 18.0;
        reasons.push("identity intent matched account/user/login endpoint".into());
    }
    if failure && (flow.status_code.unwrap_or_default() >= 400 || !flow.error_type.is_empty()) {
        score += 24.0;
        reasons.push("failure intent matched failing request".into());
    }
    if slow && flow.duration_ms.unwrap_or_default() > 1000 {
        score += 18.0;
        reasons.push("slow intent matched high duration".into());
    }
    if streaming && is_sse_flow(flow) {
        score += 80.0;
        reasons.push("streaming intent matched SSE/EventStream".into());
    }
    if is_upload_question(question) && is_upload_flow(flow) {
        score += 120.0;
        reasons.push("upload intent matched file-like request".into());
    }
    if flow
        .tags
        .iter()
        .any(|tag| tag == "selected" || tag == "selected-by-user")
        || question.contains(&flow.id)
    {
        score += 10_000.0;
        reasons.push("explicitly targeted by user".into());
    }

    if ["json", "xhr", "api"]
        .iter()
        .any(|term| haystack.contains(term))
    {
        score += 4.0;
    }

    (score, reasons)
}

#[cfg(test)]
fn retrieve_evidence_candidates(
    flows: &[CaptureFlow],
    question: &str,
    history_text: &str,
    profile: Option<&EvidenceSearchProfile>,
    has_images: bool,
) -> Vec<EvidenceCandidate> {
    let terms = build_evidence_search_terms(question, history_text, profile);
    let mut candidates: Vec<EvidenceCandidate> = flows
        .iter()
        .cloned()
        .filter_map(|flow| {
            let (score, reasons) = match_flow_against_terms(&flow, &terms, question);
            if score > 0.0 {
                let snippets = search_snippets(&flow, &terms, 5);
                Some(EvidenceCandidate {
                    flow,
                    score,
                    reasons,
                    snippets,
                })
            } else {
                None
            }
        })
        .collect();

    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.flow.started_at.cmp(&left.flow.started_at))
    });

    let mut seen = candidates
        .iter()
        .map(|candidate| candidate.flow.id.clone())
        .collect::<HashSet<_>>();
    if has_images && candidates.len() < MAX_EVIDENCE_CANDIDATES {
        let mut recent = flows.to_vec();
        recent.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        for flow in recent {
            if candidates.len() >= MAX_EVIDENCE_CANDIDATES {
                break;
            }
            if !seen.insert(flow.id.clone()) {
                continue;
            }
            let path = flow.path.to_ascii_lowercase();
            let is_static = [
                ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".css", ".js", ".woff", ".woff2",
                ".ttf",
            ]
            .iter()
            .any(|suffix| path.ends_with(suffix));
            if is_static {
                continue;
            }
            candidates.push(EvidenceCandidate {
                flow,
                score: 1.0,
                reasons: vec!["recent fallback for screenshot matching".into()],
                snippets: Vec::new(),
            });
        }
    }

    candidates.truncate(MAX_EVIDENCE_CANDIDATES);
    candidates
}

#[cfg(test)]
fn evidence_candidate_value(candidate: &EvidenceCandidate, rank: usize) -> Value {
    json!({
        "rank": rank,
        "score": (candidate.score * 10.0).round() / 10.0,
        "matchReasons": candidate.reasons,
        "snippets": candidate.snippets,
        "flow": summarize_flow(&candidate.flow)
    })
}

fn parse_search_batch_decision(content: &str, candidates: &[Value]) -> Option<SearchBatchDecision> {
    let parsed = extract_json_object(content)?;
    let candidate_ids = candidates
        .iter()
        .filter_map(|item| {
            item.get("flow")
                .and_then(|flow| flow.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let selected_flow_id = parsed
        .get("selectedFlowId")
        .or_else(|| parsed.get("selected_flow_id"))
        .or_else(|| parsed.get("flowId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| candidate_ids.contains(id));
    let confidence = parsed
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let sufficient = parsed
        .get("sufficient")
        .and_then(Value::as_bool)
        .unwrap_or(selected_flow_id.is_some() && confidence >= 0.72);
    let reason = parsed
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let refine_terms = parsed
        .get("refineTerms")
        .or_else(|| parsed.get("refine_terms"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_search_text)
                .filter(|term| !term.is_empty())
                .take(12)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(SearchBatchDecision {
        selected_flow_id,
        confidence,
        sufficient,
        reason,
        refine_terms,
    })
}

fn heuristic_batch_decision(batch: &[EvidenceCandidate]) -> SearchBatchDecision {
    let best = batch.first();
    let Some(candidate) = best else {
        return SearchBatchDecision {
            reason: "no candidates".into(),
            ..Default::default()
        };
    };
    let sufficient = candidate.score >= 180.0;
    SearchBatchDecision {
        selected_flow_id: if sufficient {
            Some(candidate.flow.id.clone())
        } else {
            None
        },
        confidence: if sufficient { 0.74 } else { 0.0 },
        sufficient,
        reason: if sufficient {
            format!(
                "fallback selected highest scoring candidate ({:.1})",
                candidate.score
            )
        } else {
            "fallback found no strong candidate".into()
        },
        refine_terms: Vec::new(),
    }
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

#[cfg(test)]
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
    if is_upload_question(question) && is_upload_flow(flow) {
        score += 260.0;
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

#[cfg(test)]
fn summarize_flow_index(flow: &CaptureFlow) -> Value {
    json!({
        "id": flow.id,
        "time": safe_date(flow.started_at),
        "method": flow.method,
        "statusCode": flow.status_code,
        "host": flow.host,
        "path": flow.path,
        "query": flow.query,
        "url": format!("{}://{}{}{}", if flow.scheme.is_empty() { "https" } else { &flow.scheme }, flow.host, flow.path, flow.query),
        "durationMs": flow.duration_ms,
        "tags": flow.tags
    })
}

#[cfg(test)]
fn build_agent_context(
    flows: &[CaptureFlow],
    question: &str,
    history_text: &str,
    has_images: bool,
    profile: Option<&EvidenceSearchProfile>,
) -> Value {
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
    let evidence_candidates =
        retrieve_evidence_candidates(flows, question, history_text, profile, has_images);
    let mut ranked = sorted.clone();
    ranked.sort_by(|left, right| {
        score_flow_for_question(right, question, now)
            .partial_cmp(&score_flow_for_question(left, question, now))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (_, _, _, _, streaming) = question_terms(question);

    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let sse_candidates = if streaming {
        sse_flows.clone()
    } else {
        Vec::new()
    };
    for flow in evidence_candidates
        .iter()
        .map(|candidate| candidate.flow.clone())
        .chain(ranked)
        .into_iter()
        .chain(sse_candidates)
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
    let focused_flow = selected
        .iter()
        .find(|flow| {
            flow.tags
                .iter()
                .any(|tag| tag == "selected" || tag == "selected-by-user")
        })
        .map(summarize_flow);
    let recent_limit = if has_images { 24 } else { 32 };
    let search_terms = build_evidence_search_terms(question, history_text, profile);

    json!({
        "generatedAt": safe_date(now),
        "scope": "当前上下文只包含本次应用内存中的抓包会话。用户说“今天”时，优先使用 startedAt 属于本地今天的请求；如果没有历史持久化数据，不要声称覆盖浏览器外的全部历史。",
        "matchingPolicy": if has_images {
            "本轮有截图：先从截图 OCR/视觉内容提取关键词，再搜索 candidateFlows、recentFlowIndex、flows 和 sseFlows；优先从 candidateFlows 里选择 startedAt 最新且 host/path/query/body/header 字段匹配最多的接口。不要默认使用当前 UI 选中请求；只有 focusedFlow 非空时才表示用户明确指定接口。"
        } else {
            "没有截图时，根据用户本轮文字和历史追问语境匹配接口；不要默认使用当前 UI 选中请求。只有 focusedFlow 非空时才表示用户明确指定接口。"
        },
        "focusedFlow": focused_flow,
        "visualSearchProfile": profile.map(|profile| json!({
            "summary": profile.summary.clone(),
            "terms": profile.terms.clone()
        })),
        "retriever": {
            "mode": "application_high_recall_then_ai_rerank",
            "searchTerms": search_terms,
            "candidateCount": evidence_candidates.len(),
            "policy": "candidateFlows 是应用侧高召回证据池。最终回答必须优先从 candidateFlows 选择证据；如果 candidateFlows 只有 recent fallback 或为空，必须说明未找到强匹配，不要改用无关旧接口。"
        },
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
        "recentFlowIndex": sorted.iter().take(recent_limit).map(summarize_flow_index).collect::<Vec<_>>(),
        "candidateFlows": evidence_candidates.iter().enumerate().map(|(index, candidate)| evidence_candidate_value(candidate, index + 1)).collect::<Vec<_>>(),
        "sseFlows": sse_flows.iter().take(12).map(summarize_flow).collect::<Vec<_>>(),
        "identityHints": selected.iter().flat_map(extract_identity_hints).take(80).collect::<Vec<_>>(),
        "flows": selected.iter().map(summarize_flow).collect::<Vec<_>>()
    })
}

fn build_final_agent_context(
    flows: &[CaptureFlow],
    question: &str,
    history_text: &str,
    has_images: bool,
    profile: &EvidenceSearchProfile,
    resolution: &SearchResolution,
) -> Value {
    let mut sorted = flows.to_vec();
    sorted.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let focused_flow = flows.iter().find(|flow| {
        flow.tags
            .iter()
            .any(|tag| tag == "selected" || tag == "selected-by-user")
    });
    let selected_flow = resolution
        .selected_flow_id
        .as_ref()
        .and_then(|id| flows.iter().find(|flow| &flow.id == id));
    let mut related = Vec::new();
    let mut related_seen = HashSet::new();
    if let Some(flow) = selected_flow {
        related_seen.insert(flow.id.clone());
        related.push(summarize_flow(flow));
    }
    for batch in &resolution.batches {
        if related.len() >= MAX_FINAL_CONTEXT_FLOWS {
            break;
        }
        if let Some(candidates) = batch.get("candidates").and_then(Value::as_array) {
            for candidate in candidates {
                if related.len() >= MAX_FINAL_CONTEXT_FLOWS {
                    break;
                }
                let Some(id) = candidate
                    .get("flow")
                    .and_then(|flow| flow.get("id"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if related_seen.contains(id) {
                    continue;
                }
                if let Some(flow) = flows.iter().find(|flow| flow.id == id) {
                    related_seen.insert(id.to_string());
                    related.push(summarize_flow(flow));
                }
            }
        }
    }
    let identity_hints = selected_flow
        .map(|flow| {
            extract_identity_hints(flow)
                .into_iter()
                .take(40)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "generatedAt": safe_date(now),
        "scope": "当前上下文只包含本次应用内存中的抓包会话；隐藏搜索器最多检查最近 100 条请求，每批 10 条。",
        "question": question,
        "hasScreenshot": has_images,
        "historyContext": truncate(history_text, 1200),
        "focusedFlow": focused_flow.map(summarize_flow),
        "searchIntent": profile_value(profile),
        "searchResult": {
            "selectedFlowId": resolution.selected_flow_id,
            "selectedConfidence": resolution.selected_confidence,
            "searchedCount": resolution.searched_count,
            "stoppedReason": resolution.stopped_reason,
            "batches": resolution.batches
        },
        "selectedFlow": selected_flow.map(summarize_flow),
        "relatedFlowDetails": related,
        "identityHints": identity_hints,
        "totals": {
            "allPassedToAgent": flows.len(),
            "searchedWindow": sorted.len().min(MAX_AGENT_SEARCH_FLOWS),
            "failed": sorted.iter().filter(|flow| flow.status_code.unwrap_or_default() >= 400 || !flow.error_type.is_empty()).count(),
            "slow": sorted.iter().filter(|flow| flow.duration_ms.unwrap_or_default() > 1000).count(),
            "sse": sorted.iter().filter(|flow| is_sse_flow(flow)).count(),
            "today": sorted.iter().filter(|flow| is_same_local_day(flow.started_at, now)).count()
        }
    })
}

fn selected_flow_for_resolution<'a>(
    flows: &'a [CaptureFlow],
    resolution: &SearchResolution,
) -> Option<&'a CaptureFlow> {
    resolution
        .selected_flow_id
        .as_ref()
        .and_then(|id| flows.iter().find(|flow| &flow.id == id))
}

fn flow_path_with_query(flow: &CaptureFlow) -> String {
    format!("{}{}", flow.path, flow.query)
}

fn collect_json_primitive_fields(
    value: &Value,
    path: &str,
    result: &mut Vec<AgentEvidenceField>,
    limit: usize,
) {
    if result.len() >= limit {
        return;
    }
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().take(8).enumerate() {
                collect_json_primitive_fields(item, &format!("{path}[{index}]"), result, limit);
                if result.len() >= limit {
                    return;
                }
            }
        }
        Value::Object(map) => {
            for (key, item) in map.iter().take(32) {
                let next_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                collect_json_primitive_fields(item, &next_path, result, limit);
                if result.len() >= limit {
                    return;
                }
            }
        }
        Value::Null => {}
        _ => {
            let value_text = content_to_text(value.clone());
            if !value_text.is_empty() {
                result.push(AgentEvidenceField {
                    label: path.to_string(),
                    value: truncate(&value_text, 1600),
                });
            }
        }
    }
}

fn body_primitive_fields(
    flow: &CaptureFlow,
    direction: &str,
    limit: usize,
) -> Vec<AgentEvidenceField> {
    let body = if direction == "request" {
        &flow.request_body_preview
    } else {
        &flow.response_body_preview
    };
    let Some(parsed) = try_parse_json(body) else {
        return Vec::new();
    };
    let mut fields = Vec::new();
    collect_json_primitive_fields(
        &parsed,
        if direction == "request" {
            "requestBody"
        } else {
            "responseBody"
        },
        &mut fields,
        limit,
    );
    fields
}

fn field_copy_priority(label: &str) -> i32 {
    let lower = label.to_ascii_lowercase();
    if lower.ends_with(".file_id") || lower.ends_with(".uid") || lower.ends_with(".user_id") {
        return 100;
    }
    if lower.ends_with(".id") || lower.contains("task_id") || lower.contains("template_id") {
        return 90;
    }
    if lower.contains("file_url") || lower.ends_with(".url") || lower.contains("token") {
        return 82;
    }
    if lower.contains("file_name") || lower.ends_with(".name") || lower.contains("account") {
        return 74;
    }
    if lower.ends_with(".code") || lower.ends_with(".message") || lower.ends_with(".status") {
        return 66;
    }
    if lower.contains("type") || lower.contains("size") || lower.contains("description") {
        return 52;
    }
    10
}

fn unique_evidence_fields(
    fields: Vec<AgentEvidenceField>,
    limit: usize,
) -> Vec<AgentEvidenceField> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for field in fields {
        if field.label.is_empty() || field.value.is_empty() {
            continue;
        }
        let key = format!("{}={}", field.label, field.value);
        if seen.insert(key) {
            result.push(field);
        }
        if result.len() >= limit {
            break;
        }
    }
    result
}

fn build_stream_structured_answer(
    content: &str,
    flows: &[CaptureFlow],
    resolution: &SearchResolution,
) -> AgentStructuredAnswer {
    let summary = content
        .split("\n\n")
        .map(str::trim)
        .find(|part| !part.is_empty())
        .map(|part| truncate(part, 1000))
        .unwrap_or_else(|| "已完成分析。".into());
    let Some(flow) = selected_flow_for_resolution(flows, resolution) else {
        return AgentStructuredAnswer {
            summary: Some(summary),
            highlights: Some(Vec::new()),
            evidence: Some(Vec::new()),
            analysis: Some(
                content
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .take(6)
                    .map(|line| truncate(line, 500))
                    .collect(),
            ),
            test_cases: Some(Vec::new()),
        };
    };

    let mut fields = Vec::new();
    fields.extend(body_primitive_fields(flow, "request", 16));
    fields.extend(body_primitive_fields(flow, "response", 24));
    fields.sort_by(|left, right| {
        field_copy_priority(&right.label)
            .cmp(&field_copy_priority(&left.label))
            .then_with(|| left.label.cmp(&right.label))
    });
    let fields = unique_evidence_fields(fields, 12);

    let mut highlights = vec![AgentHighlight {
        label: "接口".into(),
        value: format!("{} {}", flow.method, flow_path_with_query(flow)),
        kind: Some("url".into()),
        source: Some("selectedFlow.path".into()),
    }];
    if let Some(status) = flow.status_code {
        highlights.push(AgentHighlight {
            label: "状态".into(),
            value: status.to_string(),
            kind: Some("status".into()),
            source: Some("selectedFlow.statusCode".into()),
        });
    }
    for field in fields
        .iter()
        .filter(|field| field_copy_priority(&field.label) >= 52)
        .take(5)
    {
        highlights.push(AgentHighlight {
            label: field
                .label
                .rsplit('.')
                .next()
                .unwrap_or(&field.label)
                .trim_matches(|ch| ch == '[' || ch == ']')
                .to_string(),
            value: field.value.clone(),
            kind: Some("field".into()),
            source: Some(field.label.clone()),
        });
    }

    let analysis = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with('#'))
        .take(8)
        .map(|line| truncate(line, 500))
        .collect::<Vec<_>>();

    AgentStructuredAnswer {
        summary: Some(summary),
        highlights: Some(highlights),
        evidence: Some(vec![AgentEvidence {
            title: Some("命中接口".into()),
            time: Some(safe_date(flow.started_at)),
            method: Some(flow.method.clone()),
            status: flow.status_code.map(Value::from),
            host: Some(flow.host.clone()),
            path: Some(flow_path_with_query(flow)),
            fields: Some(fields),
        }]),
        analysis: Some(analysis),
        test_cases: Some(Vec::new()),
    }
}

fn normalize_history(history: Vec<AgentChatMessage>) -> Vec<Value> {
    history
        .into_iter()
        .filter(|item| {
            (item.role == "user" || item.role == "assistant") && !item.content.is_empty()
        })
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|item| chat_message(&item.role, Value::String(truncate(&item.content, 600))))
        .collect()
}

fn build_final_user_content(question: &str, context: &Value) -> Value {
    Value::String(format!(
        "用户问题：{question}\n\n隐藏搜索器已经完成截图/文字意图提取、候选检索和分批判断。请只基于下面上下文回答，不要重新假设当前选中接口。\n\n{}",
        serde_json::to_string_pretty(context).unwrap_or_else(|_| "{}".into())
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        build_agent_context, build_stream_structured_answer, build_text_search_profile,
        rank_search_candidates, retrieve_evidence_candidates, EvidenceSearchProfile,
        SearchResolution,
    };
    use crate::models::CaptureFlow;
    use std::collections::{HashMap, HashSet};

    fn flow(
        id: &str,
        started_at: u64,
        host: &str,
        path: &str,
        response_body: &str,
        tags: Vec<&str>,
    ) -> CaptureFlow {
        CaptureFlow {
            id: id.into(),
            started_at,
            completed_at: Some(started_at + 20),
            method: "GET".into(),
            scheme: "https".into(),
            host: host.into(),
            port: None,
            path: path.into(),
            query: String::new(),
            status_code: Some(200),
            protocol: "HTTP/2".into(),
            source: "test".into(),
            client_address: None,
            duration_ms: Some(42),
            request_headers: HashMap::new(),
            response_headers: HashMap::new(),
            request_body_preview: String::new(),
            request_body_path: None,
            request_body_text_path: None,
            request_body_preview_truncated: false,
            request_body_decoded_size: 0,
            request_body_replay_size: 0,
            response_body_preview: response_body.into(),
            response_body_text_path: None,
            response_body_preview_truncated: false,
            response_body_decoded_size: 0,
            request_size: 0,
            response_size: response_body.len() as u64,
            error_type: String::new(),
            sse_events: Vec::new(),
            tags: tags.into_iter().map(String::from).collect(),
        }
    }

    #[test]
    fn evidence_retriever_prefers_keyword_match_over_recent_fallback() {
        let matched = flow(
            "layout-flow",
            2_000,
            "api.example.test",
            "/space/api/obj_stats/member_active/",
            r#"{"layout_key":129,"title":"自动布局"}"#,
            vec![],
        );
        let recent = flow(
            "recent-flow",
            3_000,
            "api.example.test",
            "/accounts/status/heartbeat",
            "{}",
            vec![],
        );
        let profile = EvidenceSearchProfile {
            summary: "页面显示自动布局和 layout_key".into(),
            terms: vec!["自动布局".into(), "layout_key".into()],
            ..Default::default()
        };

        let candidates = retrieve_evidence_candidates(
            &[recent, matched],
            "这页明显是自动布局啊",
            "",
            Some(&profile),
            true,
        );

        assert_eq!(
            candidates.first().map(|item| item.flow.id.as_str()),
            Some("layout-flow")
        );
        assert!(candidates[0]
            .reasons
            .iter()
            .any(|reason| reason.contains("layout_key") || reason.contains("自动布局")));
    }

    #[test]
    fn screenshot_context_does_not_promote_old_sse_without_streaming_intent() {
        let mut old_sse = flow(
            "old-sse",
            1_000,
            "api.example.test",
            "/events",
            "data: {}\n\n",
            vec!["sse"],
        );
        old_sse
            .response_headers
            .insert("content-type".into(), "text/event-stream".into());
        let matched = flow(
            "layout-flow",
            2_000,
            "api.example.test",
            "/layout/config",
            r#"{"layout_key":129}"#,
            vec![],
        );
        let profile = EvidenceSearchProfile {
            summary: String::new(),
            terms: vec!["layout_key".into()],
            ..Default::default()
        };

        let context = build_agent_context(
            &[old_sse, matched],
            "这页是什么布局",
            "",
            true,
            Some(&profile),
        );
        let first_candidate = context
            .get("candidateFlows")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .and_then(|item| item.get("flow"))
            .and_then(|flow| flow.get("id"))
            .and_then(|id| id.as_str());

        assert_eq!(first_candidate, Some("layout-flow"));
    }

    #[test]
    fn hidden_search_prefers_upload_api_over_static_image_resource() {
        let mut upload = flow(
            "upload-api",
            2_000,
            "api.example.test",
            "/space/api/file/upload",
            r#"{"file_token":"abc"}"#,
            vec![],
        );
        upload.method = "POST".into();
        upload
            .request_headers
            .insert("content-type".into(), "multipart/form-data".into());
        let mut image = flow(
            "image-asset",
            3_000,
            "cdn.example.test",
            "/materials/avatar.png",
            "[binary body omitted]",
            vec![],
        );
        image
            .response_headers
            .insert("content-type".into(), "image/png".into());
        let profile = build_text_search_profile("上传图片用的是哪个接口", "");

        let candidates = rank_search_candidates(
            &[image, upload],
            "上传图片用的是哪个接口",
            "",
            &profile,
            true,
            &HashSet::new(),
        );

        assert_eq!(
            candidates.first().map(|item| item.flow.id.as_str()),
            Some("upload-api")
        );
    }

    #[test]
    fn streamed_answer_keeps_structured_copy_fields() {
        let mut upload = flow(
            "upload-api",
            2_000,
            "api.example.test",
            "/overseas-agent/api/file/save",
            r#"{"code":0,"message":"success","data":{"file_id":7386,"file_name":"demo.pdf"}}"#,
            vec![],
        );
        upload.method = "POST".into();
        upload.request_body_preview = r#"{"file_name":"demo.pdf","file_url":"https://s3.example/demo.pdf","file_type":"pdf"}"#.into();
        let resolution = SearchResolution {
            selected_flow_id: Some("upload-api".into()),
            selected_confidence: 0.9,
            ..Default::default()
        };

        let structured = build_stream_structured_answer(
            "这个接口是 POST /overseas-agent/api/file/save，用于保存上传后的文件元数据。",
            &[upload],
            &resolution,
        );

        let highlights = structured.highlights.unwrap_or_default();
        assert!(highlights.iter().any(
            |item| item.label == "接口" && item.value.contains("/overseas-agent/api/file/save")
        ));
        assert!(highlights
            .iter()
            .any(|item| item.source.as_deref() == Some("responseBody.data.file_id")));
        let evidence_fields = structured
            .evidence
            .unwrap_or_default()
            .into_iter()
            .flat_map(|item| item.fields.unwrap_or_default())
            .collect::<Vec<_>>();
        assert!(evidence_fields
            .iter()
            .any(|field| field.label == "requestBody.file_url"));
    }
}

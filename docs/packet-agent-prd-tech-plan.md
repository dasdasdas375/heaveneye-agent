# HeavenEye Agent 需求文档与技术实现方案

版本：v0.1
日期：2026-06-11
目标阶段：产品立项 / MVP 技术预研

## 1. 背景与机会

传统抓包工具已经非常成熟，但大多诞生较早，核心交互仍然停留在“捕获流量、展示请求、人工分析”的阶段。对于现代研发和测试团队，真实痛点已经从“能不能抓到包”转向：

- 抓到大量请求后，无法快速定位与缺陷相关的关键请求。
- HTTPS、证书、代理、移动端配置门槛仍然偏高。
- 测试提交缺陷时，经常只能附截图或 HAR，开发仍需二次复现。
- 前后端联调缺少自动化差异分析，例如请求参数、Header、Cookie、响应结构差异。
- Mock、重放、断点、弱网、异常响应构造分散在多个工具里。
- 抓包数据包含 Token、Cookie、手机号、邮箱等敏感信息，团队分享风险高。
- WebSocket、SSE、GraphQL、AI 流式接口、HTTP/2、移动 App 调试等现代场景支持不均衡。

本产品希望做一个面向开发者和测试人员的现代化抓包调试 Agent，不只负责抓包，还能理解抓包结果、辅助诊断问题、生成复现材料、构造测试场景，并安全地协作分享。

## 2. 产品定位

产品正式名：HeavenEye Agent

中文名：天瞳 / 天眼抓包Agent

品牌释义：Heaven（天宫、天界）+ Eye（神眼），直译天眼，贴合二郎神天眼设定。寓意如二郎真君天界神目，全域透视网络数据流，AI 自动捕获、解析、追踪所有接口请求。

产品全称：HeavenEye Agent - AI智能流量抓包分析工具

域名参考：heaveneye.dev / heaveneye.tech

Slogan：

- HeavenEye，洞悉全网每一条数据流
- One Divine Eye, All Network Traces
- 天眼之下，无藏匿报文

一句话定位：

面向研发和测试的智能抓包调试 Agent，支持浏览器、桌面应用、移动设备的 HTTP/HTTPS 流量捕获、分析、重放、Mock、弱网模拟、缺陷报告生成和团队协作。

产品不做什么：

- 不作为第一阶段的通用底层网络协议分析工具，不与 Wireshark 正面竞争。
- 不作为第一阶段的渗透测试平台，不与 Burp Suite 正面竞争。
- 不作为单纯 API 管理平台，不替代 Postman。
- 不作为企业 NDR/IDS/安全审计平台，不替代 Zeek、Suricata、Arkime。

核心差异化：

- 抓包 + Agent 分析 + 复现材料生成。
- 开发、测试、前后端联调工作流闭环。
- 默认本地优先、默认脱敏分享。
- 对现代 Web/App 调试场景友好。

## 3. 目标用户

### 3.1 核心用户

前端开发：

- 查看页面触发了哪些接口。
- 排查接口参数、跨域、缓存、鉴权、响应格式问题。
- 对比不同环境、不同用户、不同版本请求差异。

后端开发：

- 验证客户端实际发送的请求。
- 复现测试人员发现的问题。
- 分析 Header、Cookie、Token、请求体、响应体。
- 将抓包请求转为 curl、单元测试或接口测试。

测试工程师：

- 快速抓包并附带到缺陷报告。
- 构造异常响应、弱网、超时、空数据、错误状态码。
- 回放请求验证问题是否复现。
- 将抓包会话交给开发复现。

移动端开发 / 测试：

- 抓取 iOS 真机、iOS Simulator、Android 真机、Android Emulator 的 HTTPS 请求。
- 分析 App 接口请求、WebView 请求、图片/资源请求。
- 快速处理证书、代理、设备配置。

自动化测试工程师：

- 从抓包请求生成接口测试用例。
- 将失败请求沉淀为回归用例。
- 在 CI 中复用抓包、Mock、重放能力。

### 3.2 非核心用户

- 安全测试人员：可使用改包、重放、弱网等能力，但高级漏洞扫描不是首期重点。
- 网络运维人员：可查看基础网络错误，但深层 TCP/TLS 分析不是首期重点。
- 企业安全团队：可使用脱敏与审计能力，但 NDR/IDS 不是产品主线。

## 4. 竞品启发

| 工具 | 优点 | 不足 | 借鉴点 |
| --- | --- | --- | --- |
| Proxyman | macOS 体验好，移动端 HTTPS 配置顺滑，UI 现代 | 仍以人工分析为主，团队测试闭环有限 | 低门槛配置、现代 UI、移动端引导 |
| Charles | 老牌稳定，断点、弱网、Map Local 成熟 | UI 老，自动化和协作弱 | 规则系统、断点、弱网模拟 |
| Fiddler | Windows 用户多，HTTP 调试成熟 | 体验偏传统，智能化不足 | QA 友好、会话保存、过滤 |
| mitmproxy | 开源、脚本能力强、适合自动化 | 对非技术测试人员门槛高 | CLI、脚本、可编程代理 |
| Burp Suite | 重放、改包、安全测试强 | 对普通研发测试偏重 | Repeater、请求编辑、请求历史 |
| Chrome DevTools | 前端天然入口，无需额外代理 | 只能看单浏览器当前上下文，协作和移动调试弱 | 页面请求瀑布流、Timing、Initiator |
| Postman | API 调试和集合管理强 | 不是被动抓包工具，无法完整还原客户端行为 | 请求集合、环境变量、测试脚本 |
| Wireshark | 协议解析强 | HTTPS 应用层调试门槛高 | 底层诊断作为高级补充 |

产品机会：

- 把 Proxyman/Charles 的易用抓包、mitmproxy 的自动化、Postman 的接口集合、Chrome DevTools 的前端视图、AI Agent 的自动诊断融合在一个面向研发测试的工作流里。

## 5. 核心使用场景

### 5.1 前后端联调

用户故事：

作为前端开发，我希望打开页面后自动捕获相关接口，并快速知道接口失败原因，以便减少和后端反复沟通。

关键流程：

1. 启动 Agent。
2. 选择浏览器或项目域名。
3. 打开页面并操作。
4. Agent 自动标记失败、慢请求、异常响应结构。
5. 用户点击失败接口查看详情。
6. Agent 给出诊断，例如“请求缺少 Authorization Header”或“响应字段类型与上一次成功请求不一致”。

### 5.2 测试提交缺陷

用户故事：

作为测试工程师，我希望在发现 bug 后一键生成包含关键请求、环境、复现步骤和脱敏数据的缺陷报告。

关键流程：

1. 测试打开录制模式。
2. 复现 bug。
3. 点击“生成缺陷报告”。
4. Agent 识别关键请求和错误响应。
5. 自动脱敏 Token、Cookie、手机号、邮箱等字段。
6. 导出 Markdown / HTML / Jira / 飞书 / 禅道格式。

### 5.3 请求重放与改包

用户故事：

作为后端开发，我希望拿到测试发来的抓包会话后可以直接重放失败请求，并修改参数验证问题。

关键流程：

1. 开发打开测试分享的会话。
2. 点击关键请求。
3. 使用 Repeat 原样重放。
4. 使用 Edit & Repeat 修改 Header、Body、Query。
5. 对比重放结果和原始结果。

### 5.4 Mock 和异常场景测试

用户故事：

作为测试人员，我希望快速模拟接口超时、500、空数据、字段缺失等异常场景。

关键流程：

1. 选择某个接口。
2. 点击“创建 Mock 场景”。
3. 选择状态码、延迟、响应体模板。
4. 保存为场景，例如“库存不足”“登录过期”“接口超时”。
5. 再次操作 App 或页面时自动命中 Mock。

### 5.5 AI 流式接口调试

用户故事：

作为开发者，我希望能调试 SSE、WebSocket、流式 JSON 响应，查看每一段返回内容和耗时。

关键流程：

1. 捕获流式请求。
2. 展示连接建立、首包时间、每段消息、结束原因。
3. 支持按消息搜索。
4. Agent 总结流式响应中断、超时、格式错误原因。

## 6. 功能需求

### 6.1 抓包代理

必须支持：

- HTTP/HTTPS 正向代理。
- 浏览器抓包：Chrome、Edge、Safari、Firefox。
- 常见 HTTP 方法：GET、POST、PUT、PATCH、DELETE、OPTIONS、HEAD。
- HTTPS 解密：本地根证书生成、安装、信任、卸载。
- 域名级 SSL 解密开关。
- localhost / 127.0.0.1 / 本机端口抓包。
- 代理开关：系统代理、浏览器代理、指定进程代理。
- 请求和响应完整捕获：Header、Cookie、Query、Body、Status、Timing。
- WebSocket 消息捕获。
- SSE / text/event-stream 捕获。

建议支持：

- HTTP/2。
- HTTP/3/QUIC 检测与禁用提示。
- PAC 代理规则。
- 外部上游代理。
- VPN 冲突检测。
- 按应用进程识别请求来源。

### 6.2 请求列表与详情

请求列表字段：

- 时间
- Method
- Status
- Host
- Path
- Content-Type
- Size
- Duration
- Source App / Browser
- Protocol
- 标签 / 备注
- 命中规则

请求详情视图：

- Overview
- Request Headers
- Response Headers
- Query Params
- Cookies
- Request Body
- Response Body
- Timing
- Raw
- Preview
- Agent Analysis

Body 预览：

- JSON 格式化、折叠、搜索、JSONPath 查询。
- XML 格式化。
- HTML 预览。
- 图片预览。
- Form 表单解析。
- Multipart 文件上传解析。
- JWT 解析。
- GraphQL operation 识别。
- Protobuf / MessagePack 插件化解析。

### 6.3 搜索与过滤

基础过滤：

- Method
- Status code
- Host
- Path
- Content-Type
- Duration
- Size
- Source App
- 是否失败
- 是否慢请求
- 是否命中 Mock

高级搜索：

- 搜索 Header、Body、Cookie、Query。
- JSON 字段搜索。
- 正则表达式。
- 保存过滤器。
- 过滤器组合。

智能过滤：

- 只看失败请求。
- 只看本次用户操作产生的请求。
- 只看登录、支付、上传等关键链路。
- 自动隐藏静态资源。

### 6.4 重放与改包

必须支持：

- 原样重放请求。
- 编辑并重放请求。
- 批量重放。
- 复制为 curl。
- 复制为 Fetch。
- 复制为 Axios。
- 复制为 Python requests。
- 复制为 OkHttp。
- 复制为 Swift URLSession。

建议支持：

- 请求参数化。
- 环境变量替换。
- Token 自动继承。
- 重放结果与原请求对比。
- 生成 Postman Collection。
- 生成 OpenAPI 草稿。
- 生成 Playwright API 测试。
- 生成 pytest / Jest 测试代码。

### 6.5 Mock、Rewrite 与断点

Mock 能力：

- 将接口响应映射到本地文件。
- 直接编辑响应体。
- 修改状态码。
- 修改响应 Header。
- 设置响应延迟。
- 设置响应模板。
- 根据真实响应生成 Mock。

Rewrite 能力：

- 修改请求 URL。
- 修改请求 Header。
- 修改 Query。
- 修改 Body。
- 修改响应 Body。
- 修改 Cookie。
- 域名转发，例如 test API 转 dev API。

断点能力：

- 请求发送前暂停。
- 响应返回后暂停。
- 手动编辑请求 / 响应后继续。
- 丢弃请求。
- 返回指定错误。

异常场景快捷模板：

- 401 未登录。
- 403 无权限。
- 404 资源不存在。
- 409 状态冲突。
- 422 参数校验失败。
- 429 频率限制。
- 500 服务异常。
- 空列表。
- 空对象。
- 字段缺失。
- 字段类型错误。
- 慢响应。
- 超时。
- 断网。

### 6.6 弱网模拟

必须支持：

- 固定延迟。
- 下载限速。
- 上传限速。
- 请求超时。

建议支持：

- 丢包率。
- 抖动。
- 预设网络：2G、3G、4G、弱 Wi-Fi、离线。
- 按域名 / 接口 / App 设置弱网。

### 6.7 Agent 智能分析

Agent 不是简单聊天框，而是围绕抓包会话提供可执行诊断能力。

核心能力：

- 失败请求总结。
- 慢请求总结。
- 异常状态码解释。
- CORS 问题诊断。
- 鉴权问题诊断。
- Cookie / Session 问题诊断。
- 请求差异对比。
- 响应结构差异对比。
- 缺陷报告生成。
- Mock 场景生成。
- 测试用例生成。
- 敏感信息识别与脱敏建议。

示例指令：

- “帮我找出这次页面加载失败的原因。”
- “为什么这个 PUT 请求返回 403？”
- “对比这两个请求的差异。”
- “把这次抓包整理成 bug 报告。”
- “帮我生成 curl、Postman 和 Playwright 测试。”
- “找出响应超过 1 秒的接口。”
- “把敏感字段脱敏后分享给开发。”
- “根据这个响应生成空数据和 500 两个 Mock 场景。”

Agent 输出要求：

- 给出结论。
- 引用证据请求。
- 标注相关 Header / Body / Status。
- 给出可能原因和验证建议。
- 提供一键操作，例如重放、生成报告、创建 Mock、导出测试。

### 6.8 缺陷报告生成

报告内容：

- 标题建议。
- 问题摘要。
- 复现步骤。
- 发生时间。
- 客户端环境。
- 目标环境。
- 关键请求列表。
- 关键请求详情。
- 失败响应。
- Agent 初步判断。
- 已脱敏的 curl。
- 附件：脱敏抓包会话。

导出格式：

- Markdown。
- HTML。
- JSON。
- Jira。
- GitHub Issue。
- Linear。
- 飞书 / 企业微信 / 禅道可作为后续集成。

### 6.9 脱敏与安全

默认敏感字段：

- Authorization
- Cookie
- Set-Cookie
- access_token
- refresh_token
- id_token
- token
- password
- secret
- phone
- email
- id_card
- bank_card
- session

能力要求：

- 分享前默认脱敏。
- 用户可预览脱敏结果。
- 支持自定义脱敏规则。
- 支持域名级禁抓。
- 支持字段级永久隐藏。
- 支持会话加密存储。
- 企业版支持审计日志。

### 6.10 团队协作

MVP 支持：

- 本地会话保存。
- 导出脱敏会话文件。
- 导入会话文件。
- 请求备注。
- 请求标签。

后续支持：

- 云端项目空间。
- 分享链接。
- 评论。
- 指派。
- 权限管理。
- 团队 Mock 规则。
- 团队脱敏规则。
- 缺陷平台集成。

## 7. 非功能需求

### 7.1 性能

- 10 万条请求会话可打开和搜索。
- 列表虚拟滚动。
- 大响应体懒加载。
- 流式响应增量写入。
- UI 不因大包阻塞。
- 代理核心不明显影响正常网络访问。
- 单请求 100MB 以上响应可保存但默认不完整渲染。

### 7.2 稳定性

- 代理崩溃不应导致系统代理长期残留。
- 应提供恢复系统代理能力。
- 证书安装失败、代理冲突、端口占用应给出明确提示。
- 会话数据应定期 flush，减少崩溃丢失。

### 7.3 安全与隐私

- 默认本地存储。
- 默认不上传抓包内容。
- 云同步必须用户明确开启。
- 分享默认脱敏。
- 根证书可一键卸载。
- 支持关闭特定域名捕获。

### 7.4 易用性

- 新用户 3 分钟内完成浏览器 HTTPS 抓包。
- 移动端配置提供步骤化向导。
- 常见异常自动诊断：证书未信任、代理未开启、QUIC、VPN、localhost、证书锁定。
- UI 面向开发/测试，不展示过多底层协议概念。

## 8. MVP 范围

### 8.1 MVP 必做

平台：

- macOS 桌面端。

抓包：

- Chrome / Safari HTTP/HTTPS 抓包。
- 系统代理配置。
- 根证书生成、安装、信任、卸载。
- 域名级 SSL Proxying。
- localhost 抓包。

查看：

- 请求列表。
- 请求详情。
- Headers、Query、Cookies、Body、Timing。
- JSON 格式化。
- 图片预览。
- WebSocket 基础查看。
- SSE 基础查看。

调试：

- Repeat。
- Edit & Repeat。
- Copy as cURL。
- Map Local。
- 简单 Breakpoint。
- 固定延迟弱网。

Agent：

- 失败请求总结。
- 两个请求差异对比。
- 生成缺陷报告。
- 敏感字段脱敏。

数据：

- 本地会话保存。
- 导出 / 导入会话文件。

### 8.2 MVP 暂不做

- Windows / Linux 桌面端。
- 云端团队协作。
- 高级安全扫描。
- 完整 HTTP/3 解密。
- 全量底层 TCP 协议分析。
- 企业审计后台。
- 移动端独立 App。
- 插件市场。

## 9. 技术实现方案

## 9.1 总体架构

系统分为七层：

1. Desktop App：桌面 UI、会话管理、规则配置、Agent 面板。
2. Proxy Core：本地代理、TLS MITM、HTTP/HTTPS/WebSocket/SSE 处理。
3. Capture Pipeline：流量解析、脱敏预处理、索引、持久化。
4. Rule Engine：Mock、Rewrite、Breakpoint、Weak Network。
5. Agent Engine：诊断、对比、报告、测试生成。
6. Storage Engine：本地数据库、对象文件、索引。
7. Integration Layer：CLI、测试框架、缺陷平台、团队服务。

推荐首期架构：

```text
Browser / App / Mobile
        |
        v
 System Proxy / Manual Proxy
        |
        v
 Local Proxy Core
        |
        +--> TLS MITM / Certificate Manager
        +--> HTTP Parser / WebSocket Parser / SSE Parser
        +--> Rule Engine
        +--> Capture Pipeline
                 |
                 +--> Storage Engine
                 +--> Search Index
                 +--> Agent Context Builder
        |
        v
 Desktop UI
        |
        +--> Request Inspector
        +--> Replay / Mock / Breakpoint
        +--> Agent Panel
        +--> Export / Import
```

## 9.2 技术选型建议

### 9.2.1 桌面端

候选：

- Tauri + React / Vue / Svelte
- Electron + React / Vue
- SwiftUI 原生 macOS

建议：

MVP 可优先选择 Tauri + React。

原因：

- 比 Electron 轻。
- Rust 与代理核心结合自然。
- 后续跨平台潜力较好。
- 前端生态成熟，方便构建复杂请求列表和编辑器。

如果团队强 macOS 原生能力，也可选择 SwiftUI + SwiftNIO，但后续 Windows/Linux 成本更高。

### 9.2.2 代理核心

候选：

- Rust：hyper、tokio、rustls、h2。
- Go：net/http、crypto/tls、goproxy。
- Node.js：http-proxy、mitmproxy-like 实现。
- Swift：SwiftNIO。

建议：

MVP 优先 Rust 或 Go。

Rust 优点：

- 性能好。
- 内存安全。
- 与 Tauri 集成好。
- 适合长期构建高性能本地代理。

Go 优点：

- 网络库成熟。
- 开发速度快。
- 跨平台简单。
- 招人和维护成本较低。

建议判断：

- 如果团队追求长期性能和桌面端轻量化，选 Rust。
- 如果团队追求 MVP 速度和工程效率，选 Go。

本文后续以 Rust 为主方案。

### 9.2.3 存储

建议：

- SQLite 存结构化元数据。
- 本地文件系统存大请求体 / 响应体。
- Tantivy 或 SQLite FTS 做搜索索引。

原因：

- 抓包数据天然本地优先。
- SQLite 稳定、可迁移、可加密。
- 大 Body 不适合全部塞入单表。

### 9.2.4 Agent

建议分为规则诊断 + LLM 诊断两层：

- 本地规则引擎：快速、稳定、可解释。
- LLM Agent：负责总结、解释、报告、测试生成。

本地规则覆盖：

- 4xx / 5xx 状态码。
- CORS。
- 超时。
- 重定向循环。
- Content-Type 不匹配。
- JSON 解析失败。
- Token 缺失。
- Cookie 缺失。
- 响应字段缺失。
- 请求差异。

LLM 输入必须受控：

- 默认只传相关请求摘要。
- Body 大小限制。
- 敏感字段先脱敏。
- 用户确认后才发送云端模型。
- 支持企业配置私有模型或本地模型。

## 9.3 核心模块设计

### 9.3.1 Certificate Manager

职责：

- 生成本地 Root CA。
- 保存 CA 私钥。
- 安装和信任证书。
- 按域名动态签发证书。
- 证书过期轮换。
- 一键卸载证书。

关键点：

- CA 私钥只保存在本机。
- macOS 使用 Keychain 管理。
- Windows 后续使用系统证书存储。
- Firefox 有独立证书库，需要单独处理。

### 9.3.2 Proxy Core

职责：

- 监听本地代理端口，例如 9090。
- 处理 HTTP 明文请求。
- 处理 HTTPS CONNECT。
- 对开启 SSL Proxying 的域名执行 MITM。
- 转发请求到目标服务。
- 捕获请求与响应。
- 支持 WebSocket upgrade。
- 支持 SSE 流式转发。

处理流程：

```text
Client Request
  -> Proxy Accept
  -> Match Capture Rule
  -> If HTTPS CONNECT:
       If SSL enabled for host:
         Establish TLS with client using generated cert
         Establish TLS with upstream
         Decode HTTP
       Else:
         Tunnel raw TCP
  -> Apply Request Rules
  -> Send Upstream
  -> Receive Response
  -> Apply Response Rules
  -> Persist Capture
  -> Return Response to Client
```

### 9.3.3 Capture Pipeline

职责：

- 标准化请求数据。
- 提取元数据。
- 生成请求 ID。
- 计算耗时。
- 解析 Body。
- 写入存储。
- 通知 UI 增量更新。

元数据包括：

- flow_id
- session_id
- timestamp
- method
- scheme
- host
- port
- path
- query
- status_code
- request_headers
- response_headers
- request_body_ref
- response_body_ref
- duration_ms
- content_type
- protocol
- source_app
- rule_hits
- error_type

### 9.3.4 Rule Engine

规则类型：

- Capture Rule：是否捕获。
- SSL Rule：是否解密。
- Rewrite Rule：改请求 / 改响应。
- Mock Rule：返回本地或模板响应。
- Breakpoint Rule：暂停等待用户操作。
- Throttle Rule：弱网模拟。
- Block Rule：阻断请求。

规则匹配条件：

- Host。
- Path。
- Method。
- Status。
- Header。
- Query。
- Body JSONPath。
- Source App。

规则执行顺序：

1. Block。
2. Mock。
3. Request Rewrite。
4. Breakpoint Before Request。
5. Upstream Request。
6. Response Rewrite。
7. Breakpoint After Response。
8. Throttle / Delay。
9. Persist。

### 9.3.5 Replay Engine

职责：

- 从捕获请求还原可发送请求。
- 支持编辑 Header、Query、Body。
- 支持环境变量。
- 支持 Token 替换。
- 保存重放历史。
- 对比原始响应和重放响应。

注意：

- 默认不自动携带敏感 Cookie 到其他环境。
- 跨环境重放需要用户确认。
- 文件上传请求需要保留 multipart 文件引用。

### 9.3.6 Agent Engine

模块：

- Context Selector：选择与问题相关的请求。
- Sanitizer：脱敏。
- Rule Diagnoser：规则诊断。
- Diff Engine：请求 / 响应差异。
- Report Generator：报告生成。
- Test Generator：测试生成。
- Action Planner：把 Agent 结论转成 UI 操作。

Agent 工作流：

```text
User asks question
  -> Identify intent
  -> Select relevant flows
  -> Sanitize data
  -> Run local diagnostics
  -> Build compact LLM context
  -> Generate conclusion
  -> Attach evidence
  -> Return actions
```

示例输出结构：

```json
{
  "summary": "PUT /api/user/123 返回 403，最可能原因是缺少 CSRF Token。",
  "evidence": [
    {
      "flow_id": "flow_123",
      "field": "request.headers.x-csrf-token",
      "issue": "missing"
    }
  ],
  "suggestions": [
    "检查前端是否从 cookie 或 meta 标签读取 CSRF token",
    "与成功请求对比 Header"
  ],
  "actions": [
    "compare_with_successful_request",
    "copy_as_curl",
    "create_bug_report"
  ]
}
```

## 9.4 数据模型草案

### 9.4.1 sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  description TEXT,
  encrypted INTEGER DEFAULT 0
);
```

### 9.4.2 flows

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  method TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  path TEXT NOT NULL,
  query TEXT,
  status_code INTEGER,
  protocol TEXT,
  source_app TEXT,
  content_type TEXT,
  request_size INTEGER DEFAULT 0,
  response_size INTEGER DEFAULT 0,
  duration_ms INTEGER,
  request_headers_json TEXT,
  response_headers_json TEXT,
  request_body_ref TEXT,
  response_body_ref TEXT,
  error_type TEXT,
  rule_hits_json TEXT,
  tags_json TEXT,
  comment TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

### 9.4.3 rules

```sql
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  matcher_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 9.4.4 agent_reports

```sql
CREATE TABLE agent_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  report_type TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  evidence_flow_ids_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
```

## 9.5 UI 信息架构

主界面：

```text
Top Toolbar
  - Recording On/Off
  - Proxy Status
  - SSL Status
  - Search
  - Export
  - Agent

Left Sidebar
  - Sessions
  - Projects
  - Apps
  - Domains
  - Saved Filters

Center
  - Request Table

Right / Bottom Inspector
  - Overview
  - Headers
  - Query
  - Cookies
  - Body
  - Timing
  - Rules
  - Agent
```

关键交互：

- 请求列表支持虚拟滚动。
- 点击请求后右侧展示详情。
- 右键请求支持重放、复制、Mock、断点、生成报告。
- Agent 面板可以引用当前请求或当前过滤结果。
- 规则命中情况在请求详情中可见。

## 9.6 关键技术难点

### 9.6.1 HTTPS MITM 稳定性

难点：

- 根证书信任流程复杂。
- Firefox 独立证书库。
- 移动端证书配置复杂。
- 证书锁定导致解密失败。

解决：

- 首期优先桌面浏览器。
- 提供证书状态自检。
- 对证书锁定给出明确提示，而不是伪装成网络错误。
- 提供一键卸载和恢复。

### 9.6.2 大流量会话性能

难点：

- 大量请求导致 UI 卡顿。
- 大 Body 占用内存。
- 搜索全量 Body 成本高。

解决：

- 元数据和 Body 分离存储。
- 请求列表虚拟滚动。
- Body 懒加载。
- 大 Body 只做摘要索引。
- 后台批量写入。

### 9.6.3 流式协议展示

难点：

- SSE、WebSocket 不是传统一次性响应。
- 消息可能很长，持续时间长。
- Agent 分析需要分段上下文。

解决：

- 流式消息独立 message 表。
- 增量渲染。
- 消息级搜索。
- 首包时间、消息间隔、结束原因单独记录。

### 9.6.4 Agent 上下文控制

难点：

- 抓包数据量大。
- 敏感信息多。
- LLM 输入成本和隐私风险高。

解决：

- 默认先规则诊断。
- 只选择相关请求。
- 先脱敏再传入模型。
- 大 Body 摘要化。
- 用户确认后才发送云端。
- 企业版支持私有模型。

### 9.6.5 系统代理恢复

难点：

- App 崩溃后系统代理可能残留。
- 用户无法正常上网。

解决：

- 启动时记录原代理配置。
- 退出时恢复。
- 崩溃恢复守护进程。
- 下次启动检测异常代理配置并提示修复。

## 10. 开发里程碑

### 阶段 0：技术验证，2-3 周

目标：

- 跑通本地 HTTP/HTTPS 代理。
- 支持根证书生成和 HTTPS 解密。
- 捕获 Chrome 请求。
- 展示简单请求列表。

交付：

- Proxy Core Demo。
- TLS MITM Demo。
- 基础 UI Demo。

### 阶段 1：MVP，8-10 周

目标：

- 可作为日常抓包工具使用。

交付：

- macOS 桌面应用。
- HTTP/HTTPS 抓包。
- 请求列表与详情。
- JSON 格式化。
- 过滤搜索。
- Repeat / Edit & Repeat。
- Copy as cURL。
- Map Local。
- 固定延迟弱网。
- 本地会话保存。
- Agent 失败请求总结。
- Agent 生成缺陷报告。

### 阶段 2：测试工作流增强，6-8 周

目标：

- 从抓包走向测试协作。

交付：

- 批量重放。
- 高级 Mock 场景。
- 请求差异对比。
- 响应结构对比。
- 自动脱敏规则配置。
- 导出 Postman Collection。
- 生成 Playwright / pytest 测试。
- Jira / GitHub Issue 集成。

### 阶段 3：移动端与团队协作，8-12 周

目标：

- 支持移动端测试和团队协作。

交付：

- iOS 真机 / Simulator 向导。
- Android 真机 / Emulator 向导。
- 云端项目空间。
- 分享链接。
- 评论与指派。
- 团队 Mock 规则。
- 团队脱敏规则。

### 阶段 4：跨平台与企业能力，12 周以上

目标：

- 进入团队和企业采购场景。

交付：

- Windows 版本。
- Linux 版本。
- CLI。
- CI 集成。
- SSO。
- 审计日志。
- 私有部署。
- 私有模型配置。

## 11. MVP 验收标准

基础抓包：

- 用户可在 3 分钟内完成 Chrome HTTPS 抓包。
- 可查看 GET、POST、PUT、DELETE 请求。
- 可查看请求体、响应体、Header、Cookie。
- 可对指定域名开启和关闭 SSL 解密。

调试能力：

- 可对请求执行 Repeat。
- 可修改请求后重放。
- 可复制为 curl。
- 可将某接口响应替换为本地 JSON。
- 可给指定接口增加固定延迟。

Agent 能力：

- 可自动列出当前会话失败请求。
- 可解释常见 401、403、404、500。
- 可对比两个请求差异。
- 可生成 Markdown 缺陷报告。
- 可自动脱敏常见 Token、Cookie、手机号、邮箱。

稳定性：

- App 正常退出后系统代理恢复。
- App 崩溃后下次启动能检测并恢复代理。
- 1 万条请求会话打开不卡顿。

## 12. 商业化方向

免费版：

- 本地抓包。
- 基础查看。
- 基础重放。
- 有限 Mock。
- 本地会话。

专业版：

- Agent 分析。
- 高级 Mock。
- 批量重放。
- 测试用例生成。
- 高级脱敏。
- 移动端高级向导。

团队版：

- 云端项目空间。
- 分享链接。
- 评论。
- 团队规则。
- 缺陷平台集成。
- 团队脱敏策略。

企业版：

- 私有部署。
- SSO。
- 审计日志。
- 私有模型。
- 权限控制。
- 数据保留策略。

## 13. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| HTTPS 证书配置复杂 | 新用户流失 | 自动检测、图形化向导、一键修复 |
| 证书锁定无法解密 | 用户误以为产品不可用 | 明确识别并解释 certificate pinning |
| 与系统代理/VPN 冲突 | 网络异常 | 代理状态检测、恢复机制、冲突提示 |
| 大会话性能差 | 专业用户不可用 | 虚拟列表、懒加载、索引、分片存储 |
| Agent 分析不准确 | 影响信任 | 规则诊断优先、证据引用、置信度展示 |
| 敏感数据泄露 | 严重安全风险 | 默认本地、默认脱敏、分享前预览 |
| MVP 范围过大 | 延期 | 首期只做 macOS + 浏览器 + 基础 Agent |

## 14. 推荐 MVP 产品形态

第一版最应该打磨的闭环：

1. 用户启动应用。
2. 一键开启浏览器 HTTPS 抓包。
3. 操作页面复现问题。
4. 自动标记失败请求。
5. Agent 给出原因和证据。
6. 用户一键生成脱敏缺陷报告。
7. 开发打开报告，复制 curl 或导入会话重放。

这个闭环比“支持更多协议”更重要。只要这个闭环做顺，产品就能明显区别于传统抓包工具。

## 15. 后续开放问题

- 首期桌面端是否只做 macOS，还是同步做 Windows？
- 代理核心选 Rust 还是 Go？
- Agent 是否必须支持本地模型？
- 是否从一开始支持团队云同步？
- 移动端抓包是否进入 MVP？
- 是否开放插件系统？
- 是否采用开源核心 + 商业 UI 的模式？

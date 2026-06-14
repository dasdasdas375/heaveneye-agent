# HeavenEye Agent 产品介绍

## 一句话定位

HeavenEye Agent 是面向开发、测试和排障团队的 AI 智能流量抓包分析工具，提供类似 Charles、Fiddler、Wireshark 和浏览器 DevTools Network 的接口观察能力，并把 AI 分析、重放、Mock、弱网和断点调试整合到同一个桌面工作台。

中文名：天瞳 / 天眼抓包 Agent。

Slogan：HeavenEye，洞悉全网每一条数据流。

## 产品愿景

传统抓包工具擅长“看见流量”，但接口排障往往还需要人工串联上下文：哪个请求失败、哪个 Header 异常、某个用户的 token 是否缺失、今天新增了哪些 4xx/5xx、某张截图里的页面问题对应哪条接口线索。

HeavenEye Agent 的目标是把抓包工具从“被动记录器”升级成“主动排障助手”：

- 先把 HTTP/HTTPS/WebSocket 流量稳定捕获下来。
- 再把请求、响应、Header、Body、状态码、耗时和失败原因结构化展示。
- 最后让 AI Agent 基于真实流量回答问题、生成报告、比较接口差异和定位异常链路。

## 适用场景

- Web 系统测试：打开 F12 侧栏模式，让页面和接口记录同时出现在截图中。
- 移动端联调：手机代理到电脑，查看 App 请求、状态码、耗时和 HTTPS 解密结果。
- 接口排障：筛选 4xx/5xx、慢请求、异常响应体，快速定位失败原因。
- 回归测试：导出 HAR 或 Session，保留可复现证据。
- 后端调试：复制 cURL、Postman、Playwright 片段，重放请求。
- Mock 和弱网：对响应做 Rewrite、断点编辑、延迟和错误模拟。
- AI 协助：让 Agent 查询“今天哪些接口报错”“最新登录账号 uid 是什么”“这张截图里的请求有什么异常”。

## 核心能力

### 抓包与解密

- HTTP/HTTPS 显式代理。
- 本地根证书生成与 macOS 一键信任。
- 基于目标域名的 HTTPS MITM，减少无关域名噪音。
- 对证书 pinning、QUIC/HTTP3、系统高安全域名给出明确失败说明。
- 对 Apple/iCloud/Google 基础域名默认绕过 MITM，避免无意义 495 失败刷屏。

### 接口工作台

- 请求列表默认展示名称、状态和抓包时间。
- 详情页默认突出传参和响应，Headers 与高级信息默认收起。
- 支持 JSON/tree/text 预览、复制、放大查看、大响应体查看。
- 支持请求筛选、目标域名过滤、会话清空和会话导出。

### 调试工具

- Replay 和 Edit & Repeat。
- cURL、Postman、Playwright 片段生成。
- 响应 Rewrite。
- Breakpoint 断点编辑。
- 弱网模拟。
- WebSocket/WSS 捕获路径。

### AI Agent

- 支持主流 AI Provider 与自定义兼容接口。
- 失败请求分析。
- 多接口对比。
- Bug Report 生成。
- 自然语言查询本地抓包会话。
- 截图辅助输入，为 UI 问题和接口问题建立上下文。

### 布局模式

- Agent 主场：适合完整排障与 AI 协作。
- 经典三栏：类似传统抓包工具的稳定工作台。
- F12 侧栏：约占屏幕三分之一，适合测试 Web 系统时把页面和接口一起截图。

## 与同类工具的差异

HeavenEye Agent 当前不追求完全替代 Charles、Wireshark 或 Chrome DevTools。它更适合成为“开发测试场景里的 AI 抓包工作台”：

- 比 DevTools 更独立，可以捕获浏览器外部和移动设备代理流量。
- 比传统抓包工具更强调 AI 总结、证据整理和排障问答。
- 比底层协议分析器更贴近接口调试、Mock、重放和报告输出。

## 当前边界

- 对证书 pinning 的 App 不能保证解密。
- 对 Android 7+ 默认不信任用户 CA 的 App，需要应用侧网络安全配置支持。
- QUIC/HTTP3/UDP 不属于显式 HTTP 代理可稳定覆盖的范围。
- 当前项目仍处于 public preview 阶段，底层协议兼容性会持续迭代。

## 开源定位

建议公开时定位为：

> AI-assisted HTTP/HTTPS capture workbench for developers and QA teams.

中文可以写作：

> 面向开发与测试团队的 AI 智能流量抓包分析工具。

不建议在当前阶段直接宣称“Charles 替代品”。更稳妥的表达是：HeavenEye Agent 借鉴了 Charles、DevTools Network 和现代 AI Agent 的工作流，目标是在接口排障和测试证据整理上形成差异化能力。

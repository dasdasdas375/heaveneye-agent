# HeavenEye Agent 使用手册

## 1. 安装与启动

开发模式启动：

```bash
npm install
cp .env.example .env.local
cargo install tauri-cli --version "^2"
npm run dev
```

构建桌面包：

```bash
npm run build
```

打包产物会生成在 `src-tauri/target/release/bundle/`，该目录属于本地构建产物，不应提交到开源仓库。

## 2. 基础配置

复制 `.env.example` 为 `.env.local`：

```bash
AI_PROVIDER=qwen
AI_API_KEY=
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen3.7-max
AI_VISION_MODEL=qwen3-vl-plus
APP_PROXY_PORT=9090
CAPTURE_HOSTS=app.example.test
```

常用字段：

- `APP_PROXY_PORT`：本地代理端口，默认 `9090`。
- `CAPTURE_HOSTS`：需要捕获和解密的目标域名。
- `AI_PROVIDER`：AI 服务商。
- `AI_API_KEY`：AI 服务商 API Key，建议只放在本地环境变量或应用设置里。
- `AI_BASE_URL`：OpenAI-compatible 或其他 Provider 的 API 地址。
- `AI_MODEL`：文本分析模型。
- `AI_VISION_MODEL`：截图分析模型。

## 3. 配置 AI Provider

打开应用右上角的 AI 设置入口，可以选择：

- Qwen / DashScope
- OpenAI
- Anthropic Claude
- Google Gemini
- DeepSeek
- Moonshot / Kimi
- Doubao / Ark
- Zhipu GLM
- OpenRouter
- Custom OpenAI-compatible

填写 API Key 后，可以点击测试连接。Key 会保存在本机配置中，不应提交到仓库。

## 4. 抓 Web 系统接口

1. 启动 HeavenEye Agent。
2. 在目标域名输入框中填入业务域名，例如 `app.example.test`。
3. 点击 `Apply`。
4. 点击 `Start` 启动代理。
5. 将浏览器代理指向 `127.0.0.1:9090`，或使用应用提供的系统代理入口。
6. 访问目标页面。
7. 在左侧接口列表查看请求。

接口列表默认展示三列：

- 名称
- 状态
- 抓包时间

选中请求后，中间详情区会展示 Overview、传参、响应、Headers 和高级信息。默认情况下，传参和响应展开，Headers 和高级信息收起。

## 5. HTTPS 证书信任

HTTPS 明文抓包需要安装并信任本地根证书。

应用会生成本地 CA：

```bash
.local-certs/heaveneye-agent-root-ca.pem
```

macOS 可在应用内点击一键信任，也可以手动导入钥匙串并设置为始终信任。

命令行验证：

```bash
curl -x http://127.0.0.1:9090 \
  --cacert .local-certs/heaveneye-agent-root-ca.pem \
  https://app.example.test/
```

如果只看到 `CONNECT` 而没有真实 `GET/POST`，通常说明该域名未加入 `CAPTURE_HOSTS`，或 TLS 解密被客户端拒绝。

## 6. 移动端抓包

1. 确保手机与电脑在同一局域网。
2. 在应用顶部查看电脑局域网代理地址。
3. 手机 Wi-Fi 代理设置为手动，Host 填电脑 IP，Port 填 `9090`。
4. 在手机上安装 HeavenEye CA 证书。
5. iOS 需要在证书信任设置里手动开启完整信任。
6. Android 7+ App 默认不信任用户 CA，若 App 未显式允许用户 CA，可能只能看到 CONNECT 隧道，无法解密明文。

### 抓 App HTTPS 明文前的代码前提

如果要抓移动 App 的 HTTPS 明文，除了手机安装并信任 HeavenEye CA 外，**被测试 App 本身也必须允许调试 CA**。这通常需要在测试包或 Debug 包里加配置；正式生产包不建议这样做。

Android 7+ 默认不信任用户安装的 CA。测试包需要在 `network_security_config` 中允许 user CA，例如：

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
```

并在 `AndroidManifest.xml` 的 `<application>` 上引用：

```xml
<application
  android:networkSecurityConfig="@xml/network_security_config">
</application>
```

iOS App 如果使用系统默认 `URLSession` 且设备已完整信任 CA，通常可以抓 HTTPS 明文；但如果 App 做了证书 pinning、自定义 Trust Evaluation、内置证书校验、gRPC/QUIC 特殊通道，仍然会拒绝 MITM。测试包需要关闭 pinning，或只在 Debug/TestFlight 内加入调试证书信任逻辑。

通用建议：

- 只在 Debug、QA 或测试包里允许用户 CA。
- 不要在生产包里放宽证书校验。
- 若 App 使用 OkHttp、Alamofire、TrustKit、自研网络库或证书 pinning，需要在测试构建中显式关闭或切换为测试证书策略。
- 如果 HeavenEye 中只看到 `CONNECT` 或 `495`，优先检查 App 是否信任用户 CA、是否开启 pinning、是否走了 QUIC/HTTP3/UDP。

## 7. F12 侧栏模式

点击布局切换中的 `F12 侧栏`。

该模式会把 HeavenEye 收缩为类似浏览器 DevTools 的侧边栏：

- 上方：左侧接口列表，右侧接口详情。
- 下方：小型 Agent 输入框。
- 适合 Web 系统测试时，把页面与接口异常同时截图。

需要使用完整 Agent、实验室、导出等能力时，切回 `Agent 主场` 或 `经典三栏`。

## 8. 查看和复制请求

选中请求后可以：

- 查看响应体和请求参数。
- 展开 Request Headers / Response Headers。
- 复制正文或 Header。
- 放大查看完整内容。
- 生成 cURL / Postman / Playwright 片段。
- 对请求执行 Replay。

大 Body 会优先存储为本地文本缓存，界面会显示预览大小和完整大小。

## 9. Rewrite、断点和弱网

### Rewrite

用于按规则修改响应状态、Header 或 Body，适合 Mock 接口返回。

### Breakpoint

用于在请求或响应阶段暂停，手动检查和编辑内容后再继续。

### 弱网

用于模拟延迟、慢请求或失败，帮助复现移动端和复杂网络环境下的问题。

## 10. WebSocket / WSS

HeavenEye 会识别 WebSocket Upgrade 请求，并保留关键握手 Header。WSS 仍然依赖 HTTPS MITM，遇到证书 pinning 或客户端拒绝证书时可能无法解密。

## 11. AI Agent 常用问法

可以直接问：

- 今天哪些接口报错？
- 帮我找最新登录账号的 uid。
- 对比这两条接口为什么一个成功一个失败。
- 这张截图里的请求有什么异常？
- 基于当前失败请求生成 bug report。
- 哪些接口耗时最高？

Agent 的结论基于本地抓包会话和你提供的截图，不会替代人工安全判断。

## 12. 导出与分享

可导出：

- Session：保留 HeavenEye 会话结构。
- HAR：方便与其他工具或团队协作。

分享前建议检查是否包含：

- Cookie
- Authorization
- access_token / refresh_token
- 手机号、邮箱、用户 ID
- 内部域名和业务参数

## 13. 常见问题

### 看到 495 是什么原因？

`495` 是 HeavenEye 本地标记的 TLS MITM 失败，不是目标服务器返回的 HTTP 状态码。常见原因：

- 客户端不信任 HeavenEye CA。
- App 做了证书 pinning。
- Android 7+ App 未允许用户 CA。
- 流量使用 QUIC/HTTP3/UDP。
- 某些系统高安全域名拒绝 MITM。

对于 Apple/iCloud/Google 基础域，HeavenEye 默认走隧道绕过 MITM，以减少无意义失败。

### 为什么只有 CONNECT，没有 GET/POST？

可能原因：

- 目标域名未配置到 `CAPTURE_HOSTS`。
- 该域名被默认绕过 MITM。
- 客户端证书校验拒绝解密。

### 为什么手机 App 抓不到 HTTPS 明文？

如果是 Android 7+，App 默认不信任用户安装的 CA。需要 App 的 `network_security_config` 允许用户 CA，或使用测试包。

### 为什么某些请求 DevTools 能看到，HeavenEye 看不到？

浏览器 DevTools 可以看到渲染进程内部请求，包括缓存、扩展或 Service Worker 相关条目。HeavenEye 是网络代理视角，只能看到真实经过代理的网络流量。

### 如何避免误抓无关流量？

只配置明确的 `CAPTURE_HOSTS`，不要长期使用 `*`。抓包结束后恢复系统代理，并清理不需要的会话数据。

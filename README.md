# HeavenEye Agent

HeavenEye Agent is an AI-assisted HTTP/HTTPS capture and debugging workbench for developers and QA teams.

中文名：天瞳 / 天眼抓包 Agent。它把桌面抓包、HTTPS MITM、接口重放、Mock/Rewrite、断点调试、弱网模拟、会话导出和 AI 分析放在同一个开发工具里，适合排查 Web、移动端和后端接口问题。

> Public preview: the project is usable for local debugging, but the lower-level proxy compatibility is still evolving. Do not use it to inspect traffic you do not own or have explicit permission to test.

## Highlights

- HTTP/HTTPS proxy capture with local CA based MITM.
- Request list, structured JSON/text preview, large body viewer, copy and expand workflows.
- cURL, Postman and Playwright snippets for selected requests.
- Replay, edit-and-repeat, response rewrite, breakpoints and weak network simulation.
- WebSocket/WSS-aware capture path.
- AI Agent for failure analysis, request comparison, bug report drafting and natural-language traffic queries.
- Main workbench, classic three-column layout and F12-style sidecar layout.
- Session and HAR export for sharing sanitized debugging evidence.
- Mainstream AI provider presets: Qwen/DashScope, OpenAI, Anthropic Claude, Google Gemini, DeepSeek, Moonshot/Kimi, Doubao/Ark, Zhipu GLM, OpenRouter and custom compatible endpoints.

## Documentation

- [Product introduction](docs/product-introduction.md)
- [User manual](docs/user-manual.md)
- [Product and technical plan](docs/packet-agent-prd-tech-plan.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

## Quick Start

Requirements:

- Node.js `>=20.19.0` or `>=22.12.0`
- Rust stable toolchain
- macOS for the current desktop packaging path

```bash
npm install
cp .env.example .env.local
cargo install tauri-cli --version "^2"
npm run dev
```

Optional `.env.local` example:

```bash
AI_PROVIDER=qwen
AI_API_KEY=your-ai-api-key
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen3.7-max
AI_VISION_MODEL=qwen3-vl-plus
APP_PROXY_PORT=9090
CAPTURE_HOSTS=app.example.test
```

`CAPTURE_HOSTS` controls the domains HeavenEye will decrypt and show as real HTTP requests. Leave unrelated or strongly pinned system domains out of this list.

## HTTPS Capture

1. Start HeavenEye Agent.
2. Configure the target domain in the left target input, for example `app.example.test`.
3. Trust the generated local CA certificate when the app prompts you.
4. Point your browser, simulator, device or system proxy to `127.0.0.1:9090`.
5. Browse the target application and inspect requests in the workbench.

The root certificate is generated locally and ignored by git:

```bash
.local-certs/heaveneye-agent-root-ca.pem
```

Command-line verification:

```bash
curl -x http://127.0.0.1:9090 \
  --cacert .local-certs/heaveneye-agent-root-ca.pem \
  https://app.example.test/
```

## Scripts

```bash
npm run dev        # Tauri desktop app in development mode
npm run dev:web    # Web-only preview with demo backend
npm run build:web  # TypeScript check and frontend build
npm run build      # Build desktop bundle
npm test           # Frontend/unit tests
```

Rust tests:

```bash
cd src-tauri
cargo test
```

## Architecture

- `src/`: React desktop workbench and UI state.
- `src-tauri/`: Tauri + Rust desktop backend, proxy core, certificate manager, replay, system proxy and AI commands.
- `docs/`: product, usage and planning documents.
- `electron/`: legacy Electron/Node implementation kept as migration reference. It is not the current runtime entry.
- `vendor/`: small vendored Rust dependency patches required by the current local build.

## Known Limits

- Certificate pinning can prevent HTTPS decryption.
- Android 7+ apps do not trust user-installed CAs unless the app explicitly opts in.
- QUIC/HTTP3/UDP traffic can bypass an explicit HTTP proxy.
- Some Apple, iCloud and Google infrastructure domains are intentionally MITM-bypassed by default to avoid noisy TLS failures.
- HeavenEye is a debugging tool, not a stealth interception tool. Use it only for systems and traffic you are authorized to inspect.

## License

MIT. See [LICENSE](LICENSE).

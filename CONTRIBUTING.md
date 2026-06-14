# Contributing

Thanks for helping improve HeavenEye Agent.

## Development Setup

```bash
npm install
cp .env.example .env.local
cargo install tauri-cli --version "^2"
npm run dev
```

## Before Opening a Pull Request

Run:

```bash
npm test
npm run build:web
cd src-tauri
cargo fmt --check
cargo test
```

## Code Guidelines

- Keep UI changes consistent with the existing React workbench.
- Keep Rust proxy changes covered by focused tests when possible.
- Avoid committing generated files, local certificates, HAR exports, Session exports or screenshots containing private data.
- Prefer small, reviewable pull requests.
- Document user-visible behavior changes in `README.md` or `docs/user-manual.md`.

## Security-Sensitive Changes

Proxy, certificate, system proxy and AI-provider changes can affect user privacy or local system trust. Explain the security impact clearly in the pull request.

## Legacy Electron Code

The current runtime is Tauri + Rust. The `electron/` directory is retained as migration reference unless removed in a dedicated cleanup change.

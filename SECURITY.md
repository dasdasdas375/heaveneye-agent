# Security Policy

HeavenEye Agent is a local debugging tool that can inspect HTTP and HTTPS traffic after the user explicitly configures a proxy and trusts a local CA certificate.

## Authorized Use Only

Use HeavenEye Agent only for systems, devices, accounts and traffic that you own or have explicit permission to test.

Do not use this project to intercept third-party traffic, bypass access controls, collect credentials, or inspect private communications without consent.

## Sensitive Data

Captured sessions can contain credentials, cookies, tokens, personal data, internal hostnames and business payloads.

Before sharing a Session or HAR export:

- Remove `Authorization`, `Cookie` and `Set-Cookie` headers.
- Remove access tokens, refresh tokens, API keys and passwords.
- Remove personal data such as phone numbers, email addresses and user IDs when not needed.
- Remove internal-only domains and business secrets.

Never commit local certificate material, generated root CA files, private keys, `.env.local`, HAR exports, Session exports or body cache files.

## Local CA Certificate

HeavenEye creates a local root CA for HTTPS debugging. Treat this certificate and its private key as sensitive local material.

- Trust it only on devices you control.
- Remove trust when debugging is complete if you no longer need it.
- Do not publish or share the generated private key.

## Reporting Vulnerabilities

If you find a vulnerability in HeavenEye Agent, please report it privately first. If this project is hosted on GitHub, use GitHub Security Advisories. Otherwise contact the project maintainer through a private channel before opening a public issue.

Please include:

- A clear description of the issue.
- Reproduction steps.
- Affected platform and version.
- Impact and suggested mitigation if known.

Do not include live secrets, private traffic dumps or third-party personal data in reports.

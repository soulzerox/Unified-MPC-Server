# Security policy

Report vulnerabilities privately. Do not publish exploit details in issues.

- Preferred: private GitHub Security Advisory for `soulzerox/Unified-MPC-Server`.
- Include affected commit/version, reproduction steps, impact, and mitigation.
- Remove credentials, personal data, Cloudflare tunnel tokens, and capability values.

Control plane binds to loopback and rotates capability authorization on startup. Public MCP access requires explicit Cloudflare hostname/origin allowlists.
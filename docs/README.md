# Unified-MPC-Server Documentation

Unified-MPC-Server is a 100% Linux-native, local-first Model Context Protocol (MCP) orchestrator, multi-IDE policy synchronizer, and senior engineering harness.

---

## Documentation Map

1. **[Architecture Overview](ARCHITECTURE.md)**:
   Comprehensive system topology, monorepo package relationships, process model, and loopback security boundaries.
2. **[Core Concepts](CONCEPT.md)**:
   Fundamental design principles: Bifurcated Dynamic Ingestion, Zero-Artifact Pruning, Gated Remote Bridges, and Ponytail Runtime Harness.
3. **[CLI Reference](CLI_REFERENCE.md)**:
   Full command-line interface documentation for the `unified-mpc` binary, options, subcommands, and exit code contracts.
4. **[Web Control Plane SPA](WEB_CONTROL_PLANE.md)**:
   Guide to the local native `node:http` reactive web dashboard (`http://127.0.0.1:3000/`) and separate MCP bridge (`127.0.0.1:18765`).
5. **[Multi-Client Ecosystem & Policy Sync](MULTI_CLIENT_SYNC.md)**:
   Discovery and rule compilation matrix across Google Antigravity, Cursor, Claude Code, OpenCode, Cline, Oh My Pi (OMP), and Codex.
6. **[Linux Ubuntu Deployment & Systemd](DEPLOYMENT_LINUX.md)**:
   Production deployment on Ubuntu 24.04 LTS, XDG filesystem standards, and systemd user-unit service setup.
7. **[คู่มือการใช้งานภาษาไทย (Thai User Manual)](USAGE_TH.md)**:
   คู่มือการใช้งานระบบ Unified-MPC-Server ฉบับสมบูรณ์เป็นภาษาไทย
8. **[Guarded Pull-Request Merge](GUARDED_MERGE.md)**:
   Exact-head evidence chain, the built-in GitHub merge provider and the optional child MCP provider.
9. **[Approved Git Push Path](APPROVED_PUSH_PATH.md)**:
   Approved publish for a leased Goal: `publish_approve` receipts, host-built `git_publish`, credential handling and preflight. Credential-free transports plus lease-bound HTTP(S) (#297).
10. **[Publish Credential Mediation (S2 design)](APPROVED_PUSH_PATH_CREDENTIALS.md)**:
   The S2 slice of #297: a host-owned credential helper, a receipt-bound grant, the guard allowlist and the revocation lifecycle. S2a (lease port, SecretStore ledger, operator CLI, expiry sweep), S2b (the `publish-credential-helper` artifact inside a promoted release), S2c (fingerprint-bound receipt, diagnostic preflight lease, one-spawn lease spend and revocation) and S2d (non-secret grant/use/revoke/sweep audit rows and the [token-rotation runbook](PUBLISH_CREDENTIAL_RUNBOOK.md)) are implemented.


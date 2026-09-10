# Control Plane v0.1 — Web Front Door

The only web surface (ADR 0002). Served by the daemon on loopback TCP; the browser is the single front door.

## Provisioning

- Daemon binds `127.0.0.1:<gateway.controlPlanePort>` (seed 7420; fixed configurable — round 2 item 3).
- **Start token**: 32-byte random value generated at daemon start and printed by `unified-mcp start`. First visit passes it once (`?token=…`), the server exchanges it for a session cookie. It lives only in runtime state — never in the config, never in audit/logs.
- **Single-instance lock** in the data dir; a second `start` exits with code 3.
- `--embedded` serves the control plane too (zero-setup, one process).

## Session hardening

| surface | defense |
|---|---|
| Origin/CSRF | Origin and Host must be `127.0.0.1:<port>` or `localhost:<port>`; mutations are POST-only; no GET mutations |
| Session | HttpOnly, SameSite=Strict cookie (no `Secure` flag — loopback http is the only surface); idle timeout 30 minutes (owner session policy) |
| XSS | CSP `default-src 'self'`; no inline script; every config value rendered as text |
| Clickjacking | `frame-ancestors 'none'` |
| Cache | `Cache-Control: no-store` on all control-plane responses |
| Service worker | none registered |

## Versioned editing flow (ADR 0003)

1. `POST /config/prepare` — server validates the candidate (schema, strict rules) → returns a diff; nothing written.
2. `POST /config/confirm` — atomic write (tmp + rename), archive previous document to history, `configVersion` bump if schema meaning changed. Applies **on restart**.
3. `POST /gateway/restart` — one-click graceful restart, offered because there is no hot-reload.

## API surface (minimal)

`GET /status` · `GET /upstreams` · `GET /audit` · `GET /config/current` · `POST /config/prepare` · `POST /config/confirm` · `POST /gateway/restart`

**Auth seam (reserved)**: every route resolves through an auth provider interface; the v0.1 provider is the start-token session. Accounts and multi-tenant modes plug here (Future entry 8) without reworking routes.
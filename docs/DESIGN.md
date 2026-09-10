# DESIGN v0.1 — Control Plane Interface

The web control plane is the only UI (ADR 0002). Plain TS + static assets served by the daemon; no SPA framework, no build step.

## Tokens

- Color (dark default): surface `#0d1117`, card `#161b22`, accent-allow `#3fb950`, accent-deny `#f85149`, accent-rate `#d29922`, text `#e6edf3`
- Light variant: surfaces `#ffffff` / `#f6f8fa` (via `prefers-color-scheme`)
- Type: system-ui; monospace for config, diff, and audit values
- Spacing scale 4/8/16/24; radius 8

## Views (4)

1. **Status** — daemon state, config version, session count `x/32`, upstream health
2. **Upstreams** — mounted list with health; restart button
3. **Policy & Config** — versioned editor: validate → diff → confirm → apply-on-restart (ADR 0003); diff rendered mono — red = removed, green = added
4. **Audit** — table `(ts, session, upstream, tool, action, reason)`; redaction visible as `***`

## Components

- **ConfirmDialog** — every config write requires explicit confirm + reason
- **DiffViewer** — line-level, redaction-aware
- **RestartBanner** — "pending changes apply after restart" + one-click graceful restart

## Hardening (UI-side contract)

- CSP `default-src 'self'`; no inline script
- `frame-ancestors 'none'` (clickjacking — ADR 0002)
- every mutation is a POST with confirm; no GET mutations
- all responses `Cache-Control: no-store`; no service worker

## Accessibility

WCAG AA contrast; keyboard navigable; visible focus; `prefers-color-scheme` respected.

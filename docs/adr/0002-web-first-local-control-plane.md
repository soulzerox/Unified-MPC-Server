# 0002 - Web-first local control plane, loopback-only, no accounts

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner

## Context

The original spec featured an Electron desktop app plus a separate WebDashboard. The product owner chose the web app as the **single front door**: no desktop shell. This adds browser-only trust surfaces (Origin/CSRF/XSS/clickjacking/session/token storage) that a desktop shell never had. Multi-user hosted operation would require accounts and multi-tenant auth from day one.

## Decision

The program is a **local daemon exposing a web control plane**; the user opens `localhost:<port>` as the primary UI. v0.1 is **single-user, loopback-only**: bind localhost, loopback token issued at daemon start, Origin/Host checks, session cookie HttpOnly + SameSite, and clickjacking protection. There are **no user accounts** in v0.1. An authentication seam is reserved so future hosted/multi-user modes can extend without reworking the core.

## Consequences

- Threat model stays "local user" rather than "internet attacker", but the browser trust surface is still defended in full.
- Account login, hosted deployment, and multi-tenant auth are explicitly out of v0.1 and hang off the reserved auth seam.
- The daemon start/stop and port/token provisioning UX become part of the product surface, not an afterthought.

## Alternatives

- Accounts from v0.1: rejected - a different threat model; would delay the core behind auth work.
- No web security hardening in v0.1: rejected - leaves the control plane wide open on an exposed port.
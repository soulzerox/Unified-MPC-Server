# 0001 - Gateway-first, platform as a future layer

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner

## Context

SPEC.md as originally written describes an autonomous engineering platform: orchestrator, harness, installer, remote connector, and web dashboard. A cross-cutting architecture audit reduced the proven core to a **secure tools-only gateway** (ProtocolGateway + policy engine + unified config) and showed the gateway carries neither the authority nor the trust model to host an orchestrator. The product owner asked that v0.1 already target the final destination so the core does not have to be rewritten repeatedly.

## Decision

v0.1 is the **gateway product**. The web destination is the gateway's control plane. The autonomous platform (orchestrator, harness, agent runtime) is a **future layer built on top of the gateway**, not a v0.1 feature. v0.1 is responsible for locking the seams that make that layer possible without touching the core.

## Consequences

- Shipping scope shrinks to gateway + web control plane; the platform is recorded as Future, not abandoned.
- "No repeated rewrites" is achieved by contract-first design (seams), not by building platform features early.
- Any pull request that grows v0.1 into agent execution territory is out of scope by this ADR.

## Alternatives

- Full autonomous platform in v0.1: rejected - contradicts the audit's authority/trust findings and inflates the trust surface before the core is proven.
- Drop the platform permanently: rejected - the destination still includes it; only the schedule changed.

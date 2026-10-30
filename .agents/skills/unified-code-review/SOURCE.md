# Provenance

`SKILL.md` is first-party content written for Unified-MPC Server issue #144. No
upstream skill text is copied; the structure below was evaluated by reading the
pinned commits and is credited as design reference only.

| Upstream | Pinned commit | License | What informed this skill |
| --- | --- | --- | --- |
| https://github.com/vercel-labs/open-agents | `cf865e94de7729751c747171785b6ce57e7b178c` | MIT | full-file context before judging a hunk; correctness and security before style |
| https://github.com/mattpocock/skills | `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` | MIT | separate Standards/Spec axes; a reviewer that reports rather than patches |
| https://github.com/openai/codex | `26cb4d73e2ce25575644038d7af5beb2440d0ed0` | Apache-2.0 | one orchestrator that holds the domain list, with no per-domain scoring |

The findings contract, severity rule, invalidation rule and capsule format are
this repository's own and are exercised by `scripts/review-gate.test.mjs`.

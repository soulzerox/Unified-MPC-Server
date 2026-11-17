# Skill precedence decision (#294)

Recorded outcome of the host Skill reconciliation: every declared Skill name is
resolved to **one** owner, with the provenance needed to review or undo it. This is
the decision artifact #294 asks for; the audit that produced it is
`unified-mpc skill audit --json` (`SkillInventoryAuditService`), which never
imports, prunes or chooses precedence on its own.

## Decision (2026-11-17)

1. The 12 declared names that had no canonical copy are **imported** into the
   canonical store from `~/.agents/skills/<name>`, the user-owned root.
2. The **canonical copy wins** for every declared name. Legacy roots keep their
   files untouched, so nothing is deleted and the decision stays reversible.

Not last-wins: each row below names the source, the full-directory content
fingerprint of every variant, and which copy the decision keeps.

## Imports (12)

Source root `~/.agents/skills/<name>`; canonical id `<name>` (install name must
equal the `name:` declared in `SKILL.md`, `installer.ts:120`).

| declared name | fingerprint | legacy copies | canonical id |
| --- | --- | --- | --- |
| `canvas-design` | `4a36891e50d3` | agents-skills, antigravity-config-skills, cline-skills, unified-mpc-skills | `unified-mpc-skills/canvas-design` |
| `design-md` | `b283d2716e6e` | agents-skills, antigravity-config-skills, cline-skills, unified-mpc-skills | `unified-mpc-skills/design-md` |
| `frontend-design` | `9ac48827970a` | agents-skills, antigravity-config-skills, cline-skills, unified-mpc-skills | `unified-mpc-skills/frontend-design` |
| `theme-factory` | `07b00a9ae490` | agents-skills, antigravity-config-skills, cline-skills, unified-mpc-skills | `unified-mpc-skills/theme-factory` |
| `web-artifacts-builder` | `7851802f8e51` | agents-skills, antigravity-config-skills, cline-skills, unified-mpc-skills | `unified-mpc-skills/web-artifacts-builder` |
| `seo-ahrefs` | `64f84fc3564d` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-ahrefs` |
| `seo-bing` | `6172da8f09c2` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-bing` |
| `seo-firecrawl` | `d7da7d6b5dda` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-firecrawl` |
| `seo-matomo` | `f1d066a855c0` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-matomo` |
| `seo-profound` | `56e25acd8b77` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-profound` |
| `seo-seranking` | `c6cc204a506d` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-seranking` |
| `seo-unlighthouse` | `5318b5d6c7c6` | agents-skills, unified-mpc-skills | `unified-mpc-skills/seo-unlighthouse` |

## Divergent names the canonical copy wins (43)

27 names have a canonical copy whose content differs from every legacy
sibling (`divergent / canonical diverges`); 16 more diverge overall while the
canonical copy matches at least one legacy copy. The decision is the same for both
groups, but the first group is the one a reviewer must look at.

| declared name | canonical fingerprint | variants | legacy roots |
| --- | --- | --- | --- |
| `ask-matt` | `30894968c362` | 5 | agents-skills, antigravity-config-skills, claude-skills, cline-skills, codex-skills, cursor-skills, opencode-config-skill |
| `brainstorming` | `ce47260d5cc6` | 2 | agents-skills |
| `claude-handoff` | `e848ff16497a` | 3 | agents-skills, cline-skills |
| `code-review` | `94ad7dd3859e` | 3 | agents-skills, cline-skills |
| `codebase-design` | `bc3a867a9953` | 3 | agents-skills, cline-skills |
| `diagnosing-bugs` | `61f9fed42cb9` | 3 | agents-skills, cline-skills |
| `domain-modeling` | `948935588324` | 3 | agents-skills, cline-skills |
| `executing-plans` | `f59156f4240e` | 2 | agents-skills |
| `finishing-a-development-branch` | `3286e2a048ac` | 2 | agents-skills |
| `grilling` | `63635ada0375` | 3 | agents-skills, cline-skills |
| `handoff` | `770ad45f7572` | 3 | agents-skills, cline-skills |
| `implement` | `9a19632e057a` | 2 | agents-skills, cline-skills |
| `implement-spec` | `2e0e601b40f8` | 2 | agents-skills |
| `improve-codebase-architecture` | `57617ee4573b` | 3 | agents-skills, cline-skills |
| `requesting-code-review` | `ef45b1dee87c` | 2 | agents-skills |
| `retro` | `e2755f92e195` | 2 | agents-skills |
| `setup-matt-pocock-skills` | `995e88094d5a` | 3 | agents-skills, cline-skills |
| `systematic-debugging` | `764ecc05babc` | 2 | agents-skills |
| `tdd` | `d98acd9db05e` | 3 | agents-skills, cline-skills |
| `teach` | `f58f025a49c8` | 3 | agents-skills, cline-skills |
| `test-driven-development` | `ccf27cd63be6` | 2 | agents-skills |
| `to-tickets` | `4a5fac190824` | 3 | agents-skills, cline-skills |
| `triage` | `76cadbcb0939` | 3 | agents-skills, cline-skills |
| `wait-what` | `fe10a68bcdc3` | 3 | agents-skills, cline-skills |
| `wayfinder` | `25cac5621994` | 3 | agents-skills, cline-skills |
| `wizard` | `a3ee969b4c91` | 3 | agents-skills, cline-skills |
| `writing-plans` | `f29a99c25156` | 2 | agents-skills |

The 16 `divergent / canonical matches` names are counted in the audit output and
need no reviewer action: the canonical copy is byte-identical to a legacy sibling,
so the decision keeps the user-owned content.

## Not settled by this decision

- `seo` — `unverified`: 2 copy/copies could not be
  fingerprinted, so the audit refuses to claim which content is canonical. It
  stays as-is until the unreadable copy is fixed.

## Rollback

- Imports are additive: `~/.local/share/unified-mpc/extensions/skills/<name>/` is
  created; removing that directory returns the host to the pre-import state.
- No legacy root, copy or client catalog was modified or deleted, so the
  pre-decision host state is intact.
- The audit is stable across runs, so a later run can be diffed against these
  fingerprints to detect drift.

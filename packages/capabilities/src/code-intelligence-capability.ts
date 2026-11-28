import type { Result } from '@unified-mpc/domain';

import type {
  CapabilityManifest,
  CapabilityManifestInput,
  CapabilityRegistry,
} from './capability-registry.js';

/**
 * #131 slice 4 / #133 item 7: Code Intelligence on the capability lifecycle.
 *
 * Phase 1 of the capability runtime already owns the manifest, the states and the
 * lease accounting, so this lane does not add a supervisor or a worker: answering a
 * query is a pure projection over records the caller already holds (slice 3), and
 * there is no process to start, idle or recycle. The manifest exists so a host can
 * acquire the id and count it like any other capability, and so the heavy half —
 * extraction and indexing, which really are `burst` work — can be declared as a
 * separate lane by the slice that supervises workers instead of being smuggled in
 * under a `small` cost class here.
 *
 * `requires: [SHARED_EVIDENCE_CAPABILITY_ID]` is the #131 dependency made explicit:
 * a query is answered from a stored generation, so this lane is meaningless without
 * one. The dependency is the exported id, not a repeated literal, so renaming the
 * capability cannot leave a dependency the registry fails to resolve at runtime.
 */
export const SHARED_EVIDENCE_CAPABILITY_ID = 'shared-evidence';

/** The evidence substrate's registry entry: a token, not a worker. */
export const SHARED_EVIDENCE_MANIFEST: CapabilityManifestInput = {
  id: SHARED_EVIDENCE_CAPABILITY_ID,
  version: 1,
  provides: ['shared_evidence'],
  runtimeKind: 'in-process',
  activation: 'on-demand',
  costClass: 'small',
  recyclable: false,
};

export const CODE_INTELLIGENCE_CAPABILITY_ID = 'code-intelligence';

/** The tokens a caller can ask this lane for; each maps to one slice-3 query. */
export const CODE_INTELLIGENCE_PROVIDES = [
  'code_symbols',
  'code_definitions',
  'code_imports',
  'code_dependents',
  'code_repo_summary',
] as const;

export const CODE_INTELLIGENCE_MANIFEST: CapabilityManifestInput = {
  id: CODE_INTELLIGENCE_CAPABILITY_ID,
  version: 1,
  provides: [...CODE_INTELLIGENCE_PROVIDES],
  requires: [SHARED_EVIDENCE_CAPABILITY_ID],
  runtimeKind: 'in-process',
  activation: 'on-demand',
  costClass: 'small',
  idleTtlMs: 120_000,
  recyclable: true,
  // A query pins an immutable generation, so there is no worker generation to
  // fence and no stale worker that could answer for an older tree.
  generationFenced: false,
};

/**
 * Registers the lane, plus the evidence dependency it requires.
 *
 * A registry refuses a dependency that is not registered yet, so the dependency is
 * declared here as its own `in-process` lane: nothing starts it, and the heavy
 * extraction it will eventually cover belongs to the worker slice.
 */
export async function registerCodeIntelligenceCapability(
  registry: CapabilityRegistry,
): Promise<Result<CapabilityManifest>> {
  const evidence = await registry.register(SHARED_EVIDENCE_MANIFEST);
  if (!evidence.ok && !isAlreadyRegistered(evidence.error)) return evidence;
  return registry.register(CODE_INTELLIGENCE_MANIFEST);
}

/**
 * `register` answers `CONFLICT` for exactly one condition — the id is already in the
 * registry — so the helper tolerates that code and nothing else. Matching the error
 * message would have made the behaviour depend on prose.
 *
 * The lane itself is not tolerated: a second call still returns `CONFLICT`, because
 * that is the truth and a caller that wants idempotence can say so.
 */
function isAlreadyRegistered(error: { readonly code?: string }): boolean {
  return error.code === 'CONFLICT';
}

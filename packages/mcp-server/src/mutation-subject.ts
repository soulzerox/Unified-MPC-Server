import { codeMutationPaths, isDevelopmentArtifactPath, normalizeHarnessPath } from './harness-runtime.js';

/**
 * What a mutation is *about*, as opposed to what its request spells (#142,
 * step 5b).
 *
 * `validateHarnessMutation` decides from `codeMutationPaths`, a pure function of
 * the request. That is the right extractor for a tool that names a file, and the
 * wrong one for a tool that names something that *points at* files:
 *
 * ```text
 * write_file        path: 'src/app.ts'      ── the request names the artifact
 * restore_deleted_file  recoveryId: '…'     ── the store names the artifact
 * shell             command: 'rm src/app.ts' ── nothing names the artifact
 * ```
 *
 * This module is the seam that turns all three into one subject, so the gate
 * decides from the subject rather than from the spelling of a request. It is
 * pure: store lookups arrive as injected functions, so the whole matrix is
 * testable without a workspace, a store or a clock.
 *
 * The subject is deliberately not a verdict. An opaque subject stays allowed
 * here; step 5b-2 is where a workspace-scoped preparation gives it a gate. What
 * this step buys is that a restore of a development artifact is *path-bearing*,
 * so the preparation the agent already produced for that path is required
 * instead of skipped.
 */
export type MutationSubject =
  | {
    readonly kind: 'paths';
    readonly paths: readonly string[];
    /**
     * `request` when the caller spelled the paths itself, `store` when a lookup
     * named them. The two are treated differently by the default mode: a
     * request-named path is auto-prepared exactly as before, while a store-named
     * one is only asked about in the opt-in mode. Auto-preparing a restore would
     * read pre-edit context for a path the restore exists because it is missing.
     */
    readonly origin: 'request' | 'store';
  }
  | { readonly kind: 'opaque'; readonly reason: 'command' | 'unresolved' };

/**
 * The tools whose request names its own artifact paths. Exported so the matrix
 * test can prove this set and `codeMutationPaths` agree: a tool that switches on
 * one side and not the other would resolve to `opaque/command` and silently keep
 * its mutation ungated.
 */
export const PATH_NAMED_MUTATION_TOOLS: readonly string[] = [
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  'copy_file',
  'apply_patch',
  'lsp_rename',
];

const PATH_NAMED = new Set(PATH_NAMED_MUTATION_TOOLS);

/** Tools whose request names a stored subject instead of an artifact path. */
const RECOVERY_MUTATION_TOOLS = new Set(['restore_deleted_file', 'restore_recovery_item']);
const CHECKPOINT_MUTATION_TOOLS = new Set(['restore_checkpoint']);

export function isRestoreMutationTool(toolName: string): boolean {
  return RECOVERY_MUTATION_TOOLS.has(toolName) || CHECKPOINT_MUTATION_TOOLS.has(toolName);
}

/**
 * A resolver answers with the paths the store holds for that id, or `undefined`
 * when it cannot answer at all — an unknown id, an unreadable store, a service
 * this deployment does not wire. The two are different: `[]` says "found it,
 * nothing to prepare", `undefined` says "I do not know what this mutates".
 * Collapsing them would let a broken store look like a clean mutation.
 */
export interface MutationSubjectResolvers {
  readonly recoveryPaths: (recoveryId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly checkpointPaths: (checkpointId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

export async function resolveMutationSubjects(
  toolName: string,
  input: unknown,
  resolvers?: MutationSubjectResolvers,
): Promise<MutationSubject> {
  if (PATH_NAMED.has(toolName)) {
    return { kind: 'paths', paths: artifactPaths(codeMutationPaths(toolName, input)), origin: 'request' };
  }

  const recoveryId = RECOVERY_MUTATION_TOOLS.has(toolName) ? readId(input, 'recoveryId') : undefined;
  const checkpointId = CHECKPOINT_MUTATION_TOOLS.has(toolName) ? readId(input, 'checkpointId') : undefined;
  // A request that does not even name its subject is the opaque case, not an
  // unresolved one: the store could not have answered this.
  if (recoveryId === undefined && checkpointId === undefined) return { kind: 'opaque', reason: 'command' };
  if (resolvers === undefined) return { kind: 'opaque', reason: 'unresolved' };

  const resolved = recoveryId !== undefined
    ? await guardResolve(() => resolvers.recoveryPaths(recoveryId))
    : await guardResolve(() => resolvers.checkpointPaths(checkpointId as string));
  if (resolved === undefined) return { kind: 'opaque', reason: 'unresolved' };
  return { kind: 'paths', paths: artifactPaths(resolved), origin: 'store' };
}

/**
 * Development artifacts only, deduplicated through the one path spelling the
 * ledger uses. A resolver can hand back the same file twice (a checkpoint of a
 * directory and its contents) and a `move_file` can name one path on both sides;
 * the gate must ask for one preparation, not two.
 */
function artifactPaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !isDevelopmentArtifactPath(path)) continue;
    const normalized = normalizeHarnessPath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(path);
  }
  return unique;
}

function readId(input: unknown, field: 'recoveryId' | 'checkpointId'): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * A store lookup that throws is a store that could not answer, not a crash
 * inside the gate. The caller turns `undefined` into the opaque subject, which
 * keeps today's behaviour instead of refusing a mutation on an unrelated error.
 */
async function guardResolve(resolve: () => Promise<readonly string[] | undefined> | readonly string[] | undefined): Promise<readonly string[] | undefined> {
  try {
    return await resolve();
  } catch {
    return undefined;
  }
}

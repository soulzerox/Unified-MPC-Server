interface ProviderGenerationRelease {
  releaseUnknown(knownWorkspaceIds: readonly string[]): Promise<readonly string[]>;
}

interface WorkspaceRegistrationList {
  list(): Promise<readonly { readonly id: string }[]>;
}

export interface ProviderGenerationReconcileResult {
  readonly released: readonly string[];
  /** Set when the sweep could not run; the rows keep pinning until a later pass. */
  readonly error?: string;
}

/**
 * Release provider-generation rows whose workspace is no longer registered
 * (#210 bullet 4 follow-up).
 *
 * Archived registrations cannot own a live generation, so their rows must stop
 * pinning a manifest. A registration can be archived outside the web removal
 * adapter: a `--reset-workspaces` pass, lifecycle auto-cleanup, or a crash
 * between archive and release.
 *
 * The sweep is best-effort: a stale pin delays ordinary revision GC but never
 * loses data, so a cleanup-only failure must not take the caller down. The
 * caller decides how to report `error` (the CLI writes it to stderr).
 *
 * The known set is read from the active registry, sampled after any restore or
 * registration the caller performs. That ordering is what keeps a workspace
 * this process just restored — and whose generation it will reuse without a
 * reindex — pinned.
 */
export async function reconcileProviderGenerations(
  providerGenerations: ProviderGenerationRelease,
  workspaces: WorkspaceRegistrationList,
): Promise<ProviderGenerationReconcileResult> {
  try {
    const known = (await workspaces.list()).map((workspace) => workspace.id);
    const released = await providerGenerations.releaseUnknown(known);
    return { released: [...released] };
  } catch (error: unknown) {
    return { released: [], error: error instanceof Error ? error.message : String(error) };
  }
}

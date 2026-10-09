/**
 * Synchronous, in-process authority barrier for workspace registry writes.
 *
 * This is NOT a cross-process subscription or durable epoch. The repository
 * revokes its current worker generation BEFORE executing its local SQLite write.
 * Other writers/processes remain subject to live snapshot polling until a
 * separate durable, transactional registry authority boundary is implemented.
 */
export class LocalWorkspaceAuthorityEpoch {
  private controller = new AbortController();
  private epoch = 1;

  public readonly signal = (): AbortSignal => this.controller.signal;
  public readonly currentGeneration = (): number => this.epoch;

  public readonly revokeBeforeMutation = (): void => {
    const next = this.epoch + 1;
    if (!Number.isSafeInteger(next)) throw new Error('workspace_authority_epoch_exhausted');
    const old = this.controller;
    // Abort dispatch admission synchronously, then publish a fresh generation
    // for children created after the corresponding synchronous SQLite write.
    old.abort(new Error('workspace_authority_registry_mutated'));
    this.epoch = next;
    this.controller = new AbortController();
  };
}

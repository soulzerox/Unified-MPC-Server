/**
 * Opt-in listener that promotes COMMITTED SQLite registry epoch drift from
 * another process to the same synchronous AbortSignal fence as local writes.
 *
 * This runs only after a strict FD3 child asks for a signal, and stops on host
 * shutdown. It aborts pending HOST RPCs; it does not undo a Python side effect
 * that already ran, and remote revocation is bounded by polling latency.
 */
export class CrossProcessWorkspaceAuthorityWatcher {
  private observedGeneration: number | undefined;
  private initialized = false;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  public constructor(
    private readonly readGeneration: () => number,
    private readonly epoch: LocalWorkspaceAuthorityEpoch,
    private readonly pollIntervalMs: number = 75,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1000) {
      throw new Error('workspace_authority_watch_interval_invalid');
    }
  }

  public readonly signal = (): AbortSignal => {
    if (this.closed) throw new Error('workspace_authority_watch_closed');
    this.checkNow();
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        try { this.checkNow(); } catch { /* fail closed in checkNow; retry later */ }
      }, this.pollIntervalMs);
      this.timer.unref();
    }
    return this.epoch.signal();
  };

  public readonly checkNow = (): void => {
    if (this.closed) throw new Error('workspace_authority_watch_closed');
    let next: number;
    try {
      next = this.readGeneration();
      if (!Number.isSafeInteger(next) || next < 1) throw new Error('workspace_authority_epoch_invalid');
    } catch {
      this.initialized = true;
      this.observedGeneration = undefined;
      this.epoch.revokeBeforeMutation();
      throw new Error('workspace_authority_epoch_unavailable');
    }
    if (this.initialized && next !== this.observedGeneration) {
      this.epoch.revokeBeforeMutation();
    }
    this.observedGeneration = next;
    this.initialized = true;
  };

  public readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.epoch.revokeBeforeMutation();
  };
}

/**
 * Synchronous in-process authority barrier for local workspace registry writes.
 * Separate processes use the durable SQLite epoch through the watcher above.
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

/**
 * Lifecycle of one exact publish approval binding (#297), as reported by a
 * read-only diagnostic. `pending` means an unexpired, unconsumed receipt exists
 * for this workspace/remote/branch/SHA; it is never authority by itself, because
 * only the publish path may spend a receipt.
 */
export type PublishApprovalState = 'missing' | 'pending' | 'expired' | 'consumed';

export interface PublishApprovalBinding {
  readonly workspaceId: string;
  readonly remote: string;
  readonly branch: string;
  readonly expectedSha: string;
}

/** Read-only lookup for diagnostics and preflight. A failed lookup is not an approval. */
export interface PublishApprovalLookupPort {
  inspect(binding: PublishApprovalBinding, now: number): Promise<PublishApprovalState>;
}

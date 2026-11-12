export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
export const MAX_MULTI_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PROCESS_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_SEARCH_RESULTS = 200;
export const MAX_SEARCH_RESULTS = 500;
export const DEFAULT_TREE_DEPTH = 4;
export const MAX_TREE_DEPTH = 8;
export const DEFAULT_TREE_ENTRIES = 2000;
export const MAX_TREE_ENTRIES = 5000;

/**
 * Largest delay a Node timer can represent (2^31-1 ms, ~24.86 days). Node clamps
 * a larger delay to 1 ms and warns, so an "effectively unlimited" deadline
 * becomes the shortest one instead of the longest. Bound a deadline where the
 * timer is armed, and pass the bounded value to any child that arms its own.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ResultBudget {
  readonly maxItems: number;
  readonly maxTextBytes: number;
  readonly maxStructuredBytes: number;
  readonly maxBinaryBytes: number;
  readonly maxBase64Bytes: number;
}

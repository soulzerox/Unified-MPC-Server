/**
 * Strictness switch for the reachability readers (#210 §7).
 *
 * GC planning must never read "I could not read this root" as "this root does
 * not exist": dropping a live root makes its artifacts look unreachable, and
 * the destructive pass would then delete them. The stores' default listing is
 * deliberately tolerant because operator surfaces (`index status`) should still
 * report what they can. A destructive caller asks for `strict` instead, and a
 * failure becomes a refusal rather than an empty answer.
 */
export interface ReachabilityReadOptions {
  readonly strict?: boolean;
}

export function isStrictRead(options?: ReachabilityReadOptions): boolean {
  return options?.strict === true;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A missing directory/file is the legitimately empty case; anything else is not. */
export function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * The budget a native Thai-RAG call must be allowed before the driver gives up
 * (#770).
 *
 * The provider serves every call through the shared data owner, which processes
 * requests serially: while an index legitimately owns it for minutes, a read
 * waits in line. Two budgets govern that wait:
 *
 * - `THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT` (900 s by default) is the connect
 *   deadline and, reused, the response budget of an ordinary call.
 * - `THAI_RAG_DATA_OWNER_RESPONSE_TIMEOUT` (3600 s by default) is the budget of
 *   the methods the provider lists as long-running. That list includes
 *   `pre_edit_context` — the mandatory gate read — because it may start a
 *   verification pass, so a read is not automatically an ordinary call.
 *
 * The driver cannot see the provider's per-method list, and it used to keep a
 * third, shorter deadline of its own which it enforced by dropping the child.
 * It gave up first, aborted work the provider was still doing, and the next
 * call started cold against the same busy owner, so one slow read became a
 * cold-start loop that was still slow.
 *
 * A request session therefore gets the larger of the two declared budgets plus a
 * transport margin. Anything smaller can kill a call the provider would still
 * have answered; the provider's own bound is what ends a genuinely stuck wait.
 * No policy ceiling is applied: the value is the host's declaration, the
 * provider uses the same number, and clamping only the driver would recreate the
 * disagreement this module exists to remove. The only cap is the largest delay
 * Node's timers can represent, because a larger number is not a longer wait — a
 * timer delay above 2^31-1 ms is clamped to 1 ms, which would abort every call
 * immediately.
 */
import { MAX_TIMER_DELAY_MS } from '@unified-mpc/domain';

export const THAI_RAG_CONNECT_BUDGET_ENV = 'THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT';
export const THAI_RAG_RESPONSE_BUDGET_ENV = 'THAI_RAG_DATA_OWNER_RESPONSE_TIMEOUT';

/** Seconds handed to the child when the host does not configure the connect budget. */
export const DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS = 900;

/** Same for the long-running response budget; mirrors the provider's default. */
export const DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS = 3600;

/** Room for the RPC round trip the provider's own timer does not cover. */
const TRANSPORT_MARGIN_MS = 5_000;

/**
 * The derived deadline is still a `setTimeout` delay, so it inherits the largest
 * delay a Node timer can represent (~24.86 days); a larger number is not a longer
 * wait. Shared with every other deadline in the runtime.
 */
export const MAX_THAI_RAG_CALL_BUDGET_MS = MAX_TIMER_DELAY_MS;

/**
 * Request-session deadline for a child call, derived from the environment the
 * child receives. A missing, blank or unparseable value falls back to the
 * launcher default, matching what the provider itself would do.
 */
export function thaiRagReadCallBudgetMs(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number {
  const connect = budgetSeconds(env, THAI_RAG_CONNECT_BUDGET_ENV, DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS);
  const response = budgetSeconds(env, THAI_RAG_RESPONSE_BUDGET_ENV, DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS);
  return Math.min(
    MAX_THAI_RAG_CALL_BUDGET_MS,
    Math.ceil(Math.max(connect, response) * 1_000) + TRANSPORT_MARGIN_MS,
  );
}

function budgetSeconds(
  env: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
  fallback: number,
): number {
  const raw = env?.[key]?.trim();
  const seconds = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

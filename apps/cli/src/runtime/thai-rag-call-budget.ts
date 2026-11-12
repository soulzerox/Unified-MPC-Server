/**
 * One budget for a native Thai-RAG ordinary call (#770).
 *
 * The provider serves an ordinary call through the shared data owner, which
 * processes requests serially: while an index legitimately owns it for minutes,
 * a read waits in line. `_remote_call` therefore uses the data-owner connect
 * budget (`THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT`) as the response budget of an
 * ordinary call, and the launcher hands the child 900 s exactly so that wait is
 * allowed.
 *
 * The driver's request session kept its own, shorter deadline and enforced it by
 * dropping the child. It gave up first, aborted the provider's in-flight work,
 * and the next call started cold against the same busy owner, so one slow read
 * became a cold-start loop that was still slow.
 *
 * The request deadline is therefore derived from the same value the child is
 * launched with: the driver waits at least as long as the provider says it may
 * take, and the provider's own bound is what ends a stuck wait. The margin
 * covers the stdio round trip, which starts just after the driver's clock.
 */
export const THAI_RAG_ORDINARY_CALL_BUDGET_ENV = 'THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT';

/** Seconds handed to the child when the host does not configure the budget. */
export const DEFAULT_THAI_RAG_ORDINARY_CALL_BUDGET_SECONDS = 900;

/** Room for the RPC round trip the provider's own timer does not cover. */
const TRANSPORT_MARGIN_MS = 5_000;

/**
 * Same ceiling as the index session: a hostile or mistaken host value must not
 * park an agent read for a day. The provider clamps its own budgets as well.
 */
const MAX_ORDINARY_CALL_BUDGET_MS = 3_600_000;

/**
 * Request-session deadline for one ordinary provider call, derived from the
 * environment the child receives. A missing, blank or unparseable value falls
 * back to the launcher default, matching what the provider itself would do.
 */
export function thaiRagOrdinaryCallBudgetMs(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number {
  const raw = env?.[THAI_RAG_ORDINARY_CALL_BUDGET_ENV]?.trim();
  const seconds = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
  const budgetSeconds = Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_THAI_RAG_ORDINARY_CALL_BUDGET_SECONDS;
  return Math.min(MAX_ORDINARY_CALL_BUDGET_MS, Math.ceil(budgetSeconds * 1_000) + TRANSPORT_MARGIN_MS);
}

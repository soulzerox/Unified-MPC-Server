import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS,
  DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS,
  MAX_THAI_RAG_CALL_BUDGET_MS,
  THAI_RAG_CONNECT_BUDGET_ENV,
  THAI_RAG_RESPONSE_BUDGET_ENV,
  thaiRagReadCallBudgetMs,
} from './thai-rag-call-budget.js';

describe('thaiRagReadCallBudgetMs', () => {
  it('clears the larger provider budget, plus the RPC margin (#770)', () => {
    // An ordinary call may wait the connect budget, and `pre_edit_context` — the
    // mandatory gate read — is long-running in the provider and may wait the
    // response budget. The driver cannot see that per-method list, so the larger
    // one wins and neither path can be killed early.
    expect(thaiRagReadCallBudgetMs(undefined)).toBe(3_605_000);
    expect(thaiRagReadCallBudgetMs({})).toBe(3_605_000);
    expect(DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS).toBe(900);
    expect(DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS).toBe(3600);
    // The launcher's own defaults, stated explicitly.
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_CONNECT_BUDGET_ENV]: '900' })).toBe(3_605_000);
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: '3600' })).toBe(3_605_000);
  });

  it('lets the larger declared budget win on either side', () => {
    // A host that shortens the response budget still leaves an ordinary read its
    // 900 s connect budget.
    expect(thaiRagReadCallBudgetMs({
      [THAI_RAG_CONNECT_BUDGET_ENV]: '900',
      [THAI_RAG_RESPONSE_BUDGET_ENV]: '60',
    })).toBe(905_000);
    // A host that raises the connect budget above the response one is honoured.
    expect(thaiRagReadCallBudgetMs({
      [THAI_RAG_CONNECT_BUDGET_ENV]: '1200',
      [THAI_RAG_RESPONSE_BUDGET_ENV]: '600',
    })).toBe(1_205_000);
    // Fractional seconds are legal in the provider's own parser.
    expect(thaiRagReadCallBudgetMs({
      [THAI_RAG_CONNECT_BUDGET_ENV]: ' 0.3 ',
      [THAI_RAG_RESPONSE_BUDGET_ENV]: '0.1',
    })).toBe(5_300);
  });

  it('falls back to the launcher default when the provider would reject the value', () => {
    for (const value of ['', '   ', 'nonsense', '0', '-5', 'Infinity', 'NaN']) {
      expect(thaiRagReadCallBudgetMs({ [THAI_RAG_CONNECT_BUDGET_ENV]: value })).toBe(3_605_000);
      expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: value })).toBe(3_605_000);
    }
  });

  it('does not cap a host that declares a longer pass than the default', () => {
    // Clamping only the driver would recreate the disagreement this module
    // exists to remove: the provider would keep waiting after the driver had
    // already dropped the child.
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: '7200' })).toBe(7_205_000);
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: '86400' })).toBe(86_405_000);
  });

  it('stays representable by a Node timer instead of aborting immediately', () => {
    // Node clamps any `setTimeout` delay above 2^31-1 ms to 1 ms, so a host that
    // declares "effectively unlimited" (or overflows the multiplication) would
    // otherwise make every call abort at once — the same undercut the module
    // removes, just faster. The cap is the timer's, not a policy ceiling: it only
    // bites above ~24.86 days, far past any declared budget.
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: String(2_147_484) })).toBe(MAX_THAI_RAG_CALL_BUDGET_MS);
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_RESPONSE_BUDGET_ENV]: '1e308' })).toBe(MAX_THAI_RAG_CALL_BUDGET_MS);
    expect(thaiRagReadCallBudgetMs({ [THAI_RAG_CONNECT_BUDGET_ENV]: '1e308' })).toBe(MAX_THAI_RAG_CALL_BUDGET_MS);
  });
});

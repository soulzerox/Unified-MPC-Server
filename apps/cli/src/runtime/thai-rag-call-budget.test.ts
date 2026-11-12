import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THAI_RAG_ORDINARY_CALL_BUDGET_SECONDS,
  THAI_RAG_ORDINARY_CALL_BUDGET_ENV,
  thaiRagOrdinaryCallBudgetMs,
} from './thai-rag-call-budget.js';

const withBudget = (value: string): Readonly<Record<string, string>> => ({
  [THAI_RAG_ORDINARY_CALL_BUDGET_ENV]: value,
});

describe('thaiRagOrdinaryCallBudgetMs', () => {
  it('derives the request deadline from the budget the child is launched with (#770)', () => {
    // The launcher's default, plus the RPC margin.
    expect(thaiRagOrdinaryCallBudgetMs(undefined)).toBe(905_000);
    expect(thaiRagOrdinaryCallBudgetMs({})).toBe(905_000);
    expect(DEFAULT_THAI_RAG_ORDINARY_CALL_BUDGET_SECONDS).toBe(900);
    expect(thaiRagOrdinaryCallBudgetMs(withBudget('900'))).toBe(905_000);
    // A host value stays authoritative, exactly as the provider reads it.
    expect(thaiRagOrdinaryCallBudgetMs(withBudget('60'))).toBe(65_000);
    // Fractional seconds are legal in the provider's own parser.
    expect(thaiRagOrdinaryCallBudgetMs(withBudget(' 0.3 '))).toBe(5_300);
  });

  it('falls back to the launcher default when the provider would reject the value', () => {
    for (const value of ['', '   ', 'nonsense', '0', '-5', 'Infinity', 'NaN']) {
      expect(thaiRagOrdinaryCallBudgetMs(withBudget(value))).toBe(905_000);
    }
  });

  it('keeps a mistaken host value from parking a read for a day', () => {
    expect(thaiRagOrdinaryCallBudgetMs(withBudget('86400'))).toBe(3_600_000);
    expect(thaiRagOrdinaryCallBudgetMs(withBudget('7200'))).toBe(3_600_000);
  });
});

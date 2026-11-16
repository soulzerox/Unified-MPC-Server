import { describe, expect, it } from 'vitest';
import { DEFERRED_CLOSURE_OPERATION_KINDS } from '@unified-mpc/storage';
import { RECOVERY_JOURNAL_TOOLS } from './stdio-mcp-runtime.js';

describe('recovery journal allowlist', () => {
  it('journals every kind the durable-reference projection treats as unproven', () => {
    // A deferred kind that is not journaled is dead policy: the projection can
    // only report `present` for a row some writer actually kept.
    const missing = [...DEFERRED_CLOSURE_OPERATION_KINDS].filter((kind) => !RECOVERY_JOURNAL_TOOLS.has(kind));
    expect(missing).toEqual([]);
  });

  it('journals the restart-safe shell and the post-request merge attempt', () => {
    // `shell` is where `process_start` sends work that must survive a restart,
    // and `merge_verification_run` continues after the client request ends.
    expect(RECOVERY_JOURNAL_TOOLS.has('shell')).toBe(true);
    expect(RECOVERY_JOURNAL_TOOLS.has('merge_verification_run')).toBe(true);
  });
});

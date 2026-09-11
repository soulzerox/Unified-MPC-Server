import { describe, expect, it } from 'vitest';
import { appError, err, ok } from './errors.js';

describe('Result helpers', () => {
  it('creates success result', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('creates sanitized application error result', () => {
    expect(err(appError('INVALID_INPUT', 'bad input'))).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'bad input', recoverable: false },
    });
  });
});

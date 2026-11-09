import { describe, expect, it } from 'vitest';
import { appError, err, isAppErrorCode, ok } from './errors.js';

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

  it('keeps open details values', () => {
    expect(appError('CONFLICT', 'nested', false, {
      expected: ['a'],
      actual: { kind: 'b' },
    }).details).toEqual({
      expected: ['a'],
      actual: { kind: 'b' },
    });
  });
});

describe('isAppErrorCode', () => {
  it('accepts declared codes', () => {
    for (const code of ['INVALID_INPUT', 'CONFLICT', 'INTERNAL_ERROR']) {
      expect(isAppErrorCode(code)).toBe(true);
    }
  });

  it('rejects unknown values, including Object.prototype names', () => {
    for (const value of [undefined, null, 1, {}, '', 'NOT_A_CODE', 'constructor', '__proto__', 'toString']) {
      expect(isAppErrorCode(value)).toBe(false);
    }
  });
});

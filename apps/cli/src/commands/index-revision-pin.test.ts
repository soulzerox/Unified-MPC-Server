import { describe, expect, it } from 'vitest';
import { formatCanonicalRevisionPin, parseIndexRevisionPinArgs } from './index-revision-pin.js';

const ID = `man:v1:${'a'.repeat(64)}`;

describe('parseIndexRevisionPinArgs', () => {
  it('parses pin with an optional note and --json', () => {
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID])).toEqual({
      ok: true,
      value: { kind: 'index-revision-pin', action: 'pin', manifestId: ID, json: false },
    });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--note', 'keep for audit', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-pin', action: 'pin', manifestId: ID, note: 'keep for audit', json: true },
    });
  });

  it('parses unpin and normalizes the manifest id case', () => {
    expect(parseIndexRevisionPinArgs(['revision', 'unpin', ID.toUpperCase()])).toEqual({
      ok: true,
      value: { kind: 'index-revision-pin', action: 'unpin', manifestId: ID, json: false },
    });
  });

  it('rejects missing, malformed and duplicate manifest ids', () => {
    expect(parseIndexRevisionPinArgs(['revision', 'pin'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', 'man:v1:nothex'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, ID])).toMatchObject({ ok: false });
  });

  it('rejects unknown flags, duplicate flags and notes on unpin', () => {
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--reason', 'rollback'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--note', 'one', '--note', 'two'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--note'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'pin', ID, '--note', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'unpin', ID, '--note', 'x'])).toMatchObject({ ok: false });
  });

  it('rejects the list and advance verbs', () => {
    expect(parseIndexRevisionPinArgs(['revision', 'list'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPinArgs(['revision', 'advance'])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalRevisionPin', () => {
  it('prints the pin reason and every remaining reason', () => {
    expect(formatCanonicalRevisionPin({
      manifestId: ID,
      action: 'pinned',
      pins: ['goal-base', 'user-pin'],
    })).toBe([
      `pinned ${ID} reason user-pin`,
      'pins goal-base user-pin',
    ].join('\n'));
  });

  it('prints an unpin and says none when no reason remains', () => {
    expect(formatCanonicalRevisionPin({ manifestId: ID, action: 'unpinned', pins: [] })).toBe([
      `unpinned ${ID}`,
      'pins none',
    ].join('\n'));
  });

  it('prints not-pinned with whatever system reasons remain', () => {
    expect(formatCanonicalRevisionPin({ manifestId: ID, action: 'not-pinned', pins: ['canonical-ref'] })).toBe([
      `not-pinned ${ID}`,
      'pins canonical-ref',
    ].join('\n'));
  });
});

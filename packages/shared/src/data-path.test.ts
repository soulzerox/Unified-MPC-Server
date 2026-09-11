import { describe, expect, it } from 'vitest';
import { resolveDataPath } from './data-path.js';

describe('resolveDataPath', () => {
  it('uses explicit UNIFIED_MPC_DATA_PATH override', () => {
    expect(resolveDataPath({ UNIFIED_MPC_DATA_PATH: '/mnt/custom-data' }, 'linux')).toBe('/mnt/custom-data');
  });

  it.each([
    ['darwin', '/Users/alice/Library/Application Support/unified-mpc'],
    ['linux', '/home/alice/.local/share/unified-mpc'],
  ] as const)('uses host-native default data paths on %s', (platform, expected) => {
    expect(resolveDataPath({ HOME: platform === 'darwin' ? '/Users/alice' : '/home/alice' }, platform)).toBe(expected);
  });

  it('uses an absolute XDG data directory on Linux and ignores a relative one', () => {
    expect(resolveDataPath({ HOME: '/home/alice', XDG_DATA_HOME: '/mnt/data' }, 'linux')).toBe('/mnt/data/unified-mpc');
    expect(resolveDataPath({ HOME: '/home/alice', XDG_DATA_HOME: 'relative' }, 'linux')).toBe('/home/alice/.local/share/unified-mpc');
  });

  it('ignores relative explicit data-path overrides instead of resolving them against cwd', () => {
    expect(resolveDataPath({ UNIFIED_MPC_DATA_PATH: 'relative-data', HOME: '/home/alice' }, 'linux'))
      .toBe('/home/alice/.local/share/unified-mpc');
  });
});

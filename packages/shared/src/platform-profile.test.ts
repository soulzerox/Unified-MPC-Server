import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createPlatformProfile, currentPlatformProfile } from './platform-profile.js';

describe('platform profile', () => {
  it('classifies macOS arm64/x64 as supported targets', () => {
    for (const arch of ['arm64', 'x64']) {
      expect(createPlatformProfile({ platform: 'darwin', arch, release: '23.6.0' })).toMatchObject({
        family: 'macos',
        supportTier: 'supported',
        capabilities: {
          shell: 'native',
          screen_record: 'dependency_gated',
          'tunnel-client': 'dependency_gated',
        },
      });
    }
  });

  it('classifies Linux x64 as supported and Linux arm64 as preview', () => {
    expect(createPlatformProfile({ platform: 'linux', arch: 'x64', release: '6.8.0' })).toMatchObject({
      family: 'linux',
      supportTier: 'supported',
      capabilities: {
        shell: 'native',
        screen_record: 'dependency_gated',
        'tunnel-client': 'dependency_gated',
      },
    });
    expect(createPlatformProfile({ platform: 'linux', arch: 'arm64', release: '6.8.0' })).toMatchObject({
      family: 'linux',
      supportTier: 'preview',
    });
  });

  it('fails closed for unsupported hosts and architectures', () => {
    expect(createPlatformProfile({ platform: 'freebsd', arch: 'x64', release: '14.0' })).toMatchObject({
      family: 'unsupported',
      supportTier: 'unsupported',
      capabilities: {
        shell: 'unsupported',
        'tunnel-client': 'unsupported',
      },
    });
    expect(createPlatformProfile({ platform: 'darwin', arch: 'ia32', release: '23.6.0' })).toMatchObject({
      family: 'unsupported',
      supportTier: 'unsupported',
    });
  });

  it('uses the host kernel release when resolving the current profile', () => {
    expect(currentPlatformProfile()).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    });
  });
});

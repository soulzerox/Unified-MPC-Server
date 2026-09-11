import os from 'node:os';

export type SupportedHostPlatform = 'darwin' | 'linux';

export type PlatformSupportTier = 'supported' | 'preview' | 'unsupported';

export type PlatformCapabilityDisposition = 'native' | 'dependency_gated' | 'unsupported';

export interface PlatformProfileInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
}

export interface PlatformProfile {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly family: 'macos' | 'linux' | 'unsupported';
  readonly supportTier: PlatformSupportTier;
  readonly capabilities: Readonly<Record<string, PlatformCapabilityDisposition>>;
}

const CAPABILITY_NAMES = [
  'shell',
  'dom_cdp',
  'accessibility',
  'input_event',
  'vision',
  'window',
  'health',
  'system_info',
  'notification',
  'file_dialog',
  'clipboard',
  'web_fetch',
  'audio',
  'screen_record',
  'office',
  'scheduler',
  'tunnel-client',
  'event_log_context',
  'service_context',
] as const;

const MACOS_NATIVE = Object.freeze({
  shell: 'native',
  dom_cdp: 'dependency_gated',
  accessibility: 'dependency_gated',
  input_event: 'dependency_gated',
  vision: 'dependency_gated',
  window: 'dependency_gated',
  health: 'native',
  system_info: 'native',
  notification: 'dependency_gated',
  file_dialog: 'native',
  clipboard: 'dependency_gated',
  web_fetch: 'native',
  audio: 'dependency_gated',
  screen_record: 'dependency_gated',
  office: 'dependency_gated',
  scheduler: 'dependency_gated',
  'tunnel-client': 'dependency_gated',
  event_log_context: 'native',
  service_context: 'dependency_gated',
} satisfies Record<(typeof CAPABILITY_NAMES)[number], PlatformCapabilityDisposition>);

const LINUX_NATIVE = Object.freeze({
  shell: 'native',
  dom_cdp: 'dependency_gated',
  accessibility: 'dependency_gated',
  input_event: 'dependency_gated',
  vision: 'dependency_gated',
  window: 'dependency_gated',
  health: 'native',
  system_info: 'native',
  notification: 'dependency_gated',
  file_dialog: 'dependency_gated',
  clipboard: 'dependency_gated',
  web_fetch: 'native',
  audio: 'dependency_gated',
  screen_record: 'dependency_gated',
  office: 'dependency_gated',
  scheduler: 'dependency_gated',
  'tunnel-client': 'dependency_gated',
  event_log_context: 'dependency_gated',
  service_context: 'dependency_gated',
} satisfies Record<(typeof CAPABILITY_NAMES)[number], PlatformCapabilityDisposition>);

const UNSUPPORTED = Object.freeze(
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, 'unsupported' as const])) as Record<
    (typeof CAPABILITY_NAMES)[number],
    PlatformCapabilityDisposition
  >,
);

function darwinMajorVersion(release: string): number | null {
  const major = Number.parseInt(release.trim().split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** Build a deterministic host profile for Linux/macOS. */
export function createPlatformProfile(input: PlatformProfileInput): PlatformProfile {
  const { platform, arch, release } = input;

  if (platform === 'linux') {
    const supported = arch === 'x64' || arch === 'arm64';
    return {
      platform,
      arch,
      release,
      family: supported ? 'linux' : 'unsupported',
      supportTier: arch === 'x64' ? 'supported' : arch === 'arm64' ? 'preview' : 'unsupported',
      capabilities: supported ? LINUX_NATIVE : UNSUPPORTED,
    };
  }

  if (platform === 'darwin') {
    const supported = (arch === 'arm64' || arch === 'x64') && (darwinMajorVersion(release) ?? 0) >= 22;
    return {
      platform,
      arch,
      release,
      family: supported ? 'macos' : 'unsupported',
      supportTier: supported ? 'supported' : 'unsupported',
      capabilities: supported ? MACOS_NATIVE : UNSUPPORTED,
    };
  }

  return {
    platform,
    arch,
    release,
    family: 'unsupported',
    supportTier: 'unsupported',
    capabilities: UNSUPPORTED,
  };
}

/** Resolve the actual host profile for production startup. */
export function currentPlatformProfile(): PlatformProfile {
  return createPlatformProfile({ platform: process.platform, arch: process.arch, release: os.release() });
}

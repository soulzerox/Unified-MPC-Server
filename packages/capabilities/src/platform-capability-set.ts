import path from 'node:path';
import { BrowserCdpBackend } from './browser-cdp-backend.js';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { HealthCapabilityBackend } from './health-backend.js';
import { LocalCapabilityService, type CapabilityBackend } from './local-capability-service.js';
import { SchedulerCapabilityBackend } from './scheduler-backend.js';
import { ShellCapabilityBackend } from './shell-backend.js';
import { WebFetchCapabilityBackend } from './web-fetch-backend.js';
import { UnavailableCapabilityBackend } from './unavailable-backend.js';
import type { NativeHostProcessBridge } from './native-host-protocol.js';
import { MacosNativeCapabilityBackend } from './macos-native-backend.js';
import { LinuxNativeCapabilityBackend } from './linux-native-backend.js';
import { MacosSchedulerCapabilityBackend, LinuxSchedulerCapabilityBackend } from './portable-scheduler-backend.js';
import { SystemInfoCapabilityBackend } from './system-info-backend.js';
import { MacosOfficeCapabilityBackend } from './macos-office-backend.js';
import { LinuxOfficeCapabilityBackend } from './linux-office-backend.js';

export interface PlatformCapabilitySetOptions {
  readonly platform?: NodeJS.Platform;
  readonly dataPath: string;
  readonly workspaceRootsProvider: () => Promise<readonly string[]>;
  readonly unrestricted?: boolean;
  readonly configuredRootsProvider?: () => readonly string[];
  readonly synchronousWaitSecondsProvider?: () => number;
  /** Electron-main providers whose semantics are shared by macOS/Linux. */
  readonly shared?: Partial<Record<import('./index.js').CapabilityToolName, CapabilityBackend>>;
  /** Optional integrity-bound native host for macOS/Linux desktop capabilities. */
  readonly nativeHost?: NativeHostProcessBridge;
}

export interface PlatformCapabilitySet {
  readonly service: LocalCapabilityService;
  readonly health: HealthCapabilityBackend;
  readonly shell: ShellCapabilityBackend;
  readonly backends: Readonly<Record<string, CapabilityBackend>>;
}

/**
 * Compose exactly one host provider set for Linux/macOS.
 */
export function createPlatformCapabilitySet(options: PlatformCapabilitySetOptions): PlatformCapabilitySet {
  const platform = options.platform ?? process.platform;
  const unrestricted = options.unrestricted === true;
  const configuredRootsProvider = options.configuredRootsProvider ?? ((): readonly string[] => []);
  const capabilityRootsProvider = async (): Promise<readonly string[]> => {
    const workspaceRoots = await options.workspaceRootsProvider();
    const roots = [...workspaceRoots, ...configuredRootsProvider()];
    return roots.length === 0 ? [options.dataPath] : roots;
  };
  const shell = new ShellCapabilityBackend({
    allowedRoots: [options.dataPath],
    allowedRootsProvider: capabilityRootsProvider,
    unrestricted,
    taskStateDirectory: path.join(options.dataPath, 'background-tasks'),
    ...(options.synchronousWaitSecondsProvider === undefined ? {} : { maxSynchronousWaitSecondsProvider: options.synchronousWaitSecondsProvider }),
  });
  const browserProtocol = new NodeBrowserCdpProtocol({ platform, profileDir: path.join(options.dataPath, 'browser-profile') });
  const browser = new BrowserCdpBackend({
    protocol: browserProtocol,
    launcher: (url: string | undefined, signal?: AbortSignal): Promise<import('@unified-mpc/domain').Result<unknown>> => browserProtocol.launch(url, signal),
  });
  const webFetch = new WebFetchCapabilityBackend();

  const unavailable = (name: string, reason: 'unsupported_platform' | 'dependency_missing' = 'unsupported_platform'): UnavailableCapabilityBackend => (
    new UnavailableCapabilityBackend(name, reason, `${name} has no native provider for ${platform}`)
  );

  let accessibility: CapabilityBackend;
  let inputEvent: CapabilityBackend;
  let vision: CapabilityBackend;
  let window: CapabilityBackend;
  let systemInfo: CapabilityBackend;
  let notification: CapabilityBackend;
  let fileDialog: CapabilityBackend;
  let clipboard: CapabilityBackend;
  let audio: CapabilityBackend;
  let screenRecord: CapabilityBackend;
  let office: CapabilityBackend;
  let scheduler: CapabilityBackend;
  const wslExec: CapabilityBackend = unavailable('wsl_exec');
  const wslFs: CapabilityBackend = unavailable('wsl_fs');

  if (platform === 'darwin' || platform === 'linux') {
    const nativeBackend = <T extends import('./native-capability-backend.js').PortableNativeCapabilityName>(capability: T): CapabilityBackend => platform === 'darwin'
      ? new MacosNativeCapabilityBackend(capability, { ...(options.nativeHost === undefined ? {} : { bridge: options.nativeHost }), allowedRootsProvider: capabilityRootsProvider })
      : new LinuxNativeCapabilityBackend(capability, { ...(options.nativeHost === undefined ? {} : { bridge: options.nativeHost }), allowedRootsProvider: capabilityRootsProvider });
    accessibility = nativeBackend('accessibility');
    inputEvent = nativeBackend('input_event');
    vision = nativeBackend('vision');
    window = nativeBackend('window');
    systemInfo = options.shared?.system_info ?? new SystemInfoCapabilityBackend(platform);
    notification = options.shared?.notification ?? unavailable('notification');
    fileDialog = options.shared?.file_dialog ?? unavailable('file_dialog');
    clipboard = options.shared?.clipboard ?? unavailable('clipboard');
    audio = nativeBackend('audio');
    screenRecord = nativeBackend('screen_record');
    office = platform === 'darwin'
      ? new MacosOfficeCapabilityBackend({ allowedRootsProvider: capabilityRootsProvider })
      : new LinuxOfficeCapabilityBackend({ allowedRootsProvider: capabilityRootsProvider });
    scheduler = platform === 'darwin' ? new MacosSchedulerCapabilityBackend() : new LinuxSchedulerCapabilityBackend();
  } else {
    accessibility = unavailable('accessibility');
    inputEvent = unavailable('input_event');
    vision = unavailable('vision');
    window = unavailable('window');
    systemInfo = options.shared?.system_info ?? unavailable('system_info');
    notification = options.shared?.notification ?? unavailable('notification');
    fileDialog = options.shared?.file_dialog ?? unavailable('file_dialog');
    clipboard = options.shared?.clipboard ?? unavailable('clipboard');
    audio = unavailable('audio');
    screenRecord = unavailable('screen_record');
    office = unavailable('office');
    scheduler = unavailable('scheduler');
  }

  const health = new HealthCapabilityBackend({
    platform,
    domCdp: browser,
    accessibility,
    scheduler,
    wslExec,
    wslFs,
    backends: { dom_cdp: browser, accessibility, input_event: inputEvent, vision, window, system_info: systemInfo, notification, file_dialog: fileDialog, clipboard, web_fetch: webFetch, audio, screen_record: screenRecord, office, scheduler, wsl_exec: wslExec, wsl_fs: wslFs },
  });
  const service = new LocalCapabilityService({
    shell,
    domCdp: browser,
    accessibility,
    inputEvent,
    vision,
    window,
    health,
    systemInfo,
    notification,
    fileDialog,
    clipboard,
    webFetch,
    audio,
    screenRecord,
    office,
    scheduler,
    wslExec,
    wslFs,
  });
  return {
    service,
    health,
    shell,
    backends: { accessibility, inputEvent, vision, window, systemInfo, notification, fileDialog, clipboard, audio, screenRecord, office, scheduler, wslExec, wslFs },
  };
}

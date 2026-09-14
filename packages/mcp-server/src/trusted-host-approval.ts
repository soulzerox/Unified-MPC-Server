import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { HostMutationApprovalRequest } from './tool-registry.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_COMMAND_STDOUT_BYTES = 4_096;

export type HostApprovalCommandStatus = 'approved' | 'denied' | 'unavailable';

export interface HostApprovalCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly resultMode?: 'exit-zero' | 'stdout-approve';
  readonly timeoutMs?: number;
}

export interface HostApprovalCommandResult {
  readonly status: HostApprovalCommandStatus;
}

export interface TrustedHostMutationApprovalOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCommand?: (request: HostApprovalCommandRequest) => Promise<HostApprovalCommandResult>;
  readonly ttyPrompt?: (message: string, platform: NodeJS.Platform) => Promise<boolean | null>;
  readonly timeoutMs?: number;
}

export type TrustedHostMutationApprovalProvider = (request: HostMutationApprovalRequest) => Promise<boolean>;

export function formatHostMutationApprovalMessage(request: HostMutationApprovalRequest): string {
  const lines = [
    'Unified MPC exact-action approval',
    '',
    `Tool: ${request.toolName}`,
    `Mutation: ${request.mutationKind}`,
    `Reason: ${request.reason}`,
    `Exact action: ${request.summary}`,
  ];

  if (request.workspaceId !== undefined) lines.push(`Workspace ID: ${request.workspaceId}`);
  if (request.workspaceRoot !== undefined) lines.push(`Workspace root: ${request.workspaceRoot}`);
  if (request.externalMcpContract !== undefined) {
    lines.push(`Child descriptor fingerprint: ${request.externalMcpContract.descriptorFingerprint}`);
    if (request.externalMcpContract.catalogFingerprint !== undefined) {
      lines.push(`Child catalog fingerprint: ${request.externalMcpContract.catalogFingerprint}`);
    }
  }

  lines.push('', 'Approve only if this exact action is expected.');
  return lines.join('\n');
}

export function createTrustedHostMutationApprovalProvider(
  options: TrustedHostMutationApprovalOptions = {},
): TrustedHostMutationApprovalProvider {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const runCommand = options.runCommand ?? defaultRunApprovalCommand;
  const ttyPrompt = options.ttyPrompt ?? defaultTtyPrompt;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  let queue: Promise<void> = Promise.resolve();

  return async (request): Promise<boolean> => {
    const execute = async (): Promise<boolean> => {
      try {
        return await requestTrustedApproval(request, {
          platform,
          environment,
          runCommand,
          ttyPrompt,
          timeoutMs,
        });
      } catch {
        return false;
      }
    };

    const current = queue.then(execute, execute);
    queue = current.then(() => undefined, () => undefined);
    return current;
  };
}

interface ResolvedApprovalOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly runCommand: (request: HostApprovalCommandRequest) => Promise<HostApprovalCommandResult>;
  readonly ttyPrompt: (message: string, platform: NodeJS.Platform) => Promise<boolean | null>;
  readonly timeoutMs: number;
}

async function requestTrustedApproval(
  request: HostMutationApprovalRequest,
  options: ResolvedApprovalOptions,
): Promise<boolean> {
  const message = formatHostMutationApprovalMessage(request);
  const guiResult = await requestGuiApproval(message, options);
  if (guiResult !== null) return guiResult;

  const ttyResult = await options.ttyPrompt(message, options.platform);
  return ttyResult === true;
}

async function requestGuiApproval(
  message: string,
  options: ResolvedApprovalOptions,
): Promise<boolean | null> {
  switch (options.platform) {
    case 'linux':
      return requestLinuxGuiApproval(message, options);
    case 'darwin':
      return resolveCommandChain([
        macOsApprovalCommand(message, options.timeoutMs),
      ], options.runCommand);
    case 'win32':
      return resolveCommandChain([
        windowsApprovalCommand('powershell.exe', message, options.environment, options.timeoutMs),
        windowsApprovalCommand('pwsh.exe', message, options.environment, options.timeoutMs),
      ], options.runCommand);
    default:
      return null;
  }
}

async function requestLinuxGuiApproval(
  message: string,
  options: ResolvedApprovalOptions,
): Promise<boolean | null> {
  const hasGuiSession = Boolean(options.environment.DISPLAY?.trim() || options.environment.WAYLAND_DISPLAY?.trim());
  if (!hasGuiSession) return null;

  return resolveCommandChain([
    {
      command: 'zenity',
      args: [
        '--question',
        '--title=Unified MPC exact-action approval',
        `--text=${message}`,
        '--ok-label=Approve',
        '--cancel-label=Deny',
        '--width=560',
      ],
      resultMode: 'exit-zero',
      timeoutMs: options.timeoutMs,
    },
    {
      command: 'kdialog',
      args: [
        '--title', 'Unified MPC exact-action approval',
        '--yesno', message,
        '--yes-label', 'Approve',
        '--no-label', 'Deny',
      ],
      resultMode: 'exit-zero',
      timeoutMs: options.timeoutMs,
    },
  ], options.runCommand);
}

function macOsApprovalCommand(message: string, timeoutMs: number): HostApprovalCommandRequest {
  const script = [
    'on run argv',
    'set promptText to item 1 of argv',
    'try',
    'set answer to display dialog promptText with title "Unified MPC exact-action approval" buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution',
    'if button returned of answer is "Approve" then return "APPROVE"',
    'on error number -128',
    'end try',
    'return "DENY"',
    'end run',
  ].join('\n');
  return {
    command: 'osascript',
    args: ['-e', script, '--', message],
    resultMode: 'stdout-approve',
    timeoutMs,
  };
}

function windowsApprovalCommand(
  command: string,
  message: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): HostApprovalCommandRequest {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$result = [System.Windows.Forms.MessageBox]::Show($env:UNIFIED_MPC_APPROVAL_MESSAGE, 'Unified MPC exact-action approval', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)",
    "if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { Write-Output 'APPROVE' } else { Write-Output 'DENY' }",
  ].join('; ');
  return {
    command,
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    environment: { ...environment, UNIFIED_MPC_APPROVAL_MESSAGE: message },
    resultMode: 'stdout-approve',
    timeoutMs,
  };
}

async function resolveCommandChain(
  commands: readonly HostApprovalCommandRequest[],
  runCommand: (request: HostApprovalCommandRequest) => Promise<HostApprovalCommandResult>,
): Promise<boolean | null> {
  for (const command of commands) {
    const result = await runCommand(command);
    if (result.status === 'approved') return true;
    if (result.status === 'denied') return false;
  }
  return null;
}

async function defaultRunApprovalCommand(request: HostApprovalCommandRequest): Promise<HostApprovalCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const timerRef: { current?: NodeJS.Timeout } = {};
    const settle = (result: HostApprovalCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      resolve(result);
    };

    let child;
    try {
      child = spawn(request.command, [...request.args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        ...(request.environment === undefined ? {} : { env: request.environment }),
      });
    } catch (error) {
      settle({ status: isMissingExecutable(error) ? 'unavailable' : 'denied' });
      return;
    }

    timerRef.current = setTimeout(() => {
      child.kill();
      settle({ status: 'denied' });
    }, normalizeTimeout(request.timeoutMs));
    timerRef.current.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length >= MAX_COMMAND_STDOUT_BYTES) return;
      stdout += chunk.toString().slice(0, MAX_COMMAND_STDOUT_BYTES - stdout.length);
    });
    child.once('error', (error) => {
      settle({ status: isMissingExecutable(error) ? 'unavailable' : 'denied' });
    });
    child.once('close', (code) => {
      if (request.resultMode === 'stdout-approve') {
        const token = stdout.trim();
        if (code === 0 && token === 'APPROVE') {
          settle({ status: 'approved' });
        } else if (code === 0 && token === 'DENY') {
          settle({ status: 'denied' });
        } else {
          settle({ status: 'unavailable' });
        }
        return;
      }
      settle({ status: code === 0 ? 'approved' : 'denied' });
    });
  });
}

async function defaultTtyPrompt(message: string, platform: NodeJS.Platform): Promise<boolean | null> {
  const inputPath = platform === 'win32' ? 'CONIN$' : '/dev/tty';
  const outputPath = platform === 'win32' ? 'CONOUT$' : '/dev/tty';
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const output = createWriteStream(outputPath, { encoding: 'utf8' });

  const streamReady = await new Promise<boolean>((resolve) => {
    let resolved = false;
    const finish = (value: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    input.once('open', () => finish(true));
    input.once('error', () => finish(false));
    output.once('error', () => finish(false));
  });
  if (!streamReady) {
    input.destroy();
    output.destroy();
    return null;
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await rl.question(`${message}\n\nType APPROVE to continue, or anything else to deny: `);
    return answer.trim() === 'APPROVE';
  } catch {
    return null;
  } finally {
    rl.close();
    input.destroy();
    output.end();
  }
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : DEFAULT_APPROVAL_TIMEOUT_MS;
}

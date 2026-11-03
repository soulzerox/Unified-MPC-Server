import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DoctorProbeResult, DoctorProbes, DoctorReport, DoctorService } from '@unified-mpc/application';

export interface DoctorCommandRunner {
  run(): Promise<DoctorReport>;
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map((check) => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
    .join('\n');
}

export async function runDoctorCommand(
  service: Pick<DoctorService, 'run'> | DoctorCommandRunner,
  write: (text: string) => void,
): Promise<number> {
  const report = await service.run();
  write(formatDoctorReport(report));
  return report.exitCode;
}

/** Resolve an executable on `PATH`; `null` when it is absent or not executable. */
export type ExecutableLookup = (executable: string) => Promise<string | null>;

export type PortAvailability = 'available' | 'in-use';

/**
 * Real probes behind `unified-mpc doctor`.
 *
 * The command used to answer with one hardcoded pass check, so the documented
 * "exits non-zero when a required check fails" contract could never fire. A
 * probe here decides only its status and message; the caller owns how the
 * database, the workspace registry, and `PATH` are reached, which keeps these
 * probes testable without a real SQLite file or a real `rg` binary.
 */
export interface DoctorProbeDependencies {
  /** Resolve an executable on `PATH`; `null` when it is not installed. */
  readonly lookupExecutable: ExecutableLookup;
  /** Open and read the operational database; throws when it is unavailable. */
  readonly probeDatabase: () => Promise<void>;
  readonly workspaceCount: () => Promise<number>;
  /** The port the HTTP MCP runtime would bind. */
  readonly mcpPort: number;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  /** Defaults to a real loopback bind probe. */
  readonly probePort?: (port: number) => Promise<PortAvailability>;
}

export function createDoctorProbes(dependencies: DoctorProbeDependencies): DoctorProbes {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const release = dependencies.release ?? os.release();
  const probePort = dependencies.probePort ?? probePortAvailability;

  return {
    os: async () => pass(`${platform} ${arch} (${release})`),
    database: async (): Promise<DoctorProbeResult> => {
      try {
        await dependencies.probeDatabase();
        return pass('Unified MCP core operational');
      } catch (error) {
        return fail(`database unavailable: ${describe(error)}`);
      }
    },
    git: async () => optional(dependencies.lookupExecutable, 'git', 'Git'),
    ripgrep: async (): Promise<DoctorProbeResult> => {
      const binary = await dependencies.lookupExecutable('rg');
      return binary === null ? fail('ripgrep is not installed') : pass(`ripgrep ready (${binary})`);
    },
    workspaces: async (): Promise<DoctorProbeResult> => {
      const count = await dependencies.workspaceCount();
      if (count === 0) return { status: 'warn', message: 'No project workspace is registered yet' };
      return pass(`${count} workspace${count === 1 ? '' : 's'} configured`);
    },
    mcpPort: async (): Promise<DoctorProbeResult> => {
      let availability: PortAvailability;
      try {
        availability = await probePort(dependencies.mcpPort);
      } catch (error) {
        return fail(`MCP port ${dependencies.mcpPort} could not be probed: ${describe(error)}`);
      }
      return availability === 'available'
        ? pass(`MCP port ${dependencies.mcpPort} is available`)
        : { status: 'warn', message: `MCP port ${dependencies.mcpPort} is already in use` };
    },
    codex: async () => optional(dependencies.lookupExecutable, 'codex', 'Codex'),
  };
}

/**
 * Bind and release the loopback port. A port another process holds is reported,
 * not thrown: the runtime may legitimately be listening already, and `doctor`
 * must stay usable while the server is up.
 */
export function probePortAvailability(port: number): Promise<PortAvailability> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      try {
        server.close();
      } catch {
        // The listener never started, so there is nothing to release.
      }
      if (error.code === 'EADDRINUSE') {
        resolve('in-use');
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve('available'));
    });
  });
}

/**
 * `PATH` lookup without spawning a shell. Missing entries and non-executable
 * files are skipped: a `doctor` probe must report what the runtime can launch,
 * not fail on the first directory it cannot read.
 */
export function resolveOnPath(executable: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  if (executable.trim().length === 0) return null;
  const entries = (environment.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function pass(message: string): DoctorProbeResult {
  return { status: 'pass', message };
}

function fail(message: string): DoctorProbeResult {
  return { status: 'fail', message };
}

async function optional(lookup: ExecutableLookup, executable: string, label: string): Promise<DoctorProbeResult> {
  const binary = await lookup(executable);
  return binary === null
    ? { status: 'warn', message: `${label} is not installed` }
    : pass(`${label} ready (${binary})`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

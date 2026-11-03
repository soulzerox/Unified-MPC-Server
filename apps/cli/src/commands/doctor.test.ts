import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDoctorProbes,
  formatDoctorReport,
  probePortAvailability,
  resolveOnPath,
  runDoctorCommand,
  type DoctorProbeDependencies,
} from './doctor.js';

const report = {
  exitCode: 0 as const,
  checks: [
    { id: 'os' as const, required: true, status: 'pass' as const, message: 'Windows x64' },
    { id: 'codex' as const, required: false, status: 'warn' as const, message: 'Codex is not installed' },
  ],
};

function dependencies(overrides: Partial<DoctorProbeDependencies> = {}): DoctorProbeDependencies {
  return {
    lookupExecutable: async (executable) => `/usr/bin/${executable}`,
    probeDatabase: async (): Promise<void> => {},
    workspaceCount: async () => 1,
    mcpPort: 18_765,
    platform: 'linux',
    arch: 'x64',
    release: '6.8.0',
    probePort: async () => 'available',
    ...overrides,
  };
}

describe('doctor CLI command', () => {
  it('formats checks without exposing extra data', () => {
    expect(formatDoctorReport(report)).toBe('[PASS] os: Windows x64\n[WARN] codex: Codex is not installed');
  });

  it('returns the doctor exit code and writes the formatted report', async () => {
    const output: string[] = [];
    const exitCode = await runDoctorCommand({ run: async () => report }, (text) => output.push(text));

    expect(exitCode).toBe(0);
    expect(output).toEqual(['[PASS] os: Windows x64\n[WARN] codex: Codex is not installed']);
  });
});

describe('doctor probes', () => {
  it('reports every check as a pass when the host is ready', async () => {
    const probes = createDoctorProbes(dependencies());

    await expect(probes.os()).resolves.toEqual({ status: 'pass', message: 'linux x64 (6.8.0)' });
    await expect(probes.database()).resolves.toEqual({ status: 'pass', message: 'Unified MCP core operational' });
    await expect(probes.git()).resolves.toEqual({ status: 'pass', message: 'Git ready (/usr/bin/git)' });
    await expect(probes.ripgrep()).resolves.toEqual({ status: 'pass', message: 'ripgrep ready (/usr/bin/rg)' });
    await expect(probes.workspaces()).resolves.toEqual({ status: 'pass', message: '1 workspace configured' });
    await expect(probes.mcpPort()).resolves.toEqual({ status: 'pass', message: 'MCP port 18765 is available' });
    await expect(probes.codex()).resolves.toEqual({ status: 'pass', message: 'Codex ready (/usr/bin/codex)' });
  });

  it('fails the required ripgrep check when the binary is absent', async () => {
    const probes = createDoctorProbes(dependencies({
      lookupExecutable: async (executable) => (executable === 'rg' ? null : `/usr/bin/${executable}`),
    }));

    await expect(probes.ripgrep()).resolves.toEqual({ status: 'fail', message: 'ripgrep is not installed' });
  });

  it('keeps optional Git and Codex absence non-fatal', async () => {
    const probes = createDoctorProbes(dependencies({
      lookupExecutable: async (executable) => (executable === 'rg' ? '/usr/bin/rg' : null),
    }));

    await expect(probes.git()).resolves.toEqual({ status: 'warn', message: 'Git is not installed' });
    await expect(probes.codex()).resolves.toEqual({ status: 'warn', message: 'Codex is not installed' });
  });

  it('surfaces a database failure with its message', async () => {
    const probes = createDoctorProbes(dependencies({
      probeDatabase: async () => {
        throw new Error('disk I/O error');
      },
    }));

    await expect(probes.database()).resolves.toEqual({
      status: 'fail',
      message: 'database unavailable: disk I/O error',
    });
  });

  it('keeps a clean profile without a registered workspace recoverable', async () => {
    const probes = createDoctorProbes(dependencies({ workspaceCount: async () => 0 }));

    await expect(probes.workspaces()).resolves.toEqual({
      status: 'warn',
      message: 'No project workspace is registered yet',
    });
  });

  it('reports a busy MCP port without failing the runtime', async () => {
    const probes = createDoctorProbes(dependencies({ probePort: async () => 'in-use' }));

    await expect(probes.mcpPort()).resolves.toEqual({
      status: 'warn',
      message: 'MCP port 18765 is already in use',
    });
  });

  it('fails the required MCP port check when the probe itself fails', async () => {
    const probes = createDoctorProbes(dependencies({
      probePort: async () => {
        throw new Error('EACCES');
      },
    }));

    await expect(probes.mcpPort()).resolves.toEqual({
      status: 'fail',
      message: 'MCP port 18765 could not be probed: EACCES',
    });
  });
});

describe('doctor host lookups', () => {
  it('resolves an executable from PATH and skips missing entries', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doctor-path-'));
    const binary = path.join(directory, 'fake-rg');
    try {
      writeFileSync(binary, '#!/bin/sh\n');
      chmodSync(binary, 0o755);

      expect(resolveOnPath('fake-rg', { PATH: `/nonexistent:${directory}` })).toBe(binary);
      expect(resolveOnPath('fake-rg', { PATH: '/nonexistent' })).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('detects a bound loopback port and reports it available after release', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    try {
      await expect(probePortAvailability(address.port)).resolves.toBe('in-use');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await expect(probePortAvailability(address.port)).resolves.toBe('available');
  });
});

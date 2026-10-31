import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import type { DoctorReport } from '@unified-mpc/application';
import type { InstallServerResult, InstallSkillResult, PruneServerResult, PruneSkillResult } from '@unified-mpc/extensions';
import {
  parseCliArgs,
  runCli,
  type CliCommand,
  type CliDependencies,
  type CliStatus,
  type WebRunResult,
} from './index.js';
import type { ToolSummary } from './commands/tools.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

/** Markdown files that show runnable `unified-mpc` / `pnpm cli` examples. */
const DOC_FILES = ['README.md', path.join('docs', 'CLI_REFERENCE.md'), path.join('docs', 'USAGE_TH.md')] as const;

/** Shell examples that are grammar lines, not runnable commands. */
const PLACEHOLDER = /</;

function shellExamples(markdown: string): string[] {
  const examples: string[] = [];
  for (const block of markdown.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    // A trailing backslash continues the command on the next line.
    const body = block[1]!.replace(/\\\r?\n/g, ' ');
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/^\$ /, '');
      if (line.length === 0 || line.startsWith('#')) continue;
      if (/^unified-mpc(\s|$)/.test(line)) examples.push(line);
      else if (/^pnpm cli(\s|$)/.test(line)) examples.push(line.replace(/^pnpm cli/, 'unified-mpc'));
    }
  }
  return examples;
}

function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
}

interface ExampleExpectation {
  /** Documented command shape, matched against the example text before tokenizing. */
  readonly pattern: RegExp;
  /** Command the parser must produce, so a doc line cannot silently dispatch elsewhere. */
  readonly kind: CliCommand['kind'];
  /** Dependency method a correct dispatch calls exactly once. */
  readonly dispatch: string;
}

/**
 * One semantic expectation per documented command family. A new doc example that
 * matches none of these fails, which is the point: the guard must not accept an
 * example whose meaning nobody stated.
 */
const EXPECTATIONS: readonly ExampleExpectation[] = [
  { pattern: /^unified-mpc status(?:\s|$)/, kind: 'status', dispatch: 'status' },
  { pattern: /^unified-mpc doctor(?:\s|$)/, kind: 'doctor', dispatch: 'doctor' },
  { pattern: /^unified-mpc sync(?:\s|$)/, kind: 'sync', dispatch: 'sync' },
  { pattern: /^unified-mpc install skill(?:\s|$)/, kind: 'install-skill', dispatch: 'installSkill' },
  { pattern: /^unified-mpc install server(?:\s|$)/, kind: 'install-server', dispatch: 'installServer' },
  { pattern: /^unified-mpc prune skill(?:\s|$)/, kind: 'prune-skill', dispatch: 'pruneSkill' },
  { pattern: /^unified-mpc prune server(?:\s|$)/, kind: 'prune-server', dispatch: 'pruneServer' },
  { pattern: /^unified-mpc web(?:\s|$)/, kind: 'web', dispatch: 'web' },
  { pattern: /^unified-mpc tools list(?:\s|$)/, kind: 'tools-list', dispatch: 'toolsList' },
  { pattern: /^unified-mpc tools call(?:\s|$)/, kind: 'tools-call', dispatch: 'toolsCall' },
  { pattern: /^unified-mpc publish-credential grant(?:\s|$)/, kind: 'publish-credential-grant', dispatch: 'publishCredential' },
  { pattern: /^unified-mpc publish-credential revoke(?:\s|$)/, kind: 'publish-credential-revoke', dispatch: 'publishCredential' },
  { pattern: /^unified-mpc publish-credential status(?:\s|$)/, kind: 'publish-credential-status', dispatch: 'publishCredential' },
];

/**
 * Dependency set that records which handler a documented example reached. Every
 * method returns a successful, empty result: replaying docs must never touch a
 * real database, config file, child process or port.
 */
function replayDependencies(calls: string[]): CliDependencies {
  const unused = async (): Promise<never> => {
    throw new Error('documented example reached a dependency it should not use');
  };
  return {
    status: async (): Promise<CliStatus> => {
      calls.push('status');
      return { workspaceCount: 1 };
    },
    workspaceAdd: unused,
    workspaceList: unused,
    mcpStdio: unused,
    mcpHttp: unused,
    doctor: async (): Promise<DoctorReport> => {
      calls.push('doctor');
      return {
        checks: [{ id: 'database', required: true, status: 'pass', message: 'Unified MCP core operational' }],
        exitCode: 0,
      };
    },
    codexDoctor: unused,
    installSkill: async (): Promise<Result<InstallSkillResult>> => {
      calls.push('installSkill');
      return ok({ name: 'documented-skill', installedPaths: [], targets: ['all'] });
    },
    installServer: async (): Promise<Result<InstallServerResult>> => {
      calls.push('installServer');
      return ok({ name: 'documented-server', targets: ['all'], updatedConfigFiles: [] });
    },
    pruneSkill: async (): Promise<Result<PruneSkillResult>> => {
      calls.push('pruneSkill');
      return ok({ name: 'documented-skill', removedPaths: [] });
    },
    pruneServer: async (): Promise<Result<PruneServerResult>> => {
      calls.push('pruneServer');
      return ok({
        name: 'documented-server',
        updatedConfigFiles: [],
        processTerminated: true,
        removedPaths: [],
        recoveryStatus: 'completed',
        recoveryIds: [],
      });
    },
    sync: async (): Promise<Result<{ readonly updatedFiles: readonly string[] }>> => {
      calls.push('sync');
      return ok({ updatedFiles: [] });
    },
    web: async (): Promise<Result<WebRunResult>> => {
      calls.push('web');
      return ok({ handle: { close: async (): Promise<void> => undefined }, url: 'http://127.0.0.1:3000' });
    },
    toolsList: (): readonly ToolSummary[] => {
      calls.push('toolsList');
      return [{ name: 'read_file', description: 'Read file contents' }];
    },
    toolsCall: async (): Promise<Result<unknown>> => {
      calls.push('toolsCall');
      return ok({ replayed: true });
    },
    publishCredential: async (_command, write): Promise<number> => {
      calls.push('publishCredential');
      write('publish credential replayed');
      return 0;
    },
  };
}

describe('documented CLI examples', () => {
  for (const file of DOC_FILES) {
    describe(file, () => {
      const examples = shellExamples(readFileSync(path.join(repoRoot, file), 'utf8'));

      it('contains examples to check', () => {
        expect(examples.length).toBeGreaterThan(0);
      });

      for (const example of examples) {
        // Grammar lines such as `unified-mpc <command> [flags]` document the shape
        // of the CLI rather than a command a reader can run.
        if (PLACEHOLDER.test(example)) continue;
        it(`parses: ${example}`, () => {
          const parsed = parseCliArgs(tokenize(example).slice(1));
          expect(parsed.ok, parsed.ok ? undefined : `${example} -> ${parsed.error.message}`).toBe(true);
          if (!parsed.ok) return;
          // `--args` splits on commas, so one element containing spaces means the
          // example teaches a form that installs a single bogus argv element.
          const commandArgs = (parsed.value as { args?: readonly string[] }).args;
          if (Array.isArray(commandArgs)) {
            expect(
              commandArgs.filter((argument) => argument.includes(' ')),
              `${example} -> ${JSON.stringify(commandArgs)}`,
            ).toEqual([]);
          }
        });
      }
    });
  }
});

describe('documented CLI examples (semantic replay)', () => {
  for (const file of DOC_FILES) {
    describe(file, () => {
      const examples = shellExamples(readFileSync(path.join(repoRoot, file), 'utf8'));

      for (const example of examples) {
        if (PLACEHOLDER.test(example)) continue;
        it(`dispatches: ${example}`, async () => {
          const expectation = EXPECTATIONS.find((entry) => entry.pattern.test(example));
          expect(expectation, `documented example has no semantic expectation: ${example}`).toBeDefined();

          const parsed = parseCliArgs(tokenize(example).slice(1));
          expect(parsed.ok, parsed.ok ? undefined : `${example} -> ${parsed.error.message}`).toBe(true);
          if (!parsed.ok || expectation === undefined) return;
          expect(parsed.value.kind).toBe(expectation.kind);

          const calls: string[] = [];
          const stdout: string[] = [];
          const stderr: string[] = [];
          const exitCode = await runCli(tokenize(example).slice(1), {
            ...replayDependencies(calls),
            write: (text) => stdout.push(text),
            writeError: (text) => stderr.push(text),
          });

          expect(stderr, `stderr for ${example}`).toEqual([]);
          expect(exitCode, `exit code for ${example}`).toBe(0);
          expect(calls, `dispatch for ${example}`).toEqual([expectation.dispatch]);
          expect(stdout.length, `output for ${example}`).toBeGreaterThan(0);
        });
      }
    });
  }
});

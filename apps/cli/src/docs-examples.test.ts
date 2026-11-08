import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import type { DoctorReport } from '@unified-mpc/application';
import type { InstallServerResult, InstallSkillResult, PruneServerResult, PruneSkillResult } from '@unified-mpc/extensions';
import type { SqlitePhysicalMetrics, StorageRecoveryResult } from '@unified-mpc/storage';
import type { CanonicalStatusReport, CanonicalRevisionListReport, CanonicalRevisionPinReport, CanonicalStoreRepairReport, GcCycleReport, GcExpireReport, GcStatusReport, GitRevisionAdvanceResult, LogicalSpaceReport, MaintenanceCycleReport, RevisionPruneReport } from '@unified-mpc/workspace';
import type { ThaiRagIndexJobListing } from '@unified-mpc/thai-rag';
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
  { pattern: /^unified-mpc storage recover(?:\s|$)/, kind: 'storage-recover', dispatch: 'storageRecover' },
  { pattern: /^unified-mpc storage metrics(?:\s|$)/, kind: 'storage-metrics', dispatch: 'storageMetrics' },
  { pattern: /^unified-mpc index revision advance(?:\s|$)/, kind: 'index-revision-advance', dispatch: 'indexRevisionAdvance' },
  { pattern: /^unified-mpc index revision list(?:\s|$)/, kind: 'index-revision-list', dispatch: 'canonicalRevisionList' },
  { pattern: /^unified-mpc index revision pin(?:\s|$)/, kind: 'index-revision-pin', dispatch: 'canonicalRevisionPin' },
  { pattern: /^unified-mpc index revision unpin(?:\s|$)/, kind: 'index-revision-pin', dispatch: 'canonicalRevisionPin' },
  { pattern: /^unified-mpc index revision prune(?:\s|$)/, kind: 'index-revision-prune', dispatch: 'indexRevisionPrune' },
  { pattern: /^unified-mpc index repair(?:\s|$)/, kind: 'index-repair', dispatch: 'indexRepair' },
  { pattern: /^unified-mpc index gc expire(?:\s|$)/, kind: 'index-gc-expire', dispatch: 'indexGcExpire' },
  { pattern: /^unified-mpc index gc status(?:\s|$)/, kind: 'index-gc-status', dispatch: 'indexGcStatus' },
  { pattern: /^unified-mpc index gc(?:\s|$)/, kind: 'index-gc', dispatch: 'indexGc' },
  { pattern: /^unified-mpc index maintenance(?:\s|$)/, kind: 'index-maintenance', dispatch: 'indexMaintenance' },
  { pattern: /^unified-mpc index status(?:\s|$)/, kind: 'index-status', dispatch: 'canonicalStatus' },
  { pattern: /^unified-mpc index job list(?:\s|$)/, kind: 'index-job-list', dispatch: 'indexJobList' },
  { pattern: /^unified-mpc index space(?:\s|$)/, kind: 'index-space', dispatch: 'canonicalLogicalSpace' },
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
    storageRecover: async (): Promise<StorageRecoveryResult> => {
      calls.push('storageRecover');
      return {
        status: 'not_needed',
        sourcePath: null,
        destinationPath: '/tmp/documented/unified-mpc.sqlite',
        canonicalBackupId: null,
        sourceBackupId: null,
        migratedBackupId: null,
        provenancePath: null,
      };
    },
    storageMetrics: async (): Promise<SqlitePhysicalMetrics> => {
      calls.push('storageMetrics');
      return {
        measuredAt: '2026-11-04T00:00:00.000Z',
        inMemory: false,
        databasePath: '/tmp/documented/unified-mpc.sqlite',
        databaseBytes: 8192,
        walBytes: 0,
        shmBytes: 0,
        pageSizeBytes: 4096,
        pageCount: 2,
        freelistCount: 0,
        freelistBytes: 0,
        liveBytes: 8192,
        freelistRatio: 0,
        checkpoint: { mode: 'passive', busy: false, walPages: 0, checkpointedPages: 0, truncated: false },
        compactionRecommended: false,
        compactionReason: null,
      };
    },
    indexRevisionAdvance: async (): Promise<GitRevisionAdvanceResult> => {
      calls.push('indexRevisionAdvance');
      return {
        status: 'noop',
        repositoryId: 'repo:v1:documented',
        targetRef: 'refs/remotes/origin/main',
        commitSha: '0'.repeat(40),
        gitTreeOid: '0'.repeat(40),
        unifiedTreeOid: '0'.repeat(64),
        revisionId: 'rev:v1:documented',
        manifestId: 'man:v1:documented',
        reuse: { reusedPaths: [], newPaths: [], renamedPaths: [], deletedPaths: [] },
        artifacts: { status: 'registered', registered: 0, reused: 0, unclassified: [] },
      };
    },
    canonicalStatus: async (): Promise<CanonicalStatusReport> => {
      calls.push('canonicalStatus');
      return {
        status: 'healthy',
        refs: [{
          ref: 'refs/remotes/origin/main',
          manifestId: 'man:v1:documented',
          commitSha: '0'.repeat(40),
          treeOid: '0'.repeat(40),
          manifestCreatedAt: '1970-01-01T00:00:00.000Z',
          manifestEntryCount: 0,
          manifestExists: true,
          pinned: false,
          pinReasons: [],
        }],
        overlays: [],
        jobs: [],
        manifestCount: 1,
        pinCount: 0,
        refCount: 1,
        overlayCount: 0,
        quarantinedCount: 0,
        activeJobCount: 0,
        danglingRefs: [],
        missingOverlayBases: [],
        orphanedPins: [],
        danglingRefCount: 0,
        missingOverlayBaseCount: 0,
        orphanedPinCount: 0,
      };
    },
    indexJobList: async (): Promise<ThaiRagIndexJobListing> => {
      calls.push('indexJobList');
      return { jobs: [], totalRowCount: 0, matchingRowCount: 0, legacyRowCount: 0 };
    },
    canonicalLogicalSpace: async (): Promise<LogicalSpaceReport> => {
      calls.push('canonicalLogicalSpace');
      return {
        status: 'measured',
        manifests: {
          total: 1,
          retained: 1,
          prunable: 0,
          retainedManifestIds: ['man:v1:documented'],
          prunableManifestIds: [],
        },
        artifacts: {
          total: 1,
          reachable: 1,
          unreferenced: 0,
          unreferencedHashes: [],
          bytesMeasurable: false,
          reachableBytes: null,
          unreferencedBytes: null,
        },
      };
    },
    canonicalRevisionList: async (): Promise<CanonicalRevisionListReport> => {
      calls.push('canonicalRevisionList');
      return {
        revisions: [{
          manifestId: `man:v1:${'0'.repeat(64)}`,
          repositoryId: 'repo:v1:documented',
          revisionId: `rev:v1:${'0'.repeat(64)}`,
          commitSha: '0'.repeat(40),
          treeOid: '0'.repeat(40),
          targetRef: 'refs/remotes/origin/main',
          entryCount: 695,
          createdAt: '2026-10-17T00:00:00.000Z',
          refs: ['refs/remotes/origin/main'],
          pins: [],
          overlayGoalIds: [],
          indexJobOperationIds: [],
        }],
        total: 1,
      };
    },
    canonicalRevisionPin: async (input): Promise<CanonicalRevisionPinReport> => {
      calls.push('canonicalRevisionPin');
      return {
        manifestId: input.manifestId,
        action: input.action === 'pin' ? 'pinned' : 'unpinned',
        pins: input.action === 'pin' ? ['user-pin'] : [],
      };
    },
    indexRevisionPrune: async (): Promise<RevisionPruneReport> => {
      calls.push('indexRevisionPrune');
      return {
        status: 'planned',
        pruneable: [`man:v1:${'1'.repeat(64)}`],
        removed: [],
        retained: [{ manifestId: `man:v1:${'0'.repeat(64)}`, reason: 'canonical-ref' }],
      };
    },
    indexRepair: async (): Promise<CanonicalStoreRepairReport> => {
      calls.push('indexRepair');
      return {
        status: 'planned',
        orphanPins: [{ manifestId: `man:v1:${'1'.repeat(64)}`, reasons: ['user-pin'] }],
        danglingRefs: [],
        missingOverlayBases: [],
      };
    },
    indexGc: async (): Promise<GcCycleReport> => {
      calls.push('indexGc');
      return {
        status: 'planned',
        reachable: ['0'.repeat(64)],
        unreachable: ['1'.repeat(64)],
        unreachableArtifacts: [{ repositoryId: 'repo:v1:documented', artifactKey: `file:v1:${'2'.repeat(64)}` }],
        quarantined: [],
        quarantinedArtifacts: [],
      };
    },
    indexMaintenance: async (): Promise<MaintenanceCycleReport> => {
      calls.push('indexMaintenance');
      return { status: 'skipped', reason: 'below-threshold', tookFence: true, tookAdmission: false };
    },
    indexGcExpire: async (): Promise<GcExpireReport> => {
      calls.push('indexGcExpire');
      return {
        status: 'planned',
        expired: [`${'3'.repeat(64)}`, { kind: 'artifact-key', repositoryId: 'repo:v1:documented', artifactKey: `file:v1:${'4'.repeat(64)}` }],
        deleted: [],
        retained: [`${'5'.repeat(64)}`],
      };
    },
    indexGcStatus: async (): Promise<GcStatusReport> => {
      calls.push('indexGcStatus');
      return {
        status: 'healthy',
        lease: { status: 'free' },
        quarantine: {
          total: 2,
          due: 1,
          inGrace: 1,
          rows: [
            { target: `${'4'.repeat(64)}`, quarantinedAt: '2026-11-04T00:00:00.000Z', graceMs: 604_800_000, expiresAt: '2026-11-11T00:00:00.000Z', due: true },
            {
              target: { kind: 'artifact-key', repositoryId: 'repo:v1:documented', artifactKey: `file:v1:${'9'.repeat(64)}` },
              quarantinedAt: '2026-11-04T00:00:00.000Z',
              graceMs: 604_800_000,
              expiresAt: '2026-11-11T00:00:00.000Z',
              due: false,
            },
          ],
        },
      };
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

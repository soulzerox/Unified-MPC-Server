import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

import { extractStructuralRecords } from './structural-extractor.js';
import { STRUCTURAL_SOURCE_EXTENSION } from './structural-source-pattern.js';
import type { StructuralGeneration, StructuralRecordStore } from './structural-record-store.js';

/**
 * #131 slice 6: the one call that turns a checked-out tree into a stored generation.
 *
 * Slices 1 and 2 were tested separately — the extractor as a pure function, the store
 * with synthetic records — so nothing proved they compose, and nothing in the repo
 * could produce the generation every consumer needs. This is only the glue: extract the
 * admitted files, then write them under one canonical identity, which is the durable
 * unit the store already defines.
 *
 * `buildStructuralGeneration` is not a filesystem walker: `files` is the caller's
 * discovery result, so that function stays free of ignore rules and worktree policy. The
 * worktree policy lives in `indexStructuralWorkspace` below, which is the composite that
 * discovers files from Git and refuses a checkout that is not the identity it would be
 * stored under. Neither is incremental — the store is identity-addressed and immutable,
 * so one generation is one full extraction, and a partial update would need a new
 * identity, not a merge.
 *
 * Paths are not deduplicated here. The extractor admits a path by its repo-relative
 * form, so `./a.ts` and `a.ts` are one file and contribute one record; a raw-string
 * check here would refuse a pair the extractor already understands, and refusing
 * nothing is better than a rule that disagrees with the reader.
 */
export interface BuildStructuralGenerationInput {
  readonly store: StructuralRecordStore;
  readonly identity: CanonicalSourceIdentity;
  /** Repository root the repo-relative `files` are read from. */
  readonly repositoryRoot: string;
  /** Repo-relative paths; the caller owns discovery and ordering. */
  readonly files: readonly string[];
}

export async function buildStructuralGeneration(
  input: BuildStructuralGenerationInput,
): Promise<Result<StructuralGeneration>> {
  if (!Array.isArray(input.files)) {
    return err(appError('INVALID_INPUT', 'a structural generation needs a list of files'));
  }
  // An empty generation would state "this tree has no code" as evidence, and the store
  // could never correct it: the identity is immutable and a rewrite is refused.
  if (input.files.length === 0) {
    return err(appError('INVALID_INPUT', 'a structural generation needs at least one file'));
  }
  for (const file of input.files) {
    if (typeof file !== 'string' || file.length === 0) {
      return err(appError('INVALID_INPUT', 'every structural generation path must be a non-empty string'));
    }
  }

  const records = await extractStructuralRecords({
    repositoryRoot: input.repositoryRoot,
    identity: input.identity,
    files: input.files,
  });
  if (!records.ok) return records;
  return input.store.writeGeneration({ identity: input.identity, records: records.value });
}

/** Lists repository files; injected so discovery is testable without a Git binary. */
export type StructuralFileLister = (repositoryRoot: string) => Promise<Result<readonly string[]>>;

export interface DiscoverStructuralFilesInput {
  readonly repositoryRoot: string;
  /** Defaults to `git ls-files -z --cached`. */
  readonly listFiles?: StructuralFileLister;
}

/**
 * The source files a generation should carry.
 *
 * `git ls-files --cached` is the authority: the index is what the canonical identity's
 * commit and tree describe, so re-implementing `.gitignore` for one subsystem is how two
 * answers to "which files exist" start.
 *
 * Uncommitted files are deliberately not evidence. A record written for a file that only
 * exists in one developer's worktree would be attributed to a commit that never carried
 * it, and the store cannot correct an immutable generation. Commit the file, then index.
 *
 * An empty result is an answer, not an error: a tree with no source files has no
 * structural evidence, and the composite `indexStructuralWorkspace` refuses to store
 * that as a generation.
 */
export async function discoverStructuralFiles(
  input: DiscoverStructuralFilesInput,
): Promise<Result<readonly string[]>> {
  const listed = await (input.listFiles ?? gitListedFiles)(input.repositoryRoot);
  if (!listed.ok) return listed;

  // A `Set` collapses one path reached twice, and the default `.sort()` is code-unit
  // order, which is the order every other query documents.
  const sources = new Set<string>();
  for (const file of listed.value) {
    if (typeof file === 'string' && file.length > 0 && STRUCTURAL_SOURCE_EXTENSION.test(file)) {
      sources.add(file);
    }
  }
  return ok([...sources].sort());
}

/** What the checkout says about itself: the commit it is on, its root, and whether it is clean. */
export interface StructuralWorktreeState {
  readonly head: string;
  readonly toplevel: string;
  readonly dirty: boolean;
}

/** Injected so the identity gate is testable without spawning Git. */
export type StructuralWorktreeReader = (repositoryRoot: string) => Promise<Result<StructuralWorktreeState>>;

/** `files` is discovery's output here, so it is omitted from the input rather than ignored. */
export interface IndexStructuralWorkspaceInput extends Omit<BuildStructuralGenerationInput, 'files'> {
  readonly listFiles?: StructuralFileLister;
  /** Defaults to `git rev-parse HEAD`, `git rev-parse --show-toplevel`, `git status --porcelain`. */
  readonly readWorktree?: StructuralWorktreeReader;
}

/**
 * Discovery plus extraction for a whole checkout: the path a caller usually wants.
 *
 * Three refusals make the stored generation attributable to its identity:
 *
 * - the worktree must be clean, because extraction fingerprints bytes on disk and
 *   uncommitted content would be evidence for a tree that never existed;
 * - `HEAD` must be the identity's commit, because a clean checkout of a different
 *   commit would store those bytes under the wrong immutable id;
 * - the root must be the worktree toplevel, because indexing a subdirectory would
 *   record subdirectory-relative paths as if they were repository-relative.
 */
export async function indexStructuralWorkspace(
  input: IndexStructuralWorkspaceInput,
): Promise<Result<StructuralGeneration>> {
  const worktree = await (input.readWorktree ?? gitWorktreeState)(input.repositoryRoot);
  if (!worktree.ok) return worktree;
  if (worktree.value.dirty) {
    return err(appError(
      'INVALID_INPUT',
      'structural indexing needs a clean worktree: uncommitted changes cannot be attributed to the identity',
    ));
  }
  if (worktree.value.head !== input.identity.commit_sha) {
    return err(appError(
      'INVALID_INPUT',
      `structural indexing refused: worktree HEAD ${worktree.value.head} is not the identity commit ${input.identity.commit_sha}`,
    ));
  }
  const root = await realpath(input.repositoryRoot).catch(() => undefined);
  if (root === undefined || root !== worktree.value.toplevel) {
    return err(appError(
      'INVALID_INPUT',
      'structural indexing needs the worktree toplevel as repositoryRoot',
    ));
  }

  const discovered = await discoverStructuralFiles({
    repositoryRoot: input.repositoryRoot,
    ...(input.listFiles === undefined ? {} : { listFiles: input.listFiles }),
  });
  if (!discovered.ok) return discovered;
  if (discovered.value.length === 0) {
    return err(appError('INVALID_INPUT', 'structural discovery found no source files under the repository root'));
  }
  return buildStructuralGeneration({ ...input, files: discovered.value });
}

async function gitWorktreeState(repositoryRoot: string): Promise<Result<StructuralWorktreeState>> {
  const head = await gitText(repositoryRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) return head;
  const toplevel = await gitText(repositoryRoot, ['rev-parse', '--show-toplevel']);
  if (!toplevel.ok) return toplevel;
  const status = await gitText(repositoryRoot, ['status', '--porcelain', '--ignore-submodules']);
  if (!status.ok) return status;
  const resolvedRoot = await realpath(toplevel.value).catch(() => toplevel.value);
  return ok({ head: head.value, toplevel: resolvedRoot, dirty: status.value.trim().length > 0 });
}

function gitText(repositoryRoot: string, args: readonly string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        if (error !== null) {
          resolve(err(appError('INVALID_INPUT', `structural indexing refused ${repositoryRoot}: ${error.message}`)));
          return;
        }
        resolve(ok(stdout.trim()));
      },
    );
  });
}

function gitListedFiles(repositoryRoot: string): Promise<Result<readonly string[]>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached'],
      { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        if (error !== null) {
          resolve(err(appError('INVALID_INPUT', `structural discovery refused ${repositoryRoot}: ${error.message}`)));
          return;
        }
        resolve(ok(stdout.split('\0').filter((file) => file.length > 0)));
      },
    );
  });
}

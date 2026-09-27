import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { DirectGitRunner, type GitRunOptions, type GitRunResult, type GitRunner } from './git-runner.js';
import { parsePorcelainStatus, type GitStatusEntry } from './parsers/status-parser.js';

export interface GitStatusResult {
  readonly entries: readonly GitStatusEntry[];
}

export interface GitWorkspaceSnapshot {
  readonly repositoryIdentity: string;
  readonly gitCommonDirIdentity: string;
  readonly worktreeIdentity: string;
  readonly branch: string | null;
  readonly head: string;
  readonly statusEntries: readonly GitStatusEntry[];
  readonly stagedFingerprint: string;
  readonly dirtyFingerprint: string;
  readonly baseRef?: string;
  readonly resolvedBaseRef?: string;
  readonly baseSha?: string;
  readonly mergeBaseSha?: string;
  readonly remoteGoalRef?: string;
  readonly resolvedRemoteGoalRef?: string;
  readonly remoteGoalSha?: string;
}

export interface GitWorkspaceSnapshotOptions {
  readonly baseRef?: string;
  readonly resolvedBaseRef?: string;
  readonly remoteGoalRef?: string;
  readonly resolvedRemoteGoalRef?: string;
  readonly excludedPathSegments?: readonly string[];
}

export interface GitDiffRequest {
  readonly path?: string;
  readonly staged?: boolean;
  readonly maxBytes?: number;
}

export interface GitDiffResult {
  readonly patch: string;
  readonly truncated: boolean;
}

export interface GitLogRequest {
  readonly maxCommits?: number;
  readonly maxBytes?: number;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitLogResult {
  readonly entries: readonly GitLogEntry[];
  readonly truncated: boolean;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitGuardedRebaseRequest {
  readonly expectedBranch: string;
  readonly oldHead: string;
  readonly oldBaseSha: string;
  readonly newBaseSha: string;
  readonly recoveryRef: string;
}

export type GitGuardedRebaseResult =
  | { readonly status: 'completed'; readonly newHead: string }
  | {
      readonly status: 'conflict' | 'failed';
      readonly conflictedPaths: readonly string[];
      readonly abortSucceeded: boolean;
      readonly headAfterAbort?: string;
      readonly cleanAfterAbort?: boolean;
      readonly reason?: string;
    };

const MAX_GIT_ARGS = 128;
const MAX_GIT_ARG_LENGTH = 32_768;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_TIMEOUT_MS = 300_000;
const MAX_WORKSPACE_STATUS_BYTES = 1024 * 1024;
const MAX_WORKSPACE_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 256;
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_GENERATED_SEGMENTS = ['.cache', '.next', '.turbo', 'coverage', 'dist', 'node_modules', 'vendor'];

export class GitAdapter {
  public constructor(private readonly runner: GitRunner = new DirectGitRunner()) {}

  public async observeWorkspace(
    cwd: string,
    options: GitWorkspaceSnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<Result<GitWorkspaceSnapshot>> {
    const rootResult = await this.runner.run(['rev-parse', '--show-toplevel'], cwd, this.signalOptions(signal));
    const rootError = this.mapError(rootResult);
    if (rootError !== null) return rootError;
    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(rootResult.stdout.trim());
    } catch {
      return err(appError('GIT_NOT_REPOSITORY', 'Git worktree root could not be resolved'));
    }

    const commonResult = await this.runner.run(['rev-parse', '--git-common-dir'], cwd, this.signalOptions(signal));
    const commonError = this.mapError(commonResult);
    if (commonError !== null) return commonError;
    let commonDirectory: string;
    try {
      commonDirectory = await realpath(path.resolve(workspaceRoot, commonResult.stdout.trim()));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Git common directory could not be resolved', true));
    }

    const headResult = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
    const headError = this.mapError(headResult);
    if (headError !== null) return headError;
    const head = headResult.stdout.trim().toLowerCase();
    if (!isCommitSha(head)) return err(appError('INTERNAL_ERROR', 'Git HEAD did not resolve to a commit', true));

    const branchResult = await this.runner.run(['branch', '--show-current'], cwd, this.signalOptions(signal));
    const branchError = this.mapError(branchResult);
    if (branchError !== null) return branchError;
    const branch = branchResult.stdout.trim() || null;

    const statusResult = await this.runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, this.signalOptions(signal),
    );
    const statusError = this.mapError(statusResult);
    if (statusError !== null) return statusError;
    if (Buffer.byteLength(statusResult.stdout, 'utf8') > MAX_WORKSPACE_STATUS_BYTES) {
      return err(appError('INVALID_INPUT', 'Git workspace status exceeds the admission scan limit'));
    }
    const customExcluded = options.excludedPathSegments ?? [];
    if (customExcluded.length > 64 || customExcluded.some((segment) => segment.length > 128
      || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
      return err(appError('INVALID_INPUT', 'Generated-path exclusions must be plain path segments'));
    }
    const excluded = new Set([...DEFAULT_GENERATED_SEGMENTS, ...customExcluded]);
    const entries = parsePorcelainStatus(statusResult.stdout).filter((entry) => !isExcludedPath(entry.path, excluded));
    if (entries.filter((entry) => entry.kind === 'untracked').length > MAX_UNTRACKED_FILES) {
      return err(appError('INVALID_INPUT', 'Git workspace has too many untracked files for admission'));
    }

    const diffPathspecs = [...excluded].flatMap((segment) => [
      `:(exclude,glob)${segment}/**`,
      `:(exclude,glob)**/${segment}/**`,
    ]);
    const stagedResult = await this.runner.run(
      ['diff', '--cached', '--binary', '--no-ext-diff', '--', '.', ...diffPathspecs], cwd, this.signalOptions(signal),
    );
    const stagedError = this.mapError(stagedResult);
    if (stagedError !== null) return stagedError;
    const unstagedResult = await this.runner.run(
      ['diff', '--binary', '--no-ext-diff', '--', '.', ...diffPathspecs], cwd, this.signalOptions(signal),
    );
    const unstagedError = this.mapError(unstagedResult);
    if (unstagedError !== null) return unstagedError;
    if (Buffer.byteLength(stagedResult.stdout, 'utf8') > MAX_WORKSPACE_DIFF_BYTES
      || Buffer.byteLength(unstagedResult.stdout, 'utf8') > MAX_WORKSPACE_DIFF_BYTES) {
      return err(appError('INVALID_INPUT', 'Git workspace diff exceeds the admission scan limit'));
    }

    const stagedFingerprint = sha256(stagedResult.stdout);
    const dirtyHash = createHash('sha256');
    dirtyHash.update(statusEntriesFingerprint(entries));
    dirtyHash.update(stagedResult.stdout);
    dirtyHash.update(unstagedResult.stdout);
    let untrackedBytes = 0;
    for (const entry of entries) {
      if (entry.kind !== 'untracked') continue;
      const filePath = path.resolve(workspaceRoot, entry.path);
      const relativePath = path.relative(workspaceRoot, filePath);
      if (escapesRoot(relativePath)) {
        return err(appError('PERMISSION_DENIED', 'Untracked admission path escapes the Git worktree'));
      }
      try {
        const before = await lstat(filePath);
        if (!before.isFile() || before.size > MAX_UNTRACKED_FILE_BYTES) {
          return err(appError('INVALID_INPUT', 'Untracked admission path is not a bounded regular file'));
        }
        const actualPath = await realpath(filePath);
        const actualRelative = path.relative(workspaceRoot, actualPath);
        if (escapesRoot(actualRelative)) {
          return err(appError('PERMISSION_DENIED', 'Untracked admission path resolves outside the Git worktree'));
        }
        untrackedBytes += before.size;
        if (untrackedBytes > MAX_UNTRACKED_TOTAL_BYTES) {
          return err(appError('INVALID_INPUT', 'Untracked admission content exceeds the scan limit'));
        }
        const contents = await readFile(actualPath);
        const after = await lstat(filePath);
        if (contents.byteLength !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          return err(appError('CONFLICT', 'Untracked workspace state changed during admission scan'));
        }
        dirtyHash.update(relativePath.replaceAll(path.sep, '/'));
        dirtyHash.update('\0');
        dirtyHash.update(contents);
        dirtyHash.update('\0');
      } catch {
        return err(appError('INTERNAL_ERROR', 'Untracked workspace state could not be fingerprinted', true));
      }
    }

    const baseRef = options.resolvedBaseRef ?? options.baseRef;
    const base = baseRef === undefined ? undefined : await this.resolveAdmissionRef(cwd, baseRef, signal);
    if (base !== undefined && !base.ok) return base;
    const mergeBase = base === undefined ? undefined : await this.runner.run(['merge-base', head, baseRef!], cwd, this.signalOptions(signal));
    if (mergeBase !== undefined) {
      const mergeError = this.mapError(mergeBase);
      if (mergeError !== null) return mergeError;
    }
    const remoteGoalRef = options.resolvedRemoteGoalRef ?? options.remoteGoalRef;
    const remoteGoal = remoteGoalRef === undefined ? undefined : await this.resolveAdmissionRef(cwd, remoteGoalRef, signal);
    if (remoteGoal !== undefined && !remoteGoal.ok) return remoteGoal;

    const currentHead = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
    const currentBranch = await this.runner.run(['branch', '--show-current'], cwd, this.signalOptions(signal));
    const currentStatus = await this.runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, this.signalOptions(signal),
    );
    const currentHeadError = this.mapError(currentHead);
    if (currentHeadError !== null) return currentHeadError;
    const currentBranchError = this.mapError(currentBranch);
    if (currentBranchError !== null) return currentBranchError;
    const currentStatusError = this.mapError(currentStatus);
    if (currentStatusError !== null) return currentStatusError;
    if (Buffer.byteLength(currentStatus.stdout, 'utf8') > MAX_WORKSPACE_STATUS_BYTES) {
      return err(appError('CONFLICT', 'Git workspace changed during admission scan'));
    }
    const currentEntries = parsePorcelainStatus(currentStatus.stdout).filter((entry) => !isExcludedPath(entry.path, excluded));
    const currentBase = baseRef === undefined ? undefined : await this.resolveAdmissionRef(cwd, baseRef, signal);
    if (currentBase !== undefined && !currentBase.ok) return currentBase;
    const currentRemoteGoal = remoteGoalRef === undefined ? undefined : await this.resolveAdmissionRef(cwd, remoteGoalRef, signal);
    if (currentRemoteGoal !== undefined && !currentRemoteGoal.ok) return currentRemoteGoal;
    if (currentHead.stdout.trim().toLowerCase() !== head
      || (currentBranch.stdout.trim() || null) !== branch
      || statusEntriesFingerprint(currentEntries) !== statusEntriesFingerprint(entries)
      || (currentBase !== undefined && base?.ok === true && currentBase.value !== base.value)
      || (currentRemoteGoal !== undefined && remoteGoal?.ok === true && currentRemoteGoal.value !== remoteGoal.value)) {
      return err(appError('CONFLICT', 'Git workspace changed during admission scan'));
    }
    const mergeBaseSha = mergeBase?.stdout.trim().toLowerCase();
    if (mergeBaseSha !== undefined && !isCommitSha(mergeBaseSha)) {
      return err(appError('INTERNAL_ERROR', 'Git merge base did not resolve to a commit', true));
    }

    return ok({
      repositoryIdentity: sha256(commonDirectory),
      gitCommonDirIdentity: sha256(commonDirectory),
      worktreeIdentity: sha256(workspaceRoot),
      branch,
      head,
      statusEntries: entries,
      stagedFingerprint,
      dirtyFingerprint: dirtyHash.digest('hex'),
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(baseRef === undefined ? {} : { resolvedBaseRef: baseRef, baseSha: base!.value }),
      ...(mergeBaseSha === undefined ? {} : { mergeBaseSha }),
      ...(options.remoteGoalRef === undefined ? {} : { remoteGoalRef: options.remoteGoalRef }),
      ...(remoteGoalRef === undefined ? {} : { resolvedRemoteGoalRef: remoteGoalRef, remoteGoalSha: remoteGoal!.value }),
    });
  }

  private async resolveAdmissionRef(cwd: string, ref: string, signal?: AbortSignal): Promise<Result<string>> {
    if (!/^refs\/(?:heads|unified-mpc\/admission)\/[A-Za-z0-9._/-]+$/.test(ref)
      || ref.includes('..') || ref.includes('//') || ref.endsWith('/')) {
      return err(appError('INVALID_INPUT', 'Git admission ref is invalid'));
    }
    const result = await this.runner.run(['rev-parse', '--verify', `${ref}^{commit}`], cwd, this.signalOptions(signal));
    const error = this.mapError(result);
    if (error !== null) return error;
    const sha = result.stdout.trim().toLowerCase();
    return isCommitSha(sha) ? ok(sha) : err(appError('INTERNAL_ERROR', 'Git admission ref did not resolve to a commit', true));
  }

  public async refreshRemoteRef(
    cwd: string,
    remote: string,
    sourceRef: string,
    destinationRef: string,
    signal?: AbortSignal,
  ): Promise<Result<string>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)
      || !sourceRef.startsWith('refs/heads/')
      || !destinationRef.startsWith('refs/unified-mpc/admission/')
      || sourceRef.includes('..') || destinationRef.includes('..')
      || sourceRef.includes('//') || destinationRef.includes('//')
      || sourceRef.endsWith('/') || destinationRef.endsWith('/')) {
      return err(appError('INVALID_INPUT', 'Git admission ref is invalid'));
    }
    for (const ref of [sourceRef, destinationRef]) {
      const validRef = await this.runner.run(['check-ref-format', ref], cwd, this.signalOptions(signal));
      if (validRef.exitCode !== 0) return err(appError('INVALID_INPUT', 'Git admission ref is invalid'));
    }

    const fetch = await this.runner.run(
      ['fetch', '--no-tags', '--no-write-fetch-head', remote, `+${sourceRef}:${destinationRef}`],
      cwd,
      this.signalOptions(signal),
    );
    const fetchError = this.mapError(fetch);
    if (fetchError !== null) return fetchError;

    const resolved = await this.runner.run(['rev-parse', '--verify', `${destinationRef}^{commit}`], cwd, this.signalOptions(signal));
    const resolveError = this.mapError(resolved);
    if (resolveError !== null) return resolveError;
    const sha = resolved.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
      return err(appError('INTERNAL_ERROR', 'Git admission ref did not resolve to a commit', true));
    }
    return ok(sha.toLowerCase());
  }

  public async remoteBranchSha(
    cwd: string,
    remote: string,
    branchName: string,
    signal?: AbortSignal,
  ): Promise<Result<string | null>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)
      || branchName.length === 0 || branchName.length > 1024
      || branchName.includes('..') || branchName.includes('//') || branchName.endsWith('/')) {
      return err(appError('INVALID_INPUT', 'Git remote branch is invalid'));
    }
    const ref = `refs/heads/${branchName}`;
    const validRef = await this.runner.run(['check-ref-format', ref], cwd, this.signalOptions(signal));
    if (validRef.exitCode !== 0) return err(appError('INVALID_INPUT', 'Git remote branch is invalid'));

    const safety = await this.validatePushSafety(cwd, remote, signal);
    if (!safety.ok) return safety;

    const pushUrls = await this.runner.run(['remote', 'get-url', '--push', '--all', remote], cwd, this.signalOptions(signal));
    const pushUrlError = this.mapError(pushUrls);
    if (pushUrlError !== null) return pushUrlError;
    const targets = pushUrls.stdout.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
    if (targets.length === 0) return err(appError('CONFLICT', 'Git publication remote could not be resolved', true));

    let observed: string | null = null;
    for (const target of targets) {
      if (!isSupportedRemoteTarget(target)) {
        return err(appError('PERMISSION_DENIED', 'Git publication remote uses an unsupported transport'));
      }
      const remoteBranch = await this.runner.run(['ls-remote', '--heads', target, ref], cwd, this.signalOptions(signal));
      const remoteError = this.mapError(remoteBranch);
      if (remoteError !== null) return remoteError;
      const lines = remoteBranch.stdout.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
      if (lines.length === 0) continue;
      if (lines.length !== 1) return err(appError('CONFLICT', 'Git publication remote returned ambiguous branch state', true));
      const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/(.+)$/i.exec(lines[0] ?? '');
      if (match?.[1] === undefined || match[2] !== branchName) {
        return err(appError('CONFLICT', 'Git publication remote returned unexpected branch state', true));
      }
      const sha = match[1].toLowerCase();
      if (observed !== null && observed !== sha) {
        return err(appError('CONFLICT', 'Git publication remotes disagree on the goal branch head', true));
      }
      observed = sha;
    }
    return ok(observed);
  }

  public async isAncestor(
    cwd: string,
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean>> {
    if (!isCommitSha(ancestorSha) || !isCommitSha(descendantSha)) {
      return err(appError('INVALID_INPUT', 'Git ancestry requires exact commit SHAs'));
    }
    const result = await this.runner.run(
      ['merge-base', '--is-ancestor', ancestorSha.toLowerCase(), descendantSha.toLowerCase()],
      cwd,
      this.signalOptions(signal),
    );
    if (result.exitCode === 0) return ok(true);
    if (result.exitCode === 1) return ok(false);
    const error = this.mapError(result);
    return error ?? err(appError('INTERNAL_ERROR', 'Git ancestry check failed', true));
  }

  public async createRecoveryRef(
    cwd: string,
    recoveryRef: string,
    expectedHead: string,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    if (!/^refs\/unified-mpc\/recovery\/rebase\/[A-Za-z0-9._-]{1,128}$/.test(recoveryRef)
      || !isCommitSha(expectedHead)) {
      return err(appError('INVALID_INPUT', 'Git rebase recovery reference is invalid'));
    }
    const validRef = await this.runner.run(['check-ref-format', recoveryRef], cwd, this.signalOptions(signal));
    if (validRef.exitCode !== 0) return err(appError('INVALID_INPUT', 'Git rebase recovery reference is invalid'));
    const head = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
    const headError = this.mapError(head);
    if (headError !== null) return headError;
    if (head.stdout.trim().toLowerCase() !== expectedHead.toLowerCase()) {
      return err(appError('CONFLICT', 'Git HEAD changed before the recovery checkpoint could be created', true));
    }
    const update = await this.runner.run(
      ['update-ref', recoveryRef, expectedHead.toLowerCase(), '0'.repeat(expectedHead.length)],
      cwd,
      this.signalOptions(signal),
    );
    const updateError = this.mapError(update);
    return updateError ?? ok(undefined);
  }

  public async guardedRebase(
    cwd: string,
    request: GitGuardedRebaseRequest,
    signal?: AbortSignal,
  ): Promise<Result<GitGuardedRebaseResult>> {
    if (request.expectedBranch.length === 0 || request.expectedBranch.length > 1024
      || !isCommitSha(request.oldHead) || !isCommitSha(request.oldBaseSha) || !isCommitSha(request.newBaseSha)
      || !/^refs\/unified-mpc\/recovery\/rebase\/[A-Za-z0-9._-]{1,128}$/.test(request.recoveryRef)) {
      return err(appError('INVALID_INPUT', 'Guarded rebase request is invalid'));
    }
    const executableConfig = await this.runner.run(
      ['config', '--get-regexp', '^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process)|core\\.(attributesFile|fsmonitor)|sequence\\.editor|core\\.editor|gpg\\..*\\.program|commit\\.gpgSign)$'],
      cwd,
      this.signalOptions(signal),
    );
    if (executableConfig.exitCode === 0) {
      return err(appError('PERMISSION_DENIED', 'Guarded rebase cannot run with executable Git transformation configuration'));
    }
    if (executableConfig.exitCode !== 1) {
      const configError = this.mapError(executableConfig);
      if (configError !== null) return configError;
    }

    const branch = await this.runner.run(['branch', '--show-current'], cwd, this.signalOptions(signal));
    const branchError = this.mapError(branch);
    if (branchError !== null) return branchError;
    const head = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
    const headError = this.mapError(head);
    if (headError !== null) return headError;
    const status = await this.runner.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, this.signalOptions(signal));
    const statusError = this.mapError(status);
    if (statusError !== null) return statusError;
    const recovery = await this.runner.run(['rev-parse', '--verify', `${request.recoveryRef}^{commit}`], cwd, this.signalOptions(signal));
    const recoveryError = this.mapError(recovery);
    if (recoveryError !== null) return recoveryError;
    if (branch.stdout.trim() !== request.expectedBranch
      || head.stdout.trim().toLowerCase() !== request.oldHead.toLowerCase()
      || status.stdout.length !== 0
      || recovery.stdout.trim().toLowerCase() !== request.oldHead.toLowerCase()) {
      return err(appError('CONFLICT', 'Workspace changed after guarded rebase admission', true));
    }

    const safeConfig = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      '-c', 'submodule.recurse=false',
    ];
    const rebase = await this.runner.run(
      [...safeConfig, 'rebase', '--no-autostash', '--onto', request.newBaseSha.toLowerCase(), request.oldBaseSha.toLowerCase()],
      cwd,
      this.signalOptions(signal),
    );
    if (rebase.exitCode === 0) {
      const newHead = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
      const newHeadError = this.mapError(newHead);
      if (newHeadError !== null) return newHeadError;
      const clean = await this.runner.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, this.signalOptions(signal));
      const cleanError = this.mapError(clean);
      if (cleanError !== null) return cleanError;
      const resolvedHead = newHead.stdout.trim().toLowerCase();
      if (!isCommitSha(resolvedHead) || clean.stdout.length !== 0) {
        return err(appError('CONFLICT', 'Guarded rebase completed without a clean exact HEAD', true));
      }
      return ok({ status: 'completed', newHead: resolvedHead });
    }

    const unmerged = await this.runner.run(
      ['diff', '--name-only', '--diff-filter=U', '-z', '--'],
      cwd,
      this.signalOptions(signal),
    );
    const conflictedPaths = unmerged.exitCode === 0
      ? unmerged.stdout.split('\0').filter((value) => value.length > 0).slice(0, 100)
      : [];
    const abort = await this.runner.run([...safeConfig, 'rebase', '--abort'], cwd, this.signalOptions(signal));
    const abortSucceeded = abort.exitCode === 0;
    let headAfterAbort: string | undefined;
    let cleanAfterAbort: boolean | undefined;
    if (abortSucceeded) {
      const restoredHead = await this.runner.run(['rev-parse', '--verify', 'HEAD^{commit}'], cwd, this.signalOptions(signal));
      const restoredStatus = await this.runner.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, this.signalOptions(signal));
      if (restoredHead.exitCode === 0 && isCommitSha(restoredHead.stdout.trim())) {
        headAfterAbort = restoredHead.stdout.trim().toLowerCase();
      }
      if (restoredStatus.exitCode === 0) cleanAfterAbort = restoredStatus.stdout.length === 0;
    }
    return ok({
      status: conflictedPaths.length > 0 ? 'conflict' : 'failed',
      conflictedPaths,
      abortSucceeded,
      ...(headAfterAbort === undefined ? {} : { headAfterAbort }),
      ...(cleanAfterAbort === undefined ? {} : { cleanAfterAbort }),
      reason: conflictedPaths.length > 0 ? 'rebase_conflict' : 'rebase_failed',
    });
  }

  public async status(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>> {
    const result = await this.runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd,
      this.signalOptions(signal),
    );
    const error = this.mapError(result);
    if (error !== null) return error;
    return ok({ entries: parsePorcelainStatus(result.stdout) });
  }

  public async branch(cwd: string): Promise<Result<string | null>> {
    const result = await this.runner.run(['branch', '--show-current'], cwd);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return ok(result.stdout.trim());
    }
    const revResult = await this.runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (revResult.exitCode === 0) {
      const name = revResult.stdout.trim();
      return ok(name === 'HEAD' || name.length === 0 ? null : name);
    }
    const error = this.mapError(result);
    if (error !== null) return error;
    return ok(null);
  }

  public async defaultBranch(cwd: string, remote = 'origin'): Promise<Result<string | null>> {
    const branches = await this.defaultBranches(cwd, remote);
    return branches.ok ? ok(branches.value[0] ?? null) : branches;
  }

  public async defaultBranches(cwd: string, remote = 'origin'): Promise<Result<readonly string[]>> {
    const pushUrls = await this.runner.run(['remote', 'get-url', '--push', '--all', remote], cwd);
    if (pushUrls.exitCode !== 0) return ok([]);
    const targets = pushUrls.stdout.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
    if (targets.length === 0) return ok([]);
    const branches: string[] = [];
    for (const target of targets) {
      if (!isSupportedRemoteTarget(target)) return ok([]);
      const remoteHead = await this.runner.run(['ls-remote', '--symref', target, 'HEAD'], cwd);
      if (remoteHead.exitCode !== 0) return ok([]);
      const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD\s*$/im.exec(remoteHead.stdout);
      if (match?.[1] === undefined) return ok([]);
      branches.push(match[1]);
    }
    return ok(branches);
  }

  public async validatePushSafety(cwd: string, remote: string, signal?: AbortSignal): Promise<Result<void>> {
    const executableEnvironmentKeys = [
      'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH',
    ];
    if (executableEnvironmentKeys.some((key) => (process.env[key] ?? '').trim().length > 0)) {
      return err(appError('PERMISSION_DENIED', 'Git push cannot use executable transport or credential environment overrides'));
    }
    const executableConfigKeys = [
      `remote.${remote}.receivepack`,
      `remote.${remote}.uploadpack`,
      `remote.${remote}.proxy`,
      `remote.${remote}.vcs`,
      'core.sshCommand',
      'core.askPass',
      'core.gitProxy',
      'credential.helper',
      'push.gpgSign',
      'push.recurseSubmodules',
      'submodule.recurse',
      'protocol.allow',
    ];
    for (const key of executableConfigKeys) {
      const configured = await this.runner.run(['config', '--get-all', key], cwd, this.signalOptions(signal));
      if (configured.exitCode === 0) return err(appError('PERMISSION_DENIED', 'Git push cannot use configured executable transport or credential helpers'));
      if (configured.exitCode !== 1) {
        const error = this.mapError(configured);
        if (error !== null) return error;
      }
    }
    const protocolAllow = await this.runner.run(['config', '--get-regexp', '^protocol\\..*\\.allow$'], cwd, this.signalOptions(signal));
    if (protocolAllow.exitCode === 0) return err(appError('PERMISSION_DENIED', 'Git push cannot enable external transport protocols'));
    if (protocolAllow.exitCode !== 1) {
      const error = this.mapError(protocolAllow);
      if (error !== null) return error;
    }
    const credentialHelpers = await this.runner.run(['config', '--get-regexp', '^credential(\\..+)?\\.helper$'], cwd, this.signalOptions(signal));
    if (credentialHelpers.exitCode === 0) return err(appError('PERMISSION_DENIED', 'Git push cannot use configured credential helpers'));
    if (credentialHelpers.exitCode !== 1) {
      const error = this.mapError(credentialHelpers);
      if (error !== null) return error;
    }
    const signingPrograms = await this.runner.run(['config', '--get-regexp', '^gpg(\\..+)?\\.program$'], cwd, this.signalOptions(signal));
    if (signingPrograms.exitCode === 0) return err(appError('PERMISSION_DENIED', 'Git push cannot use configured signing programs'));
    if (signingPrograms.exitCode !== 1) {
      const error = this.mapError(signingPrograms);
      if (error !== null) return error;
    }

    const hooks = await this.runner.run(['rev-parse', '--git-path', 'hooks'], cwd, this.signalOptions(signal));
    const hooksError = this.mapError(hooks);
    if (hooksError !== null) return hooksError;
    const hooksPath = hooks.stdout.trim();
    if (hooksPath.length === 0) return err(appError('PERMISSION_DENIED', 'Git push hook location could not be resolved safely'));
    try {
      const hook = await stat(path.join(path.resolve(cwd, hooksPath), 'pre-push'));
      if (hook.isFile()) return err(appError('PERMISSION_DENIED', 'Git push cannot run a configured pre-push hook'));
    } catch (error: unknown) {
      if (!isMissingFile(error)) return err(appError('INTERNAL_ERROR', 'Git push hook safety could not be verified', true));
    }
    return ok(undefined);
  }

  public async diff(cwd: string, request: GitDiffRequest = {}, signal?: AbortSignal): Promise<Result<GitDiffResult>> {
    const maxBytes = request.maxBytes ?? 1024 * 1024;
    if (!this.isLimit(maxBytes, 4 * 1024 * 1024)) return err(appError('INVALID_INPUT', 'Git diff byte limit is invalid'));
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (request.staged === true) args.push('--cached');
    args.push('--');
    if (request.path !== undefined) args.push(request.path);
    const result = await this.runner.run(args, cwd, this.signalOptions(signal));
    const error = this.mapError(result);
    if (error !== null) return error;
    const bounded = this.bound(result.stdout, maxBytes);
    return ok({ patch: bounded.text, truncated: bounded.truncated });
  }

  public async log(cwd: string, request: GitLogRequest = {}, signal?: AbortSignal): Promise<Result<GitLogResult>> {
    const maxCommits = request.maxCommits ?? 20;
    const maxBytes = request.maxBytes ?? 1024 * 1024;
    if (!this.isLimit(maxCommits, 100) || !this.isLimit(maxBytes, 4 * 1024 * 1024)) {
      return err(appError('INVALID_INPUT', 'Git log limit is invalid'));
    }
    const args = ['log', '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '-n', String(maxCommits), '--'];
    const result = await this.runner.run(args, cwd, this.signalOptions(signal));
    const error = this.mapError(result);
    if (error !== null) return error;
    const bounded = this.bound(result.stdout, maxBytes);
    const entries = bounded.text.split('\u001e').flatMap((record) => {
      const fields = record.split('\u001f');
      return fields.length === 4 && fields.every((field) => field.length > 0)
        ? [{ hash: fields[0] ?? '', author: fields[1] ?? '', date: fields[2] ?? '', subject: fields[3] ?? '' }]
        : [];
    });
    return ok({ entries, truncated: bounded.truncated });
  }

  public async run(
    cwd: string,
    args: readonly string[],
    timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<Result<GitCommandResult>> {
    const validation = this.validateArgs(args, timeoutMs);
    if (!validation.ok) return validation;
    const result = await this.runner.run(args, cwd, {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode === -1 && /ENOENT/i.test(result.stderr)) {
      return err(appError('EXECUTABLE_NOT_FOUND', 'Git executable was not found'));
    }
    return ok({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }

  private validateArgs(args: readonly string[], timeoutMs: number): Result<void> {
    if (!Array.isArray(args) || args.length === 0 || args.length > MAX_GIT_ARGS) {
      return err(appError('INVALID_INPUT', 'Git args must be a non-empty array'));
    }
    if (!args.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_GIT_ARG_LENGTH)) {
      return err(appError('INVALID_INPUT', 'Git args must be non-empty strings'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_GIT_TIMEOUT_MS) {
      return err(appError('INVALID_INPUT', 'Git timeout is invalid'));
    }
    return ok(undefined);
  }

  private signalOptions(signal: AbortSignal | undefined): GitRunOptions | undefined {
    return signal === undefined ? undefined : { signal };
  }

  private mapError(result: GitRunResult): Result<never> | null {
    if (result.exitCode === 0) return null;
    if (result.exitCode === 128 && /not a git repository/i.test(result.stderr)) {
      return err(appError('GIT_NOT_REPOSITORY', 'Workspace is not a Git repository'));
    }
    if (result.exitCode === -1 && /ENOENT/i.test(result.stderr)) {
      return err(appError('EXECUTABLE_NOT_FOUND', 'Git executable was not found'));
    }
    return err(appError('INTERNAL_ERROR', 'Git command failed', true));
  }

  private isLimit(value: number, maximum: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= maximum;
  }

  private bound(value: string, maxBytes: number): { text: string; truncated: boolean } {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
    return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isSupportedRemoteTarget(target: string): boolean {
  if (/^[a-z][a-z0-9+.-]*::/i.test(target)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase();
  return scheme === undefined || ['file', 'git', 'git+ssh', 'http', 'https', 'ssh'].includes(scheme);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isCommitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function statusEntriesFingerprint(entries: readonly GitStatusEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.path, entry.oldPath ?? '', entry.kind, entry.indexStatus, entry.worktreeStatus]));
}

function isExcludedPath(filePath: string, excludedSegments: ReadonlySet<string>): boolean {
  return filePath.split(/[\\/]/).some((segment) => excludedSegments.has(segment));
}

function escapesRoot(relativePath: string): boolean {
  return path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

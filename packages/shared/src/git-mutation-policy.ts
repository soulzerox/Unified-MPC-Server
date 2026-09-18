const ALWAYS_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'column',
  'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree',
  'for-each-ref', 'fsck', 'grep', 'help', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge-base', 'name-rev', 'rev-list', 'rev-parse', 'show',
  'show-branch', 'show-ref', 'status', 'verify-commit', 'verify-pack',
  'verify-tag', 'whatchanged',
]);

const AGENT_ALLOWED_GIT_SUBCOMMANDS = new Set([
  ...ALWAYS_READ_ONLY_GIT_SUBCOMMANDS,
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'commit',
  'config', 'fetch', 'gc', 'init', 'merge', 'mv', 'pull', 'push', 'rebase',
  'remote', 'reset', 'restore', 'revert', 'rm', 'clean', 'stash', 'switch', 'symbolic-ref',
  'tag', 'worktree',
]);

/** A deliberately small contract shared by the MCP gateway and Git backend. */
export function isProvablyReadOnlyGitInvocation(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0]!.toLowerCase();
  if (first.startsWith('-')) return args.length === 1 && (first === '--help' || first === '--version');
  const rest = args.slice(1);
  if (containsBroadPathspecMagic(rest)) return false;

  if (ALWAYS_READ_ONLY_GIT_SUBCOMMANDS.has(first)) return true;
  if (first === 'branch') return isReadOnlyBranch(rest);
  if (first === 'config') return isReadOnlyConfig(rest);
  if (first === 'remote') return rest.length === 0 || ['-v', '--verbose', 'get-url', 'show'].includes(rest[0]!.toLowerCase());
  if (first === 'reflog') return rest.length === 0 || ['show', 'exists'].includes(rest[0]!.toLowerCase());
  if (first === 'stash') return rest.length > 0 && ['list', 'show'].includes(rest[0]!.toLowerCase());
  if (first === 'symbolic-ref') return isReadOnlySymbolicRef(rest);
  if (first === 'tag') return isReadOnlyTag(rest);
  return false;
}

/**
 * Hard blocks only Git forms that escape the scoped cwd, inject aliases, or use
 * mutation shapes that the action-level policy cannot safely classify. Known
 * workspace delete/reset/restore families are handled by the destructive policy
 * so Full Access can ask or auto-approve them according to user settings.
 */
export interface GitMutationPolicyOptions {
  readonly defaultBranch?: string;
}

export interface GitPushArguments {
  readonly remote?: string;
  readonly refspecs: readonly string[];
  readonly invalidOption?: string;
}

const GIT_PUSH_OPTIONS_WITH_VALUES = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo', '--recurse-submodules']);
const GIT_PUSH_OPTIONS = new Set([
  '--all', '--atomic', '--delete', '--dry-run', '--exec', '--follow-tags', '--force', '--force-if-includes', '--force-with-lease',
  '--ipv4', '--ipv6', '--mirror', '--no-follow-tags', '--no-force-if-includes', '--no-progress', '--no-signed', '--no-thin',
  '--no-verify', '--porcelain', '--prune', '--progress', '--push-option', '--receive-pack', '--recurse-submodules', '--repo',
  '--set-upstream', '--signed', '--tags', '--thin', '--verbose', '--quiet',
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(['-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);

export interface GitInvocation {
  readonly subcommand?: string;
  readonly subcommandArgs: readonly string[];
  readonly scopeChangingOption?: string;
}

/** Finds the actual Git subcommand while preserving the arguments after it. */
export function parseGitInvocation(args: readonly string[]): GitInvocation {
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    const lower = argument.toLowerCase();
    if (!argument.startsWith('-')) return { subcommand: lower, subcommandArgs: args.slice(index + 1) };
    if (lower === '--') {
      const subcommand = args[index + 1];
      return subcommand === undefined
        ? { subcommandArgs: [] }
        : { subcommand: subcommand.toLowerCase(), subcommandArgs: args.slice(index + 2) };
    }

    const scopeChangingOption = scopeChangingGitOption(argument);
    if (scopeChangingOption !== undefined) {
      return skipGitGlobalOption(args, index, scopeChangingOption);
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(lower) && !lower.startsWith('--exec-path')) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return { subcommandArgs: [] };
}

/** Keeps repository aliases and unknown Git subcommands out of the native Git path. */
export function prohibitedGitSubcommandReason(args: readonly string[]): string | undefined {
  const invocation = parseGitInvocation(args);
  if (invocation.subcommand === undefined) return 'Git invocation has no explicit subcommand';
  if (!AGENT_ALLOWED_GIT_SUBCOMMANDS.has(invocation.subcommand)) {
    return `Git subcommand ${invocation.subcommand} is not on the explicit agent allowlist; repository aliases are never executed`;
  }
  return undefined;
}

/** Rejects every push-time config override so included config cannot redirect the actual push target. */
export function prohibitedGitPushConfigOverrideReason(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) return undefined;
    const lower = argument.toLowerCase();
    if (argument === '-c' || lower === '--config-env') {
      const value = args[index + 1];
      if (value === undefined) return 'Git push config override is missing its value';
      return 'Git push cannot use invocation-local config overrides; use the guarded repository configuration instead';
    }
    if ((argument.startsWith('-c') && !argument.startsWith('--')) || lower.startsWith('--config-env=')) {
      return 'Git push cannot use invocation-local config overrides; use the guarded repository configuration instead';
    }
  }
  return undefined;
}

/** Rejects global executable-path overrides before a guarded push reaches Git. */
export function prohibitedGitPushGlobalOptionReason(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) return undefined;
    const lower = argument.toLowerCase();
    if (lower === '--exec-path' || lower.startsWith('--exec-path=')) {
      return 'Git push cannot override the Git executable path; guarded pushes must use Git\'s normal helper programs';
    }
    if (lower === '--') return undefined;
  }
  return undefined;
}

/** Keeps native Git config mutations from installing executable transport helpers. */
export function prohibitedGitConfigMutationReason(args: readonly string[]): string | undefined {
  const invocation = parseGitInvocation(args);
  if (invocation.subcommand !== 'config') return undefined;
  const configArgs = invocation.subcommandArgs.map((argument) => argument.toLowerCase());
  if (configArgs.some((argument) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--name-only', '--show-origin', '--show-scope'].includes(argument))) {
    return undefined;
  }
  if (configArgs.some(isExecutableGitConfigKey)) {
    return 'Git config cannot install executable transport or credential helpers';
  }
  return undefined;
}

function isExecutableGitConfigKey(argument: string): boolean {
  const key = argument.split('=', 1)[0]!;
  return key === 'core.sshcommand'
    || key === 'core.askpass'
    || key === 'core.gitproxy'
    || key === 'credential.helper'
    || /^credential\..+\.helper$/.test(key)
    || key === 'push.gpgsign'
    || key === 'push.recursesubmodules'
    || key === 'submodule.recurse'
    || /^gpg(?:\..+)?\.program$/.test(key)
    || key === 'protocol.allow'
    || /^protocol\..+\.allow$/.test(key)
    || /^remote\..+\.(?:receivepack|uploadpack|proxy|vcs)$/.test(key);
}

function skipGitGlobalOption(args: readonly string[], index: number, option: string): GitInvocation {
  const argument = args[index]!;
  const hasAttachedValue = argument.includes('=') || (option === '-C' && argument.length > 2);
  if (hasAttachedValue) {
    return findGitSubcommand(args, index + 1, option);
  }
  return findGitSubcommand(args, index + 2, option);
}

function findGitSubcommand(args: readonly string[], start: number, scopeChangingOption: string): GitInvocation {
  const parsed = parseGitInvocation(args.slice(start));
  return { ...parsed, scopeChangingOption };
}

function scopeChangingGitOption(argument: string): string | undefined {
  const lower = argument.toLowerCase();
  if (argument === '-C' || (argument.startsWith('-C') && !argument.startsWith('--'))) return '-C';
  if (lower === '--git-dir' || lower.startsWith('--git-dir=')) return '--git-dir';
  if (lower === '--work-tree' || lower.startsWith('--work-tree=')) return '--work-tree';
  return undefined;
}

export function prohibitedAgentGitInvocationReason(args: readonly string[], options: GitMutationPolicyOptions = {}): string | undefined {
  if (args.length === 0) return 'Git invocation has no explicit subcommand';
  const first = args[0]!.toLowerCase();
  if (first.startsWith('-')) {
    return args.length === 1 && (first === '--help' || first === '--version')
      ? undefined
      : 'Git global options can override the scoped working tree or inject aliases';
  }
  if (!AGENT_ALLOWED_GIT_SUBCOMMANDS.has(first)) {
    return `Git subcommand ${first} is not on the explicit agent allowlist; repository aliases are never executed`;
  }

  const rest = args.slice(1);
  const lower = rest.map((arg) => arg.toLowerCase());
  if (first === 'checkout') {
    if (lower.includes('--') || rest.includes('-B') || hasGitOption(lower, ['--force', '-f', '--ours', '--theirs', '--merge', '-m', '--conflict'])) {
      return 'git checkout mode can overwrite paths or force-move a branch without Recovery Trash';
    }
    const explicitlyCreatesBranch = hasGitOption(lower, ['-b', '--branch']);
    const explicitlyDetaches = hasGitOption(lower, ['--detach']);
    if (!explicitlyCreatesBranch && !explicitlyDetaches) {
      return 'git checkout target is ambiguous between a ref and a working-tree path; use git switch for branch changes or a reviewed staged-only restore';
    }
  }
  if (first === 'switch' && (rest.includes('-C') || hasGitOption(lower, ['--force', '-f', '--discard-changes', '--force-create']))) {
    return 'git switch mode can discard changes or force-reset a branch';
  }
  if (first === 'stash' && lower.some((arg) => ['drop', 'clear', 'pop'].includes(arg))) {
    return 'git stash operation deletes recovery history';
  }
  if (first === 'reflog' && lower.some((arg) => ['delete', 'expire'].includes(arg))) {
    return 'git reflog operation deletes recovery history';
  }
  if (first === 'branch' && (rest.includes('-M') || rest.includes('-C') || hasGitOption(lower, ['--delete', '-d', '--force', '-f']))) {
    return 'git branch operation deletes or force-moves a branch';
  }
  if (first === 'tag' && hasGitOption(lower, ['--delete', '-d', '--force', '-f'])) {
    return 'git tag operation deletes or force-replaces a tag';
  }
  if (first === 'worktree' && lower.some((arg) => ['remove', 'prune'].includes(arg))) {
    return 'git worktree operation removes worktree state';
  }
  if (first === 'remote' && lower.some((arg) => ['remove', 'rm', 'prune'].includes(arg))) {
    return 'git remote operation deletes configuration or remote-tracking refs';
  }
  if (first === 'fetch' && hasGitOption(lower, ['--prune', '-p', '--prune-tags'])) {
    return 'git fetch pruning deletes remote-tracking refs';
  }
  if (first === 'gc') return 'git gc can permanently prune otherwise recoverable objects';
  if (first === 'mv' && hasGitOption(lower, ['--force', '-f'])) return 'git mv --force can replace an existing path';
  if (first === 'push' && isDestructivePush(lower)) return 'git push invocation deletes or force-rewrites remote refs';
  if (first === 'push') return prohibitedDefaultBranchPushReason(rest, options.defaultBranch);
  return undefined;
}

function hasGitOption(args: readonly string[], options: readonly string[]): boolean {
  return args.some((arg) => options.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

function isDestructivePush(args: readonly string[]): boolean {
  if (hasGitOption(args, ['--force', '-f', '--force-with-lease', '--force-if-includes', '--delete', '--mirror', '--prune'])) return true;
  return args.some((arg) => arg.startsWith(':') || arg.startsWith('+'));
}

export function prohibitedDefaultBranchPushReason(args: readonly string[], defaultBranch?: string): string | undefined {
  const sideEffectOption = args.find((arg) => {
    const lower = arg.toLowerCase();
    return lower === '--receive-pack'
      || lower.startsWith('--receive-pack=')
      || lower === '--exec'
      || lower.startsWith('--exec=')
      || lower === '--signed'
      || lower.startsWith('--signed=');
  });
  if (sideEffectOption !== undefined) {
    return `AI-issued git push cannot use ${sideEffectOption}; guarded pushes must use Git's normal transport`;
  }
  const recursiveOption = args.find((arg) => {
    const lower = arg.toLowerCase();
    return lower === '--recurse-submodules' || lower.startsWith('--recurse-submodules=');
  });
  if (recursiveOption !== undefined) {
    return `AI-issued git push cannot use ${recursiveOption}; guarded pushes cannot launch nested submodule pushes`;
  }
  const parsed = parseGitPushArguments(args);
  if (parsed.invalidOption !== undefined) return `AI-issued git push option ${parsed.invalidOption} is not on the explicit allowlist or is missing its value`;
  const lower = args.map((arg) => arg.toLowerCase());
  if (hasGitOption(lower, ['--all'])) {
    return 'AI-issued git push --all can update the default branch; push one explicit feature or issue branch and use a reviewed pull request instead';
  }

  if (parsed.remote === undefined || parsed.refspecs.length === 0) {
    return 'AI-issued git push must name an explicit remote and non-default destination branch; implicit push can bypass the pull-request review workflow';
  }

  for (const refspec of parsed.refspecs) {
    if (refspec.includes('*') || refspec.includes('?') || refspec.includes('[') || refspec.includes(']')) {
      return 'AI-issued git push wildcard refspecs are blocked because they can update the default branch; push one explicit feature or issue branch instead';
    }
    const separator = refspec.lastIndexOf(':');
    const destinationRaw = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    const destination = destinationRaw.replace(/^refs\/heads\//i, '').toLowerCase();
    if (destination === '' || (separator < 0 && (destination === 'head' || destination === '@'))) {
      return 'AI-issued git push must use an explicit non-default destination branch so the pull-request review workflow cannot be bypassed';
    }
    if (defaultBranch !== undefined && destination === normalizeBranch(defaultBranch)) {
      return `Direct AI push to ${destination} is blocked; push a feature or issue branch and merge it only after pull-request review`;
    }
  }
  return undefined;
}

export function parseGitPushArguments(args: readonly string[]): GitPushArguments {
  const positional: string[] = [];
  let optionRemote: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const lower = argument.toLowerCase();
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (GIT_PUSH_OPTIONS_WITH_VALUES.has(lower)) {
      const value = args[index + 1];
      if (value === undefined) return { refspecs: [], invalidOption: argument };
      if (lower === '--repo') optionRemote = value;
      index += 1;
      continue;
    }
    const optionName = lower.split('=', 1)[0]!;
    if (GIT_PUSH_OPTIONS_WITH_VALUES.has(optionName)) {
      if (optionName === '--repo') optionRemote = argument.slice(argument.indexOf('=') + 1);
      continue;
    }
    if (argument.startsWith('--') && !GIT_PUSH_OPTIONS.has(optionName)) return { refspecs: [], invalidOption: argument };
    if (!argument.startsWith('-')) positional.push(argument);
  }
  if (optionRemote !== undefined) return { remote: optionRemote, refspecs: positional };
  return positional[0] === undefined
    ? { refspecs: [] }
    : { remote: positional[0], refspecs: positional.slice(1) };
}

function normalizeBranch(value: string): string {
  return value.trim().replace(/^refs\/heads\//i, '').toLowerCase();
}

function containsBroadPathspecMagic(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith(':') || ['*', '?', '[', ']', '{', '}'].some((token) => arg.includes(token)));
}

function isReadOnlyBranch(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  const lower = args.map((arg) => arg.toLowerCase());
  if (hasGitOption(lower, ['--delete', '-d', '--force', '-f', '--move', '-m', '--copy', '-c', '--set-upstream-to', '-u', '--unset-upstream', '--edit-description'])) return false;
  if (args.some((arg) => arg === '-M' || arg === '-C')) return false;
  if (lower.includes('--show-current')) return lower.every((arg) => arg === '--show-current' || arg === '--color' || arg.startsWith('--color='));
  return lower.every((arg) =>
    arg === '--list' || arg === '-l' || arg === '-a' || arg === '--all' || arg === '-r' || arg === '--remotes' ||
    arg === '-v' || arg === '-vv' || arg === '--verbose' || arg === '--no-color' || arg === '--color' || arg.startsWith('--color=') ||
    ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--no-column'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)) ||
    (!arg.startsWith('-') && lower.some((value) => ['--list', '-l'].includes(value)))
  );
}

function isReadOnlyConfig(args: readonly string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  return lower.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope'].includes(arg));
}

function isReadOnlySymbolicRef(args: readonly string[]): boolean {
  const positional = args.filter((arg) => !['-q', '--quiet', '--short'].includes(arg.toLowerCase()));
  return positional.length === 1 && !positional[0]!.startsWith('-');
}

function isReadOnlyTag(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every((arg) => arg.startsWith('-l') || ['--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

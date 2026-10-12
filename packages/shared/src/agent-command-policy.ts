import path from 'node:path';
import { prohibitedAgentGitInvocationReason } from './git-mutation-policy.js';

const DIRECT_RISKY_EXECUTABLES = new Set([
  'rm', 'unlink', 'rmdir', 'shred', 'truncate', 'dd', 'del',
]);
const HARD_BLOCK_EXECUTABLES = new Set(['shutdown', 'reboot', 'poweroff', 'halt']);
const POSIX_SHELL_EXECUTABLES = new Set(['sh', 'dash', 'bash', 'zsh', 'fish']);
const POWERSHELL_EXECUTABLES = new Set(['pwsh', 'powershell']);
const WINDOWS_SHELL_EXECUTABLES = new Set(['cmd']);
const JAVASCRIPT_EXECUTABLES = new Set(['node', 'nodejs', 'bun', 'deno']);
const PYTHON_EXECUTABLES = new Set(['python', 'python3']);
const INLINE_SCRIPT_EXECUTABLES = new Set(['perl', 'ruby']);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set(['-C', '-c', '-cde', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
const GH_GLOBAL_OPTIONS_WITH_VALUES = new Set(['--hostname', '--repo', '-r']);
const ENV_OPTIONS_WITH_VALUES = new Set(['-u', '--unset', '-c', '--chdir', '-s', '--split-string']);
const XARGS_OPTIONS_WITH_VALUES = new Set(['-n', '-p', '-i', '-s', '-a', '-d', '-e', '-l', '--max-args', '--max-procs', '--replace', '--arg-file', '--delimiter', '--eof', '--max-lines', '--max-chars']);
/**
 * Wrappers that hand their remaining argv to a real executable unchanged. Unwrapping them lets the
 * underlying command be fenced, so `env gh pr merge` cannot route around the merge gate.
 */
const TRANSPARENT_WRAPPERS = new Map<string, ReadonlySet<string>>([
  ['env', ENV_OPTIONS_WITH_VALUES],
  ['xargs', XARGS_OPTIONS_WITH_VALUES],
  ['nohup', new Set<string>()],
  ['command', new Set<string>()],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['setsid', new Set(['-f', '-w', '--fork', '--wait'])],
]);

/**
 * Hard blocks machine-level commands plus terminal-style inline text editing that
 * must go through the guarded file tools. The latter is a routing safeguard: it
 * prevents an AI from turning shell/process into an ad-hoc text editor and
 * bypassing edit_file/apply_patch/write_file checkpoints and conflict checks.
 */
export function prohibitedAgentCommandReason(executable: string, args: readonly string[]): string | undefined {
  const basename = executableBasename(executable);
  const unscopedGitPush = prohibitedUnscopedGitPushReason(executable, args);
  if (unscopedGitPush !== undefined) return unscopedGitPush;
  const unscopedPullRequestMerge = prohibitedUnscopedPullRequestMergeReason(executable, args);
  if (unscopedPullRequestMerge !== undefined) return unscopedPullRequestMerge;
  const fileEditReason = terminalTextEditRoutingReason(basename, args);
  if (fileEditReason !== undefined) return fileEditReason;
  if (HARD_BLOCK_EXECUTABLES.has(basename)) return `${basename} is blocked for AI-issued execution`;
  const commandText = interpreterCommandText(basename, args);
  if (commandText !== undefined && /\b(?:shutdown\s+-[rRhH]|poweroff|reboot|halt)\b/i.test(commandText)) {
    return 'Machine-level destructive command is blocked for AI-issued execution';
  }
  return undefined;
}

export function prohibitedUnscopedGitPushReason(
  executable: string,
  args: readonly string[],
): string | undefined {
  const basename = executableBasename(executable);
  if (basename === 'git' && hasGitPushArguments(args)) return guardedGitPushReason();
  if (isOpaqueGitRunner(basename)) {
    const commandText = interpreterCommandText(basename, args);
    if (commandText !== undefined && hasGitPushCommand(commandText)) return guardedGitPushReason();
  }
  return undefined;
}

export function prohibitedUnscopedPullRequestMergeReason(
  executable: string,
  args: readonly string[],
): string | undefined {
  const basename = executableBasename(executable);
  const ghArguments = resolveGhArguments(basename, args);
  if (ghArguments !== undefined) {
    if (hasGhPullRequestMergeArguments(ghArguments)) return guardedPullRequestMergeReason();
    if (hasGhApiPullRequestMergeArguments(ghArguments)) return guardedPullRequestMergeReason();
  }
  if (basename === 'gh' && hasGhMergeAliasDefinition(args)) return guardedPullRequestMergeReason();
  const scriptText = inlineScriptText(basename, args);
  if (scriptText !== undefined && hasGhMergeInScriptText(scriptText)) return guardedPullRequestMergeReason();
  if (isOpaqueGitRunner(basename)) {
    const commandText = interpreterCommandText(basename, args);
    if (commandText === undefined) return undefined;
    const tokens = commandTokens(commandText);
    for (let index = 0; index < tokens.length; index += 1) {
      if (executableBasename(tokens[index]!) !== 'gh') continue;
      const tail = tokens.slice(index + 1);
      if (hasGhPullRequestMergeArguments(tail) || hasGhApiPullRequestMergeArguments(tail)) {
        return guardedPullRequestMergeReason();
      }
    }
  }
  return undefined;
}

/**
 * Applies the merge-fence to free text that is about to be injected as OS keystrokes.
 *
 * `shell`, `wsl_exec` and `scheduler` fence their argv, but `input_event`/`computer_use`
 * hand raw text to whatever window currently has focus. If that window is a terminal the
 * text becomes a command line, so the argv fence never sees it. The fence cannot tell a
 * terminal from a text box, so it errs toward blocking exactly as it already does for a
 * merge command merely mentioned inside an inline script: a merge command typed anywhere
 * is refused, because nothing here can prove it is not executed.
 *
 * Deliberately narrow: this covers the merge/push fence only. Hard-block executables such
 * as `shutdown` are ordinary words in notes, documentation and search boxes, and since the
 * focused target is unknowable, fencing them here would block ordinary typing for no
 * security gain. Add them if a keystroke sink ever gains reliable focus information.
 */
export function prohibitedTypedTextReason(text: string): string | undefined {
  if (hasGhMergeInScriptText(text)) return guardedPullRequestMergeReason();
  if (hasGitPushCommand(text)) return guardedGitPushReason();
  return undefined;
}

/**
 * Splits opaque command text into fence tokens. Quote characters are separators as well as
 * whitespace, so an embedded string literal (`exec('gh pr merge 5')`) still exposes the real
 * command instead of hiding it behind a glued-on prefix.
 */
function commandTokens(commandText: string): string[] {
  return commandText.split(/[\s'"`]+/)
    .map((token) => token.replace(/^[('`]+|[)'`;|&,]+$/g, ''))
    .filter(Boolean)
    .map(unquote);
}

/** Unwraps transparent argument wrappers so `env gh pr merge` is fenced like a direct `gh` call. */
function resolveGhArguments(basename: string, args: readonly string[]): readonly string[] | undefined {
  const wrapperOptions = TRANSPARENT_WRAPPERS.get(basename);
  if (wrapperOptions === undefined) return basename === 'gh' ? args : undefined;
  let index = 0;
  while (index < args.length) {
    const argument = args[index]!;
    if (argument === '--') { index += 1; break; }
    if (argument.startsWith('-') && argument.length > 1) {
      const flag = argument.split('=')[0]!.toLowerCase();
      index = wrapperOptions.has(flag) && !argument.includes('=') ? index + 2 : index + 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) { index += 1; continue; }
    break;
  }
  return executableBasename(args[index] ?? '') === 'gh' ? args.slice(index + 1) : undefined;
}

/**
 * Inline interpreters (`node -e`, `python -c`, `perl -e`) carry their whole program as one opaque
 * blob, so the token fence cannot be applied to it and the text is searched instead. This
 * deliberately errs toward blocking: a merge command merely mentioned inside an inline script is
 * refused, because the fence cannot prove it is not executed.
 */
function hasGhMergeInScriptText(scriptText: string): boolean {
  // Array-style argv hides the tokens behind quotes and commas (`{args:['pr','merge','5']}`),
  // so separators are flattened to spaces before the token pattern is applied.
  const text = scriptText.replace(/['"`\\,]+/g, ' ');
  return /\bgh(?:\.exe)?\b[^\n;]*?\bpr\s+merge\b/i.test(text)
    || /\bgh(?:\.exe)?\b[^\n;]*?\bapi\b[^\n;]*?(?:pulls\/\d+\/merge|\bmerges\b|mergePullRequest|enablePullRequestAutoMerge)/i.test(text);
}

/** `gh alias set <name> 'pr merge 5'` defines a merge under a name that later runs unguarded. */
function hasGhMergeAliasDefinition(args: readonly string[]): boolean {
  const aliasIndex = args.findIndex((arg) => unquote(arg).toLowerCase() === 'alias');
  if (aliasIndex < 0) return false;
  if (unquote(args[aliasIndex + 1] ?? '').toLowerCase() !== 'set') return false;
  // The alias body is a gh argument list, not a full command line: `gh` is implied by the alias.
  return args.slice(aliasIndex + 2).some((value) => {
    const aliasArguments = commandTokens(unquote(value));
    return hasGhPullRequestMergeArguments(aliasArguments) || hasGhApiPullRequestMergeArguments(aliasArguments);
  });
}

/** Returns the program text of an inline-script interpreter, if the invocation carries one. */
function inlineScriptText(basename: string, args: readonly string[]): string | undefined {
  const lower = args.map((arg) => arg.toLowerCase());
  const flags = JAVASCRIPT_EXECUTABLES.has(basename)
    ? ['-e', '--eval', '-p', '--print', 'eval']
    : PYTHON_EXECUTABLES.has(basename)
      ? ['-c']
      : INLINE_SCRIPT_EXECUTABLES.has(basename)
        ? ['-e', '-E']
        : [];
  for (const flag of flags) {
    const index = lower.indexOf(flag);
    if (index >= 0) return args.slice(index + 1).join(' ');
  }
  return undefined;
}

function guardedGitPushReason(): string {
  return 'AI-issued git push must use the guarded git tool so the repository default branch and pull-request review gate are enforced';
}

function guardedPullRequestMergeReason(): string {
  return 'AI-issued gh pr merge is blocked until a guarded merge path validates exact-head verification and truthful review evidence';
}

function isOpaqueGitRunner(basename: string): boolean {
  return POSIX_SHELL_EXECUTABLES.has(basename)
    || POWERSHELL_EXECUTABLES.has(basename)
    || WINDOWS_SHELL_EXECUTABLES.has(basename)
    || JAVASCRIPT_EXECUTABLES.has(basename)
    || PYTHON_EXECUTABLES.has(basename)
    || INLINE_SCRIPT_EXECUTABLES.has(basename);
}

function hasGitPushArguments(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const argument = args[index]!.toLowerCase();
    if (argument === 'push') return true;
    if (!argument.startsWith('-')) return false;
    index += optionTakesValue(argument) && !argument.includes('=') ? 2 : 1;
  }
  return false;
}

function hasGitPushCommand(commandText: string): boolean {
  const tokens = commandText.split(/\s+/).filter(Boolean).map((token) => token.replace(/^[('"`]+|[)"'`;|&]+$/g, ''));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]!).toLowerCase();
    if (token !== 'git' && token !== 'git.exe') continue;
    if (hasGitPushArguments(tokens.slice(index + 1).map(unquote))) return true;
  }
  return false;
}

function hasGhApiPullRequestMergeArguments(args: readonly string[]): boolean {
  const commands: string[] = [];
  let index = 0;
  while (index < args.length && commands.length < 2) {
    const raw = unquote(args[index]!);
    const lower = raw.toLowerCase();
    if (lower.startsWith('-')) {
      if (ghOptionTakesValue(lower) && !lower.includes('=') && !isAttachedShortGhOption(lower)) index += 2;
      else index += 1;
      continue;
    }
    commands.push(lower);
    index += 1;
  }
  if (commands[0] !== 'api') return false;

  // Every remaining argument is a candidate endpoint, flag value, or GraphQL body.
  for (const argument of args) {
    const value = unquote(argument).toLowerCase();
    if (/(?:^|\/)pulls\/\d+\/merge(?:$|[/?#]|\?)/.test(value)) return true;
    if (/(?:^|\/)repos\/[^/]+\/[^/]+\/merges(?:$|[/?#]|\?)/.test(value)) return true;
    // Only a real GraphQL merge mutation merges. Matching arbitrary arguments would block
    // legitimate searches or comments that merely mention the mutation name.
    const queryBody = graphqlQueryBody(value);
    if (queryBody === undefined) continue;
    const flattened = queryBody.replace(/[^a-z]/g, '');
    if (!flattened.startsWith('mutation')) continue;
    if (flattened.includes('mergepullrequest') || flattened.includes('enablepullrequestautomerge')) return true;
  }
  return false;
}

/** Returns the GraphQL document carried by a `query=` / `query:` flag value, if any. */
function graphqlQueryBody(value: string): string | undefined {
  const match = /^(?:--raw-field[= ]|-f[= ]|-F[= ])?query=?(.*)$/s.exec(value);
  return match?.[1];
}

function hasGhPullRequestMergeArguments(args: readonly string[]): boolean {
  const commands: string[] = [];
  let index = 0;
  while (index < args.length && commands.length < 2) {
    const raw = unquote(args[index]!);
    const lower = raw.toLowerCase();
    if (lower.startsWith('-')) {
      if (ghOptionTakesValue(lower) && !lower.includes('=') && !isAttachedShortGhOption(lower)) index += 2;
      else index += 1;
      continue;
    }
    commands.push(lower);
    index += 1;
  }
  return commands[0] === 'pr' && commands[1] === 'merge';
}

function ghOptionTakesValue(argument: string): boolean {
  if (GH_GLOBAL_OPTIONS_WITH_VALUES.has(argument)) return true;
  return argument.startsWith('--repo=') || argument.startsWith('--hostname=') || isAttachedShortGhOption(argument);
}

function isAttachedShortGhOption(argument: string): boolean {
  return argument.startsWith('-r') && argument.length > 2;
}

function unquote(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function optionTakesValue(argument: string): boolean {
  return GIT_GLOBAL_OPTIONS_WITH_VALUES.has(argument);
}

function terminalTextEditRoutingReason(basename: string, args: readonly string[]): string | undefined {
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const route = 'Do not edit source/config/text files through shell or process_start. Use edit_file for exact replacements, apply_patch for reviewed multi-file or whole-file replacements, or write_file for file creation/replacement.';

  if (JAVASCRIPT_EXECUTABLES.has(basename) && hasAnyArgument(lowerArgs, ['-e', '--eval', '-p', '--print', 'eval'])) {
    const script = inlineArgument(args, lowerArgs, ['-e', '--eval', '-p', '--print', 'eval']);
    if (script !== undefined && /(?:\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\s*\(|\bfs\.(?:writeFile|appendFile)\s*\(|\bDeno\.(?:writeTextFile|writeFile)\s*\(|\bBun\.write\s*\()/i.test(script)) return route;
  }

  if (PYTHON_EXECUTABLES.has(basename) && hasAnyArgument(lowerArgs, ['-c'])) {
    const script = inlineArgument(args, lowerArgs, ['-c']);
    if (script !== undefined && /(?:\.write_(?:text|bytes)\s*\(|\bopen\s*\([^,\r\n]+,\s*['"][^'"]*[wax+][^'"]*['"])/i.test(script)) return route;
  }

  if (POWERSHELL_EXECUTABLES.has(basename) && hasAnyArgument(lowerArgs, ['-command', '-c'])) {
    const script = inlineArgument(args, lowerArgs, ['-command', '-c']);
    if (script !== undefined && /(?:\b(?:Set-Content|Add-Content|Out-File)\b|>\s*|>>\s*)/i.test(script)) return route;
  }

  if (basename === 'sed' && lowerArgs.some((arg) => arg === '-i' || (arg.length > 2 && arg.startsWith('-i')))) return route;
  return undefined;
}

/** Returns a reason only when an otherwise allowed command is risky enough to require confirmation. */
export function riskyAgentCommandReason(executable: string, args: readonly string[]): string | undefined {
  const basename = executableBasename(executable);
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  if (DIRECT_RISKY_EXECUTABLES.has(basename)) return `${basename} can delete, move, or replace filesystem data`;
  if (basename === 'git') {
    const prohibited = prohibitedAgentGitInvocationReason(args);
    if (prohibited !== undefined) return prohibited;
    return riskyGitCommandReason(args);
  }

  if (POSIX_SHELL_EXECUTABLES.has(basename)) {
    const commandText = interpreterCommandText(basename, args);
    if (commandText !== undefined && riskyCommandText(commandText)) return 'Shell command can modify or delete system/project state';
  }
  if (POWERSHELL_EXECUTABLES.has(basename)) {
    if (lowerArgs.some((arg) => ['-encodedcommand', '-e', '-enc'].includes(arg))) {
      return 'PowerShell encoded command is opaque and requires explicit confirmation';
    }
    const commandIndex = lowerArgs.findIndex((arg) => ['-command', '-c'].includes(arg));
    if (commandIndex >= 0) {
      const commandText = args.slice(commandIndex + 1).join(' ');
      if (
        riskyCommandText(commandText)
        || /(?:^|[;&|]\s*|\b)(?:remove-item|ri|rmdir|del|erase|clear-content)\b/i.test(commandText)
        || /(?:^|[;&|]\s*)&(?:\s*\(|\s*['"]|\s*\$|\s+\S)/.test(commandText)
        || /\b(?:invoke-expression|iex)\b/i.test(commandText)
      ) {
        return 'PowerShell command can modify or delete system/project state';
      }
    }
  }
  if (JAVASCRIPT_EXECUTABLES.has(basename) && hasAnyArgument(lowerArgs, ['-e', '--eval', '-p', '--print', 'eval'])) {
    const script = inlineArgument(args, lowerArgs, ['-e', '--eval', '-p', '--print', 'eval']);
    if (script !== undefined && /(?:\b(?:rmSync|unlinkSync|rmdirSync|truncateSync|writeFileSync|renameSync)\s*\(|\bfs\.(?:rm|unlink|rmdir|truncate|writeFile|rename)\s*\()/i.test(script)) return 'Inline JavaScript contains destructive filesystem operations';
    return 'Inline JavaScript is opaque and requires explicit confirmation';
  }
  if (PYTHON_EXECUTABLES.has(basename) && hasAnyArgument(lowerArgs, ['-c'])) {
    const script = inlineArgument(args, lowerArgs, ['-c']);
    if (script !== undefined && /(?:\bos\.(?:remove|unlink|rmdir|replace|rename)\s*\(|\bshutil\.(?:rmtree|move)\s*\()/i.test(script)) return 'Inline Python contains destructive filesystem operations';
    return 'Inline Python is opaque and requires explicit confirmation';
  }
  if (INLINE_SCRIPT_EXECUTABLES.has(basename) && lowerArgs.some(isInlineScriptFlag)) return `Inline ${basename} is opaque and requires explicit confirmation`;
  if (basename === 'rsync' && lowerArgs.some((arg) => arg === '--delete' || arg.startsWith('--delete-') || arg === '--remove-source-files' || arg === '--inplace')) return 'rsync mode can delete or replace destination data';
  if (basename === 'sed' && lowerArgs.some((arg) => arg === '-i' || (arg.length > 2 && arg.startsWith('-i')))) return 'sed in-place editing replaces file content';
  return undefined;
}

function riskyGitCommandReason(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  const subcommand = args[0]!.toLowerCase();
  const lower = args.slice(1).map((arg) => arg.toLowerCase());
  if (subcommand === 'rm') return 'git rm can delete workspace data';
  if (subcommand === 'clean') return 'git clean can delete untracked workspace data';
  if (subcommand === 'reset' && lower.some((arg) => ['--hard', '--merge', '--keep', '--recurse-submodules'].includes(arg))) return 'git reset mode can discard working-tree changes';
  if (subcommand === 'restore' && (!lower.includes('--staged') && !lower.includes('-s') || lower.includes('--worktree') || lower.includes('-w'))) return 'git restore can discard working-tree changes';
  return undefined;
}

function riskyCommandText(value: string): boolean {
  return /(?:^|[;&|]\s*|\b)(?:rm|rmdir|truncate|shred|dd|git\s+(?:clean|rm|reset\s+--hard|restore)|systemctl\s+(?:stop|restart)|kill|pkill)\b/i.test(value);
}

function interpreterCommandText(basename: string, args: readonly string[]): string | undefined {
  const lower = args.map((arg) => arg.toLowerCase());
  const flags = POSIX_SHELL_EXECUTABLES.has(basename)
    ? ['-c', '-lc', '-cl', '--command']
    : POWERSHELL_EXECUTABLES.has(basename)
      ? ['-command', '-c']
      : WINDOWS_SHELL_EXECUTABLES.has(basename)
        ? ['/c', '/k', '/r']
        : [];
  for (const flag of flags) {
    const index = lower.indexOf(flag);
    if (index >= 0) return args.slice(index + 1).join(' ');
  }
  return undefined;
}

function executableBasename(executable: string): string {
  const rawBasename = path.posix.basename(executable.replaceAll('\\', '/')).toLowerCase();
  return rawBasename.endsWith('.exe') ? rawBasename.slice(0, -4) : rawBasename;
}
function hasAnyArgument(args: readonly string[], values: readonly string[]): boolean { return args.some((arg) => values.includes(arg)); }
function inlineArgument(args: readonly string[], lowerArgs: readonly string[], flags: readonly string[]): string | undefined { for (const flag of flags) { const index = lowerArgs.indexOf(flag); if (index >= 0) return args[index + 1]; } return undefined; }
function isInlineScriptFlag(arg: string): boolean { if (arg.length < 2 || arg[0] !== '-') return false; const flags = arg.slice(1); return flags.includes('e') && [...flags].every((c) => c >= 'a' && c <= 'z'); }

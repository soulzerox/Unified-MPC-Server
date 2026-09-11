import path from 'node:path';
import { prohibitedAgentGitInvocationReason } from './git-mutation-policy.js';

const DIRECT_RISKY_EXECUTABLES = new Set([
  'rm', 'unlink', 'rmdir', 'shred', 'truncate', 'dd', 'del',
]);
const HARD_BLOCK_EXECUTABLES = new Set(['shutdown', 'reboot', 'poweroff', 'halt']);
const POSIX_SHELL_EXECUTABLES = new Set(['sh', 'dash', 'bash', 'zsh', 'fish']);
const POWERSHELL_EXECUTABLES = new Set(['pwsh', 'powershell']);
const JAVASCRIPT_EXECUTABLES = new Set(['node', 'nodejs', 'bun', 'deno']);
const PYTHON_EXECUTABLES = new Set(['python', 'python3']);
const INLINE_SCRIPT_EXECUTABLES = new Set(['perl', 'ruby']);

/**
 * Hard blocks machine-level commands plus terminal-style inline text editing that
 * must go through the guarded file tools. The latter is a routing safeguard: it
 * prevents an AI from turning shell/process into an ad-hoc text editor and
 * bypassing edit_file/apply_patch/write_file checkpoints and conflict checks.
 */
export function prohibitedAgentCommandReason(executable: string, args: readonly string[]): string | undefined {
  const basename = executableBasename(executable);
  const fileEditReason = terminalTextEditRoutingReason(basename, args);
  if (fileEditReason !== undefined) return fileEditReason;
  if (HARD_BLOCK_EXECUTABLES.has(basename)) return `${basename} is blocked for AI-issued execution`;
  const commandText = interpreterCommandText(basename, args);
  if (commandText !== undefined && /\b(?:shutdown\s+-[rRhH]|poweroff|reboot|halt)\b/i.test(commandText)) {
    return 'Machine-level destructive command is blocked for AI-issued execution';
  }
  return undefined;
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
  const flags = POSIX_SHELL_EXECUTABLES.has(basename) ? ['-c', '-lc', '-cl', '--command'] : [];
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

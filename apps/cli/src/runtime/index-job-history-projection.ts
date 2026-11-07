import type { RagIndexJobHistory, RagIndexJobHistoryRow } from '@unified-mpc/mcp-server';
import type { ThaiRagIndexJobListing } from '@unified-mpc/thai-rag';

const PATH_PLACEHOLDER = '<path>';
const JOB_ID_PLACEHOLDER = '<job-id>';

/**
 * A quoted segment is a path when it carries a separator. The opening quote must
 * follow a token boundary (a backslash escape counts) so an apostrophe inside a
 * word cannot start a match. The segment ends at the next same quote that is
 * followed by a token terminator or the end of the text; when no terminator
 * follows any same quote, the last same quote still closes it, so an internal
 * apostrophe plus a suffix or possessive after a path cannot leak the tail. An
 * internal quote keeps `O'Brien` inside one quoted path. That closing boundary
 * is deliberately wider than the token stops used below (`}` and `!` count),
 * because a quoted path usually arrives inside a JSON snippet or a sentence. An
 * opener with no same quote after it is literal text and the scan continues,
 * unless a local path token follows it after optional whitespace; that
 * truncated path is redacted through the end of the text. Exact Git refs and
 * non-file URLs are diagnostics the operator surface deliberately keeps.
 */
const QUOTE_OPENS_AFTER = new Set([' ', '\t', '\n', '\r', '(', '=', '"', "'", '`', '[', '{', ',', ';', ':', '\\']);
const QUOTE_CLOSES_BEFORE = new Set([' ', '\t', '\n', '\r', '.', ',', ';', ':', ')', ']', '}', '>', '!', '?', '|']);
const GIT_REF = /^refs\/[A-Za-z0-9._/-]+$/;
const SAFE_URL = /^(?!file:)[A-Za-z][A-Za-z0-9+.-]*:\/\//i;
/** A truncated quoted path still starts with a local absolute token. */
const PATH_START = /^(?:(?:file|path):\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?!\/))/i;

type QuoteCharacter = "'" | '"';

interface QuoteScan {
  readonly positions: Readonly<Record<QuoteCharacter, readonly number[]>>;
  readonly terminators: Readonly<Record<QuoteCharacter, readonly number[]>>;
}

/** Index of the first entry strictly greater than `index`, if any. */
function firstIndexAfter(positions: readonly number[], index: number): number | undefined {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle]! <= index) low = middle + 1;
    else high = middle;
  }
  return positions[low];
}

/**
 * Precompute quote positions once so continuing past an unmatched quote stays
 * near-linear instead of rescanning the remaining text for every quote.
 */
function scanQuotes(text: string): QuoteScan {
  const positions: Record<QuoteCharacter, number[]> = { "'": [], '"': [] };
  const terminators: Record<QuoteCharacter, number[]> = { "'": [], '"': [] };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character !== "'" && character !== '"') continue;
    positions[character].push(index);
    const next = text[index + 1];
    if (next === undefined || QUOTE_CLOSES_BEFORE.has(next)) terminators[character].push(index);
  }
  return { positions, terminators };
}

function quotedPathSpan(text: string, start: number, scan: QuoteScan): { content: string; end: number } | undefined {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') return undefined;
  const terminator = firstIndexAfter(scan.terminators[quote], start);
  if (terminator !== undefined) {
    return { content: text.slice(start + 1, terminator), end: terminator + 1 };
  }
  const positions = scan.positions[quote];
  const last = positions[positions.length - 1];
  if (last !== undefined && last > start) {
    const content = text.slice(start + 1, last);
    // A widened span that begins with a safe URL is adjacent quoted tokens,
    // not one path; leave the opener so the scan redacts the inner token.
    if (SAFE_URL.test(content) && /["']/.test(content)) return undefined;
    return { content, end: last + 1 };
  }
  // No same quote follows. A local path token directly after the opener still
  // means the quoted path was truncated, so redact the remainder.
  const remainder = text.slice(start + 1);
  return PATH_START.test(remainder.trimStart()) ? { content: remainder, end: text.length } : undefined;
}

function redactQuotedPaths(text: string): string {
  const scan = scanQuotes(text);
  let output = '';
  let index = 0;
  while (index < text.length) {
    const quote = text[index]!;
    const opensQuote = (quote === "'" || quote === '"')
      && (index === 0 || QUOTE_OPENS_AFTER.has(text[index - 1]!));
    if (!opensQuote) {
      output += quote;
      index += 1;
      continue;
    }
    const span = quotedPathSpan(text, index, scan);
    if (span === undefined) {
      // This opener starts no single path span, so treat it as literal. Keep
      // scanning: a later quote can still open a redactable path.
      output += quote;
      index += 1;
      continue;
    }
    const isPath = /[\\/]/.test(span.content) && !GIT_REF.test(span.content) && !SAFE_URL.test(span.content);
    output += isPath ? `${quote}${PATH_PLACEHOLDER}${quote}` : text.slice(index, span.end);
    index = span.end;
  }
  return output;
}

/** Absolute-local-path token classes, in the order they must be applied. */
const FILE_URI = /\bfile:\/\/[^\s"'`<>|,;)]*/gi;
const WINDOWS_DRIVE = /\b[A-Za-z]:[\\/][^\s"'`<>|,;)]*/g;
const WINDOWS_UNC = /\\\\[^\s"'`<>|,;)]*/g;
const POSIX_ABSOLUTE = /(^|[\s(="'`[{,;:])(?:\/(?!\/)|~\/)[^\s"'`<>|,;)]*/g;

/** Provider and local job ids share the `idx_` prefix. */
const JOB_ID = /\bidx_[A-Za-z0-9_-]+/g;

/**
 * Bound and normalize terminal failure text before it reaches a tool response.
 *
 * The durable ledger keeps diagnostic detail, but §11's tool contract promises
 * that a response never carries owner identity: absolute local paths (quoted
 * paths with spaces, file URIs, Windows drive/UNC paths and POSIX absolute
 * tokens) and `idx_...` job-id tokens are replaced with placeholders after
 * control characters and whitespace are collapsed and before the
 * 400-character bound is applied.
 *
 * Pipeline order matters: collapse whitespace and control characters first so
 * the quoted-path scan sees one space per separator, then redact quoted paths
 * before the unquoted absolute rules (a quoted path can contain spaces, which
 * those token rules must not split), then redact the remaining absolute tokens
 * and job ids, then re-collapse the spaces the placeholders left behind and
 * apply the bound.
 *
 * Over-redaction is preferred to leakage: a lost diagnostic word is acceptable,
 * a returned host path or provider job id is not. URLs and Git refs survive
 * because they are source identity, not execution-host identity.
 */
export function sanitizeIndexJobError(error: string): string | undefined {
  // The tool response renders this inline, so collapse control characters and
  // whitespace and bound the length; the full text stays in the ledger.
  const normalized = [...error]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character.trim().length === 0 ? ' ' : character;
    })
    .join('');
  const redacted = redactQuotedPaths(normalized)
    .replace(FILE_URI, PATH_PLACEHOLDER)
    .replace(WINDOWS_DRIVE, PATH_PLACEHOLDER)
    .replace(WINDOWS_UNC, PATH_PLACEHOLDER)
    .replace(POSIX_ABSOLUTE, (_match, prefix: string) => `${prefix}${PATH_PLACEHOLDER}`)
    .replace(JOB_ID, JOB_ID_PLACEHOLDER)
    .replace(/ {2,}/g, ' ')
    .trim();
  return redacted.length === 0 ? undefined : redacted.slice(0, 400);
}

/**
 * Project the CLI-owned durable index-job ledger into the MCP tool shape.
 *
 * This is the safety boundary: provider job ids, the raw provider `result`
 * payload, owner identity (owner ids embed the host pid), owner-process
 * identity and `legacyData` are dropped here, and a terminal error is
 * identity-redacted and bounded. Absent counters stay absent instead of becoming `0`, so
 * the response never claims a measurement the row did not record.
 * `legacy-unavailable` rows are counted by the listing, never listed.
 */
export function projectIndexJobHistory(listing: ThaiRagIndexJobListing): RagIndexJobHistory {
  return {
    totalRowCount: listing.totalRowCount,
    matchingRowCount: listing.matchingRowCount,
    legacyRowCount: listing.legacyRowCount,
    jobs: listing.jobs.flatMap((job): RagIndexJobHistoryRow[] => {
      if (job.status === 'legacy-unavailable') return [];
      const error = job.error === undefined ? undefined : sanitizeIndexJobError(job.error);
      return [{
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        ...(job.indexedFiles === undefined ? {} : { indexedFiles: job.indexedFiles }),
        ...(job.skippedFiles === undefined ? {} : { skippedFiles: job.skippedFiles }),
        ...(job.totalFiles === undefined ? {} : { totalFiles: job.totalFiles }),
        ...(job.cacheHitFiles === undefined ? {} : { cacheHitFiles: job.cacheHitFiles }),
        ...(job.cacheHitChunks === undefined ? {} : { cacheHitChunks: job.cacheHitChunks }),
        ...(job.cacheMissFiles === undefined ? {} : { cacheMissFiles: job.cacheMissFiles }),
        ...(job.cacheMissChunks === undefined ? {} : { cacheMissChunks: job.cacheMissChunks }),
        ...(job.newEmbeddedFiles === undefined ? {} : { newEmbeddedFiles: job.newEmbeddedFiles }),
        ...(job.newEmbeddedChunks === undefined ? {} : { newEmbeddedChunks: job.newEmbeddedChunks }),
        ...(job.cacheMissReasons === undefined ? {} : { cacheMissReasons: job.cacheMissReasons }),
        status: job.status,
        force: job.force,
        ...(job.reindexReason === undefined ? {} : { reindexReason: job.reindexReason }),
        startedAt: job.startedAt,
        ...(job.progressAt === undefined ? {} : { progressAt: job.progressAt }),
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        ...(error === undefined ? {} : { error }),
      }];
    }),
  };
}

/* global Buffer, process, console */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NEGATED_CLOSING_PATTERN = new RegExp(
  String.raw`(?:\b(?:do|does|did|will|would|should|must|can)\s+not\b|\b(?:don['’]t|doesn['’]t|didn['’]t|won['’]t|wouldn['’]t|shouldn['’]t|mustn['’]t|can['’]t)\b|\bcannot\b|\bnot\b)[\s,:;()[\]{}-]+(?:(?:fully|completely|entirely|actually|intentionally|automatically|yet|directly|formally|currently|permanently|really|necessarily|safely)\s+){0,2}(?:[A-Za-z0-9]+-){0,2}(close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\b`,
  'gi',
);

/**
 * GitHub parses a positive closing keyword even when the sentence retracts it
 * immediately afterwards. "Closes #145? No — ..." still closes #145, so the
 * rhetorical form must be treated as a hazard rather than as safe prose.
 */
const RETRACTED_CLOSING_PATTERN = new RegExp(
  String.raw`\b(close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\s*(?:\?|—|–|--|:)\s*(?:no|nope|never|not(?:\s+(?:really|yet|quite))?)\b(?!\s+(?:further|more|other|additional|longer))`,
  'gi',
);

const PARENTHETICAL_RETRACTION_PATTERN = new RegExp(
  String.raw`\b(close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\s*\(\s*(?:no|nope|never|not(?:\s+(?:really|yet|quite))?)\s*\)`,
  'gi',
);

const USAGE = 'Usage: node scripts/check-issue-closing-keywords.mjs <github-event.json> | - | --title <title> --body-file <path>';

function normalizeForScan(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalKeyword(value) {
  const lower = value.toLowerCase();
  if (lower.startsWith('clos')) return 'close';
  if (lower.startsWith('fix')) return 'fix';
  return 'resolve';
}

export function findNegatedClosingKeywordHazards(metadata) {
  const hazards = [];
  const seen = new Set();

  const collect = (source, normalized, pattern) => {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const hazard = {
        source,
        keyword: canonicalKeyword(match[1]),
        issueRef: match[2],
        excerpt: match[0].trim(),
      };
      const key = `${hazard.source}\u0000${hazard.keyword}\u0000${hazard.issueRef}\u0000${hazard.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hazards.push(hazard);
    }
  };

  for (const source of ['title', 'body']) {
    const normalized = normalizeForScan(metadata?.[source] ?? '');
    collect(source, normalized, NEGATED_CLOSING_PATTERN);
    collect(source, normalized, RETRACTED_CLOSING_PATTERN);
    collect(source, normalized, PARENTHETICAL_RETRACTION_PATTERN);
  }

  return hazards;
}

export function pullRequestMetadataFromEvent(event) {
  const pullRequest = event?.pull_request;
  if (pullRequest === null || typeof pullRequest !== 'object' || typeof pullRequest.title !== 'string') {
    throw new Error('GitHub event is missing pull_request metadata');
  }

  return {
    title: pullRequest.title,
    body: typeof pullRequest.body === 'string' ? pullRequest.body : '',
  };
}

/**
 * Accept either a raw GitHub event payload or the compact `{title, body}`
 * shape returned by `gh pr view --json title,body`.
 */
export function pullRequestMetadataFromJson(value) {
  if (value !== null && typeof value === 'object' && value.pull_request !== undefined) {
    return pullRequestMetadataFromEvent(value);
  }
  if (value !== null && typeof value === 'object' && typeof value.title === 'string') {
    return {
      title: value.title,
      body: typeof value.body === 'string' ? value.body : '',
    };
  }
  throw new Error('Input is missing pull request title/body metadata');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readMetadata(args) {
  if (args.length === 0) throw new Error(USAGE);
  if (args[0] === '-') {
    return pullRequestMetadataFromJson(JSON.parse(await readStdin()));
  }

  const titleIndex = args.indexOf('--title');
  const bodyFileIndex = args.indexOf('--body-file');
  if (titleIndex !== -1 || bodyFileIndex !== -1) {
    const title = titleIndex === -1 ? undefined : args[titleIndex + 1];
    const bodyFile = bodyFileIndex === -1 ? undefined : args[bodyFileIndex + 1];
    if (title === undefined || bodyFile === undefined) {
      throw new Error(`Both --title and --body-file are required. ${USAGE}`);
    }
    return { title, body: await readFile(bodyFile, 'utf8') };
  }

  if (args.length !== 1) throw new Error(USAGE);
  return pullRequestMetadataFromJson(JSON.parse(await readFile(args[0], 'utf8')));
}

async function main(args) {
  const metadata = await readMetadata(args);
  const hazards = findNegatedClosingKeywordHazards(metadata);

  if (hazards.length === 0) {
    console.log('Issue closing-keyword safety check passed.');
    return;
  }

  console.error(
    'Unsafe negated or retracted GitHub closing keyword detected. GitHub can parse the embedded closing token even when prose negates it.',
  );
  for (const hazard of hazards) {
    console.error(`- ${hazard.source}: ${hazard.excerpt}`);
  }
  console.error(
    'Use safe non-closing wording such as `Refs #N`, `Parent #N remains open`, or `Partial scope for #N`.',
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined
  ? ''
  : pathToFileURL(path.resolve(process.argv[1])).href;

if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

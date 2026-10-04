/* global process, console */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NEGATED_CLOSING_PATTERN = new RegExp(
  String.raw`(?:\b(?:do|does|did|will|would|should|must|can)\s+not\b|\b(?:don['’]t|doesn['’]t|didn['’]t|won['’]t|wouldn['’]t|shouldn['’]t|mustn['’]t|can['’]t)\b|\bcannot\b|\bnot\b)[\s,:;()[\]{}-]+(?:(?:fully|completely|entirely|actually|intentionally|automatically|yet|directly|formally|currently|permanently|really|necessarily|safely)\s+){0,2}(close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\b`,
  'gi',
);

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

  for (const source of ['title', 'body']) {
    const normalized = normalizeForScan(metadata?.[source] ?? '');
    NEGATED_CLOSING_PATTERN.lastIndex = 0;

    for (const match of normalized.matchAll(NEGATED_CLOSING_PATTERN)) {
      hazards.push({
        source,
        keyword: canonicalKeyword(match[1]),
        issueRef: match[2],
        excerpt: match[0].trim(),
      });
    }
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

async function main(args) {
  const [eventPath] = args;
  if (eventPath === undefined || eventPath.length === 0) {
    throw new Error('Usage: node scripts/check-issue-closing-keywords.mjs <github-event.json>');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const metadata = pullRequestMetadataFromEvent(event);
  const hazards = findNegatedClosingKeywordHazards(metadata);

  if (hazards.length === 0) {
    console.log('Issue closing-keyword safety check passed.');
    return;
  }

  console.error(
    'Unsafe negated GitHub closing keyword detected. GitHub can parse the embedded closing token even when prose negates it.',
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

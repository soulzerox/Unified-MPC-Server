import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findNegatedClosingKeywordHazards,
  pullRequestMetadataFromEvent,
} from './check-issue-closing-keywords.mjs';

test('flags negated native closing keywords even when Markdown wraps the negation', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'feat(#80): cleanup observability',
    body: 'Refs #80. This PR does **not** close #80.',
  });

  assert.deepEqual(hazards, [
    {
      source: 'body',
      keyword: 'close',
      issueRef: '#80',
      excerpt: 'does not close #80',
    },
  ]);
});

test('flags negated fix/resolve forms, contractions, and qualified issue references', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: "This doesn't fix #63",
    body: [
      'Do not fixes soulzerox/Unified-MPC-Server#82.',
      "This won't resolve owner/repo#103.",
      'This is not resolved #228.',
    ].join('\n'),
  });

  assert.deepEqual(
    hazards.map(({ source, keyword, issueRef }) => ({ source, keyword, issueRef })),
    [
      { source: 'title', keyword: 'fix', issueRef: '#63' },
      { source: 'body', keyword: 'fix', issueRef: 'soulzerox/Unified-MPC-Server#82' },
      { source: 'body', keyword: 'resolve', issueRef: 'owner/repo#103' },
      { source: 'body', keyword: 'resolve', issueRef: '#228' },
    ],
  );
});

test('allows safe non-closing wording and leaves legitimate explicit close intent to the later closure-evidence gate', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'feat: complete bounded work',
    body: [
      'Refs #80',
      'Parent #80 remains open',
      'Partial scope for #80',
      'Closes #12',
      'Fixes owner/repo#13',
    ].join('\n'),
  });

  assert.deepEqual(hazards, []);
});

test('does not treat prose containing not only as a negation hazard', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'docs',
    body: 'This not only fixes #12, it also improves diagnostics.',
  });

  assert.deepEqual(hazards, []);
});

test('flags negated closing keywords when bounded qualifiers separate the negation from the native token', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'docs',
    body: [
      'This PR does not fully close #80.',
      "This won't automatically fix owner/repo#63.",
      'The issue is not yet completely resolved #82.',
    ].join('\n'),
  });

  assert.deepEqual(
    hazards.map(({ keyword, issueRef }) => ({ keyword, issueRef })),
    [
      { keyword: 'close', issueRef: '#80' },
      { keyword: 'fix', issueRef: 'owner/repo#63' },
      { keyword: 'resolve', issueRef: '#82' },
    ],
  );
});

test('extracts pull request title/body from the GitHub event payload conservatively', () => {
  assert.deepEqual(
    pullRequestMetadataFromEvent({
      pull_request: {
        title: 'feat(#80): partial slice',
        body: null,
      },
    }),
    {
      title: 'feat(#80): partial slice',
      body: '',
    },
  );

  assert.throws(
    () => pullRequestMetadataFromEvent({ issue: { number: 80 } }),
    /pull_request metadata/,
  );
});

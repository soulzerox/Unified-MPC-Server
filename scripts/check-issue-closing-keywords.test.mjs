import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findNegatedClosingKeywordHazards,
  pullRequestMetadataFromEvent,
  pullRequestMetadataFromJson,
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

test('flags negated prefixed closing tokens that GitHub still interprets as close intent', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'feat(#99): trusted lifecycle mutation',
    body: 'Parent #99 remains open for final acceptance. This PR intentionally does not auto-close #99.',
  });

  assert.deepEqual(hazards, [
    {
      source: 'body',
      keyword: 'close',
      issueRef: '#99',
      excerpt: 'does not auto-close #99',
    },
  ]);
});

test('flags a positive closing keyword retracted by a following question and No', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'feat(queue): persist heavy-job queue state across restart (#145)',
    body: 'Closes #145? No — detached workers and cross-process wait/wakeup remain in #305.',
  });

  assert.deepEqual(hazards, [
    {
      source: 'body',
      keyword: 'close',
      issueRef: '#145',
      excerpt: 'Closes #145? No',
    },
  ]);
});

test('flags dash, colon and parenthetical retractions of positive closing keywords', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'docs',
    body: [
      'Closes #10 — no, the parent stays open.',
      'Fixes #11: not yet.',
      'Resolves owner/repo#12 (not really).',
    ].join('\n'),
  });

  assert.deepEqual(
    hazards.map(({ keyword, issueRef }) => ({ keyword, issueRef })),
    [
      { keyword: 'close', issueRef: '#10' },
      { keyword: 'fix', issueRef: '#11' },
      { keyword: 'resolve', issueRef: 'owner/repo#12' },
    ],
  );
});

test('does not flag legitimate closures or comma-separated negated references', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'feat: complete bounded work',
    body: [
      'Closes #20',
      'Closes #21: no further action is needed.',
      'Closes #22, not #23.',
    ].join('\n'),
  });

  assert.deepEqual(hazards, []);
});

test('accepts compact gh pr view metadata as well as a GitHub event payload', () => {
  assert.deepEqual(
    pullRequestMetadataFromJson({ title: 'feat: partial slice', body: null }),
    { title: 'feat: partial slice', body: '' },
  );
  assert.deepEqual(
    pullRequestMetadataFromJson({ pull_request: { title: 'feat: partial slice', body: 'Refs #80' } }),
    { title: 'feat: partial slice', body: 'Refs #80' },
  );
  assert.throws(
    () => pullRequestMetadataFromJson({}),
    /title\/body metadata/,
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

test('flags retractions with words between the negation and the keyword', () => {
  const hazards = findNegatedClosingKeywordHazards({
    title: 'Nothing here closes #71',
    body: [
      'This does not, however, close #72.',
      'This is not intended to close #73.',
      'This never closes #74.',
      'This is not a PR that fixes #75.',
    ].join('\n'),
  });

  assert.deepEqual(
    hazards.map(({ source, keyword, issueRef }) => ({ source, keyword, issueRef })),
    [
      { source: 'title', keyword: 'close', issueRef: '#71' },
      { source: 'body', keyword: 'close', issueRef: '#72' },
      { source: 'body', keyword: 'close', issueRef: '#73' },
      { source: 'body', keyword: 'close', issueRef: '#74' },
      { source: 'body', keyword: 'fix', issueRef: '#75' },
    ],
  );
});

test('does not flag a real closure that follows "not only"', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: 'This not only fixes #81 but also resolves #82.',
  });

  assert.deepEqual(hazards, []);
});

test('does not read a negation on one line as retracting a keyword on the next', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: ['- Nothing here', '- Closes #91', 'Never mind the details.', 'Closes #92'].join('\n'),
  });

  assert.deepEqual(hazards, []);
});

test('does not scan past an intervening "not only" closure from an earlier negation', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: 'Nothing here, not only fixes #93 but also resolves #94.',
  });

  assert.deepEqual(hazards, []);
});

test('keeps the excerpt on one line for a multi-line retraction', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: 'This does not,\nhowever, close #95.',
  });

  assert.deepEqual(
    hazards.map(({ source, keyword, issueRef, excerpt }) => ({ source, keyword, issueRef, excerpt })),
    [{ source: 'body', keyword: 'close', issueRef: '#95', excerpt: 'not, however, close #95' }],
  );
});

test('does not cross a blank line from a negation to a later closure', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: 'Nothing here\n\nCloses #96',
  });

  assert.deepEqual(hazards, []);
});

test('treats a heading line as its own block when the next line closes an issue', () => {
  const hazards = findNegatedClosingKeywordHazards({
    body: '## Nothing here\nCloses #97',
  });

  assert.deepEqual(hazards, []);
});

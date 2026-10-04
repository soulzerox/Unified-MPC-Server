import { describe, expect, it } from 'vitest';
import type { MergeEvidenceDecision } from './merge-verification.js';
import {
  evaluateIssueClosureEvidence,
  type IssueClosureEvidenceInput,
} from './issue-closure-evidence.js';

const mergeAllowed: MergeEvidenceDecision = {
  status: 'MERGE_ALLOWED',
  blockers: [],
};

function verification(
  implementationPR: string,
  receiptRef: string,
): IssueClosureEvidenceInput['mergeVerifications'][number] {
  return {
    implementationPR,
    decision: mergeAllowed,
    receiptRef,
  };
}

describe('historical issue closure acceptance fixtures', () => {
  it('rejects Unified #63 / PR #65 because the merged foundation slice explicitly left parent scope open', () => {
    const receipt = evaluateIssueClosureEvidence({
      issue: 'soulzerox/Unified-MPC-Server#63',
      implementationPRs: ['soulzerox/Unified-MPC-Server#65'],
      closeIntent: 'reference_only',
      antiCloseMarkers: [
        'This PR intentionally does not close #63',
        'Remaining #63 scope includes brownfield convergence and reference accounting',
      ],
      criteria: [
        {
          criterion: 'dependency resource manager foundation',
          source: { kind: 'issue_body', ref: 'Unified#63' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Unified#65@76f0fc54190e9727aeecedff9182311757a4ea4e'],
          },
        },
        {
          criterion: 'brownfield convergence, active-reference accounting, cleanup/GC and stress coverage',
          source: { kind: 'other', ref: 'Unified#65:remaining-scope' },
          disposition: { kind: 'unresolved' },
        },
      ],
      mergeVerifications: [
        verification(
          'soulzerox/Unified-MPC-Server#65',
          'historical-merge:Unified#65@76f0fc54190e9727aeecedff9182311757a4ea4e',
        ),
      ],
    });

    expect(receipt).toMatchObject({
      closeAllowed: false,
      reason: 'explicit_close_intent_missing',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'explicit_close_intent_missing' }),
        expect.objectContaining({
          code: 'anti_close_fence',
          evidence: 'This PR intentionally does not close #63',
        }),
        expect.objectContaining({
          code: 'unresolved_criterion',
          criterion: 'brownfield convergence, active-reference accounting, cleanup/GC and stress coverage',
        }),
      ]),
    });
  });

  it('rejects Unified #82 / PR #98 because the snapshot-store slice explicitly left runtime-control-plane work open', () => {
    const receipt = evaluateIssueClosureEvidence({
      issue: 'soulzerox/Unified-MPC-Server#82',
      implementationPRs: ['soulzerox/Unified-MPC-Server#98'],
      closeIntent: 'reference_only',
      antiCloseMarkers: [
        'This completes the durable projection snapshot store slice of #82; it does not close #82',
      ],
      criteria: [
        {
          criterion: 'durable authoritative Goal runtime snapshot store',
          source: { kind: 'issue_body', ref: 'Unified#82' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Unified#98@e352402d54a9b3026aaef923c7693ddb2c674633'],
          },
        },
        {
          criterion: 'heartbeat/liveness, restart reconciliation, SSE/API and janitor integration',
          source: { kind: 'other', ref: 'Unified#98:remaining-scope' },
          disposition: { kind: 'unresolved' },
        },
      ],
      mergeVerifications: [
        verification(
          'soulzerox/Unified-MPC-Server#98',
          'historical-merge:Unified#98@e352402d54a9b3026aaef923c7693ddb2c674633',
        ),
      ],
    });

    expect(receipt).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'explicit_close_intent_missing' }),
        expect.objectContaining({
          code: 'anti_close_fence',
        }),
        expect.objectContaining({
          code: 'unresolved_criterion',
          criterion: 'heartbeat/liveness, restart reconciliation, SSE/API and janitor integration',
        }),
      ]),
    });
  });

  it('allows Webtrans #114 / PR #116 to close while the separate #86 umbrella remains open', () => {
    const receipt = evaluateIssueClosureEvidence({
      issue: 'soulzerox/Webtrans#114',
      implementationPRs: ['soulzerox/Webtrans#116'],
      closeIntent: 'explicit_close',
      antiCloseMarkers: [],
      criteria: [
        {
          criterion: 'deterministic engine-bundle retention independent of filesystem mtime',
          source: { kind: 'issue_body', ref: 'Webtrans#114' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Webtrans#116@f820e4a78783e5e5f37fce4cb6f8097f03ba2181'],
          },
        },
        {
          criterion: 'preserve current and previous-good rollback bundles',
          source: { kind: 'issue_body', ref: 'Webtrans#114' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Webtrans#116:engine-retention-regression'],
          },
        },
      ],
      mergeVerifications: [
        verification(
          'soulzerox/Webtrans#116',
          'historical-merge:Webtrans#116@f820e4a78783e5e5f37fce4cb6f8097f03ba2181',
        ),
      ],
    });

    expect(receipt).toMatchObject({
      closeAllowed: true,
      reason: 'closure_evidence_complete',
      successorScope: [],
      unresolvedCriteria: [],
      blockers: [],
    });
  });

  it('allows Webtrans #65 / PR #115 to close without treating downstream or umbrella issues as unfinished #65 scope', () => {
    const receipt = evaluateIssueClosureEvidence({
      issue: 'soulzerox/Webtrans#65',
      implementationPRs: ['soulzerox/Webtrans#115'],
      closeIntent: 'explicit_close',
      antiCloseMarkers: [],
      criteria: [
        {
          criterion: 'redact credentials from HTTP/WSS URLs, headers, errors and persisted debug logs',
          source: { kind: 'issue_body', ref: 'Webtrans#65' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Webtrans#115@9bd1a15685a325c27da13123895eb3fa3e5f1eaa'],
          },
        },
        {
          criterion: 'security regressions cover success/error/timeout and legacy persisted log paths',
          source: { kind: 'issue_body', ref: 'Webtrans#65' },
          disposition: {
            kind: 'satisfied',
            evidence: ['Webtrans#115:25/25-focused-security-tests'],
          },
        },
      ],
      mergeVerifications: [
        verification(
          'soulzerox/Webtrans#115',
          'historical-merge:Webtrans#115@9bd1a15685a325c27da13123895eb3fa3e5f1eaa',
        ),
      ],
    });

    expect(receipt).toMatchObject({
      closeAllowed: true,
      reason: 'closure_evidence_complete',
      successorScope: [],
      unresolvedCriteria: [],
      blockers: [],
    });
  });

  it('allows thai-rag #18 to close after its remaining queue is explicitly transferred to open durable owners', () => {
    const receipt = evaluateIssueClosureEvidence({
      issue: 'soulzerox/thai-rag-mcp#18',
      implementationPRs: [
        'soulzerox/thai-rag-mcp#19',
        'soulzerox/thai-rag-mcp#20',
      ],
      closeIntent: 'explicit_close',
      antiCloseMarkers: [],
      criteria: [
        {
          criterion: '#9 reproducible standalone packaging and hermetic tests',
          source: { kind: 'issue_body', ref: 'thai-rag#18:queue' },
          disposition: {
            kind: 'satisfied',
            evidence: ['thai-rag#19@20482deac8603009a796aaf35c371c60dffa0a54'],
          },
        },
        {
          criterion: '#16 permanent repository CI quality gate',
          source: { kind: 'issue_body', ref: 'thai-rag#18:queue' },
          disposition: {
            kind: 'satisfied',
            evidence: ['thai-rag#20@0b0a9b1199736ab5e3c2440bb2401539913e041f'],
          },
        },
        {
          criterion: '#3 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#3',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#3'],
          },
        },
        {
          criterion: '#4 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#4',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#4'],
          },
        },
        {
          criterion: '#5 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#5',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#5'],
          },
        },
        {
          criterion: '#6 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#6',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#6'],
          },
        },
        {
          criterion: '#7 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#7',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#7'],
          },
        },
        {
          criterion: '#8 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#8',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#8'],
          },
        },
        {
          criterion: '#10 remaining Unified-aligned phase',
          source: { kind: 'issue_comment', ref: 'thai-rag#18:dependency-audit' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#10',
            ownerState: 'open',
            linkEvidence: ['thai-rag#18:dependency-audit->#10'],
          },
        },
      ],
      mergeVerifications: [
        verification(
          'soulzerox/thai-rag-mcp#19',
          'historical-merge:thai-rag#19@20482deac8603009a796aaf35c371c60dffa0a54',
        ),
        verification(
          'soulzerox/thai-rag-mcp#20',
          'historical-merge:thai-rag#20@0b0a9b1199736ab5e3c2440bb2401539913e041f',
        ),
      ],
    });

    expect(receipt).toMatchObject({
      closeAllowed: true,
      reason: 'closure_evidence_complete',
      unresolvedCriteria: [],
      blockers: [],
    });
    expect(receipt.successorScope.map((scope) => scope.ownerIssue)).toEqual([
      'soulzerox/thai-rag-mcp#3',
      'soulzerox/thai-rag-mcp#4',
      'soulzerox/thai-rag-mcp#5',
      'soulzerox/thai-rag-mcp#6',
      'soulzerox/thai-rag-mcp#7',
      'soulzerox/thai-rag-mcp#8',
      'soulzerox/thai-rag-mcp#10',
    ]);
  });
});

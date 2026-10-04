import { createHash } from 'node:crypto';

export const STRUCTURAL_EVIDENCE_IDENTITY_VERSION = 1 as const;

export type StructuralEvidenceResolution = 'resolved' | 'heuristic' | 'unresolved';

export interface StructuralSymbolEvidenceIdentityInput {
  readonly sourceFileId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly symbolKind: string;
  readonly qualifiedName: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface StructuralEdgeEvidenceIdentityInput {
  readonly sourceSymbolId: string;
  readonly edgeKind: string;
  readonly targetRef: string;
  readonly resolution: StructuralEvidenceResolution;
  readonly extractorId: string;
  readonly extractorVersion: string;
}

export interface StructuralSourceRange {
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface StructuralSymbolEvidence extends StructuralSourceRange {
  readonly symbolId: string;
  readonly sourceFileId: string;
  readonly symbolKind: string;
  readonly qualifiedName: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
}

export interface StructuralEdgeEvidence {
  readonly edgeId: string;
  readonly sourceSymbolId: string;
  readonly targetSymbolId?: string;
  readonly targetCandidateSymbolIds: readonly string[];
  readonly edgeKind: string;
  readonly resolution: StructuralEvidenceResolution;
  readonly provenance: string;
  readonly extractorVersion: string;
}

function requireIdentityPart(name: string, value: string): string {
  if (value.length === 0 || value.includes('\u0000')) {
    throw new TypeError(`${name} must be non-empty and must not contain NUL`);
  }
  return value;
}

function requireLine(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireResolution(value: StructuralEvidenceResolution): StructuralEvidenceResolution {
  if (value !== 'resolved' && value !== 'heuristic' && value !== 'unresolved') {
    throw new TypeError('resolution must be resolved, heuristic, or unresolved');
  }
  return value;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

/**
 * Stable v1 identity for structural symbol evidence.
 *
 * sourceFileId is supplied by the source authority. This module deliberately
 * does not derive repository, revision, workspace, or path identity.
 */
export function structuralSymbolEvidenceId(input: StructuralSymbolEvidenceIdentityInput): string {
  const lineStart = requireLine('lineStart', input.lineStart);
  const lineEnd = requireLine('lineEnd', input.lineEnd);
  if (lineEnd < lineStart) throw new RangeError('lineEnd must be >= lineStart');

  return `sym:v1:${digest([
    'structural-symbol',
    'v1',
    requireIdentityPart('sourceFileId', input.sourceFileId),
    requireIdentityPart('extractorId', input.extractorId),
    requireIdentityPart('extractorVersion', input.extractorVersion),
    requireIdentityPart('symbolKind', input.symbolKind),
    requireIdentityPart('qualifiedName', input.qualifiedName),
    String(lineStart),
    String(lineEnd),
  ])}`;
}

/**
 * Stable v1 identity for structural edge evidence.
 *
 * targetRef is an authoritative target symbol ID when resolved, or a stable
 * local candidate/reference token for heuristic/unresolved evidence.
 */
export function structuralEdgeEvidenceId(input: StructuralEdgeEvidenceIdentityInput): string {
  return `edge:v1:${digest([
    'structural-edge',
    'v1',
    requireIdentityPart('sourceSymbolId', input.sourceSymbolId),
    requireIdentityPart('edgeKind', input.edgeKind),
    requireResolution(input.resolution),
    requireIdentityPart('targetRef', input.targetRef),
    requireIdentityPart('extractorId', input.extractorId),
    requireIdentityPart('extractorVersion', input.extractorVersion),
  ])}`;
}

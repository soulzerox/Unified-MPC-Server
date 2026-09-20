import type { AppError, Result, ResultBudget } from '@unified-mpc/domain';
import { estimateJsonBytesBounded } from './bounded-json-size.js';

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpImageContent {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

export interface McpToolResponse {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export interface ToolResultTruncationEvent {
  readonly toolName?: string;
  readonly originalBytes: number;
  readonly maxBytes: number;
  readonly limitType: 'text' | 'structured' | 'binary' | 'base64';
}

export interface MapResultOptions {
  readonly maxBytes?: number;
  readonly budget?: Partial<ResultBudget>;
  readonly toolName?: string;
  readonly onTruncated?: (event: ToolResultTruncationEvent) => void;
}

const STRUCTURED_ONLY_TEXT = '[structured content omitted from text representation]';

export function mapResult<T>(result: Result<T>, options: MapResultOptions = {}): McpToolResponse {
  if (!result.ok) return mapError(result.error);
  const image = extractImageContent(result.value);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const budget = resolveBudget(options.budget, maxBytes);
  if (image !== undefined) {
    const binaryBytes = Buffer.byteLength(image.data, 'base64');
    const base64Bytes = Buffer.byteLength(image.data, 'utf8');
    if (binaryBytes > budget.maxBinaryBytes) return truncatedResponse(options, binaryBytes, budget.maxBinaryBytes, 'binary');
    if (base64Bytes > budget.maxBase64Bytes) return truncatedResponse(options, base64Bytes, budget.maxBase64Bytes, 'base64');
  }
  const encoded = extractEncodedContent(result.value);
  if (encoded !== undefined) {
    const binaryBytes = Buffer.byteLength(encoded.data, 'base64');
    const base64Bytes = Buffer.byteLength(encoded.data, 'utf8');
    if (binaryBytes > budget.maxBinaryBytes) return truncatedResponse(options, binaryBytes, budget.maxBinaryBytes, 'binary');
    if (base64Bytes > budget.maxBase64Bytes) return truncatedResponse(options, base64Bytes, budget.maxBase64Bytes, 'base64');
  }
  const structuredContent = toStructuredContent(result.value);
  const hasStructuredPayload = typeof result.value === 'object' && result.value !== null;
  const structuredBytes = structuredContent === undefined ? 0 : estimateJsonBytesBounded(structuredContent, budget.maxStructuredBytes);
  if (structuredBytes > budget.maxStructuredBytes) return truncatedResponse(options, structuredBytes, budget.maxStructuredBytes, 'structured');
  const textBytes = estimateJsonBytesBounded(result.value, budget.maxTextBytes);
  if (textBytes > budget.maxTextBytes) {
    if (image === undefined) return truncatedResponse(options, textBytes, budget.maxTextBytes, 'text');
    return { content: [image] };
  }
  const aggregateBudget = maxBytes ?? budget.maxStructuredBytes;
  if (hasStructuredPayload && structuredBytes + textBytes > aggregateBudget) {
    const structuredOnlyBytes = Buffer.byteLength(STRUCTURED_ONLY_TEXT, 'utf8');
    if (structuredBytes + structuredOnlyBytes <= aggregateBudget) {
      return {
        content: [{ type: 'text', text: STRUCTURED_ONLY_TEXT }],
        ...(structuredContent === undefined ? {} : { structuredContent }),
      };
    }
    return truncatedResponse(options, structuredBytes + textBytes, aggregateBudget, 'structured');
  }
  const text = toText(result.value);
  return {
    content: image === undefined ? [{ type: 'text', text }] : [image, { type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

export function mapError(error: AppError): McpToolResponse {
  const message = error.code === 'INTERNAL_ERROR' ? 'Operation failed' : error.message;
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${message}` }],
    structuredContent: {
      error: {
        code: error.code,
        message,
        recoverable: error.recoverable,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}

function normalizeMaxBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resolveBudget(budget: Partial<ResultBudget> | undefined, maxBytes: number | undefined): ResultBudget {
  const fallback = maxBytes ?? Number.MAX_SAFE_INTEGER;
  return {
    maxItems: normalizeBudgetValue(budget?.maxItems, Number.MAX_SAFE_INTEGER),
    maxTextBytes: normalizeBudgetValue(budget?.maxTextBytes, fallback),
    maxStructuredBytes: normalizeBudgetValue(budget?.maxStructuredBytes, fallback),
    maxBinaryBytes: normalizeBudgetValue(budget?.maxBinaryBytes, fallback),
    maxBase64Bytes: normalizeBudgetValue(budget?.maxBase64Bytes, fallback),
  };
}

function normalizeBudgetValue(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function truncatedResponse(options: MapResultOptions, originalBytes: number, maxBytes: number, limitType: ToolResultTruncationEvent['limitType']): McpToolResponse {
  const event = {
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    originalBytes,
    maxBytes,
    limitType,
  };
  try { options.onTruncated?.(event); } catch { /* diagnostics must not affect the response */ }
  return { content: [{ type: 'text', text: JSON.stringify({
    truncated: true,
    reason: 'tool_result_exceeds_output_budget',
    ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
    originalBytes,
    maxBytes,
    limitType,
    hint: 'Retry with a narrower query, pagination, or a smaller response target.',
  }) }] };
}

function toText(value: unknown): string {
  if (value === undefined) return 'null';
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

function toStructuredContent(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value };
  return value as Readonly<Record<string, unknown>>;
}

function extractEncodedContent(value: unknown): { readonly data: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.encoding === 'base64' && typeof record.content === 'string') return { data: record.content };
  if (typeof record.data_base64 === 'string') return { data: record.data_base64 };
  return extractEncodedContent(record.image);
}

function extractImageContent(value: unknown): McpImageContent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (record.encoding === 'base64' && typeof record.content === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
    return { type: 'image', data: record.content, mimeType: record.mimeType };
  }
  if (typeof record.data_base64 === 'string' && typeof record.mime_type === 'string' && record.mime_type.startsWith('image/')) {
    return { type: 'image', data: record.data_base64, mimeType: record.mime_type };
  }
  return extractImageContent(record.image);
}

import type { AppError, Result, ResultBudget } from '@unified-mpc/domain';

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
  const structuredContent = toStructuredContent(result.value);
  const hasStructuredPayload = typeof result.value === 'object' && result.value !== null;
  if (hasStructuredPayload && structuredContent !== undefined) {
    const structuredBytes = estimateJsonBytes(structuredContent, budget.maxStructuredBytes);
    if (structuredBytes > budget.maxStructuredBytes) return truncatedResponse(options, structuredBytes, budget.maxStructuredBytes, 'structured');
  }
  const textBytes = hasStructuredPayload ? 0 : estimateJsonBytes(result.value, budget.maxTextBytes);
  if (textBytes > budget.maxTextBytes) {
    if (image === undefined) return truncatedResponse(options, textBytes, budget.maxTextBytes, 'text');
    return { content: [image] };
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

function estimateJsonBytes(value: unknown, limit: number, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return Math.min(limit + 1, jsonStringBytes(value));
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 4 : Buffer.byteLength(serialized, 'utf8');
  }
  if (seen.has(value)) return limit + 1;
  seen.add(value);
  let bytes = 2;
  const entries = Array.isArray(value) ? value.map((entry) => [undefined, entry] as const) : Object.entries(value);
  for (const [key, entry] of entries) {
    if (key !== undefined) bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
    bytes += estimateJsonBytes(entry, Math.max(0, limit - bytes), seen) + (key === undefined ? 1 : 1);
    if (bytes > limit) return limit + 1;
  }
  seen.delete(value);
  return bytes;
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) bytes += 2;
    else if (code <= 0x1f) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else bytes += Buffer.byteLength(value[index] ?? '', 'utf8');
  }
  return bytes;
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

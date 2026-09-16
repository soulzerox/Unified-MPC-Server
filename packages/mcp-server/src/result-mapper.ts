import type { AppError, Result } from '@unified-mpc/domain';

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
}

export interface MapResultOptions {
  readonly maxBytes?: number;
  readonly toolName?: string;
  readonly onTruncated?: (event: ToolResultTruncationEvent) => void;
}

export function mapResult<T>(result: Result<T>, options: MapResultOptions = {}): McpToolResponse {
  if (!result.ok) return mapError(result.error);
  const image = extractImageContent(result.value);
  const text = toText(result.value);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  if (image === undefined && maxBytes !== undefined) {
    const originalBytes = Buffer.byteLength(text, 'utf8');
    if (originalBytes > maxBytes) {
      const event = {
        ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
        originalBytes,
        maxBytes,
      };
      try { options.onTruncated?.(event); } catch { /* diagnostics must not affect the response */ }
      const envelope = {
        truncated: true,
        reason: 'tool_result_exceeds_output_budget',
        ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
        originalBytes,
        maxBytes,
        hint: 'Retry with a narrower query, pagination, or a smaller response target.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    }
  }
  const structuredContent = toStructuredContent(result.value);
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

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@unified-mpc/domain';

export interface BinaryFileResult {
  readonly content: string;
  readonly encoding: 'utf8' | 'base64';
  readonly mimeType: string;
  readonly byteLength: number;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Reads a file with no application size cap.
 * UTF-8 text without NULs is returned as utf8; otherwise base64.
 */
export class UnboundedFileReader {
  public async read(filePath: string, maxBytes?: number, signal?: AbortSignal): Promise<Result<BinaryFileResult>> {
    if (signal !== undefined && signal.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'File read was cancelled', recoverable: true });
    let data: Buffer;
    try {
      const size = (await stat(filePath)).size;
      if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 && size > Math.floor(maxBytes)) {
        return err({ code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum read size', recoverable: false });
      }
      data = await readFile(filePath, signal === undefined ? undefined : { signal });
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'File was not found', recoverable: false });
    }
    if (signal !== undefined && signal.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'File read was cancelled', recoverable: true });
    if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 && data.byteLength > Math.floor(maxBytes)) {
      return err({ code: 'FILE_TOO_LARGE', message: 'File exceeds the maximum read size', recoverable: false });
    }

    const mimeType = guessMimeType(filePath);
    if (mimeType.startsWith('image/')) {
      return ok({
        content: data.toString('base64'),
        encoding: 'base64',
        mimeType,
        byteLength: data.byteLength,
        startLine: 1,
        endLine: 1,
      });
    }
    if (!data.subarray(0, 8192).includes(0)) {
      const content = data.toString('utf8');
      const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      return ok({
        content,
        encoding: 'utf8',
        mimeType: mimeType.startsWith('text/') || mimeType === 'application/json' ? mimeType : 'text/plain',
        byteLength: data.byteLength,
        startLine: lineCount === 0 ? 1 : 1,
        endLine: Math.max(lineCount, 1),
      });
    }

    return ok({
      content: data.toString('base64'),
      encoding: 'base64',
      mimeType,
      byteLength: data.byteLength,
      startLine: 1,
      endLine: 1,
    });
  }
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.avif': return 'image/avif';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.txt':
    case '.md':
    case '.csv': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

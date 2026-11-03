import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a file by renaming a uniquely named temporary sibling over it. A
 * concurrent writer can only replace the whole file; readers never observe a
 * half-written document, and a crash between write and rename leaves the
 * previous content intact.
 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore temp cleanup error
    }
    throw error;
  }
}

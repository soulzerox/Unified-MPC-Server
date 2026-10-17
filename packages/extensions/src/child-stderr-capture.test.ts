import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { captureChildStderr } from './child-stderr-capture.js';

describe('child stderr capture', () => {
  it('retains the child stderr tail so a dead worker can explain itself', () => {
    const stderr = new PassThrough();
    const capture = captureChildStderr(stderr);
    stderr.write('loading vector store\n');
    stderr.write('native crash: Segmentation fault\n');
    expect(capture.tail()).toContain('native crash: Segmentation fault');
    capture.drain();
  });

  it('keeps only the newest bytes of a noisy child', () => {
    const stderr = new PassThrough();
    const capture = captureChildStderr(stderr, { maxBytes: 64 });
    stderr.write('x'.repeat(200));
    stderr.write('LAST-MARKER');
    const tail = capture.tail();
    expect(tail.length).toBeLessThanOrEqual(64);
    expect(tail).toContain('LAST-MARKER');
    capture.drain();
  });

  it('stops accumulating once drained and tolerates a non-drainable stream', () => {
    const stderr = new PassThrough();
    const capture = captureChildStderr(stderr);
    stderr.write('before drain\n');
    capture.drain();
    stderr.write('after drain\n');
    expect(capture.tail()).toContain('before drain');
    expect(capture.tail()).not.toContain('after drain');

    const nothing = captureChildStderr(undefined);
    nothing.drain();
    expect(nothing.tail()).toBe('');
  });
});

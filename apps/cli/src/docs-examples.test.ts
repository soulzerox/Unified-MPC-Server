import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './index.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

/** Markdown files that show runnable `unified-mpc` / `pnpm cli` examples. */
const DOC_FILES = ['README.md', path.join('docs', 'CLI_REFERENCE.md'), path.join('docs', 'USAGE_TH.md')] as const;

/** Shell examples that are grammar lines, not runnable commands. */
const PLACEHOLDER = /</;

function shellExamples(markdown: string): string[] {
  const examples: string[] = [];
  for (const block of markdown.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    // A trailing backslash continues the command on the next line.
    const body = block[1]!.replace(/\\\r?\n/g, ' ');
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/^\$ /, '');
      if (line.length === 0 || line.startsWith('#')) continue;
      if (/^unified-mpc(\s|$)/.test(line)) examples.push(line);
      else if (/^pnpm cli(\s|$)/.test(line)) examples.push(line.replace(/^pnpm cli/, 'unified-mpc'));
    }
  }
  return examples;
}

function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
}

describe('documented CLI examples', () => {
  for (const file of DOC_FILES) {
    describe(file, () => {
      const examples = shellExamples(readFileSync(path.join(repoRoot, file), 'utf8'));

      it('contains examples to check', () => {
        expect(examples.length).toBeGreaterThan(0);
      });

      for (const example of examples) {
        // Grammar lines such as `unified-mpc <command> [flags]` document the shape
        // of the CLI rather than a command a reader can run.
        if (PLACEHOLDER.test(example)) continue;
        it(`parses: ${example}`, () => {
          const parsed = parseCliArgs(tokenize(example).slice(1));
          expect(parsed.ok, parsed.ok ? undefined : `${example} -> ${parsed.error.message}`).toBe(true);
        });
      }
    });
  }
});

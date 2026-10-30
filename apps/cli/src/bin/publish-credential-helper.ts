#!/usr/bin/env node
import { runPublishCredentialHelperProcess } from '../runtime/publish-credential-helper.js';

// The helper answers exactly one Git credential operation and is silent on
// every other path, including failure (#297 §3). It never writes a diagnostic
// to stderr: the reason belongs to the host process, not to this child, and an
// unexpected throw must not turn into a stack trace either.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
try {
  process.exitCode = await runPublishCredentialHelperProcess();
} catch {
  process.exitCode = 1;
}

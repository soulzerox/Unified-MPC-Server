# Exercise 03.01: Conversational Memory & JIT Pre-Edit Verification

## Problem Statement
Implement a workflow that records user architectural constraints during a coding session and verifies them before attempting any refactoring on target files.

### Tasks
1. Record a turn containing a critical constraint (e.g. "Do not modify the database schema without a migration").
2. Query `pre_edit_context` before modifying the corresponding database module.
3. Verify that the recorded constraint is surfaced in the pre-edit check output.


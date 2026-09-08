# Exercise 03.02: Code Property Graph (CPG-Lite) & Blast Radius Analysis

## Problem Statement
Using CPG-Lite, inspect the codebase dependency graph to compute the blast radius before refactoring a foundational method.

### Tasks
1. Parse AST symbols and edges from a multi-file Python or TypeScript module.
2. Query the call graph for a deep leaf function (e.g. `save_parent_doc`).
3. Verify that all inbound callers across different files are detected with their respective recursion depths.


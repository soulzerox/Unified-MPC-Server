# Exercise 03.02: Code Property Graph (CPG-Lite) & Blast Radius Analysis

Explore how Code Property Graph (CPG) extracts AST symbols and relationship edges to compute multi-hop call graphs and blast radius analysis.

## Key Concepts
- `code_symbols` & `code_edges`: SQLite tables storing classes, functions, methods, imports, and calls.
- `WITH RECURSIVE`: SQL common table expressions querying caller/callee trees up to arbitrary depth in sub-millisecond time.
- `code_blast_radius(symbol_name, workspace, max_depth)`: Identifies all direct and transitive callers across the codebase that will be affected by changing a symbol.


# Exercise 02.01: AST-Aware Code RAG & Hybrid Retrieval

In this exercise, you will understand how source code files are parsed into enclosing AST function blocks, indexed into SQLite FTS5 (for exact symbols) and ChromaDB (for dense vectors), and fused using Reciprocal Rank Fusion (RRF).

## Key Concepts
- Lexical search (BM25 / FTS5) guarantees exact symbol lookup.
- Dense vector search retrieves conceptual Thai queries.
- Reciprocal Rank Fusion (RRF) scores each document fairly across both systems.

# Exercise 01.01: Agent Memory with Local Ollama

In this exercise, you will explore how the Local Context MCP server stores and retrieves long-term agent memories using local vector embeddings (`nomic-embed-text-v2-moe`) and SQLite.

## Key Concepts
- `remember(content, category)` embeds text with `search_document:` prefix and stores it in SQLite + ChromaDB.
- `recall(query, category)` embeds query with `search_query:` prefix and computes cosine distance over the memory collection.

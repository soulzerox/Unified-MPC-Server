# Exercise 03.02: Code Property Graph (CPG-Lite) & Blast Radius Analysis

## Reference Solution
```python
from thai_rag.server import get_server

server = get_server()

# Step 1: Query blast radius for a symbol
blast_report = server.code_blast_radius("save_conversation_turn", workspace="thai-rag-mcp", max_depth=2)

print(blast_report)
# Confirms inbound callers (e.g. remember_turn, tests) and impacted files.
```


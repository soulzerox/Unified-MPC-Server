# Exercise 03.01: Conversational Memory & JIT Pre-Edit Verification

## Reference Solution
```python
from thai_rag.server import get_server

server = get_server()

# Step 1: Record constraint during chat
server.remember_turn(
    role="user",
    content="Always preserve backward compatibility in storage.py",
    workspace="thai-rag-mcp",
    tags=["architecture", "storage"]
)

# Step 2: Pre-edit check before editing storage.py
result = server.pre_edit_context(
    file_path="thai_rag/storage.py",
    workspace="thai-rag-mcp"
)

assert len(result["constraints"]) > 0
print("Passed: Pre-edit check safely surfaced prior constraints.")
```


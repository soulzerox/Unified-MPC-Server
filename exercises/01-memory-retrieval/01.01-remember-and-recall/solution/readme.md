# Solution: Storing and Querying User Preferences

```python
from thai_rag.server import LocalContextServer

server = LocalContextServer()
# 1. Record memory
server.remember("ผู้ใช้ชอบใช้ธีมสีมืดและคีย์ลัด vim", category="preference")

# 2. Recall memory
results = server.recall("คีย์ลัดที่ผู้ใช้ชอบ")
print(results)
```

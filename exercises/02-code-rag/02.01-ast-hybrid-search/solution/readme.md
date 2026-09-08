# Solution: Indexing and Searching a Code Workspace

```python
from thai_rag.server import LocalContextServer

server = LocalContextServer()
# 1. Index workspace
res = server.code_index("/path/to/project")
print(res)

# 2. Search exact symbol
exact_matches = server.code_search("calculate_vat_thailand")
print(exact_matches)

# 3. Search Thai semantic logic
thai_matches = server.code_search("ฟังก์ชันคำนวณภาษีมูลค่าเพิ่ม")
print(thai_matches)
```

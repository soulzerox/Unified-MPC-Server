# Implementation Plan

[Overview]
แก้ไข bug ที่ยืนยันแล้ว 3 จุด และปรับปรุงคุณภาพของ `thai-rag-mcp` (repo ที่ commit `e0ba67d`, test baseline 49/49 ผ่าน) ให้ CPG blast radius, workspace filtering และ conversational memory ทำงานถูกต้อง พร้อม tuning ประสิทธิภาพการ index และ embedding.

**ผลการตรวจสอบ (พิสูจน์ด้วย reproduction script จริง):**

| ID | ความรุนแรง | ไฟล์/จุด | อาการที่ยืนยันแล้ว |
|---|---|---|---|
| BUG-1 | **HIGH** | `storage.py:find_callers()` | `find_callers("sanitize")` คืน `('Engine.sanitize','strip')` — edge ที่ symbol เป็น**ผู้เรียกออกไปเอง** (callee) หลุดเข้ามาใน caller list เพราะ base-case WHERE มี `OR source_symbol LIKE '%.symbol'` เกินมา |
| BUG-2 | **HIGH** | `storage.py:find_callers/find_callees/get_file_symbols` | filter `workspace='My-WorkSpace'` ได้ผลลัพธ์ **0 แถว** แม้ DB เก็บ workspace ตรงกันทุกตัวอักษร — เพราะ normalize `replace("-","_").lower()` ทำให้ `workspace = ?` และ `instr(...)` fallback ไม่เคย match |
| BUG-3 | **HIGH** | `storage.py:save_conversation_turn()` | re-save turn_id เดิม (stable ID จาก `scripts/ingest_history.py`) ทำ FTS row ซ้ำ: `INSERT OR REPLACE` ตารางหลัก + `INSERT INTO fts_conversation` เพิ่มเรื่อยๆ → FTS rows = 2 จาก 1 turn, ผลค้นหาซ้ำโตทุกครั้งที่ re-ingest |
| BUG-4 | MEDIUM | `server.py:pre_edit_context()` | ใช้ `Path(file_path).is_file()` กับ indexed path แบบ `workspace/rel/path` (ไม่ใช่ path จริงบนดิสก์) → `code_context` เป็น `None` เกือบทุกกรณี; และ `get_context(file_path, 1)` ดึง scope ที่บรรทัด 1 แทน scope ของ `proposed_symbol` |
| BUG-5 | LOW | `storage.py:search_code_fts()` | สร้าง FTS expression แบบไม่ quote (`f"{w}*"` — ต่างจาก `search_conversation_turns` ที่ quote `'"w"*'`) → เปราะต่อ FTS5 syntax error |
| BUG-6 | LOW | `storage.py:search_memories_vector()` | ไม่ guard collection ว่าง (ฝั่ง code มี `col_count == 0` check) → chroma raise → recall คืน error เมื่อ memory ว่าง |
| BUG-7 | LOW | `retriever.py:index_workspace()` | ไฟล์ minified/error ที่ `continue` ไม่เรียก `notify_step` → HUD progress ค้าง/นับไม่ครบ |
| IMP-1 | PERF | `ollama_adapter.py` | ใช้ legacy `/api/embeddings` (prompt เดียวต่อ request) — embed ทีละชิ้นช้ามากบน repo ใหญ่; zero-vector fallback เดาไม่ได้และไม่บอกผู้ใช้; `is_alive()` ยิงทุก tool call (timeout 2s เมื่อ ollama ล่ม) |
| IMP-2 | PERF | `retriever.py:index_workspace()` | อ่านไฟล์ทุกไฟล์ + SHA256 ทุกไฟล์ทุกรอบ แม้ mtime ไม่เปลี่ยน → รอบ incremental ช้า (README อ้างรอบสอง < 1s) |
| IMP-8 | LOW | `progress.py:PROGRESS_SOCK_PATH` | hardcode `Path.home()/.cache/thai-rag-mcp` ไม่อ่าน `THAI_RAG_CACHE_DIR` (config.py อ่าน) |
| IMP-9 | LOW | `storage.py:get_file_symbols()` | LIKE `f"%{Path(file_path).name}"` ไม่มี `/` นำหน้า → `"server.py"` match `"myserver.py"` ได้ |

ขอบเขต: point-fix + tests เท่านั้น — ไม่ refactor สถาปัตยกรรม, ไม่แตะ wire format ของ MCP tools, ไม่แตะ DB schema ที่ทำให้ต้อง re-index ทั้ง workspace.

[Types]
ไม่มีการเปลี่ยน type/interface ภายนอก — signature ของ MCP tools 9 ตัวคงเดิมทั้งหมด (backward compatible กับ client ที่ลงทะเบียนไว้แล้ว)

- `StorageManager.find_callers / find_callees` — คง signature เดิม; แก้เฉพาะ SQL ภายใน
- เพิ่ม private helper ใน `storage.py`: `_normalize_ws(workspace: Optional[str]) -> Optional[str]`

[Files]
- **แก้ไข** `thai_rag/storage.py` — BUG-1, BUG-2, BUG-3, BUG-5, BUG-6, IMP-9
- **แก้ไข** `thai_rag/server.py` — BUG-4
- **แก้ไข** `thai_rag/retriever.py` — BUG-7, IMP-2
- **แก้ไข** `thai_rag/ollama_adapter.py` — IMP-1
- **แก้ไข** `thai_rag/progress.py` — IMP-8
- **แก้ไข** `tests/test_cpg.py`, `tests/test_conversational_memory.py`, `tests/test_ollama_adapter.py`, `tests/test_retriever.py` — เพิ่ม regression tests
- **ลบ (cleanup)** `/home/qwerty/Documents/Src Code/.scratch/audit_repro.py`
- ไม่แตะ: `README.md`, `config.py` (schema ไม่เปลี่ยน → ไม่ต้อง re-index), `ui/hud.py`, `scripts/*`

[Functions]
1. **`find_callers`** (`storage.py`) — ลบ `OR source_symbol LIKE ?` ออกจาก base SELECT (พารามิเตอร์ `like_suffix` ตัวที่ 3) ให้ caller graph หยั่งรากจาก `target_symbol` เท่านั้น; recursive step คงเดิม (ถูกแล้ว)
2. **workspace filter (BUG-2)** ใน `find_callers`, `find_callees`, `get_file_symbols` — เลิก `replace("-","_").lower()`; ใช้ `workspace = ? OR lower(workspace) = lower(?)` (case-insensitive เท่านั้น); ลบ `instr(...)` fallback ที่ทำงานผิด
3. **`save_conversation_turn` (BUG-3)** — เพิ่ม `DELETE FROM fts_conversation WHERE turn_id = ?` ก่อน INSERT ใน transaction เดียวกัน
4. **`search_code_fts` (BUG-5)** — quote แต่ละ term: `" OR ".join(f'"{w}"*' for w in words)` ให้ตรงกับ `search_conversation_turns`
5. **`search_memories_vector` (BUG-6)** — เพิ่ม `count() == 0` early-return ก่อน query
6. **`get_file_symbols` (IMP-9)** — เปลี่ยน LIKE เป็น `f"%/{Path(file_path).name}"` + คง exact-match branch
7. **`LocalContextServer.pre_edit_context` (BUG-4)** (`server.py`) — (ก) resolve path จริง: ลอง `Path(file_path)` ตรงๆ ก่อน ถ้าไม่เจอและ path เป็น `ws/rel` ให้ลอง resolve จาก cwd/ตำแหน่งที่เป็นไปได้; (ข) เมื่อมี `proposed_symbol` ให้ดึง `line_start..line_end` จาก `code_symbols` แล้ว `get_context` ที่กึ่งกลางช่วงบรรทัดนั้น แทนบรรทัด 1
8. **`HybridRetriever.index_workspace` (BUG-7 + IMP-2)** (`retriever.py`) — (ก) `notify_step(..., skipped=True)` ก่อนทุก `continue`; (ข) เทียบ `stat.st_mtime` กับ `file_cache.mtime` ก่อน read+hash — เท่ากันและไม่ force → skip ทันที; hash เฉพาะเมื่อ mtime ต่าง
9. **`OllamaEmbeddingAdapter` (IMP-1)** (`ollama_adapter.py`) — (ก) เพิ่ม `embed_documents_batch()` ยิง `POST /api/embed {"input": [...]}` (fallback sequential เมื่อ error); (ข) `embed_query` พลาดทั้งหมด → **raise** แทนคืน zero-vector; ฝั่ง ingestion คง zero-vector fallback แต่นับ `_fallback_count` ให้ `index_workspace` สรุปในผลลัพธ์; (ค) cache ผล `is_alive()` ~60 วินาที
10. **`HybridRetriever.index_file`** — ใช้ `embed_documents_batch` ก่อน ถ้ามี; return type คงเดิม
11. **`progress.py` (IMP-8)** — `PROGRESS_SOCK_PATH` อ่าน `THAI_RAG_CACHE_DIR` ก่อน แล้ว fallback `Path.home()/.cache/thai-rag-mcp`
12. **ไม่ลบ function ใด** — ไม่มี migration จำเป็น

[Classes]
- **แก้ `StorageManager`** (`storage.py`) — SQL ภายใน + helper method; public API คงเดิม
- **แก้ `HybridRetriever`** (`retriever.py`) — logic ใน `index_workspace`/`index_file`
- **แก้ `OllamaEmbeddingAdapter`** (`ollama_adapter.py`) — เพิ่ม `embed_documents_batch` + health cache attribute
- **แก้ `LocalContextServer`** (`server.py`) — ภายใน `pre_edit_context` เท่านั้น
- ไม่มี class ใหม่/ลบ class

[Dependencies]
ไม่มี package ใหม่ / ไม่มีการเปลี่ยนเวอร์ชัน — chromadb 1.5.9, mcp 2.2.0, pythainlp 5.3.7, requests (ของเดิมทั้งหมด)

[Testing]
- **`tests/test_cpg.py`** — เพิ่ม 2 test:
  - `test_find_callers_excludes_own_callees`: callers ของ `sanitize` ต้องมี `Engine.validate`/`Engine.cleanup` แต่**ห้าม**มี row `('Engine.sanitize','strip')`
  - `test_cpg_workspace_filter_exact_case`: `find_callers(..., workspace='My-WorkSpace')` ต้องได้ผลเท่าตอนไม่ filter (dash/case ห้ามทำให้ว่าง)
- **`tests/test_conversational_memory.py`** — เพิ่ม `test_resave_same_turn_id_no_fts_duplicate`: save turn_id เดิม 2 ครั้ง → FTS row = 1, ผลค้นหาไม่ซ้ำ
- **`tests/test_ollama_adapter.py`** — เพิ่ม `test_embed_query_raises_when_dead` (mock requests fail → query path raise ไม่คืน zero vector)
- **`tests/test_retriever.py`** — เพิ่ม `test_incremental_skip_by_mtime` (os.utime คง mtime → skip; เปลี่ยน mtime → re-index)
- **Gate**: `pytest tests/ -q` ผ่าน 100% (baseline 49 + ~5 test ใหม่)
- **Manual**: รัน repro script ต้องคืนค่าถูกต้องทั้ง 3 bug + MCP stdio smoke (`tools/list`, `code_blast_radius`)

[Implementation Order]
1. `storage.py` — workspace filter fix (BUG-2) ใน `find_callers`/`find_callees`/`get_file_symbols`
2. `storage.py` — ลบ `OR source_symbol LIKE ?` ใน `find_callers` (BUG-1)
3. `storage.py` — FTS pre-delete (BUG-3) + quote terms (BUG-5) + empty guard (BUG-6) + LIKE fix (IMP-9)
4. เพิ่ม regression tests ใน `test_cpg.py` + `test_conversational_memory.py` แล้วรันยืนยัน
5. `ollama_adapter.py` — batch embed + query-raise + health cache (IMP-1)
6. `retriever.py` — mtime short-circuit + notify_step ครบ + batch embed (BUG-7, IMP-2)
7. `progress.py` — sock path จาก env (IMP-8)
8. `server.py` — `pre_edit_context` path resolve + symbol-scoped context (BUG-4)
9. เพิ่ม tests ใน `test_ollama_adapter.py` + `test_retriever.py`
10. รัน `pytest tests/ -q` เต็มชุด (gate) + MCP stdio smoke + ลบ repro script
11. commit batch เดียว: `fix: correct CPG caller graph, workspace filtering, FTS turn duplication + perf (mtime skip, batch embed)`


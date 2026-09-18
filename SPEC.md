# Technical Specification: Native Thai-RAG Provider and Optional MCP Adapter

Production architecture is `Client -> Unified MCP -> Native Thai-RAG Provider`. `thai_rag.provider.ThaiRagProvider` is the transport-independent contract for memory, retrieval, indexing, CPG, health, version, capabilities, structured status/results/errors, and explicit `workspace_id` scope. The stdio FastMCP layer is an optional thin compatibility adapter; standalone mode remains usable without Unified.

The current contract does not claim canonical workspace ownership/query support before #2/#13 storage migration. Missing or unsupported canonical scope returns structured unavailable/scope errors. Selective `record_event` replaces raw automatic turn recording as provider primitive; legacy `remember_turn` is compatibility-only.

เอกสารฉบับนี้เป็นข้อกำหนดทางเทคนิค (Technical Specification) สำหรับการพัฒนา **Native Thai-RAG Provider** และ optional local MCP adapter เพื่อทำหน้าที่ 2 ประการร่วมกัน:
1. **Agent Long-Term Memory:** ระบบความจำระยะยาว (บันทึกข้อตกลง, กฎ, บริบทโปรเจกต์) เพื่อทดแทน OpenViking จากเครื่องรีโมต
2. **AST-Aware Code RAG:** ระบบสืบค้นและทำความเข้าใจซอร์สโค้ดที่เข้าใจไวยากรณ์และภาษาไทย โดยไม่ทำให้ Context Window ของ Agent บวม

---

## 🎯 1. ที่มาและปัญหา (Problem Statement)
- **ปัญหาของ OpenViking รีโมต (192.168.1.189):**
  - ใช้ Google AI Studio API ในการทำ Embedding ทำให้ติดขีดจำกัด Rate Limit (Error 429: TPM/RPM Lock) เมื่อทำการ Ingest ข้อมูลจำนวนมาก จนเกิดสถานะ `path_busy lock` และระบบค้าง
  - ต้องพึ่งพาเครือข่ายและ Tailscale ตลอดเวลาเมื่อนำเครื่องออกไปใช้งานนอกสถานที่
- **ปัญหาของสถาปัตยกรรมเดิม (plan.md & Athina AI Notebook):**
  - การใช้ `InMemoryStore()` ของ LangChain ทำให้ข้อมูล Parent หายเมื่อปิดเปิดโปรเซสใหม่
  - การใช้ `pythainlp.tokenize.word_tokenize(engine="newmm")` สับเนื้อโค้ดดิบทำให้ไวยากรณ์ (Syntax/AST) ขาดวิ่น และทำงานช้ามากบน CPU
  - การดึง Parent ข้อมูลกลับทั้งไฟล์ (Full File Retrieval) ทำให้เกิดภาวะ Context Flooding จน Agent สับสน

---

## 💡 2. แนวทางแก้ปัญหา (Solution Overview)
สร้าง FastMCP Server ภาษา Python ที่ทำงานแบบเบ็ดเสร็จในตัว (Deep Module) ผ่านช่องทาง `stdio`:
- **100% Local & Zero API Rate Limit:** ใช้ Ollama `nomic-embed-text-v2-moe` บนเครื่องท้องถิ่น (`127.0.0.1:11434`)
- **Persistent Dual Storage:**
  - **SQLite Database (`local_context.db` บน ext4):** เก็บ Parent Docstore ถาวร, FTS5 สำหรับค้นหา Symbol/Keyword ตรงตัว, ข้อมูล Memory, และ SHA256 Hashes
  - **ChromaDB (`./chroma_data` บน ext4):** จัดเก็บเวกเตอร์ 768 มิติ แยก Collection ชัดเจน (`memories` และ `code_chunks`)
- **Syntax-First + Thai Aware:** หั่นโค้ดตามขอบเขต Scope (Function/Class) ก่อน แล้วใช้ PyThaiNLP เฉพาะกับคอมเมนต์และข้อความภาษาไทย

---

## 👤 3. รายการความต้องการของผู้ใช้ (User Stories)
1. **US-01 (Agent Memory Persistence):** ในฐานะ Developer ฉันต้องการบันทึกข้อตกลงโปรเจกต์ (`remember`) ลงในเครื่อง เพื่อให้ Agent ดึงกลับมาใช้ได้เสมอแม้จะปิดเปิดโปรแกรมใหม่
2. **US-02 (Offline Semantic Recall):** ในฐานะ Developer ฉันต้องการค้นหาบริบทเดิม (`recall`) ด้วยภาษาไทยแบบ Semantic Search เพื่อให้ Agent รู้วิธีการทำงานเดิมโดยไม่ต้องต่ออินเทอร์เน็ตหรือ Tailscale
3. **US-03 (Incremental Code Indexing):** ในฐานะ Developer ฉันต้องการสั่ง Index โค้ดในโปรเจกต์ (`code_index`) โดยมีการตรวจสอบ SHA256 เพื่อข้ามไฟล์ที่ไม่เปลี่ยนแปลง และไม่ติด Rate Limit
4. **US-04 (Hybrid Code Search):** ในฐานะ Developer ฉันต้องการค้นหาฟังก์ชันหรือตรรกะโค้ด (`code_search`) ด้วย Hybrid Search (คำศัพท์ภาษาอังกฤษ + ความหมายภาษาไทย) โดยผลลัพธ์ไม่ล้น Context Window
5. **US-05 (Scope-Enclosing Context Retrieval):** ในฐานะ Developer ฉันต้องการให้ระบบดึงโค้ดขอบเขตฟังก์ชัน (`code_context`) เมื่อต้องการดูบริบทเต็ม แทนที่จะยัดเยียดไฟล์ยาวทั้งไฟล์เข้าแชท

---

## ⚙️ 4. การตัดสินใจเชิงสถาปัตยกรรม (Implementation Decisions)

### 4.1 Provider contract and adapter surface
`ThaiRagProvider` exposes typed `ProviderResult` values independent of MCP transport. Every workspace-bound operation accepts explicit canonical `workspace_id`; result metadata includes provider/contract version and capabilities. Results carry `status` (`ok`, `review_required`, `degraded`, `unavailable`), warnings, generation/operation fields, evidence/data, and machine-readable error codes.

Provider operations:
- `version()` / `health()` — contract version, provider version, capabilities, readiness and scope model.
- `remember(content, workspace_id, category)` / `recall(query, workspace_id, category, limit)` / `forget(memory_id, workspace_id)` — workspace-scoped durable memory; unavailable until canonical ownership is provided by storage.
- `record_event(event_type, content, workspace_id, summary, tags)` — selective meaningful workspace event without mandatory turn ID.
- `pre_edit_context(file_path, workspace_id, proposed_symbol)` — structured evidence with truthful `review_required`/`degraded` status.
- `code_index(workspace_path, workspace_id, force, background)` / `index_status(job_id, workspace_id)` — explicit workspace namespace and job status.
- `code_search(query, workspace_id, top_k, path_filter)`, `code_context(file_path, line_number, workspace_id, window)`, and `code_blast_radius(symbol_name, workspace_id, max_depth)`.

The optional FastMCP adapter may retain legacy string tools for standalone compatibility. Unified owns public formatting and policy.

---

### 4.2 ชั้นการจัดเก็บข้อมูล (Data Persistence Layer)
เก็บไว้ในพาธ Native Linux: `~/.cache/thai-rag-mcp/` เพื่อหลีกเลี่ยงปัญหา I/O lock บน NTFS

1. **SQLite Database (`local_context.db`):**
   - ตาราง `parent_documents`: เก็บ Parent code blocks พร้อม metadata
   - ตาราง `fts_code_symbols`: ตารางเสมือน FTS5 สำหรับค้นหาชื่อฟังก์ชันและตัวแปร
   - ตาราง `memories`: จัดเก็บ text, category, timestamp สำหรับงานความจำ
   - ตาราง `file_cache`: เก็บ file path, mtime, sha256 เพื่อทำ Incremental Indexing
2. **ChromaDB (`chroma_vectors/`):**
   - Collection `memory_vectors`: เก็บเวกเตอร์ความจำ
   - Collection `code_vectors`: เก็บเวกเตอร์ Child chunks ของโค้ด

---

### 4.3 โมดูลประมวลผล (Processing & Embedding Layer)
1. **Ollama Embedding Adapter:**
   - URL: `http://127.0.0.1:11434`
   - Model: `nomic-embed-text-v2-moe:latest`
   - Task Prefix:
     - Ingestion: เติม `search_document: ` นำหน้าข้อความ
     - Retrieval: เติม `search_query: ` นำหน้าข้อความค้นหา
2. **AST-Aware Code Chunker:**
   - ใช้หลักการแยกขอบเขตบล็อกฟังก์ชัน/คลาสเป็นหลัก
   - ขนาด Child Chunk: ~250–350 tokens (ไม่เกิน Context Length 512 tokens ของ nomic-v2)
   - ใช้ PyThaiNLP ในการแยกตัดคำเฉพาะข้อความที่เป็น Comment / Docstring ภาษาไทย

---

## 🧪 5. แผนการตรวจสอบและทดสอบ (Testing & Verification Plan)
1. **Persistence Test:** สั่ง `remember` ข้อมูล รีสตาร์ตโปรเซส MCP ข้อมูลต้องคงอยู่ครบถ้วนใน SQLite และ ChromaDB
2. **Incremental Indexing Test:** ทดสอบรัน `code_index` ครั้งแรกและครั้งที่สอง (รอบสองต้องใช้เวลา < 1 วินาที)
3. **Hybrid Search Accuracy:** ค้นหาด้วยชื่อสัญลักษณ์ภาษาอังกฤษเป๊ะๆ และค้นหาด้วยคำอธิบายภาษาไทย ต้องแสดงผลลัพธ์ที่ถูกต้อง
4. **Context Safety:** ขนาดผลลัพธ์ที่ส่งกลับผ่าน MCP Tools ต้องกระชับ และมี Line Reference ชัดเจน

---

## 🚫 6. สิ่งที่อยู่นอกขอบเขต (Out of Scope)
- การเรียกใช้ External Cloud Embedding API
- การสร้าง GUI หรือ Web Interface แยก (ใช้งานผ่าน FastMCP stdio เท่านั้น)

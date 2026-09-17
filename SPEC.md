# 📐 ข้อกำหนดระบบ: Local Context & Code RAG MCP Server (Unified Deep Module)

เอกสารฉบับนี้เป็นข้อกำหนดทางเทคนิค (Technical Specification) สำหรับการพัฒนา **MCP Server** ท้องถิ่น (Local 100%) เพื่อทำหน้าที่ 2 ประการร่วมกัน:
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

### 4.1 ขอบเขตคำสั่งภายนอก (Exposed MCP Interface)
ออกแบบเป็น Small Surface, High Leverage Interface แยก 2 โดเมนชัดเจน:

#### โดเมน A: ระบบจัดการความจำ (Memory Subsystem - แทน OpenViking)
- `remember(content: str, category: str = "general") -> str`: บันทึกข้อมูลบริบท/ข้อตกลง
- `recall(query: str, category: str = None, limit: int = 5) -> str`: ค้นหาความจำและความรู้เดิม
- `forget(memory_id: str, category: str = None) -> str`: ลบความจำที่ไม่ต้องการ โดยตรวจ `category` เมื่อ caller ต้องการบังคับขอบเขต workspace

#### โดเมน B: ระบบสืบค้นโค้ด (Code RAG Subsystem)
- `code_index(workspace_path: str = ".", force: bool = False, background: bool = False, workspace: str = "") -> str`: ทราเวิร์สและทำดัชนีโค้ด โดย `workspace_path` เป็น filesystem root และ `workspace` เป็น logical namespace ที่ stable; ถ้าไม่ส่ง `workspace` จะ fallback เป็น basename ของ root
- `code_search(query: str, top_k: int = 5) -> str`: ค้นหาโค้ดแบบไฮบริด (FTS5 + Vector RRF)
- `code_context(file_path: str, line_number: int, window: int = 25) -> str`: ดึงเนื้อหาแวดล้อมเฉพาะจุด

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

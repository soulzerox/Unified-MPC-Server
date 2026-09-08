# 🗺️ พิมพ์เขียวและแผนงาน: Parent-Child Retriever MCP Server (Thai & Context-Aware)

เอกสารฉบับนี้จัดทำขึ้นเพื่อรวบรวมสถาปัตยกรรม หลักการ และแนวทางการพัฒนา **MCP Server** สำหรับงานด้านโครงสร้างข้อมูล RAG (Retrieval-Augmented Generation) ของซอร์สโค้ดและคอมเมนต์ภาษาไทย โดยออกแบบมาให้เหมาะสมที่สุดกับสเปกเครื่องทรัพยากรจำกัด (i5-1135G7, RAM 16GB, Iris Xe บน Zorin OS) และเน้นการหลีกเลี่ยงข้อจำกัดความเร็ว Cloud API (RPM/TPM Lock)

---

## 🏗️ 1. สถาปัตยกรรมระบบภาพรวม (System Architecture)

ระบบถูกออกแบบให้แบ่งแยกหน้าที่อย่างชัดเจนเพื่อไม่ให้ฮาร์ดแวร์หลักทำงานหนักเกินไป (Zero Local Load Strategy):


[ Code Agent / IDE ] (Cline, Cursor, OpenCode)│▼ (stdio transport)┌────────────────────────────────────────────────────────┐│               FASTMCP SERVER (Local venv)              │├────────────────────────────────────────────────────────┤│  1. Word Segmentation (PyThaiNLP Tokenizer)            ││  2. Context Window & Token Budget Management           │└───────────┬────────────────────────────────┬───────────┘│                                │▼ (Vector Search)                ▼ (Embedding API)┌───────────────────────┐        ┌───────────────────────┐│ CHROMADB (Local Disk) │        │ OLLAMA SERVER (Local) │├───────────────────────┤        ├───────────────────────┤│ - Child Chunks Vector │        │ Model: Nomic-v2-MoE   ││ - Parent Documents    │        │ Storage: NTFS Drive   │└───────────────────────┘        └───────────────────────┘



### รายละเอียดส่วนประกอบหลัก
1. **MCP Server Layer (FastMCP):** ห่อหุ้ม Logic ทั้งหมดเป็นโปรโตคอลมาตรฐาน คอนเนคผ่านท่อ `stdio` รันแยกอยู่ใน Python Virtual Environment (`venv`) ของโปรเจกต์ เพื่อความปลอดภัยต่อ OS
2. **Text Processing Layer (PyThaiNLP):** ทำหน้าที่เป็น Tokenizer กั้นกลางก่อนแบ่งชิ้นส่วนข้อมูล เพื่อให้อัลกอริทึมเข้าใจขอบเขตคำภาษาไทยที่มีการเขียนติดกันเป็นพืด
3. **Local Vector Database (ChromaDB):** ทำหน้าที่เก็บตำแหน่งและพิกัด Vector โลคอล กิน RAM ต่ำมาก ประมวลผลได้เร็วระดับ Millisecond 
4. **Local Embedding Provider (Ollama):** เรียกใช้โมเดล `nomic-embed-text-v2-moe` ซึ่งกินพื้นที่ในเครื่องต่ำ (~958 MB) ถูกโยกย้ายสำมะโนครัวไปจัดเก็บและทำงานอยู่บน **NTFS Drive จำลองผ่าน Symbolic Link** ช่วยประหยัดพื้นที่ดิสก์หลักและรันบน CPU ได้ไวสูงสุด

---

## 🧠 2. หลักการทำงานสำคัญ (Core Principles)

### A. เทคนิคการค้นหาแบบ Parent-Child Retriever
* **ปัญหาดั้งเดิม:** หากตัดโค้ดเป็นท่อนใหญ่ AI จะได้เนื้อหาครบแต่ค้นหาความหมายไม่เจอ หากตัดท่อนเล็ก (Child) Vector จะแม่นยำสูงแต่เมื่อส่งให้ AI อ่าน โค้ดจะขาดบริบท (Lost in Context)
* **กลไกแก้ปัญหา:** 
  * **ตอน Ingest ข้อมูล:** ระบบจะหั่นซอร์สโค้ดออกเป็นชิ้นเล็กมาก ๆ (Child Chunks) เพื่อนำไปแปลง Vector และเซฟลง ChromaDB แต่จะเก็บโค้ดไฟล์เต็มหรือฟังก์ชันหลัก (Parent Document) คู่ขนานไว้ใน Key-Value Store
  * **ตอนดึงข้อมูล (Retrieval):** เมื่อสั่งค้นหา ระบบจะวิ่งไปสแกนหาชิ้นเล็ก (Child) ที่ตรงความหมายที่สุด แต่แทนที่จะส่งเศษชิ้นส่วนนั้นให้ AI ระบบจะทำการ **แมป ID ย้อนกลับไปดึงโค้ดท่อนใหญ่หรือไฟล์เต็ม (Parent)** ส่งกลับไปให้ AI ตัวหลักอ่านแทน

### B. ระบบสกัดภาษาไทยคุมตัวตัดคำ (Thai Tokenization-Aware)
* ป้องกันอาการคำภาษาไทยถูกหั่นขาดกลางประโยค เช่น คำว่า `"คำนวณ"` โดนตัดครึ่งเป็น `"คำ"` และ `"นวณ"` ซึ่งทำให้ความหมายของ Vector เสียหาย
* ก่อนการหั่นข้อความส่งไปทำ Embedding ระบบจะรันผ่าน `pythainlp.tokenize.word_tokenize(engine="newmm")` เพื่อแยกคำให้ถูกต้องตามพจนานุกรมภาษาไทยก่อน แล้วใช้วิธีคำนวณจำนวนคำในการแบ่ง Chunk แทนการนับอักษรภาษาอังกฤษแบบเดิม

### C. การจัดการบริบทและจำกัด Token (Context Budgeting)
* ป้องกันปัญหา Context บวม จนทำให้ AI Agent ทำงานหลอนหรือ tokens เต็มลิมิต
* ระบบจะคำนวณขนาด Token ท้องถิ่นผ่านจำนวนคำของ PyThaiNLP แบบ Real-time
* **Dynamic Window Truncation:** มีระบบปรับตัวอัจฉริยะ 
  * หากโควต้าพื้นที่ Context เหลือเฟือ -> ส่งโค้ดตัวเต็ม (Full Parent Document) ให้ AI
  * หากโค้ดมีขนาดใหญ่เกินกว่าลิมิต Context ที่ AI กำหนดมา -> ระบบจะสลับอัตโนมัติมาทำ **Sentence-Window Context** โดยจะกวาดเอาเฉพาะโค้ดบริเวณรอบ ๆ ของ Child ชิ้นที่ค้นพบ (เช่น ย้อนขึ้นบน 15 บรรทัด และลงล่าง 15 บรรทัด) ช่วยบีบอัด Context ให้คุ้มค่าที่สุด

---

## 📋 3. แผนงานแนวทางการพัฒนา (Step-by-Step Roadmap)

### 📌 เฟส 1: วางรากฐานและระบบกักขัง (Foundation & Virtual Environment)
เนื่องจากข้อจำกัดของระบบความปลอดภัย Linux รุ่นใหม่ (PEP 668) ห้ามติดตั้ง Library ลงใน OS ตรงๆ เราจะเริ่มจากสร้างห้องทำงานจำลอง:
1. สร้างโฟลเดอร์และตั้งค่า Virtual Environment:
   ```bash
   mkdir -p ~/thai-rag-mcp && cd ~/thai-rag-mcp
   python3 -m venv venv
   source venv/bin/activate
   ```
2. ติดตั้ง Dependencies พื้นฐาน:
   ```bash
   pip install --upgrade pip
   pip install mcp langchain-community chromadb pythainlp tiktoken
   ```
3. ยืนยันสถานะโมเดล Local บน NTFS Drive ผ่าน Ollama:
   ```bash
   ollama list # ต้องแสดง nomic-embed-text-v2-moe:latest
   ```

### 📌 เฟส 2: เขียนสคริปต์ตัวตัดคำภาษาไทยและคลังจัดเก็บ (Thai Core RAG Setup)
พัฒนาไฟล์เชื่อมต่อและตัวหั่นคำอัจฉริยะ ป้องกันคำภาษาไทยคอมเมนต์ขาดออกจากกัน:
1. เขียน Logic การตัดคำภาษาไทย `thai_word_splitter` โดยระบุความยาวคำที่เหมาะสมสำหรับการแปลง Vector รุ่น Nomic V2 (แนะนำ Child ขนาด 120-150 คำภาษาไทย, Overlap 25 คำ)
2. ตั้งค่าการเชื่อมต่อฐานข้อมูล ChromaDB โลคอลให้เก็บข้อมูลถาวรลงดิสก์ที่โฟลเดอร์โปรเจกต์ (`persist_directory="./chroma_db_context"`)

### 📌 เฟส 3: ห่อหุ้มขึ้นรูปเครื่องมือ MCP Server (FastMCP Framework)
ทำการแปลงโค้ด Python ให้กลายเป็นเครื่องมือเปิดระบบ (Tools) ให้ AI เรียกใช้:
1. นำเครื่องมือเข้าทะเบียน `@mcp.tool()` เพื่อสร้าง Tool ที่ชื่อ `index_project_file(file_path, file_content)`
2. สร้าง Tool ค้นหาข้อมูล `retrieve_code_with_context(query_thai, max_context_tokens)` 
3. ตั้งค่าระบบขนส่งหลักให้วิ่งผ่าน Standard Input/Output (`transport="stdio"`) เพื่อความไวสูงและประหยัด RAM

### 📌 เฟส 4: พัฒนาระบบคัดกรองขนาดบริบท (Context Limit Control)
1. เพิ่มระบบคำนวณ Token ลงใน Tool ค้นหา 
2. เขียนเงื่อนไขดักตรวจสอบ: คำนวณรหัสบรรทัด (Target line index) ของไฟล์ซอร์สโค้ด หากไฟล์ใหญ่เกินไป ให้ทำ Dynamic Truncation สกัดเฉพาะขอบเขตบรรทัดบน-ล่างรอบคำค้นหา ป้อนส่งกลับไปผ่านสาย stdio

---

## 🔌 4. แนวทางการผูกใช้งานร่วมกับ AI Code Agent

เมื่อพัฒนาไฟล์ Python (เช่น `thai_rag_context_mcp.py`) เสร็จเรียบร้อยแล้ว ให้ทำการเชื่อมต่อไปยังส่วนขยายของ IDE (เช่น Cline ใน VS Code) โดยการชี้ตัวประมวลผล Python ไปที่ห้อง venv จำลองโดยตรง เพื่อให้บอร์ดข้ามมิติเรียกใช้งานได้ทันทีโดยไม่ต้องเปิด Terminal สั่ง Activate เองด้วยมือ:

เปิดไฟล์ตั้งค่าโปรโตคอล `mcpServers` ของ Agent แล้วลงทะเบียนดังนี้:

```json
"mcpServers": {
  "thai-context-aware-rag": {
    "command": "/home/qwerty/thai-rag-mcp/venv/bin/python3",
    "args": [
      "/home/qwerty/thai-rag-mcp/thai_rag_context_mcp.py"
    ]
  }
}
```

---

## 💡 สรุปข้อดีสูงสุดของพิมพ์เขียวนี้ต่อผู้พัฒนา
* **ความเป็นส่วนตัว 100% (Air-Gapped Privacy):** ข้อมูลซอร์สโค้ดและโปรเจกต์ทั้งหมดถูกตัดคำและทำ Embedding อยู่ภายในเครื่องคอมพิวเตอร์ของคุณเอง ไม่รั่วไหลออกสู่ Cloud ภายนอก
* **ทำงานไวและเครื่องไม่ค้าง:** การผลักภาระคำนวณคณิตศาสตร์ Vector ไปให้ Ollama จัดการบน NTFS Drive และใช้โมเดล MoE ขนาดเล็ก ช่วยให้ RAM 16GB มีพื้นที่เหลือเฟือให้ IDE ทำงานได้ลื่นไหลระดับ Millisecond
* **ตัดปัญหาความน่ารำคาญเรื่อง API:** จบปัญหา Rate Limit (Error 429) หรืออาการติด Lock จากฝั่งคลาวด์อย่างถาวร ยิงค้นหาซ้ำ ๆ ได้ไม่จำกัดครั้งฟรีตลอดชีพ


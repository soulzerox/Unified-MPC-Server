# คู่มือการใช้งาน Unified-MPC-Server (Thai User Manual)

Unified-MPC-Server คือระบบบริหารจัดการ Model Context Protocol (MCP) และ Senior Engineering Harness รุ่นใหม่ ออกแบบสำหรับระบบปฏิบัติการ Linux Ubuntu โดยเฉพาะ (100% Linux Native) ทำงานแบบ Local-First และเป็นศูนย์กลาง (Single Source of Truth) ในการจัดการ Tools, Skills, Rules และ Policies ข้ามสภาพแวดล้อม AI IDE หลากหลายค่าย

---

## สารบัญ

1. [ภาพรวมและความสามารถหลัก](#1-ภาพรวมและความสามารถหลัก)
2. [การเตรียมสภาพแวดล้อมและการติดตั้ง](#2-การเตรียมสภาพแวดล้อมและการติดตั้ง)
3. [คู่มือคำสั่ง CLI ทั้งหมด](#3-คู่มือคำสั่ง-cli-ทั้งหมด)
4. [ระบบ Web Control Plane และ Dashboard](#4-ระบบ-web-control-plane-และ-dashboard)
5. [การซิงค์นโยบาย Multi-IDE และ Runtime Policy แบบ P1–Pn](#5-การซิงค์นโยบาย-multi-ide-และ-runtime-policy-แบบ-p1pn)
6. [การตั้งค่า Service บน Ubuntu ด้วย Systemd](#6-การตั้งค่า-service-บน-ubuntu-ด้วย-systemd)
7. [การทดสอบและการตรวจสอบความถูกต้องของระบบ](#7-การทดสอบและการตรวจสอบความถูกต้องของระบบ)

---

## 1. ภาพรวมและความสามารถหลัก

- **100% Linux Ubuntu Native**: ปราศจากโค้ด Windows (`.bat`, `.ps1`, Win32 API) และ Electron GUI โดยทำงานผ่าน Node.js LTS และมาตรฐาน POSIX XDG Directory.
- **Bifurcated Ingestion Engine**: แยกกระบวนการติดตั้งอย่างชัดเจนระหว่าง Agent Skill Markdown (`SKILL.md`) และ External MCP Server (`stdio`/`sse`/`http`).
- **Zero-Artifact Pruning**: ลบการตั้งค่าและไฟล์ที่ไม่ได้ใช้งานอย่างสมบูรณ์แบบ ไม่ทิ้งขยะตกค้างในระบบ.
- **Single Source of Truth Multi-IDE Sync**: ซิงค์ Rules และ MCP Config ไปยัง 7 IDE ชั้นนำ (Antigravity, Cursor, Claude Code, OpenCode, Cline, OMP, Codex).
- **User-Editable P1–Pn Runtime Policy**: ผู้ใช้แก้ไข เพิ่ม/ลบ และจัดลำดับการทำงานได้เอง โดย Policy ID คงที่ ส่วน P1–Pn คืออันดับการทำงานปัจจุบัน.
- **Gated Remote Gateway**: ระบบเชื่อมต่อ Remote Bridge ปลอดภัยด้วย 5-State Machine และเงื่อนไข Hard Gating.

---

## 2. การเตรียมสภาพแวดล้อมและการติดตั้ง

### ข้อกำหนดของระบบ
- **OS**: Ubuntu Linux 22.04 LTS หรือ 24.04 LTS
- **Node.js**: เวอร์ชัน `>=22.0.0` (ต้องมี `node:sqlite`)
- **Package Manager**: pnpm (ผ่าน Corepack)

### ขั้นตอนการ Build โปรเจกต์
```bash
# 1. เปิดใช้งาน Corepack และ pnpm
corepack enable
corepack prepare pnpm@latest --activate

# 2. ติดตั้ง dependencies ทั้งหมดใน Monorepo
pnpm install

# 3. คอมไพล์โค้ด TypeScript ทั้ง 21 packages
pnpm build

# 4. ทดสอบความพร้อมของระบบ
pnpm cli doctor
```

---

## 3. คู่มือคำสั่ง CLI ทั้งหมด

ไบนารี CLI (`apps/cli`) สามารถเรียกใช้ผ่าน `pnpm cli <subcommand>` หรือลิงก์ผ่าน `unified-mpc`:

### 3.1 ตรวจสอบสถานะระบบ (`status`)
แสดงข้อมูลภาพรวมของระบบ, ค่าคอนฟิก, แพลตฟอร์ม, และสถานะของ Gateway:
```bash
pnpm cli status
```
*ต้องการผลลัพธ์เป็น JSON:*
```bash
pnpm cli status --json
```

### 3.2 วินิจฉัยสภาพแวดล้อม (`doctor`)
ตรวจสอบสิทธิ์การอ่านเขียนไฟล์ในไดเรกทอรี XDG, ตรวจสอบ path ของ IDE ต่างๆ และความถูกต้องของ JSON configs:
```bash
pnpm cli doctor
```

### 3.3 ซิงค์นโยบายไปยัง IDE (`sync`)
นำเข้าและคอมไพล์ Runtime Policy แบบ P1–Pn ตามลำดับที่ผู้ใช้บันทึกไว้ไปยังไฟล์ Rules ของ IDE ทุกตัว:
```bash
# ซิงค์ IDE ทั้งหมดพร้อมกัน
pnpm cli sync

# ซิงค์เฉพาะ IDE ที่ระบุ (คั่นด้วย comma)
pnpm cli sync --targets cursor,cline,antigravity
```

### 3.4 ติดตั้ง Extensions (`install`)
ใช้ Bifurcated Engine เพื่อติดตั้ง Skill หรือ MCP Server:

**ติดตั้ง Skill:**
```bash
pnpm cli install skill --name my-skill --source ./path/to/my-skill --targets antigravity --scope workspace
```

**ติดตั้ง MCP Server:**
```bash
pnpm cli install server --name sqlite-db \
  --transport stdio \
  --command npx \
  --args "-y mcp-server-sqlite --db /tmp/test.db" \
  --targets cursor
```

### 3.5 ลบส่วนขยายที่ไม่ใช้งาน (`prune`)
ล้างข้อมูล Skill หรือ Server ออกจากระบบอย่างปลอดภัย:
```bash
pnpm cli prune --skill obsolete-skill --target all
pnpm cli prune --server deprecated-server --target all
```

### 3.6 เริ่มต้น Web Control Plane (`web`)
รันเซอร์เวอร์หน้าเว็บ Dashboard และ REST API สำหรับควบคุมระบบ:
```bash
# Dashboard ใช้พอร์ตเริ่มต้น 3000
pnpm cli web

# รันบนพอร์ตที่กำหนดเอง
pnpm cli web --port 8080
```

> MCP Streamable HTTP เป็นอีก runtime หนึ่ง โดยค่าเริ่มต้นอยู่ที่ `127.0.0.1:18765/mcp` ไม่ใช่พอร์ตเดียวกับ Dashboard

### 3.7 ตรวจสอบและรัน Tools (`tools`)
เรียกดูรายการ Tools ในระบบหรือเรียก tool โดยตรงด้วย JSON arguments:
```bash
# ดูรายการเครื่องมือทั้งหมด
pnpm cli tools list

# เรียก tool โดยชื่อและส่ง arguments เป็น JSON
pnpm cli tools call working_memory_search '{"workspaceId":"<workspace-id>","query":"current task"}'
```

---

## 4. ระบบ Web Control Plane และ Dashboard

เมื่อสั่งรัน `pnpm cli web` ระบบจะเปิดหน้าต่าง Web Dashboard ที่:
👉 **`http://127.0.0.1:3000/`**

### ฟีเจอร์หลักบน Web Control Plane
1. **Real-time Telemetry**: สังเกตการณ์สถานะหน่วยความจำ (RSS/Heap), Uptime, และ Traffic ของ MCP requests.
2. **Gateway State Machine**: ควบคุมการเปิด-ปิด Tunnel Bridge (Cloudflare Named Tunnels) พร้อมระบบตรวจสอบ Hard Gating:
   - ตราบใดที่สถานะยังไม่เป็น `BRIDGE_HEALTHY` ระบบจะป้องกันไม่ให้ Client เชื่อมต่อผ่าน `/api/chatgpt-web/connect` โดยตอบกลับเป็นสถานะ `412 Precondition Failed`.
3. **Loopback Only Security**: บล็อกคำขอที่มี Origin จากภายนอก localhost โดยอัตโนมัติ เพื่อความปลอดภัยสูงสุด.

---

## 5. การซิงค์นโยบาย Multi-IDE และ Runtime Policy แบบ P1–Pn

Unified-MPC-Server ใช้ Runtime Policy ที่ผู้ใช้แก้ไขและจัดลำดับใหม่ได้เอง โดย **Policy ID เป็นตัวตนคงที่** ส่วน **P1, P2, … Pn เป็นตำแหน่งการทำงานที่คำนวณจากลำดับปัจจุบัน** ดังนั้นการย้าย Policy จาก P4 ขึ้น P1 จะเปลี่ยนลำดับการทำงานจริงโดยไม่ทำให้ reference เดิมเสีย

ลำดับเริ่มต้นของระบบคือ:

| ลำดับ | Policy ID | Resource ID | ประเภท | มาตรการบังคับ | บทบาทหน้าที่ |
|---|---|---|---|---|---|
| **P1** | `session-start:ask-matt` | **`ask-matt`** | Skill | บังคับทุก Session | โหลดคำแนะนำเริ่มงานก่อนวางแผนหรือลงมือทำ |
| **P2** | `child:memory` | **`memory`** | MCP Server | บังคับ (Realtime) | Working Memory และตรวจ required tools ตาม policy |
| **P3** | `pre-edit:thai-rag` | **`thai-rag-mcp`** | MCP Server | บังคับทุก Session | Local RAG และ `pre_edit_context` เมื่อเกี่ยวข้องกับ repository |
| **P4** | `code-safety:godkiller` | **`godkiller`** | MCP Server | บังคับก่อนแก้โค้ด | Code intelligence และ `gk_task` สำหรับ safety pre-check |
| **P5** | `optional:sequentialthinking` | **`sequentialthinking`** | MCP Server | ตามความจำเป็น | การคิดวิเคราะห์หลายขั้นสำหรับงานซับซ้อน |
| **P6** | `optional:context7` | **`context7`** | MCP Server | ตามความจำเป็น | เอกสารและตัวอย่าง API/SDK ที่ตรงเวอร์ชัน |
| **P7** | `optional:filesystem` | **`filesystem`** | MCP Server | ตามความจำเป็น | งานไฟล์แบบ Batch และข้ามโปรเจกต์ |
| **P8** | `optional:ui-skills` | **`ui-skills`** | Skill Bundle | ตามความจำเป็น | แนวทาง UI/UX และ Frontend |

ใน Web Control Plane ผู้ใช้สามารถเพิ่ม/ลบ Policy, แก้ Resource/Type/Mandatory/Enforcement/Required Tools/Directive และเปลี่ยนตำแหน่ง P ได้โดยตรง เมื่อกด Save ระบบจะเก็บ array ตามลำดับจริง และ Save & Sync จะนำลำดับเดียวกันไปสร้าง Rules ของ IDE ทุกตัว

### Runtime Harness สำหรับ ChatGPT Web

หลังเชื่อม Unified-MPC เป็น MCP connector แล้ว การมี child MCP อยู่ในเครื่อง **ไม่ได้หมายความว่า ChatGPT จะได้สิทธิ์ใช้เป็น mandatory native โดยอัตโนมัติ** ระบบจะบังคับลำดับที่ runtime ดังนี้:

1. ก่อนแก้ source/config ครั้งแรก Client ต้องเรียก `workspace_bootstrap` พร้อม `workspaceId` ของโปรเจกต์
2. Runtime จะอ่านและสร้าง fingerprint ของ `AGENTS.md` ถ้าไฟล์หายหรืออ่านไม่ได้ bootstrap จะ fail closed
3. Runtime จะเชื่อมและ pin `memory`, `thai-rag-mcp`, `godkiller` และตรวจว่าแต่ละตัวมี tool ที่ harness ต้องใช้จริง
4. MCP ที่มาจากไฟล์ใน workspace เช่น `.cursor/mcp.json` จะไม่สามารถปลอมชื่อมาทับ mandatory native MCP ได้
5. ก่อนแก้ development artifact แต่ละ path ต้องเรียก `prepare_code_change`; ระบบจะรัน `thai-rag-mcp/pre_edit_context` และ `godkiller/gk_task` (`action=edit_safe`)
6. สิทธิ์ pre-edit ใช้ได้หนึ่ง mutation ที่สำเร็จเท่านั้น จากนั้นต้องตรวจใหม่ก่อนแก้ path เดิมอีกครั้ง
7. ถ้า `AGENTS.md` ถูกแก้ระหว่าง session bootstrap เดิมจะถูกยกเลิกและต้องเรียก `workspace_bootstrap` ใหม่
8. Working memory สำหรับ ChatGPT ใช้ native surface `working_memory_search` และ `working_memory_record` แทนการยก tool ทั้งหมดของ child `memory` ขึ้นมาไว้ใน top-level catalog

MCP `instructions` ของ Unified-MPC จะบอก flow นี้กับ Client โดยตรง แต่ enforcement อยู่ที่ `ToolRegistry` อีกชั้น ดังนั้นแม้ Client ไม่ทำตาม prompt การแก้โค้ดก็ยังถูกบล็อกก่อน mutation

เมื่อสั่ง `pnpm cli sync` ระบบจะนำตารางและข้อกำหนดนี้ไปเขียนลงในไฟล์คอนฟิกของแต่ละ IDE ภายใต้บล็อก `<!-- MCP-POLICY-START -->` ... `<!-- MCP-POLICY-END -->` โดยไม่ทับคำสั่งเดิมของผู้ใช้

---

## 6. การตั้งค่า Service บน Ubuntu ด้วย Systemd

หากต้องการให้ Unified-MPC-Server ทำงานอยู่เบื้องหลังตลอดเวลา และเริ่มทำงานใหม่อัตโนมัติเมื่อเครื่องรีบูต:

```bash
# 1. สร้างโฟลเดอร์สำหรับ user systemd
mkdir -p ~/.config/systemd/user

# 2. คัดลอกไฟล์ service จาก scripts/
cp scripts/unified-mpc.service ~/.config/systemd/user/

# 3. เปิดให้โปรเซสทำงานต่อเนื่องแม้ไม่ได้ล็อกอินผ่าน SSH/GUI
loginctl enable-linger $USER

# 4. รีโหลดและเปิดใช้งาน Service
systemctl --user daemon-reload
systemctl --user enable --now unified-mpc.service

# 5. ดูสถานะและ Log
systemctl --user status unified-mpc.service
journalctl --user -u unified-mpc.service -f
```

---

## 7. การทดสอบและการตรวจสอบความถูกต้องของระบบ

โปรเจกต์มีชุดทดสอบระดับ package, integration และ runtime-contract ครอบคลุม monorepo ทั้งระบบ โดยจำนวน test cases เปลี่ยนตามรุ่น จึงควรยึดผลจากคำสั่ง verification ปัจจุบันแทนตัวเลขคงที่ในเอกสาร:

```bash
# 1. ตรวจสอบ Lint (ESLint 9 + TypeScript-ESLint)
pnpm lint

# 2. ตรวจสอบ Type Safety ทั้งหมด (TypeScript 5.8 Project References)
pnpm typecheck

# 3. รันชุดทดสอบทั้งหมด (Vitest Monorepo Test Runner)
pnpm test
```

ทุกคำสั่งจะต้องเสร็จสิ้นโดยมีผลลัพธ์ผ่าน 100% (Exit code 0, Zero errors, Zero warnings)


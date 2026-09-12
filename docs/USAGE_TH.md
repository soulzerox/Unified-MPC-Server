# คู่มือการใช้งาน Unified-MPC-Server (Thai User Manual)

Unified-MPC-Server คือระบบบริหารจัดการ Model Context Protocol (MCP) และ Senior Engineering Harness รุ่นใหม่ ออกแบบสำหรับระบบปฏิบัติการ Linux Ubuntu โดยเฉพาะ (100% Linux Native) ทำงานแบบ Local-First และเป็นศูนย์กลาง (Single Source of Truth) ในการจัดการ Tools, Skills, Rules และ Policies ข้ามสภาพแวดล้อม AI IDE หลากหลายค่าย

---

## สารบัญ

1. [ภาพรวมและความสามารถหลัก](#1-ภาพรวมและความสามารถหลัก)
2. [การเตรียมสภาพแวดล้อมและการติดตั้ง](#2-การเตรียมสภาพแวดล้อมและการติดตั้ง)
3. [คู่มือคำสั่ง CLI ทั้งหมด](#3-คู่มือคำสั่ง-cli-ทั้งหมด)
4. [ระบบ Web Control Plane และ Dashboard](#4-ระบบ-web-control-plane-และ-dashboard)
5. [การซิงค์นโยบาย Multi-IDE และมาตรฐาน P1–P7](#5-การซิงค์นโยบาย-multi-ide-และมาตรฐาน-p1p7)
6. [การตั้งค่า Service บน Ubuntu ด้วย Systemd](#6-การตั้งค่า-service-บน-ubuntu-ด้วย-systemd)
7. [การทดสอบและการตรวจสอบความถูกต้องของระบบ](#7-การทดสอบและการตรวจสอบความถูกต้องของระบบ)

---

## 1. ภาพรวมและความสามารถหลัก

- **100% Linux Ubuntu Native**: ปราศจากโค้ด Windows (`.bat`, `.ps1`, Win32 API) และ Electron GUI โดยทำงานผ่าน Node.js LTS และมาตรฐาน POSIX XDG Directory.
- **Bifurcated Ingestion Engine**: แยกกระบวนการติดตั้งอย่างชัดเจนระหว่าง Agent Skill Markdown (`SKILL.md`) และ External MCP Server (`stdio`/`sse`/`http`).
- **Zero-Artifact Pruning**: ลบการตั้งค่าและไฟล์ที่ไม่ได้ใช้งานอย่างสมบูรณ์แบบ ไม่ทิ้งขยะตกค้างในระบบ.
- **Single Source of Truth Multi-IDE Sync**: ซิงค์ Rules และ MCP Config ไปยัง 7 IDE ชั้นนำ (Antigravity, Cursor, Claude Code, OpenCode, Cline, OMP, Codex).
- **Mandatory P1–P7 Execution Priority**: กำหนดลำดับความสำคัญของ Tools ให้ Agent ทำงานอย่างแม่นยำ ไม่สับสน.
- **Gated Remote Gateway**: ระบบเชื่อมต่อ Remote Bridge ปลอดภัยด้วย 5-State Machine และเงื่อนไข Hard Gating.

---

## 2. การเตรียมสภาพแวดล้อมและการติดตั้ง

### ข้อกำหนดของระบบ
- **OS**: Ubuntu Linux 22.04 LTS หรือ 24.04 LTS
- **Node.js**: เวอร์ชั่น 20.x หรือ 22.x LTS
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
นำเข้าและคอมไพล์นโยบาย P1–P7 ไปยังไฟล์ Rules ของ IDE ทุกตัว:
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
pnpm cli install --skill ./path/to/my-skill --target antigravity --scope workspace
```

**ติดตั้ง MCP Server:**
```bash
pnpm cli install --server sqlite-db \
  --transport stdio \
  --command npx \
  --args "-y mcp-server-sqlite --db /tmp/test.db" \
  --target cursor
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
# รันบนพอร์ตเริ่มต้น 18765
pnpm cli web

# รันบนพอร์ตที่กำหนดเอง
pnpm cli web --port 8080
```

### 3.7 ตรวจสอบและรัน Tools (`tools`)
เรียกดูรายการ Tools ในระบบหรือสั่งประมวลผลคำสั่งของ Tool โดยตรง:
```bash
# ดูรายการเครื่องมือทั้งหมด
pnpm cli tools list

# สั่ง Execute เครื่องมือ
pnpm cli tools exec --name bash --input '{"command": "uname -a"}'
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

## 5. การซิงค์นโยบาย Multi-IDE และมาตรฐาน P1–P7

Unified-MPC-Server กำหนดลำดับการเรียกใช้งาน MCP Tool ตามมาตรฐานที่เข้มงวด ดังนี้:

| ลำดับ | Resource ID | ประเภท | มาตรการบังคับ | บทบาทหน้าที่ |
|---|---|---|---|---|
| **P1** | **`memory`** | MCP Server | บังคับ (Realtime) | บันทึกความจำระยะสั้นและ log การทำงานก่อน-หลังทุกขั้นตอนสำคัญ |
| **P2** | **`thai-rag-mcp`** | MCP Server | บังคับทุก Session | ระบบค้นหาข้อมูลถาวร Local RAG 100% ต้องค้นหาความจำเดิมก่อนตอบเสมอ |
| **P3** | **`godkiller`** | MCP Server | บังคับก่อนแก้โค้ด | ประเมิน Blast Radius วางแผนโหมด และตรวจสอบความปลอดภัยของโค้ด |
| **P4** | **`sequentialthinking`** | MCP Server | เรียกตามความจำเป็น | การคิดวิเคราะห์แบบ Step-by-Step สำหรับงานที่มีความซับซ้อนสูง |
| **P5** | **`context7`** | MCP Server | เรียกตามความจำเป็น | ดึง Document และโค้ดตัวอย่างที่ตรงเวอร์ชันของไลบรารีภายนอก |
| **P6** | **`filesystem`** | MCP Server | เรียกตามความจำเป็น | จัดการและอ่านไฟล์ข้ามโปรเจกต์ หรือการค้นหาแบบ Batch |
| **P7** | **`ui-skills`** | Skill Bundle | เรียกตามความจำเป็น | แนวทางและ Best Practice สำหรับการออกแบบและพัฒนา UI/UX |
| **Fallback** | Native Tools | Built-in | สำรองสุดท้าย | ใช้เครื่องมือพื้นฐานเฉพาะเมื่อไม่มี MCP Tool ที่เหมาะสม |

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

ในโปรเจกต์นี้มีชุดทดสอบครอบคลุมทั้ง 21 packages รวมกว่า 195 test suites และมากกว่า 1,780 test cases:

```bash
# 1. ตรวจสอบ Lint (ESLint 9 + TypeScript-ESLint)
pnpm lint

# 2. ตรวจสอบ Type Safety ทั้งหมด (TypeScript 5.8 Project References)
pnpm typecheck

# 3. รันชุดทดสอบทั้งหมด (Vitest Monorepo Test Runner)
pnpm test
```

ทุกคำสั่งจะต้องเสร็จสิ้นโดยมีผลลัพธ์ผ่าน 100% (Exit code 0, Zero errors, Zero warnings)


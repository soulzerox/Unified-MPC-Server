#!/usr/bin/env python3
"""Comprehensive Migration, E2E Stress Test & Benchmark for Local Context MCP."""
import os
import sys
import json
import time
import subprocess
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from thai_rag.server import LocalContextServer

REMOTE_HOST = "root@192.168.1.189"
REMOTE_MEM_PATH = "/opt/openviking/workspace/viking/home/user/external/memories"
LOCAL_SRC_PATH = "/home/qwerty/Documents/Src Code/webtrans_prepaid/src"

def fetch_remote_memories():
    print("📡 Step 1: Fetching all real memories from OpenViking (192.168.1.189)...")
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", REMOTE_HOST,
        f"""python3 -c '
import os, json
mem_dir = "{REMOTE_MEM_PATH}"
files = []
for root, dirs, fnames in os.walk(mem_dir):
    for f in fnames:
        if f.endswith(".md") and not f.startswith("."):
            fpath = os.path.join(root, f)
            relpath = os.path.relpath(fpath, mem_dir)
            with open(fpath, "r", encoding="utf-8") as fp:
                content = fp.read()
            files.append({{"path": relpath, "content": content}})
print(json.dumps(files))
'"""
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    memories = json.loads(res.stdout)
    print(f"  ✅ Retrieved {len(memories)} memory files from remote OpenViking.")
    return memories

def main():
    print("=" * 70)
    print("🚀 OPENVIKING -> LOCAL CONTEXT MCP: FULL MIGRATION & E2E BENCHMARK")
    print("=" * 70)

    # 1. Fetch remote memories
    memories = fetch_remote_memories()

    # 2. Ingest into Local Context MCP
    print("\n📦 Step 2: Ingesting memories into Local Context MCP (SQLite + Chroma)...")
    server = LocalContextServer()
    t_start = time.time()
    migrated_count = 0
    errors = 0
    for m in memories:
        path = m["path"]
        content = m["content"]
        cat = "general"
        if "events" in path:
            cat = "event"
        elif "entities/software_tool" in path:
            cat = "tool"
        elif "entities/software_project" in path:
            cat = "project"
        elif "soul" in path or "identity" in path:
            cat = "system"

        res = server.remember(content, category=cat)
        if "Remembered" in res:
            migrated_count += 1
            print(f"  [{migrated_count}/{len(memories)}] {path} -> ✅ Success")
        else:
            errors += 1
            print(f"  [ERROR] {path} -> ❌ {res}")

    t_mem = round(time.time() - t_start, 2)
    print(f"\n  📊 Memory Migration Summary: {migrated_count} succeeded, {errors} failed in {t_mem}s.")

    # 3. Code Ingestion for webtrans_prepaid
    print("\n📂 Step 3: Indexing local source code of 'webtrans_prepaid'...")
    if Path(LOCAL_SRC_PATH).is_dir():
        t_code_start = time.time()
        idx_res = server.code_index(LOCAL_SRC_PATH)
        t_code = round(time.time() - t_code_start, 2)
        print("  Index Summary:\n" + "\n".join(f"    {line}" for line in idx_res.splitlines()))
    else:
        print(f"  ⚠️ Path {LOCAL_SRC_PATH} not found, skipping source code indexing.")

    # 4. Side-by-Side Comparison & Stress Test Queries
    benchmark_queries = [
        {
            "id": "BENCH-01 [Thai PromptPay Canvas]",
            "type": "memory",
            "query": "การใส่กรอบ Thai QR Payment PromptPay ด้วย Canvas",
            "expect": "promptpay-frame.ts"
        },
        {
            "id": "BENCH-02 [Architecture & Version]",
            "type": "memory",
            "query": "ดำน้ำ Damnam version และ DEFAULT_SERVER_ORIGIN",
            "expect": "damnam.753153268.xyz"
        },
        {
            "id": "BENCH-03 [Code Symbol Search]",
            "type": "code",
            "query": "drawFramedQr",
            "expect": "promptpay-frame.ts"
        },
        {
            "id": "BENCH-04 [Code Exact Symbol]",
            "type": "code",
            "query": "DEFAULT_SERVER_ORIGIN",
            "expect": "server-url.ts"
        },
        {
            "id": "BENCH-05 [Milestone & Backlog]",
            "type": "memory",
            "query": "webtrans_prepaid wizard Phase B checkout",
            "expect": "Phase B payment step"
        }
    ]

    print("\n" + "=" * 70)
    print("⚖️ Step 4: RUNNING BENCHMARK QUERIES & QUALITY CHECKS")
    print("=" * 70)

    for item in benchmark_queries:
        qid = item["id"]
        qtype = item["type"]
        qstr = item["query"]
        expect = item["expect"]
        print(f"\n🧪 {qid}: '{qstr}'")

        # Local Context MCP Search
        t_local_start = time.time()
        if qtype == "code":
            local_out = server.code_search(qstr, top_k=2)
        else:
            local_out = server.recall(qstr, limit=2)
        t_local_ms = round((time.time() - t_local_start) * 1000, 1)

        has_expect = expect.lower() in local_out.lower()
        print(f"  ⚡ Local MCP Latency: {t_local_ms} ms | Target Found: {'✅ PASS' if has_expect else '❌ FAIL'}")
        print("  --- Retrieved Preview ---")
        for line in local_out.splitlines()[:8]:
            print(f"    {line}")

    server.close()

    print("\n" + "=" * 70)
    print("🎉 FULL MIGRATION & BENCHMARK FINISHED!")
    print("=" * 70)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Migration script to import memories from remote OpenViking into local context MCP."""
import sys
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from thai_rag.server import LocalContextServer

REMOTE_MEMORIES = [
    {
        "id": "identity",
        "category": "identity",
        "content": """# identity.md - Who Am I?
- Creature: AI assistant
- Role: Antigravity Assistant & Code Specialist
- Vibe: Concise, thoughtful, expert engineer
"""
    },
    {
        "id": "soul",
        "category": "rule",
        "content": """# soul.md - Core Principles
1. Be helpful, not performative. Have opinions. Be resourceful before asking.
2. Earn trust through competence. You're a guest in their life — respect that.
3. Private things stay private. Ask before acting externally.
4. Concise when needed, thorough when it matters.
"""
    },
    {
        "id": "webtrans_prepaid",
        "category": "project",
        "content": """# Project: webtrans_prepaid
Project for prepaid translation and syncing across Cloudflare Workers and user scripts.
Key rules: Real-time Memory tracking, retrieval-first coding, and local-first architecture.
"""
    }
]

def migrate():
    print("🚀 Initializing LocalContextServer...")
    server = LocalContextServer()

    print("\n📦 Importing core memories from OpenViking...")
    for item in REMOTE_MEMORIES:
        res = server.remember(item["content"], category=item["category"])
        print(f"  {res.splitlines()[0]}")

    print("\n🔍 Verifying recall...")
    recall_out = server.recall("identity who am I")
    print(recall_out)

    server.close()
    print("\n✨ Migration completed successfully!")

if __name__ == "__main__":
    migrate()

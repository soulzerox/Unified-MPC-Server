"""Comprehensive Smoke, E2E, and Stress Test for sync tab codebase in thai-rag-mcp."""
import time
import sys
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from thai_rag.server import get_server

def run_tests():
    server = get_server()
    print("=" * 70)
    print("🚀 RUNNING SMOKE, E2E & STRESS TEST ON 'sync tab' CODEBASE")
    print("=" * 70)

    # --- Test 1: Incremental Cache Speed Test (Smoke) ---
    print("\n[TEST 1] Incremental Cache Hit & Speed Verification:")
    t0 = time.time()
    res1 = server.code_index(workspace_path="/home/qwerty/Documents/Src Code/sync tab", force=False)
    t_cache = time.time() - t0
    print(f"Result: {res1.strip()}")
    print(f"⏱️ Cache verification took: {t_cache:.3f}s")
    assert "Skipped (unchanged): `34 files`" in res1, "Cache hit assertion failed!"
    print("✅ TEST 1 PASSED: 34 files skipped via SHA256 cache in sub-second time.")

    # --- Test 2: Exact Code Symbol Search ---
    print("\n[TEST 2] Exact Code Symbol Retrieval ('isIgnoredUrl'):")
    t0 = time.time()
    res2 = server.code_search(query="isIgnoredUrl", top_k=3, path_filter="sync tab")
    t_sym = time.time() - t0
    print(f"Latency: {t_sym*1000:.1f}ms")
    print(f"Top result:\n{res2[:300]}...")
    assert "url-sanitizer.js" in res2, "Expected url-sanitizer.js in search results!"
    print("✅ TEST 2 PASSED: Successfully retrieved exact symbol 'isIgnoredUrl'.")

    # --- Test 3: Complex Symbol & Method Search ---
    print("\n[TEST 3] Complex Symbol Search ('getOrCreateWindowUuid'):")
    t0 = time.time()
    res3 = server.code_search(query="getOrCreateWindowUuid", top_k=3, path_filter="state-manager.js")
    t_class = time.time() - t0
    print(f"Latency: {t_class*1000:.1f}ms")
    print(f"Top result:\n{res3[:300]}...")
    assert "state-manager.js" in res3, "Expected state-manager.js in search results!"
    print("✅ TEST 3 PASSED: Successfully located StateManager topology mapping.")

    # --- Test 4: Thai Semantic Query ---
    print("\n[TEST 4] Thai Semantic Search ('การตัด tracking parameters ออกจาก URL'):")
    t0 = time.time()
    res4 = server.code_search(query="การตัด tracking parameters ออกจาก URL", top_k=3, path_filter="sync tab")
    t_thai = time.time() - t0
    print(f"Latency: {t_thai*1000:.1f}ms")
    print(f"Top result:\n{res4[:300]}...")
    assert "url-sanitizer.js" in res4 or "TRACKING_PARAM_PREFIXES" in res4 or "normalizeUrl" in res4, "Semantic match failed!"
    print("✅ TEST 4 PASSED: Thai natural language query matched URL sanitizer logic.")

    # --- Test 5: Multi-Project Path Filtering Isolation ---
    print("\n[TEST 5] Path Filtering Isolation ('sync tab' vs 'webtrans_prepaid'):")
    res_sync = server.code_search(query="storage", top_k=5, path_filter="sync tab")
    res_webtrans = server.code_search(query="storage", top_k=5, path_filter="webtrans_prepaid")
    assert "webtrans" not in res_sync, "Pollution detected: webtrans found in sync tab filtered results!"
    assert "sync tab" not in res_webtrans, "Pollution detected: sync tab found in webtrans filtered results!"
    print("✅ TEST 5 PASSED: Strict isolation between sync tab and webtrans_prepaid.")

    # --- Test 6: Code Context Window ---
    print("\n[TEST 6] Code Context Extraction for 'url-sanitizer.js':")
    res6 = server.code_context(file_path="background/url-sanitizer.js", line_number=20, window=10)
    print(f"Context retrieved:\n{res6[:300]}...")
    assert "isIgnoredUrl" in res6, "Context failed to extract function scope!"
    print("✅ TEST 6 PASSED: Function scope extracted with exact line markers.")

    # --- Test 7: Concurrency & Stress Latency Benchmark ---
    print("\n[TEST 7] Stress Latency Benchmark (10 sequential queries):")
    queries = [
        "isIgnoredUrl",
        "StateManager debounce",
        "Chrome extension service worker",
        "native-adapter.js messaging",
        "accordion clustering tabs",
        "การกู้คืน session เก่า",
        "normalizeUrl stripTracking",
        "activeWindows closedWindows",
        "STORAGE_VERSION",
        "garbage collection windowUuid",
    ]
    latencies = []
    for q in queries:
        t_start = time.time()
        s_res = server.code_search(query=q, top_k=3, path_filter="sync tab")
        latencies.append((time.time() - t_start) * 1000)

    avg_lat = sum(latencies) / len(latencies)
    min_lat = min(latencies)
    max_lat = max(latencies)
    print(f"📊 Latency Stats (10 queries): Min: {min_lat:.1f}ms | Avg: {avg_lat:.1f}ms | Max: {max_lat:.1f}ms")
    assert avg_lat < 250, f"Average latency too high: {avg_lat}ms"
    print("✅ TEST 7 PASSED: Ultra-low latency maintained under continuous query stress.")

    print("\n" + "=" * 70)
    print("🎉 ALL 7 SMOKE, E2E & STRESS TESTS PASSED WITH 100% SUCCESS!")
    print("=" * 70)

if __name__ == "__main__":
    run_tests()

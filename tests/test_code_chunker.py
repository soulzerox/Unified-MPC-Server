import pytest
from thai_rag.code_chunker import CodeChunker, CodeChunk

def test_chunk_python_file():
    code = """# โมดูลจัดการผู้ใช้
import os

class UserManager:
    \"\"\"คลาสสำหรับจัดการผู้ใช้ในระบบ\"\"\"
    def __init__(self):
        self.users = []

    def add_user(self, name: str):
        # เพิ่มผู้ใช้ใหม่ลงในลิสต์
        self.users.append(name)
        return True

def calculate_tax(amount: float) -> float:
    # คำนวณภาษีมูลค่าเพิ่ม 7% ของยอดเงิน
    vat = amount * 0.07
    return vat
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("user_manager.py", code)
    
    # Should identify functions and classes as parents
    assert len(parents) >= 2
    symbols = [p.symbol_name for p in parents]
    assert any("UserManager" in s for s in symbols)
    assert any("calculate_tax" in s for s in symbols)

    # Check child chunks
    for parent in parents:
        assert parent.start_line > 0
        assert parent.end_line >= parent.start_line
        assert len(parent.child_chunks) >= 1
        for child in parent.child_chunks:
            assert child.parent_id == parent.id
            assert child.file_path == "user_manager.py"
            assert len(child.content) > 0

def test_thai_comment_extraction():
    chunker = CodeChunker()
    text = "def calc():\n    # คำนวณยอดสุทธิและหัก ณ ที่จ่าย 3 เปอร์เซ็นต์\n    return 100"
    thai_text = chunker.extract_thai_text(text)
    assert "คำนวณ" in thai_text
    assert "ภาษี" in thai_text or "จ่าย" in thai_text

def test_typescript_chunking():
    ts_code = """// บริการเชื่อมต่อ API
export class ApiService {
  private baseUrl: string;

  constructor(url: string) {
    this.baseUrl = url;
  }

  public async fetchData(): Promise<any> {
    // ดึงข้อมูลจากเซิร์ฟเวอร์
    return fetch(this.baseUrl);
  }
}
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("api.ts", ts_code)
    assert len(parents) >= 1
    assert any("ApiService" in p.symbol_name for p in parents)


def test_nested_arrow_functions_do_not_split_outer_function():
    code = """export async function processBatch(items: string[]) {
  const innerHelper = (x: string) => x.trim();
  const results = items.map(innerHelper);
  return results;
}

export const topLevelArrow = () => {
  return 123;
};
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("batch.ts", code)
    symbols = [p.symbol_name for p in parents]
    assert "processBatch" in symbols
    assert "topLevelArrow" in symbols
    assert "innerHelper" not in symbols


def test_python_ast_class_chunking_not_truncated():
    code = """class ShadowWeaver:
    def __init__(self, llm_client: LLMClient) -> None:
        self.llm = llm_client

    async def generate_seed(self, chapter: int, outline: str) -> str:
        return "seed"
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("shadow_weaver.py", code)
    sw = [p for p in parents if p.symbol_name == "ShadowWeaver"][0]
    # The cohesive class must encompass the full class definition and not be truncated to 1 line
    assert sw.end_line > sw.start_line
    assert "def __init__" in sw.content
    assert "generate_seed" in sw.content


def test_python_inner_class_in_function_does_not_split_outer_function():
    code = """def test_emotion_word_check():
    class MockLLM:
        pass
    reviewer = MicroReviewer(MockLLM())
    assert reviewer is not None
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("test_craft.py", code)
    symbols = [p.symbol_name for p in parents]
    assert "test_emotion_word_check" in symbols
    assert "MockLLM" not in symbols
    test_p = [p for p in parents if p.symbol_name == "test_emotion_word_check"][0]
    assert test_p.start_line == 1
    assert test_p.end_line >= 5
    assert "assert reviewer is not None" in test_p.content


def test_python_large_class_separates_methods_with_qualname():
    methods = "\n".join([f"    def method_{i}(self):\n        return {i}\n" * 5 for i in range(8)])
    code = f"""class BigService:
    \"\"\"Big service docstring.\"\"\"
    def __init__(self):
        self.val = 42

{methods}
"""
    chunker = CodeChunker()
    parents = chunker.chunk_file("service.py", code)
    symbols = [p.symbol_name for p in parents]
    assert "BigService" in symbols
    # Methods must be qualified with BigService.method_*
    assert any("BigService.method_" in s for s in symbols)
    # Class header must contain __init__
    header_p = [p for p in parents if p.symbol_name == "BigService"][0]
    assert "def __init__" in header_p.content


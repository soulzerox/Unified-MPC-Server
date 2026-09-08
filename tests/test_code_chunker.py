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

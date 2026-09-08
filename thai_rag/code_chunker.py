import re
import hashlib
from dataclasses import dataclass, field
from typing import List, Optional
import pythainlp
from thai_rag.config import TARGET_CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS

@dataclass
class CodeChunk:
    id: str
    parent_id: str
    file_path: str
    start_line: int
    end_line: int
    content: str
    symbol_name: str

@dataclass
class ParentDocument:
    id: str
    file_path: str
    start_line: int
    end_line: int
    content: str
    symbol_name: str
    child_chunks: List[CodeChunk] = field(default_factory=list)

class CodeChunker:
    """AST & Syntax aware chunker with Thai language comment preservation."""

    def __init__(self, target_tokens: int = TARGET_CHUNK_TOKENS, overlap: int = CHUNK_OVERLAP_TOKENS):
        self.target_tokens = target_tokens
        self.overlap = overlap
        self.thai_regex = re.compile(r'[\u0E00-\u0E7F]+')

    def extract_thai_text(self, text: str) -> str:
        """Extract all Thai words/sentences from text using PyThaiNLP."""
        matches = self.thai_regex.findall(text)
        if not matches:
            return ""
        extracted = []
        for m in matches:
            tokens = pythainlp.tokenize.word_tokenize(m, engine="newmm")
            extracted.append(" ".join(tokens))
        return " ".join(extracted)

    def _generate_id(self, file_path: str, start_line: int, end_line: int, prefix: str = "doc") -> str:
        h = hashlib.sha256(f"{file_path}:{start_line}:{end_line}:{prefix}".encode("utf-8")).hexdigest()[:16]
        return f"{prefix}_{h}"

    def chunk_file(self, file_path: str, content: str) -> List[ParentDocument]:
        """Split a code or text file into ParentDocuments and ChildChunks."""
        if not content.strip():
            return []

        lines = content.splitlines()
        total_lines = len(lines)

        # Detect language / file type
        ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""

        # Find block boundaries based on syntax
        blocks = self._detect_blocks(lines, ext)
        if not blocks:
            # Fallback: treat whole file or coarse chunks as parent
            blocks = [(1, total_lines, Path(file_path).stem if hasattr(Path(file_path), 'stem') else "root")]

        parent_docs: List[ParentDocument] = []

        for start_line, end_line, symbol_name in blocks:
            block_lines = lines[start_line - 1 : end_line]
            block_content = "\n".join(block_lines)
            parent_id = self._generate_id(file_path, start_line, end_line, "parent")

            parent = ParentDocument(
                id=parent_id,
                file_path=file_path,
                start_line=start_line,
                end_line=end_line,
                content=block_content,
                symbol_name=symbol_name
            )

            # Split block into child chunks
            child_chunks = self._create_child_chunks(
                parent_id=parent_id,
                file_path=file_path,
                symbol_name=symbol_name,
                block_lines=block_lines,
                base_line=start_line
            )
            parent.child_chunks = child_chunks
            parent_docs.append(parent)

        return parent_docs

    def _detect_blocks(self, lines: List[str], ext: str) -> List[tuple]:
        """Detect class, function, or block headers with line numbers."""
        blocks = []
        total = len(lines)
        if total == 0:
            return []

        # Patterns for function/class definitions
        py_pattern = re.compile(r'^(?:async\s+)?(?:def|class)\s+([a-zA-Z0-9_]+)')
        js_pattern = re.compile(r'^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+([a-zA-Z0-9_]+)')
        var_func_pattern = re.compile(r'^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(')

        indices = []
        for idx, line in enumerate(lines):
            stripped = line.strip()
            # Check indentation: top-level or method level (indent <= 4 spaces)
            leading_spaces = len(line) - len(line.lstrip(' '))
            if leading_spaces <= 4:
                match = None
                if ext in ("py", ""):
                    match = py_pattern.match(stripped)
                if not match and ext in ("ts", "js", "tsx", "jsx", "mjs"):
                    if leading_spaces == 0:
                        match = js_pattern.match(stripped) or var_func_pattern.match(stripped)
                    else:
                        # Inside classes: match class methods, but exclude local closures (const/let/var)
                        method_pattern = re.compile(r'^(?:(?:public|private|protected|static|async|override)\s+)+([a-zA-Z0-9_]+)\s*\(')
                        match = js_pattern.match(stripped) or method_pattern.match(stripped)

                if match:
                    indices.append((idx, match.group(1)))

        if not indices:
            # If no AST symbols found, divide into logical chunks of ~60 lines
            step = 60
            for start in range(0, total, step):
                end = min(start + step, total)
                blocks.append((start + 1, end, f"chunk_{start+1}_{end}"))
            return blocks

        # Group into blocks
        for i, (line_idx, symbol) in enumerate(indices):
            start_line = line_idx + 1
            if i + 1 < len(indices):
                end_line = indices[i + 1][0]
            else:
                end_line = total
            if end_line >= start_line:
                blocks.append((start_line, end_line, symbol))

        # Include any leading file header / preamble if it's substantial
        first_start = indices[0][0]
        if first_start > 2:
            blocks.insert(0, (1, first_start, "header"))

        return blocks

    def _create_child_chunks(
        self,
        parent_id: str,
        file_path: str,
        symbol_name: str,
        block_lines: List[str],
        base_line: int
    ) -> List[CodeChunk]:
        """Split block into child chunks sized ~target_tokens (~250-350 tokens)."""
        chunks = []
        num_lines = len(block_lines)

        # An approximation: ~35 lines is roughly 250-350 tokens of code
        lines_per_chunk = 35
        overlap_lines = 8

        if num_lines <= lines_per_chunk + overlap_lines:
            # Single child chunk
            content = "\n".join(block_lines)
            thai_notes = self.extract_thai_text(content)
            enriched_content = f"// File: {file_path} | Symbol: {symbol_name}\n"
            if thai_notes:
                enriched_content += f"// Thai Context: {thai_notes}\n"
            enriched_content += content

            chunk_id = self._generate_id(file_path, base_line, base_line + num_lines - 1, "child")
            chunks.append(CodeChunk(
                id=chunk_id,
                parent_id=parent_id,
                file_path=file_path,
                start_line=base_line,
                end_line=base_line + num_lines - 1,
                content=enriched_content,
                symbol_name=symbol_name
            ))
            return chunks

        start = 0
        while start < num_lines:
            end = min(start + lines_per_chunk, num_lines)
            chunk_slice = block_lines[start:end]
            content = "\n".join(chunk_slice)
            thai_notes = self.extract_thai_text(content)

            enriched = f"// File: {file_path} | Scope: {symbol_name} (lines {base_line + start}-{base_line + end - 1})\n"
            if thai_notes:
                enriched += f"// Thai Notes: {thai_notes}\n"
            enriched += content

            chunk_id = self._generate_id(file_path, base_line + start, base_line + end - 1, "child")
            chunks.append(CodeChunk(
                id=chunk_id,
                parent_id=parent_id,
                file_path=file_path,
                start_line=base_line + start,
                end_line=base_line + end - 1,
                content=enriched,
                symbol_name=symbol_name
            ))

            if end == num_lines:
                break
            start += (lines_per_chunk - overlap_lines)

        return chunks

"""
Code Property Graph (CPG-Lite) AST and Call Graph Extractor.
Extracts symbols (functions, classes, methods) and edges (calls, imports, inherits)
using Python's native AST parser and high-speed regex token scanners for JS/TS.
"""

import ast
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional

class PythonASTVisitor(ast.NodeVisitor):
    def __init__(self, file_path: str, workspace: str):
        self.file_path = file_path
        self.workspace = workspace
        self.symbols: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self._class_stack: List[str] = []
        self._current_func: Optional[str] = None

    def visit_ClassDef(self, node: ast.ClassDef):
        class_name = node.name
        self.symbols.append({
            "file_path": self.file_path,
            "symbol_name": class_name,
            "symbol_type": "class",
            "line_start": node.lineno,
            "line_end": getattr(node, "end_lineno", node.lineno),
            "workspace": self.workspace
        })

        # Track inheritance
        for base in node.bases:
            base_name = None
            if isinstance(base, ast.Name):
                base_name = base.id
            elif isinstance(base, ast.Attribute):
                base_name = base.attr
            if base_name:
                self.edges.append({
                    "source_symbol": class_name,
                    "source_file": self.file_path,
                    "target_symbol": base_name,
                    "target_file": None,
                    "edge_type": "inherits",
                    "workspace": self.workspace
                })

        self._class_stack.append(class_name)
        self.generic_visit(node)
        self._class_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._handle_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._handle_func(node)

    def _handle_func(self, node: ast.AST):
        name = getattr(node, "name", "anonymous")
        if self._class_stack:
            qualified_name = f"{self._class_stack[-1]}.{name}"
            sym_type = "method"
        else:
            qualified_name = name
            sym_type = "function"

        self.symbols.append({
            "file_path": self.file_path,
            "symbol_name": qualified_name,
            "symbol_type": sym_type,
            "line_start": node.lineno,
            "line_end": getattr(node, "end_lineno", node.lineno),
            "workspace": self.workspace
        })

        # Save previous function context to handle nested functions
        prev_func = self._current_func
        self._current_func = qualified_name
        self.generic_visit(node)
        self._current_func = prev_func

    def visit_Call(self, node: ast.Call):
        target_name = None
        if isinstance(node.func, ast.Name):
            target_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            target_name = node.func.attr

        if target_name and self._current_func:
            self.edges.append({
                "source_symbol": self._current_func,
                "source_file": self.file_path,
                "target_symbol": target_name,
                "target_file": None,
                "edge_type": "calls",
                "workspace": self.workspace
            })

        self.generic_visit(node)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            self.edges.append({
                "source_symbol": "<file>",
                "source_file": self.file_path,
                "target_symbol": alias.name,
                "target_file": None,
                "edge_type": "imports",
                "workspace": self.workspace
            })
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        module = node.module or ""
        for alias in node.names:
            full_name = f"{module}.{alias.name}" if module else alias.name
            self.edges.append({
                "source_symbol": "<file>",
                "source_file": self.file_path,
                "target_symbol": full_name,
                "target_file": None,
                "edge_type": "imports",
                "workspace": self.workspace
            })
        self.generic_visit(node)


def extract_python_cpg(file_path: str, content: str, workspace: str) -> Tuple[List[Dict], List[Dict]]:
    try:
        tree = ast.parse(content, filename=file_path)
    except SyntaxError:
        return [], []
    except Exception:
        return [], []

    visitor = PythonASTVisitor(file_path=file_path, workspace=workspace)
    visitor.visit(tree)
    return visitor.symbols, visitor.edges


# Regex patterns for JavaScript/TypeScript extraction
RE_TS_IMPORT = re.compile(r"""(?:import\s+.*?\s+from\s+['"](.*?)['"]|require\(['"](.*?)['"]\))""")
RE_TS_CLASS = re.compile(r"""class\s+([A-Za-z0-9_]+)(?:\s+extends\s+([A-Za-z0-9_]+))?""")
RE_TS_FUNC = re.compile(r"""(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(""")
# BUG-R7: require '=>' — without it 'const x = someCall(...)' (parenthesized
# assignment RHS) is misread as an arrow function declaration, leaving
# current_func = x and poisoning every later call edge's source_symbol.
RE_TS_ARROW = re.compile(r"""(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{?""")
# BUG-R7b: allow optional access modifiers + static + async so class methods
# like 'private save(): void {' still register current_func. Without this the
# enclosing method context is lost and call edges get misattributed.
RE_TS_METHOD = re.compile(r"""(?:(?:private|public|protected|static|readonly|override)\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::[^{;]*)?\s*\{""")
RE_TS_CALL = re.compile(r"""(?:\b([A-Za-z0-9_]+)\s*\(|\.([A-Za-z0-9_]+)\s*\()""")

TS_KEYWORDS_FILTER = {
    "if", "for", "while", "switch", "catch", "return", "typeof", "super",
    "require", "import", "function", "class", "async", "await", "new",
    "constructor", "get", "set"
}

def extract_ts_cpg(file_path: str, content: str, workspace: str) -> Tuple[List[Dict], List[Dict]]:
    symbols: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    lines = content.splitlines()

    # 1. Imports
    for match in RE_TS_IMPORT.finditer(content):
        mod = match.group(1) or match.group(2)
        if mod:
            edges.append({
                "source_symbol": "<file>",
                "source_file": file_path,
                "target_symbol": mod,
                "target_file": None,
                "edge_type": "imports",
                "workspace": workspace
            })

    # Line-by-line lightweight scanning
    current_class = None
    current_func = None
    func_start_line = 1

    for line_idx, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            continue

        # Class definition
        class_match = RE_TS_CLASS.search(line)
        if class_match:
            c_name = class_match.group(1)
            base_name = class_match.group(2)
            current_class = c_name
            symbols.append({
                "file_path": file_path,
                "symbol_name": c_name,
                "symbol_type": "class",
                "line_start": line_idx,
                "line_end": line_idx,
                "workspace": workspace
            })
            if base_name:
                edges.append({
                    "source_symbol": c_name,
                    "source_file": file_path,
                    "target_symbol": base_name,
                    "target_file": None,
                    "edge_type": "inherits",
                    "workspace": workspace
                })
            continue

        # Function definition
        f_match = RE_TS_FUNC.search(line) or RE_TS_ARROW.search(line)
        if f_match:
            f_name = f_match.group(1)
            current_func = f_name
            func_start_line = line_idx
            symbols.append({
                "file_path": file_path,
                "symbol_name": f_name,
                "symbol_type": "function",
                "line_start": line_idx,
                "line_end": line_idx,
                "workspace": workspace
            })
            continue

        # Method in class
        if current_class and "{" in line:
            m_match = RE_TS_METHOD.search(line)
            if m_match:
                m_name = m_match.group(1)
                if m_name not in TS_KEYWORDS_FILTER:
                    q_name = f"{current_class}.{m_name}"
                    current_func = q_name
                    symbols.append({
                        "file_path": file_path,
                        "symbol_name": q_name,
                        "symbol_type": "method",
                        "line_start": line_idx,
                        "line_end": line_idx,
                        "workspace": workspace
                    })
                    continue

        # Function calls
        if current_func:
            for call_m in RE_TS_CALL.finditer(line):
                callee = call_m.group(1) or call_m.group(2)
                if callee and callee not in TS_KEYWORDS_FILTER and callee != current_func:
                    edges.append({
                        "source_symbol": current_func,
                        "source_file": file_path,
                        "target_symbol": callee,
                        "target_file": None,
                        "edge_type": "calls",
                        "workspace": workspace
                    })

    return symbols, edges


def extract_cpg(file_path: str, content: str, workspace: str = "") -> Tuple[List[Dict], List[Dict]]:
    """Extract code symbols and edges according to file extension."""
    ext = Path(file_path).suffix.lower()
    if ext == ".py":
        return extract_python_cpg(file_path, content, workspace)
    elif ext in {".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs"}:
        return extract_ts_cpg(file_path, content, workspace)
    return [], []


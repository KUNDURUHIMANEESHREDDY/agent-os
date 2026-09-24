import re
from typing import Optional
from chunking.model import Chunk

def parse_hierarchical(text: str, max_leaf_chars: int = 500) -> list[Chunk]:
    """
    Parse markdown text into hierarchical chunks.
    Returns flat list of Chunks with parent/child links intact.
    """
    chunks: list[Chunk] = []
    header_stack: list[tuple[int, str]] = []  # [(level, title), ...]
    
    # Split on lines, track position
    lines = text.split("\n")
    current_section_lines: list[str] = []
    current_parent_id: Optional[str] = None
    
    def _flush_section():
        """Create leaf chunks from accumulated section content."""
        nonlocal current_section_lines
        content = "\n".join(current_section_lines).strip()
        if not content:
            return
        
        header_path = " > ".join([h[1] for h in header_stack])
        
        # Split large sections into smaller leaf chunks
        paragraphs = re.split(r'\n\s*\n', content)
        buffer = ""
        for para in paragraphs:
            candidate = f"{buffer}\n\n{para}".strip() if buffer else para
            if len(candidate) > max_leaf_chars and buffer:
                # Flush buffer as a chunk
                _create_leaf(buffer, header_path, current_parent_id)
                buffer = para
            else:
                buffer = candidate
        if buffer:
            _create_leaf(buffer, header_path, current_parent_id)
        
        current_section_lines = []
    
    def _create_leaf(text: str, header_path: str, parent_id: Optional[str]):
        leaf = Chunk(
            text=text,
            level=len(header_stack) + 1,
            parent_id=parent_id,
            metadata={"header_path": header_path}
        )
        chunks.append(leaf)
        # Link to parent
        if parent_id:
            for c in chunks:
                if c.id == parent_id:
                    c.children_ids.append(leaf.id)
                    break
    
    # Create root document chunk
    root = Chunk(text="", level=0, metadata={"header_path": ""})
    chunks.append(root)
    
    for line in lines:
        header_match = re.match(r'^(#{1,6})\s+(.*)', line)
        if header_match:
            _flush_section()
            level = len(header_match.group(1))
            title = header_match.group(2).strip()

            # Pop stack to correct level
            while header_stack and header_stack[-1][0] >= level:
                header_stack.pop()

            parent_id = header_stack[-1][2] if header_stack else root.id

            # Create section-level chunk
            section = Chunk(
                text=f"{'#' * level} {title}",
                level=level,
                parent_id=parent_id,
                metadata={"header_path": " > ".join([h[1] for h in header_stack] + [title])}
            )
            chunks.append(section)
            # link section to parent
            for c in chunks:
                if c.id == parent_id:
                    c.children_ids.append(section.id)
                    break
            header_stack.append((level, title, section.id))
            current_parent_id = section.id
        else:
            current_section_lines.append(line)
    
    _flush_section()
    return chunks

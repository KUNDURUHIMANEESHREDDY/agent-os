from dataclasses import dataclass, field
from typing import Optional
import uuid
import hashlib

@dataclass
class Chunk:
    """A node in the hierarchical chunk tree."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    level: int = 0              # 0=doc, 1=section, 2=subsection, 3=paragraph
    parent_id: Optional[str] = None
    children_ids: list[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)  # header_path, doc_order, etc.
    
    @property
    def header_path(self) -> str:
        return self.metadata.get("header_path", "")

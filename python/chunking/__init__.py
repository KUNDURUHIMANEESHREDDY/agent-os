"""agent-os chunking package (merged from hierarchical-chunking repo)."""
from chunking.model import Chunk
from chunking.Structure import parse_hierarchical
from chunking.Embedding import HierarchicalIndex

__all__ = ["Chunk", "parse_hierarchical", "HierarchicalIndex"]

import numpy as np
from chunking.model import Chunk

class HierarchicalIndex:
    def __init__(self):
        self.chunks: dict[str, Chunk] = {}
        self.embeddings: dict[str, np.ndarray] = {}
    
    def add_chunks(self, chunks: list[Chunk], embed_fn):
        """embed_fn: callable(str) -> np.ndarray"""
        for chunk in chunks:
            self.chunks[chunk.id] = chunk
            # Only embed LEAF chunks for precise retrieval
            # Optionally also embed section summaries
            if chunk.level >= 3 or not chunk.children_ids:
                self.embeddings[chunk.id] = embed_fn(chunk.text)
    
    def search(self, query: str, embed_fn, top_k: int = 5) -> list[Chunk]:
        """Search leaf chunks, return PARENT chunks for context."""
        q_emb = embed_fn(query)
        
        scores = []
        for cid, emb in self.embeddings.items():
            score = np.dot(q_emb, emb) / (np.linalg.norm(q_emb) * np.linalg.norm(emb))
            scores.append((cid, score))
        
        scores.sort(key=lambda x: x[1], reverse=True)
        
        # Parent Document Retrieval: fetch parent instead of leaf
        retrieved_parents = set()
        results = []
        for cid, score in scores[:top_k * 2]:  # over-fetch to deduplicate parents
            leaf = self.chunks[cid]
            parent_id = leaf.parent_id or cid
            if parent_id not in retrieved_parents:
                retrieved_parents.add(parent_id)
                parent = self.chunks[parent_id]
                # Gather all sibling leaves under same parent for full context
                sibling_text = "\n\n".join(
                    self.chunks[sid].text 
                    for sid in parent.children_ids 
                    if sid in self.chunks
                ) or parent.text
                results.append(Chunk(
                    text=sibling_text,
                    metadata={**parent.metadata, "matched_leaf_score": score}
                ))
            if len(results) >= top_k:
                break
        
        return results

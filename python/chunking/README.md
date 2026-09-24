# hierarchical-chunking
it is an advanced text segmentation strategy used primarily in Retrieval-Augmented Generation (RAG) and Large Language Model (LLM) applications. Unlike flat chunking (which splits text into fixed-size pieces without regard for structure), hierarchical chunking preserves the document’s inherent structure and semantic relationships.

Why Flat Chunking Fails
Traditional fixed-size chunking (e.g., 512 tokens with 50 overlap) often causes:
Context Loss: A chunk might contain a pronoun ("it") referring to a concept defined in the previous chunk.
Semantic Fragmentation: Tables, lists, or code blocks get sliced arbitrarily.
Noise: Irrelevant headers or footers get mixed into content chunks.
Lack of Scope: The system retrieves a specific fact but misses the section-level summary needed to interpret it correctly.

[table-76a70834-b3b9-4f20-a541-9bd7066fab3f.csv](https://github.com/user-attachments/files/30868071/table-76a70834-b3b9-4f20-a541-9bd7066fab3f.csv)
Level,Granularity,Purpose,Example Content
Parent / High-Level,Coarse,"Provides context, summaries, and navigation","Chapter titles, section headers, executive summaries"
Child / Low-Level,Fine,"Contains specific facts, data, and answers","Paragraphs, bullet points, table rows"
Metadata Links,Relational,Connects levels for traversal,parent_id", "section_path", "doc_order

Common Implementation Strategies
Header-Based Splitting: Uses Markdown headers (#, ##) or HTML tags to define boundaries. Each chunk inherits its full header path as metadata (e.g., Finance > Q3 Report > Revenue).
Summary-Linked Chunking: An LLM generates a summary for each section. The summary is stored as a parent node linked to all child paragraphs within that section.
Recursive Character Splitting with Structure Awareness: Splits by \n\n first, then \n, then sentences, but respects structural boundaries before falling back to character limits.
Tree-of-Thought / RAPTOR: Builds a hierarchy where higher-level nodes are generated abstractions (summaries/clusters) rather than just extracted text, enabling multi-hop reasoning.

 Retrieval Strategies
Having hierarchical chunks requires specialized retrieval approaches:
Parent Document Retriever: Search is performed on small, precise child chunks. When a match is found, the entire parent chunk (or surrounding siblings) is fetched and sent to the LLM. This gives precise matching + broad context.
Multi-Vector Retrieval: Embeddings are created for both summaries (parents) and raw text (children). Queries can match against either level depending on whether they are high-level conceptual questions or specific factual lookups.
Graph Traversal: In knowledge-graph-enhanced RAG, the hierarchy enables upward/downward traversal to gather related context dynamically.

Tools & Frameworks
LangChain: ParentDocumentRetriever, MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
LlamaIndex: HierarchicalNodeParser, AutoMergingRetriever, RAPTOR
Unstructured.io: Structure-aware parsing that outputs hierarchical elements natively
ChromaDB / Weaviate / Pinecone: Support parent-child metadata filtering and nested document storage

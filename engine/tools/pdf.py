"""
PDF generation tool for Loom AI Engine.

Creates PDF documents from markdown content using reportlab.
"""

import time
from pathlib import Path
from typing import List, Optional


class PDFMaker:
    """Generates PDF documents from markdown content."""
    
    def __init__(self, output_dir: Optional[Path] = None):
        self.output_dir = output_dir or Path(__file__).parent.parent / "data" / "pdfs"
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def create_pdf(
        self,
        title: str,
        content: str,
        output_filename: str,
        sources: Optional[List[str]] = None
    ) -> Path:
        """
        Create a PDF document from markdown content.
        
        Args:
            title: Document title
            content: Markdown content
            output_filename: Name for the output PDF file
            sources: Optional list of source URLs
            
        Returns:
            Path to the generated PDF file
        """
        try:
            from reportlab.lib.pagesizes import letter
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import inch
            from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
            from reportlab.lib.enums import TA_LEFT, TA_CENTER
            from reportlab.pdfgen import canvas
            
            # Clean up markdown for plain text extraction (basic approach)
            clean_content = self._clean_markdown(content)
            
            # Create PDF document
            pdf_path = self.output_dir / output_filename
            doc = SimpleDocTemplate(
                str(pdf_path),
                pagesize=letter,
                rightMargin=0.75*inch,
                leftMargin=0.75*inch,
                topMargin=0.75*inch,
                bottomMargin=0.75*inch
            )
            
            # Container for the 'Flowable' objects
            story = []
            
            # Styles
            styles = getSampleStyleSheet()
            title_style = ParagraphStyle(
                'CustomTitle',
                parent=styles['Heading1'],
                fontSize=24,
                leading=28,
                alignment=TA_CENTER,
                spaceAfter=30
            )
            
            body_style = ParagraphStyle(
                'CustomBody',
                parent=styles['Normal'],
                fontSize=11,
                leading=14,
                alignment=TA_LEFT,
                spaceAfter=12
            )
            
            # Add title
            story.append(Paragraph(self._escape_xml(title), title_style))
            story.append(Spacer(1, 0.25*inch))
            
            # Add content (split into paragraphs)
            paragraphs = clean_content.split('\n\n')
            for para in paragraphs[:50]:  # Limit to first 50 paragraphs
                if para.strip():
                    # Basic formatting - escape special characters
                    escaped_para = self._escape_xml(para.strip())
                    # Replace newlines with <br/>
                    escaped_para = escaped_para.replace('\n', '<br/>')
                    story.append(Paragraph(escaped_para, body_style))
            
            # Add sources if provided
            if sources:
                story.append(PageBreak())
                story.append(Paragraph("Sources", styles['Heading2']))
                for i, source in enumerate(sources, 1):
                    story.append(Paragraph(f"{i}. {source}", body_style))
            
            # Build PDF
            doc.build(story)
            
            return pdf_path
            
        except ImportError:
            # Fallback: create a simple text file if reportlab is not available
            txt_path = self.output_dir / output_filename.replace('.pdf', '.txt')
            with open(txt_path, 'w', encoding='utf-8') as f:
                f.write(f"# {title}\n\n")
                f.write(content)
                if sources:
                    f.write("\n\n## Sources\n\n")
                    for i, source in enumerate(sources, 1):
                        f.write(f"{i}. {source}\n")
            return txt_path
    
    def _clean_markdown(self, markdown: str) -> str:
        """Basic markdown cleaning for PDF conversion."""
        # Remove code blocks (keep content)
        lines = markdown.split('\n')
        cleaned_lines = []
        in_code_block = False
        
        for line in lines:
            if line.startswith('```'):
                in_code_block = not in_code_block
                continue
            if not in_code_block:
                # Remove markdown headers markers but keep text
                if line.startswith('#'):
                    line = line.lstrip('#').strip()
                # Remove bold/italic markers
                line = line.replace('**', '').replace('*', '')
                line = line.replace('__', '').replace('_', '')
                cleaned_lines.append(line)
        
        return '\n'.join(cleaned_lines)
    
    def _escape_xml(self, text: str) -> str:
        """Escape XML special characters for reportlab."""
        text = text.replace('&', '&amp;')
        text = text.replace('<', '&lt;')
        text = text.replace('>', '&gt;')
        return text

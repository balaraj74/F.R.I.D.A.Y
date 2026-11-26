#!/usr/bin/env python3
"""Document text for FRIDAY's file index, printed as JSON sections [{"loc", "text"}].

  convert.py office <file>   Word/PowerPoint/Excel via MarkItDown (keeps tables and headings)
  convert.py ocr <file>      scanned PDFs via Docling OCR, page by page
"""

import json
import re
import sys


def office(path: str) -> list[dict]:
    from markitdown import MarkItDown

    text = MarkItDown(enable_plugins=False).convert(path).text_content or ""
    # PowerPoint output marks each slide; keep them as separate sections.
    parts = re.split(r"<!--\s*Slide number:\s*(\d+)\s*-->", text)
    if len(parts) > 1:
        return [{"loc": f"slide {parts[i]}", "text": parts[i + 1]} for i in range(1, len(parts) - 1, 2)]
    return [{"loc": "", "text": text}]


def ocr(path: str) -> list[dict]:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions(do_ocr=True, do_table_structure=True)
    conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    doc = conv.convert(path).document
    pages = sorted(doc.pages) if getattr(doc, "pages", None) else []
    if not pages:
        return [{"loc": "", "text": doc.export_to_markdown()}]
    return [{"loc": f"p. {n}", "text": doc.export_to_markdown(page_no=n)} for n in pages]


if __name__ == "__main__":
    mode, path = sys.argv[1], sys.argv[2]
    sections = office(path) if mode == "office" else ocr(path)
    json.dump([s for s in sections if s["text"].strip()], sys.stdout)

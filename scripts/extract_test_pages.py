"""
Extract sample pages from test scan PDFs for algorithm prototyping.

Extracts pages at 200 DPI as PNG images into scripts/test_pages/.
Targets diverse pages: early pages (often clean), middle pages near binding
(likely warped), pages with dense text (likely bleed-through).
"""

import os
import sys
import fitz  # pymupdf

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
TEST_BOOK_DIR = os.path.join(PROJECT_DIR, "test scan book")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "test_pages")

DPI = 200
ZOOM = DPI / 72.0  # PDF default is 72 DPI

# Pages to extract per PDF: (page_number_0based, label)
# We pick early, middle, and late pages to get variety
def pick_pages(total_pages):
    """Select representative pages from a PDF."""
    pages = []
    if total_pages == 0:
        return pages

    # Page 1 (title/cover - often clean)
    pages.append((0, "title"))

    if total_pages > 5:
        # Early content page (page 5)
        pages.append((4, "early"))

    if total_pages > 20:
        # Middle page (near binding - likely warped)
        mid = total_pages // 2
        pages.append((mid, "mid"))
        # Page right after middle (recto side)
        if mid + 1 < total_pages:
            pages.append((mid + 1, "mid_recto"))

    if total_pages > 50:
        # Late page (dense text area)
        pages.append((total_pages - 20, "late"))

    return pages


def sanitize_filename(name):
    """Make a filename-safe version of the PDF name."""
    name = os.path.splitext(name)[0]
    # Keep only alphanumeric, spaces, hyphens
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in name)
    # Collapse multiple underscores/spaces
    while "__" in safe:
        safe = safe.replace("__", "_")
    return safe.strip("_ ")[:60]


def extract_pages():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.isdir(TEST_BOOK_DIR):
        print(f"Test book directory not found: {TEST_BOOK_DIR}")
        sys.exit(1)

    pdf_files = [f for f in os.listdir(TEST_BOOK_DIR) if f.lower().endswith(".pdf")]
    if not pdf_files:
        print(f"No PDF files found in {TEST_BOOK_DIR}")
        sys.exit(1)

    print(f"Found {len(pdf_files)} PDF files in {TEST_BOOK_DIR}")
    print(f"Output directory: {OUTPUT_DIR}")
    print()

    total_extracted = 0

    for pdf_name in sorted(pdf_files):
        pdf_path = os.path.join(TEST_BOOK_DIR, pdf_name)
        safe_name = sanitize_filename(pdf_name)
        print(f"Opening: {pdf_name}")

        try:
            doc = fitz.open(pdf_path)
        except Exception as e:
            print(f"  Failed to open: {e}")
            continue

        total = doc.page_count
        print(f"  Pages: {total}")

        pages_to_extract = pick_pages(total)
        print(f"  Extracting {len(pages_to_extract)} pages...")

        for page_idx, label in pages_to_extract:
            if page_idx >= total:
                continue

            try:
                page = doc[page_idx]
                mat = fitz.Matrix(ZOOM, ZOOM)
                pix = page.get_pixmap(matrix=mat)

                out_name = f"{safe_name}_p{page_idx + 1}_{label}.png"
                out_path = os.path.join(OUTPUT_DIR, out_name)
                pix.save(out_path)

                print(f"    Page {page_idx + 1} ({label}): {pix.width}x{pix.height} -> {out_name}")
                total_extracted += 1
            except Exception as e:
                print(f"    Page {page_idx + 1} ({label}): FAILED - {e}")

        doc.close()
        print()

    print(f"Done. Extracted {total_extracted} pages to {OUTPUT_DIR}")


if __name__ == "__main__":
    extract_pages()

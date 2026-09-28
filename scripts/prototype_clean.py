"""
Prototype: Page Cleaning Algorithm

Pipeline:
1. Grayscale + light Gaussian blur
2. Morphological closing (large kernel) to estimate background
3. Division normalization to flatten lighting to white
4. Morphological opening on inverted image to remove bleed-through
5. Adaptive threshold for binary output (black text on white)

Saves before/after comparisons to scripts/test_pages/cleaned/
"""

import os
import sys
import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(SCRIPT_DIR, "test_pages")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "test_pages", "cleaned")

# --- Tunable parameters ---
BLUR_SIZE = 3               # Gaussian blur kernel size (must be odd)
BG_KERNEL_SIZE = 51         # Background estimation kernel (larger = more aggressive)
OPEN_KERNEL_SIZE = 3        # Bleed-through removal kernel
ADAPTIVE_BLOCK = 31         # Adaptive threshold block size (must be odd)
ADAPTIVE_C = 10             # Adaptive threshold constant (higher = more aggressive white)


def clean_page(img):
    """
    Clean a scanned page image.

    Args:
        img: BGR or grayscale image (numpy array)

    Returns:
        binary: Cleaned binary image (uint8, 0 or 255)
    """
    # 1. Convert to grayscale if needed
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()

    # 2. Light Gaussian blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (BLUR_SIZE, BLUR_SIZE), 0)

    # 3. Estimate background via morphological closing
    # Large kernel fills in text, leaving only the background surface
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (BG_KERNEL_SIZE, BG_KERNEL_SIZE)
    )
    background = cv2.morphologyEx(blurred, cv2.MORPH_CLOSE, kernel)

    # 4. Divide original by background to normalize lighting
    # Where background is dark (shadows), division brightens
    # Where background is bright (paper), division normalizes
    # Scale=255 maps the paper tone to pure white
    normalized = cv2.divide(blurred, background, scale=255.0)

    # 5. Remove bleed-through via morphological opening on inverted image
    # Bleed-through text is lighter/thinner than foreground text
    # Opening (erosion then dilation) removes small/thin features
    inverted = cv2.bitwise_not(normalized)
    open_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (OPEN_KERNEL_SIZE, OPEN_KERNEL_SIZE)
    )
    opened = cv2.morphologyEx(inverted, cv2.MORPH_OPEN, open_kernel)
    cleaned = cv2.bitwise_not(opened)

    # 6. Adaptive threshold for binary output
    # ADAPTIVE_THRESH_GAUSSIAN_C uses Gaussian-weighted neighborhood
    binary = cv2.adaptiveThreshold(
        cleaned, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        ADAPTIVE_BLOCK, ADAPTIVE_C
    )

    return binary


def process_all():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.isdir(INPUT_DIR):
        print(f"Input directory not found: {INPUT_DIR}")
        print("Run extract_test_pages.py first.")
        sys.exit(1)

    png_files = sorted([f for f in os.listdir(INPUT_DIR) if f.lower().endswith(".png")])
    if not png_files:
        print(f"No PNG files found in {INPUT_DIR}")
        sys.exit(1)

    print(f"Processing {len(png_files)} pages...")
    print(f"Parameters: blur={BLUR_SIZE}, bg_kernel={BG_KERNEL_SIZE}, "
          f"open_kernel={OPEN_KERNEL_SIZE}, block={ADAPTIVE_BLOCK}, C={ADAPTIVE_C}")
    print()

    for filename in png_files:
        filepath = os.path.join(INPUT_DIR, filename)
        img = cv2.imread(filepath)
        if img is None:
            print(f"  Failed to read: {filename}")
            continue

        h, w = img.shape[:2]
        print(f"  {filename} ({w}x{h})", end="")

        # Clean the page
        binary = clean_page(img)

        # Save cleaned version
        name, ext = os.path.splitext(filename)
        out_path = os.path.join(OUTPUT_DIR, f"{name}_cleaned{ext}")
        cv2.imwrite(out_path, binary)

        # Also create a side-by-side comparison (resize both to fit)
        # Convert original to grayscale for fair comparison
        gray_orig = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        comparison = np.hstack([gray_orig, binary])
        comp_path = os.path.join(OUTPUT_DIR, f"{name}_compare{ext}")
        cv2.imwrite(comp_path, comparison)

        print(f" -> saved")

    print()
    print(f"Done. Results in {OUTPUT_DIR}")
    print("Check the _compare.png files for before/after side-by-side.")


if __name__ == "__main__":
    process_all()

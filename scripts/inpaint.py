#!/usr/bin/env python3
"""
Inpaint an artifact from an image using OpenCV.

Usage:
  python inpaint.py <image_path> <mask_path> <output_path> [radius]

The mask should be a grayscale/binary image where white (255) indicates
the area to inpaint. The radius controls the inpainting neighborhood size.
"""

import sys
import cv2
import numpy as np


def main():
    if len(sys.argv) < 4:
        print("Usage: python inpaint.py <image> <mask> <output> [radius]",
              file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]
    mask_path = sys.argv[2]
    output_path = sys.argv[3]
    radius = int(sys.argv[4]) if len(sys.argv) > 4 else 5

    # Read image
    image = cv2.imread(image_path)
    if image is None:
        print(f"Error: Cannot read image: {image_path}", file=sys.stderr)
        sys.exit(1)

    # Read mask (grayscale)
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        print(f"Error: Cannot read mask: {mask_path}", file=sys.stderr)
        sys.exit(1)

    # Ensure mask matches image dimensions
    if mask.shape[:2] != image.shape[:2]:
        mask = cv2.resize(mask, (image.shape[1], image.shape[0]),
                          interpolation=cv2.INTER_NEAREST)

    # Threshold mask to ensure binary
    _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

    # Dilate the mask slightly to ensure full artifact coverage
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.dilate(mask, kernel, iterations=1)

    # Inpaint using Telea method (Fast Marching — good for small regions)
    result = cv2.inpaint(image, mask, radius, cv2.INPAINT_TELEA)

    # Write output
    cv2.imwrite(output_path, result, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"[inpaint] Done: {output_path}", file=sys.stderr)


if __name__ == '__main__':
    main()

"""
Document boundary detection.

Strategy (same family of ideas Dropbox / CamScanner describe publicly):
  1. Work on a small copy (~500 px) so it runs in a few ms.
  2. Erase the text with a morphological close, so only the paper/background
     boundary produces strong edges (the #1 reason naive Canny fails: the
     text edges are stronger than the page edges).
  3. Try the fast path: largest convex 4-point contour.
  4. Fallback: Hough lines -> intersections -> enumerate quadrilaterals and
     score each by how much edge energy lies on its perimeter (Dropbox method).
  5. If nothing convincing is found, return None (caller uses the full frame).
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import cv2
import numpy as np

WORK_SIZE = 500


@dataclass
class Detection:
    corners: np.ndarray  # (4, 2) float32, TL, TR, BR, BL in ORIGINAL image coords
    confidence: float
    method: str


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Return points ordered TL, TR, BR, BL."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    # image y points down, so increasing atan2 angle is clockwise on screen
    pts = pts[np.argsort(ang)]
    start = int(np.argmin(pts.sum(axis=1)))  # top-left = smallest x+y
    return np.roll(pts, -start, axis=0)


def _prep(img: np.ndarray):
    h, w = img.shape[:2]
    scale = min(1.0, WORK_SIZE / max(h, w))
    small = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img.copy()
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    # erase text / fine texture so only large structures survive
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, k, iterations=3)
    closed = cv2.GaussianBlur(closed, (5, 5), 0)
    # automatic Canny thresholds from the median
    v = float(np.median(closed))
    lo, hi = int(max(0, 0.66 * v) * 0.5), int(min(255, 1.33 * v))
    edges = cv2.Canny(closed, max(10, lo), max(30, hi))
    # also use colour (saturation) edges - helps white paper on a white-ish table
    if small.ndim == 3:
        sat = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[:, :, 1]
        sat = cv2.morphologyEx(sat, cv2.MORPH_CLOSE, k, iterations=2)
        sat = cv2.GaussianBlur(sat, (5, 5), 0)
        edges |= cv2.Canny(sat, 20, 60)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))
    return small, scale, edges


def _perimeter_score(edges: np.ndarray, quad: np.ndarray) -> float:
    """Fraction of the quad perimeter that sits on detected edges."""
    mask = np.zeros_like(edges)
    cv2.polylines(mask, [quad.astype(np.int32)], True, 255, 3)
    on = cv2.countNonZero(mask & edges)
    tot = cv2.countNonZero(mask)
    return on / max(tot, 1)


def _valid_quad(quad: np.ndarray, w: int, h: int, min_area_frac=0.15) -> bool:
    q = quad.astype(np.float32)
    if not cv2.isContourConvex(q.reshape(-1, 1, 2)):
        return False
    area = cv2.contourArea(q)
    if area < min_area_frac * w * h:
        return False
    # reject quads that are just the image frame (no real document edge)
    margin = 0.01 * max(w, h)
    on_border = sum(
        1 for x, y in q if x < margin or y < margin or x > w - margin or y > h - margin
    )
    if on_border == 4:
        return False
    # angles must be reasonable (no near-degenerate corners)
    for i in range(4):
        a, b, c = q[i - 1], q[i], q[(i + 1) % 4]
        v1, v2 = a - b, c - b
        cos = abs(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
        if cos > 0.7:  # angle < ~45deg or > ~135deg
            return False
    return True


def _contour_method(edges, w, h):
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:10]
    best = None
    for c in cnts:
        peri = cv2.arcLength(c, True)
        for eps in (0.02, 0.03, 0.05):
            approx = cv2.approxPolyDP(c, eps * peri, True)
            if len(approx) == 4:
                q = order_corners(approx.reshape(4, 2))
                if _valid_quad(q, w, h):
                    s = _perimeter_score(edges, q)
                    score = s * math.sqrt(cv2.contourArea(q) / (w * h))
                    if best is None or score > best[1]:
                        best = (q, score, s)
                break
    return best


def _line_intersection(l1, l2):
    (r1, t1), (r2, t2) = l1, l2
    A = np.array([[math.cos(t1), math.sin(t1)], [math.cos(t2), math.sin(t2)]])
    if abs(np.linalg.det(A)) < 1e-6:
        return None
    x, y = np.linalg.solve(A, np.array([r1, r2]))
    return np.array([x, y], dtype=np.float32)


def _hough_method(edges, w, h):
    lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=int(0.15 * min(w, h)))
    if lines is None:
        return None
    lines = lines[:, 0, :]
    # non-maximum suppression: keep strongest distinct lines
    kept = []
    for r, t in lines:
        if all(abs(r - r2) > 15 or min(abs(t - t2), np.pi - abs(t - t2)) > np.deg2rad(8) for r2, t2 in kept):
            kept.append((r, t))
        if len(kept) >= 16:
            break
    horiz = [l for l in kept if abs(math.sin(l[1])) > 0.7][:8]  # normal is ~vertical -> line horizontal
    vert = [l for l in kept if abs(math.sin(l[1])) <= 0.7][:8]
    best = None
    for h1, h2 in itertools.combinations(horiz, 2):
        for v1, v2 in itertools.combinations(vert, 2):
            pts = [_line_intersection(a, b) for a in (h1, h2) for b in (v1, v2)]
            if any(p is None for p in pts):
                continue
            pts = np.array(pts)
            if (pts[:, 0] < -0.05 * w).any() or (pts[:, 0] > 1.05 * w).any() or \
               (pts[:, 1] < -0.05 * h).any() or (pts[:, 1] > 1.05 * h).any():
                continue
            q = order_corners(pts)
            if not _valid_quad(q, w, h):
                continue
            s = _perimeter_score(edges, q)
            score = s * math.sqrt(cv2.contourArea(q) / (w * h))
            if best is None or score > best[1]:
                best = (q, score, s)
    return best


def detect_document(img: np.ndarray) -> Detection | None:
    small, scale, edges = _prep(img)
    h, w = edges.shape[:2]
    cand = []
    r = _contour_method(edges, w, h)
    if r:
        cand.append((*r, "contour"))
    if not r or r[2] < 0.6:  # weak contour result -> try Hough
        r2 = _hough_method(edges, w, h)
        if r2:
            cand.append((*r2, "hough"))
    if not cand:
        return None
    q, score, edge_frac, method = max(cand, key=lambda c: c[1])
    if edge_frac < 0.35:
        return None
    corners = _refine_corners(img, q / scale) if scale < 1 else q
    return Detection(corners=corners.astype(np.float32), confidence=float(edge_frac), method=method)


def _refine_corners(img: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """Sub-pixel refinement of corners on the full-res image."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    pts = corners.reshape(-1, 1, 2).astype(np.float32).copy()
    win = max(5, int(0.006 * max(gray.shape)))
    try:
        cv2.cornerSubPix(gray, pts, (win, win), (-1, -1),
                         (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01))
        moved = np.linalg.norm(pts.reshape(4, 2) - corners, axis=1)
        if (moved < 3 * win).all():
            return pts.reshape(4, 2)
    except cv2.error:
        pass
    return corners

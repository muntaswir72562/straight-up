'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

interface LassoCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  processing: boolean;
  onComplete: (mask: Blob, image: Blob) => void;
  onCancel: () => void;
}

interface Point {
  x: number;
  y: number;
}

export function LassoCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  processing,
  onComplete,
  onCancel,
}: LassoCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [displayScale, setDisplayScale] = useState(1);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);

  // Load and draw the image
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      loadedImageRef.current = img;
      fitCanvas();
    };
    img.src = imageUrl;
  }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitCanvas = useCallback(() => {
    const container = containerRef.current;
    const imageCanvas = imageCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const img = loadedImageRef.current;
    if (!container || !imageCanvas || !overlayCanvas || !img) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    // Reserve horizontal padding and vertical space for the bottom button bar
    const scale = Math.min((cw - 32) / imageWidth, (ch - 80) / imageHeight, 1);
    setDisplayScale(scale);

    const dw = Math.round(imageWidth * scale);
    const dh = Math.round(imageHeight * scale);

    imageCanvas.width = dw;
    imageCanvas.height = dh;
    imageCanvas.style.width = `${dw}px`;
    imageCanvas.style.height = `${dh}px`;

    overlayCanvas.width = dw;
    overlayCanvas.height = dh;
    overlayCanvas.style.width = `${dw}px`;
    overlayCanvas.style.height = `${dh}px`;

    const ctx = imageCanvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, dw, dh);
  }, [imageWidth, imageHeight]);

  // Resize handler
  useEffect(() => {
    const handler = () => fitCanvas();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [fitCanvas]);

  // Draw overlay (lasso path + filled mask preview)
  const drawOverlay = useCallback((pts: Point[], closed: boolean) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || pts.length === 0) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scale = displayScale;

    // Draw filled area if closed
    if (closed && pts.length > 2) {
      ctx.fillStyle = 'rgba(255, 60, 60, 0.3)';
      ctx.beginPath();
      ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Draw path
    ctx.strokeStyle = closed ? 'rgba(255, 60, 60, 0.9)' : 'oklch(65% 0.25 270)';
    ctx.lineWidth = 2;
    ctx.setLineDash(closed ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }, [displayScale]);

  // Redraw overlay when points change
  useEffect(() => {
    drawOverlay(points, isClosed);
  }, [points, isClosed, drawOverlay]);

  // Get image-space coords from pointer event
  const getImageCoords = useCallback((e: React.PointerEvent): Point => {
    const canvas = overlayCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / displayScale,
      y: (e.clientY - rect.top) / displayScale,
    };
  }, [displayScale]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (processing || isClosed) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const pt = getImageCoords(e);
    setPoints([pt]);
    setIsDrawing(true);
  }, [processing, isClosed, getImageCoords]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDrawing || processing) return;
    e.preventDefault();
    const pt = getImageCoords(e);
    setPoints((prev) => [...prev, pt]);
  }, [isDrawing, processing, getImageCoords]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDrawing || processing) return;
    e.preventDefault();
    setIsDrawing(false);
    setPoints((prev) => {
      if (prev.length > 5) {
        setIsClosed(true);
        return prev;
      }
      // Too few points, reset
      return [];
    });
  }, [isDrawing, processing]);

  const handleClear = useCallback(() => {
    setPoints([]);
    setIsClosed(false);
    setIsDrawing(false);
    const canvas = overlayCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const handleRemove = useCallback(async () => {
    if (!isClosed || points.length < 3) return;

    // Generate binary mask
    const maskCanvas = new OffscreenCanvas(imageWidth, imageHeight);
    const maskCtx = maskCanvas.getContext('2d')!;
    maskCtx.fillStyle = '#000';
    maskCtx.fillRect(0, 0, imageWidth, imageHeight);
    maskCtx.fillStyle = '#fff';
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      maskCtx.lineTo(points[i].x, points[i].y);
    }
    maskCtx.closePath();
    maskCtx.fill();

    const maskBlob = await maskCanvas.convertToBlob({ type: 'image/png' });

    // Export page image as JPEG
    const imgCanvas = new OffscreenCanvas(imageWidth, imageHeight);
    const imgCtx = imgCanvas.getContext('2d')!;
    const img = loadedImageRef.current;
    if (img) {
      imgCtx.drawImage(img, 0, 0, imageWidth, imageHeight);
    }
    const imageBlob = await imgCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });

    onComplete(maskBlob, imageBlob);
  }, [isClosed, points, imageWidth, imageHeight, onComplete]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'auto',
      }}
    >
      {/* Canvas stack */}
      <div style={{ position: 'relative', cursor: isClosed ? 'default' : 'crosshair', flexShrink: 0 }}>
        <canvas
          ref={imageCanvasRef}
          style={{ display: 'block', borderRadius: 'var(--radius-md)' }}
        />
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            touchAction: 'none',
            borderRadius: 'var(--radius-md)',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      {/* Fixed bottom button bar */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '12px 16px',
        background: 'linear-gradient(transparent, oklch(15% 0.02 270 / 0.9) 30%)',
        pointerEvents: 'none',
      }}>
        <div className="flex items-center gap-3" style={{ pointerEvents: 'auto' }}>
          {isClosed && !processing && (
            <button
              type="button"
              onClick={handleRemove}
              className="focus-ring flex items-center gap-1.5 text-sm font-medium px-4 py-2"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                boxShadow: 'var(--shadow-md)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 13l4-4M5 9l4-8M5 9l8-4" />
              </svg>
              Remove Artifact
            </button>
          )}
          {!processing && (
            <>
              {isClosed && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="focus-ring text-sm font-medium px-4 py-2"
                  style={{
                    background: 'oklch(100% 0 0 / 0.15)',
                    color: '#fff',
                    border: '1px solid oklch(100% 0 0 / 0.25)',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    boxShadow: 'var(--shadow-md)',
                  }}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={onCancel}
                className="focus-ring text-sm font-medium px-4 py-2"
                style={{
                  background: 'oklch(100% 0 0 / 0.15)',
                  color: '#fff',
                  border: '1px solid oklch(100% 0 0 / 0.25)',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                Cancel
              </button>
            </>
          )}
          {processing && (
            <div className="flex items-center gap-2">
              <div className="slot-validating" style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--color-primary)' }} />
              <span className="text-sm" style={{ color: '#fff' }}>Removing artifact...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

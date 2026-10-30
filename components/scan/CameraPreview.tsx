'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { CropRect } from '@/lib/scanTypes';
import { CropOverlay } from './CropOverlay';

const CAMERA_KEY = 'straightup.scan.camera';
const CROP_KEY = 'straightup.scan.crop';
const JPEG_QUALITY = 0.95;
const DEFAULT_CROP: CropRect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };

export interface CameraHandle {
  /** Full-resolution still as JPEG, and the crop area to use (null = automatic). */
  capture: () => Promise<{ blob: Blob; crop: CropRect | null }>;
}

/** Crop area per camera (the camera is fixed over the pad, so it stays valid). */
type CropMap = Record<string, { enabled: boolean; rect: CropRect }>;

function readCrops(): CropMap {
  try { return JSON.parse(localStorage.getItem(CROP_KEY) || '{}') as CropMap; } catch { return {}; }
}

type CamState =
  | { kind: 'starting' }
  | { kind: 'live'; width: number; height: number; photoWidth?: number; photoHeight?: number }
  | { kind: 'error'; message: string };

// ImageCapture isn't in every TS DOM lib / browser
interface PhotoCaps { imageWidth?: { max?: number }; imageHeight?: { max?: number } }
interface ImageCaptureLike {
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities(): Promise<PhotoCaps>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

function readStored(): string {
  try { return localStorage.getItem(CAMERA_KEY) || ''; } catch { return ''; }
}

function errorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (!window.isSecureContext) {
    return 'The camera only works on http://localhost or HTTPS. Open Straight Up from localhost (or the desktop app).';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site (camera icon in the address bar) and reload.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera found. Connect the IRIScan (or another camera) and press "Retry".';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another program (close the IRIS software) and press "Retry".';
  }
  return `Could not start the camera: ${(e as Error)?.message || String(e)}`;
}

/** Camera picker, then `children` (options, Scan button), then the live preview filling the rest. */
export function CameraPreview({ ref, flashKey, children }: { ref?: Ref<CameraHandle>; flashKey: number; children?: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoRef = useRef<{ ic: ImageCaptureLike; w?: number; h?: number } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(readStored);
  const [state, setState] = useState<CamState>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const flashRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [crops, setCrops] = useState<CropMap>(readCrops);
  const camKey = deviceId || 'default';
  const crop = crops[camKey] ?? { enabled: false, rect: DEFAULT_CROP };
  // editing: full frame with the rectangle; otherwise only the crop is shown
  const [editingCrop, setEditingCrop] = useState(false);
  const cropRef = useRef<CropRect | null>(null);
  useEffect(() => { cropRef.current = crop.enabled ? crop.rect : null; }, [crop.enabled, crop.rect]);

  const setCrop = (next: { enabled: boolean; rect: CropRect }, save: boolean) => {
    setCrops((m) => {
      const all = { ...m, [camKey]: next };
      if (save) { try { localStorage.setItem(CROP_KEY, JSON.stringify(all)); } catch { /* ignore */ } }
      return all;
    });
  };

  /** Whole frame letterboxed, or (crop on, not editing) only the crop, enlarged to fit. */
  const videoPlacement = (): React.CSSProperties => {
    const vw = state.kind === 'live' ? state.width : 0;
    const vh = state.kind === 'live' ? state.height : 0;
    if (!crop.enabled || editingCrop || !vw || !vh || !box.w || !box.h) {
      return { inset: 0, width: '100%', height: '100%', objectFit: 'contain' };
    }
    const r = crop.rect;
    const k = Math.min(box.w / (r.w * vw), box.h / (r.h * vh));
    return {
      left: (box.w - r.w * vw * k) / 2 - r.x * vw * k,
      top: (box.h - r.h * vh * k) / 2 - r.y * vh * k,
      width: vw * k,
      height: vh * k,
      objectFit: 'fill',
      maxWidth: 'none',
      // show nothing outside the crop (the box is rarely the crop's shape)
      clipPath: `inset(${r.y * vh * k}px ${(1 - r.x - r.w) * vw * k}px ${(1 - r.y - r.h) * vh * k}px ${r.x * vw * k}px)`,
    };
  };

  // size of the preview box: the crop rectangle is drawn over the shown frame
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    photoRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      stop();
      setState({ kind: 'starting' });
      if (!navigator.mediaDevices?.getUserMedia) {
        setState({ kind: 'error', message: errorMessage(new Error('getUserMedia is not available in this browser')) });
        return;
      }
      const video: MediaTrackConstraints = {
        // ask for far more than any camera has: the browser picks the highest it offers
        width: { ideal: 8192 },
        height: { ideal: 6144 },
      };
      if (deviceId) video.deviceId = { exact: deviceId };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (deviceId && (e as { name?: string })?.name === 'OverconstrainedError') {
          // remembered camera is gone: fall back to the default one
          try { localStorage.removeItem(CAMERA_KEY); } catch { /* ignore */ }
          if (!cancelled) setDeviceId('');
          return;
        }
        if (!cancelled) setState({ kind: 'error', message: errorMessage(e) });
        return;
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // still photos at full sensor resolution, where supported
      let photoWidth: number | undefined;
      let photoHeight: number | undefined;
      const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
      if (IC) {
        try {
          const ic = new IC(track);
          const caps = await ic.getPhotoCapabilities();
          photoWidth = caps.imageWidth?.max;
          photoHeight = caps.imageHeight?.max;
          photoRef.current = { ic, w: photoWidth, h: photoHeight };
        } catch {
          photoRef.current = null;
        }
      }
      try {
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        if (!cancelled) setDevices(list);
      } catch { /* labels need permission; fine */ }
      if (!cancelled) {
        setState({ kind: 'live', width: s.width ?? 0, height: s.height ?? 0, photoWidth, photoHeight });
      }
    })();
    return () => { cancelled = true; stop(); };
  }, [deviceId, attempt, stop]);

  useEffect(() => {
    if (!flashKey) return;
    flashRef.current?.animate([{ opacity: 0.75 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
  }, [flashKey]);

  useImperativeHandle(ref, () => ({
    capture: async () => {
      const video = videoRef.current;
      if (!video || !streamRef.current) throw new Error('Camera not ready');
      const p = photoRef.current;
      const crop = cropRef.current;
      // takePhoto only when it gives more pixels than the video frame. With a
      // crop area, only if the photo has the preview's shape too, so the
      // rectangle drawn on the preview covers the same part of the photo.
      const sameShape = !!p?.w && !!p?.h
        && Math.abs(p.w / p.h - video.videoWidth / video.videoHeight) < 0.02;
      if (p && (p.w ?? 0) > video.videoWidth && (!crop || sameShape)) {
        try {
          const blob = await p.ic.takePhoto({ imageWidth: p.w, imageHeight: p.h });
          return { blob: blob.type === 'image/jpeg' ? blob : await reencode(blob), crop };
        } catch {
          /* some UVC drivers refuse takePhoto: use the video frame */
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      return { blob: await toJpeg(canvas), crop };
    },
  }), []);

  const pick = (id: string) => {
    try { localStorage.setItem(CAMERA_KEY, id); } catch { /* ignore */ }
    setDeviceId(id);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
        <label className="flex items-center gap-2">
          Camera
          <select
            value={deviceId}
            onChange={(e) => pick(e.target.value)}
            className="focus-ring px-2 py-1 text-xs"
            style={{ background: 'var(--color-surface-inset)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', color: 'var(--color-ink)', maxWidth: '16rem' }}
          >
            <option value="">Default camera</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
            ))}
          </select>
        </label>
        {state.kind === 'live' && (
          <span>
            Preview {state.width}×{state.height}
            {state.photoWidth && state.photoWidth > state.width
              ? ` · photos ${state.photoWidth}×${state.photoHeight}`
              : ' · photos at preview resolution'}
          </span>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--color-ink)' }}
          title="Draw the page area on the preview: around one page, or around both pages of an open book">
          <input
            type="checkbox"
            className="focus-ring"
            checked={crop.enabled}
            onChange={(e) => {
              setCrop({ ...crop, enabled: e.target.checked }, true);
              setEditingCrop(e.target.checked); // turning it on: draw the rectangle first
            }}
          />
          Crop area
        </label>
        {crop.enabled && (
          <button
            type="button"
            onClick={() => setEditingCrop((v) => !v)}
            className="focus-ring px-2 py-0.5 text-xs font-medium"
            style={{
              background: editingCrop ? 'var(--color-primary)' : 'transparent',
              border: `1px solid ${editingCrop ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
              borderRadius: 'var(--radius-sm)', color: editingCrop ? '#fff' : 'var(--color-ink)', cursor: 'pointer',
            }}
          >
            {editingCrop ? 'Done' : 'Adjust crop'}
          </button>
        )}
        {crop.enabled && editingCrop && (
          <button
            type="button"
            onClick={() => setCrop({ enabled: true, rect: DEFAULT_CROP }, true)}
            className="focus-ring px-2 py-0.5 text-xs"
            style={{ background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-ink-muted)', cursor: 'pointer' }}
          >
            Reset
          </button>
        )}
      </div>
      {children}
      <div
        ref={boxRef}
        // fills the height left in the column (the whole frame is shown, letterboxed)
        className="relative w-full flex-1 overflow-hidden min-h-[45vh] lg:min-h-0"
        style={{ background: '#111', borderRadius: 'var(--radius-lg)' }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute"
          style={{ ...videoPlacement(), display: state.kind === 'live' ? 'block' : 'none' }}
        />
        {state.kind === 'live' && crop.enabled && !editingCrop && (
          <span
            className="absolute left-2 top-2 px-2 py-0.5 text-[11px] font-medium pointer-events-none"
            style={{ background: 'var(--color-accent)', color: '#1d1f2e', borderRadius: 'var(--radius-sm)' }}
          >
            Crop area only
          </span>
        )}
        {state.kind === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: '#ccc' }}>
            Starting camera…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
            <p className="text-sm" style={{ color: '#f3f3f3', maxWidth: '28rem' }}>{state.message}</p>
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="focus-ring px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--color-primary)', color: '#fff', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        )}
        {state.kind === 'live' && crop.enabled && editingCrop && state.width > 0 && state.height > 0 && box.w > 0 && (() => {
          // where the letterboxed frame sits inside the preview box
          const k = Math.min(box.w / state.width, box.h / state.height);
          const w = state.width * k;
          const h = state.height * k;
          return (
            <CropOverlay
              rect={crop.rect}
              area={{ left: (box.w - w) / 2, top: (box.h - h) / 2, width: w, height: h }}
              onChange={(r) => setCrop({ enabled: true, rect: r }, false)}
              onCommit={(r) => setCrop({ enabled: true, rect: r }, true)}
            />
          );
        })()}
        <div ref={flashRef} aria-hidden className="absolute inset-0 pointer-events-none" style={{ background: '#fff', opacity: 0 }} />
      </div>
    </div>
  );
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', JPEG_QUALITY);
  });
}

async function reencode(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return toJpeg(canvas);
}

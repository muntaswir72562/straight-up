'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';

const CAMERA_KEY = 'straightup.scan.camera';
const JPEG_QUALITY = 0.95;

export interface CameraHandle {
  /** Full-resolution still as JPEG. */
  capture: () => Promise<Blob>;
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

/** Camera picker, then `children` (options, Scan button), then the live preview. */
export function CameraPreview({ ref, flashKey, children }: { ref?: Ref<CameraHandle>; flashKey: number; children?: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoRef = useRef<{ ic: ImageCaptureLike; w?: number; h?: number } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(readStored);
  const [state, setState] = useState<CamState>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const flashRef = useRef<HTMLDivElement>(null);

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
      // takePhoto only when it gives more pixels than the video frame
      if (p && (p.w ?? 0) > video.videoWidth) {
        try {
          const blob = await p.ic.takePhoto({ imageWidth: p.w, imageHeight: p.h });
          if (blob.type === 'image/jpeg') return blob;
          return await reencode(blob);
        } catch {
          /* some UVC drivers refuse takePhoto: use the video frame */
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      return toJpeg(canvas);
    },
  }), []);

  const pick = (id: string) => {
    try { localStorage.setItem(CAMERA_KEY, id); } catch { /* ignore */ }
    setDeviceId(id);
  };

  return (
    <div>
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
      </div>
      {children}
      <div
        className="relative w-full overflow-hidden"
        style={{
          background: '#111',
          borderRadius: 'var(--radius-lg)',
          aspectRatio: state.kind === 'live' && state.width && state.height ? `${state.width} / ${state.height}` : '4 / 3',
          maxHeight: '62vh',
          margin: '0 auto',
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          className="w-full h-full"
          style={{ objectFit: 'contain', display: state.kind === 'live' ? 'block' : 'none' }}
        />
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

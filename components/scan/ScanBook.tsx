'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanOptions, ScanPageView, ScanSessionSummary, ScanSessionView } from '@/lib/scanTypes';
import {
  createSession, deletePage, exportProgress, exportUrl, getSession, listSessions,
  overridePage, patchSession, retryPage, startExport, uploadCapture, type PageOverride,
} from '@/lib/scanClient';
import { CameraPreview, type CameraHandle } from './CameraPreview';
import { ScanOptionsPanel } from './ScanOptionsPanel';
import { PageStrip, type PageAction } from './PageStrip';
import { ScanPageViewer } from './ScanPageViewer';

const DEFAULT_OPTIONS: ScanOptions = { colorMode: 'clean', dewarp: true, removeFingers: true, split: 'auto' };
const OPTIONS_KEY = 'straightup.scan.nextOptions';
const UNTITLED = 'Untitled scan';
const UPLOAD_RETRIES = 3;

const card = {
  background: 'var(--color-surface-card)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
} as const;

const secondaryBtn = {
  background: 'transparent',
  border: '1.5px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-ink-muted)',
  cursor: 'pointer',
} as const;

interface FailedUpload { id: string; sessionId: string; blob: Blob; options: ScanOptions; replace?: string; error: string }

function readOptions(): ScanOptions {
  try {
    const o = JSON.parse(localStorage.getItem(OPTIONS_KEY) || 'null') as Partial<ScanOptions> | null;
    return { ...DEFAULT_OPTIONS, ...(o ?? {}) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 1200;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.1);
    o.onended = () => ctx.close();
  } catch { /* no audio: fine */ }
}

function isUnfinished(s: ScanSessionSummary) {
  return s.pending > 0 || (s.pageCount > 0 && !s.exportedAt);
}

export function ScanBook() {
  const [sessions, setSessions] = useState<ScanSessionSummary[]>([]);
  const [resumeOffer, setResumeOffer] = useState<ScanSessionSummary | null>(null);
  const [session, setSession] = useState<ScanSessionView | null>(null);
  const [bookName, setBookName] = useState('');
  const [nextOptions, setNextOptions] = useState<ScanOptions>(readOptions);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [failed, setFailed] = useState<FailedUpload[]>([]);
  const [retakeTarget, setRetakeTarget] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const [exporting, setExporting] = useState<{ phase: string; current: number; total: number } | null>(null);

  const cameraRef = useRef<CameraHandle>(null);
  const capturingRef = useRef(false);
  const uploadChain = useRef<Promise<void>>(Promise.resolve());
  const sessionIdRef = useRef<string | null>(null);
  const creatingRef = useRef<Promise<string> | null>(null);
  const bookNameRef = useRef('');
  sessionIdRef.current = session?.id ?? null;
  bookNameRef.current = bookName;

  // ── Sessions: offer to resume an unfinished one (the camera is already live) ──
  const loadSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      return list;
    } catch (e) {
      setError(`Could not load scan sessions: ${(e as Error).message}`);
      return [];
    }
  }, []);

  useEffect(() => {
    listSessions()
      .then((list) => { setSessions(list); setResumeOffer(list.find(isUnfinished) ?? null); })
      .catch((e) => setError(`Could not load scan sessions: ${(e as Error).message}`));
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      const s = await getSession(id);
      setSession(s);
      setBookName(s.bookName === UNTITLED ? '' : s.bookName);
      setResumeOffer(null);
      setRetakeTarget(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const newBook = () => {
    setSession(null);
    setBookName('');
    setResumeOffer(null);
    setRetakeTarget(null);
    loadSessions();
  };

  /** The session to scan into: created on the first Scan if there is none yet. */
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    creatingRef.current ??= createSession(bookNameRef.current.trim() || UNTITLED, DEFAULT_OPTIONS)
      .then((s) => {
        sessionIdRef.current = s.id;
        setSession(s);
        setResumeOffer(null);
        return s.id;
      })
      .finally(() => { creatingRef.current = null; });
    return creatingRef.current;
  }, []);

  const refresh = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const s = await getSession(id);
      if (sessionIdRef.current === id) setSession(s);
    } catch { /* transient; next poll */ }
  }, []);

  // ── Polling ────────────────────────────────────────────────────────
  const busy = !!session && (session.queue.queued + session.queue.processing > 0 || uploading > 0);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(refresh, busy ? 1000 : 4000);
    return () => clearInterval(t);
  }, [session, busy, refresh]);

  // ── Book name (debounced save) ─────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    const name = bookName.trim() || UNTITLED;
    if (name === session.bookName) return;
    const id = session.id;
    const t = setTimeout(() => { patchSession(id, { bookName: name }).then(setSession).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [bookName, session]);

  // ── Options for the next scan (remembered on this PC) ──────────────
  const changeNextOptions = (o: ScanOptions) => {
    setNextOptions(o);
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(o)); } catch { /* ignore */ }
  };

  // ── Capture ────────────────────────────────────────────────────────
  const upload = useCallback((sessionId: string, blob: Blob, options: ScanOptions, replace?: string) => {
    setUploading((n) => n + 1);
    // one upload at a time, so captures keep the order they were taken in
    uploadChain.current = uploadChain.current.then(async () => {
      let lastErr = '';
      for (let i = 0; i < UPLOAD_RETRIES; i++) {
        try {
          await uploadCapture(sessionId, blob, options, replace);
          lastErr = '';
          break;
        } catch (e) {
          lastErr = (e as Error).message;
          await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        }
      }
      setUploading((n) => n - 1);
      if (lastErr) setFailed((f) => [...f, { id: crypto.randomUUID(), sessionId, blob, options, replace, error: lastErr }]);
      refresh();
    });
  }, [refresh]);

  const scan = useCallback(async () => {
    if (capturingRef.current || !cameraRef.current) return;
    capturingRef.current = true;
    try {
      const { blob, crop } = await cameraRef.current.capture();
      setFlashKey((k) => k + 1);
      beep();
      const id = await ensureSession();
      upload(id, blob, { ...nextOptions, crop }, retakeTarget ?? undefined);
      setRetakeTarget(null);
      setError(null);
    } catch (e) {
      setError(`Capture failed: ${(e as Error).message}`);
    } finally {
      capturingRef.current = false;
    }
  }, [upload, ensureSession, nextOptions, retakeTarget]);

  // Space bar = Scan (the operator's hands are on the book)
  useEffect(() => {
    if (viewer !== null) return;
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target)) return;
      e.preventDefault();
      if (!e.repeat) scan();
    };
    // stop Space from also "clicking" a focused button on key-up
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [viewer, scan]);

  // photos not yet on disk would be lost on close
  useEffect(() => {
    if (uploading === 0 && failed.length === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [uploading, failed.length]);

  // ── Page actions ───────────────────────────────────────────────────
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setError(null); } catch (e) { setError((e as Error).message); }
    refresh();
  };

  const move = async (from: number, to: number) => {
    if (!session || to < 0 || to >= session.pages.length || from === to) return;
    const order = session.pages.map((p) => p.id);
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    setSession({ ...session, pages: order.map((id) => session.pages.find((p) => p.id === id)!) });
    await act(async () => setSession(await patchSession(session.id, { order })));
  };

  const onOverride = (p: ScanPageView, o: PageOverride) => {
    if (!session) return;
    act(() => overridePage(session.id, p.id, o));
  };

  const onDelete = (p: ScanPageView) => {
    if (!session) return;
    const i = session.pages.findIndex((x) => x.id === p.id);
    if (!window.confirm(`Delete page ${i + 1}?`)) return;
    if (retakeTarget === p.id) setRetakeTarget(null);
    act(() => deletePage(session.id, p.id));
  };

  const onAction = (p: ScanPageView, a: PageAction) => {
    if (!session) return;
    const i = session.pages.findIndex((x) => x.id === p.id);
    switch (a) {
      case 'delete': return onDelete(p);
      case 'retake': return setRetakeTarget((t) => (t === p.id ? null : p.id));
      case 'rotate': return onOverride(p, { rotate: 90 });
      case 'split': return onOverride(p, { split: 'two' });
      case 'unsplit': return onOverride(p, { split: 'one' });
      case 'retry': return act(() => retryPage(session.id, p.id));
      case 'left': return move(i, i - 1);
      case 'right': return move(i, i + 1);
    }
  };

  // ── Export ─────────────────────────────────────────────────────────
  const doneCount = session?.pages.filter((p) => p.status === 'done').length ?? 0;
  const pending = (session ? session.queue.queued + session.queue.processing : 0) + uploading;
  const errors = session?.pages.filter((p) => p.status === 'error').length ?? 0;
  const canExport = !!session && doneCount > 0 && pending === 0 && !exporting;
  const exportHint = !session || doneCount === 0
    ? 'Scan some pages first.'
    : pending > 0
      ? `Waiting for ${pending} capture${pending === 1 ? '' : 's'} to finish processing…`
      : errors > 0
        ? `${errors} page${errors === 1 ? '' : 's'} failed and will be left out (retry or delete ${errors === 1 ? 'it' : 'them'}).`
        : '';

  const runExport = async () => {
    if (!session) return;
    const id = session.id;
    setExporting({ phase: 'preparing', current: 0, total: 0 });
    try {
      await startExport(id, false);
      for (;;) {
        await new Promise((r) => setTimeout(r, 800));
        const p = await exportProgress(id);
        setExporting(p);
        if (p.phase === 'error') throw new Error(p.error || 'Export failed');
        if (p.phase === 'done') break;
      }
      const a = document.createElement('a');
      a.href = exportUrl(id, 'pdf');
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setError(null);
      refresh();
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  const pages = session?.pages ?? [];
  const pageCount = pages.filter((p) => !p.placeholder).length;
  const others = sessions.filter((s) => s.id !== session?.id);

  // One window tall on laptop screens (lg+): only the page strip scrolls.
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {/* top bar: book, counts, switching */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
          Book name
          <input
            type="text"
            value={bookName}
            onChange={(e) => setBookName(e.target.value)}
            placeholder="e.g. Criminal Law of Mauritius"
            autoComplete="off"
            className="focus-ring px-3 py-1.5 text-sm"
            style={{
              width: '18rem', maxWidth: '60vw',
              background: 'var(--color-surface-inset)', border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)', color: 'var(--color-ink)',
            }}
          />
        </label>
        <div className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          {session ? (
            <>
              <b style={{ color: 'var(--color-ink)' }}>{pageCount}</b> page{pageCount === 1 ? '' : 's'}
              {' · '}
              {pending > 0
                ? <span style={{ color: 'var(--color-primary)' }}>{pending} in queue</span>
                : 'all processed'}
              {errors > 0 && <span style={{ color: 'var(--color-danger)' }}>{' · '}{errors} failed</span>}
              {session.worker.restarts > 0 && (
                <span title="The processing engine stopped and was restarted; no scans were lost." style={{ color: 'var(--color-ink-subtle)' }}>
                  {' · '}engine restarted {session.worker.restarts}×
                </span>
              )}
            </>
          ) : 'New book: the first scan starts it'}
        </div>
        <div className="flex-1" />
        {others.length > 0 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) open(e.target.value); }}
            aria-label="Open another scan"
            className="focus-ring px-2 py-1.5 text-sm"
            style={{ background: 'var(--color-surface-inset)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-ink)', maxWidth: '16rem' }}
            onFocus={() => { loadSessions(); }}
          >
            <option value="">Open another scan…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.bookName} ({s.pageCount} pages{s.exportedAt ? ', exported' : ''}) · {new Date(s.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
        {session && (
          <button type="button" className="focus-ring px-3 py-1.5 text-sm font-medium" style={secondaryBtn} onClick={newBook}>
            New book
          </button>
        )}
      </section>

      {resumeOffer && !session && (
        <div
          className="px-3 py-2 flex flex-wrap items-center gap-3 text-sm"
          style={{ ...card, borderRadius: 'var(--radius-md)', background: 'var(--color-primary-subtle)', borderColor: 'var(--color-primary)' }}
        >
          <span style={{ color: 'var(--color-ink)' }}>
            Unfinished scan: <b>{resumeOffer.bookName}</b> ({resumeOffer.pageCount} page{resumeOffer.pageCount === 1 ? '' : 's'}
            {resumeOffer.pending ? `, ${resumeOffer.pending} still processing` : ''})
          </span>
          <button
            type="button"
            onClick={() => open(resumeOffer.id)}
            className="focus-ring px-3 py-1 text-sm font-semibold"
            style={{ background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
          >
            Resume
          </button>
          <button type="button" onClick={() => setResumeOffer(null)} className="focus-ring px-3 py-1 text-sm font-medium" style={secondaryBtn}>
            Start new
          </button>
        </div>
      )}

      {error && <ErrorBox message={error} onClose={() => setError(null)} />}
      {failed.length > 0 && (
        <div className="px-3 py-2 text-sm flex flex-wrap items-center gap-3" style={{ ...card, borderRadius: 'var(--radius-md)', borderColor: 'var(--color-danger)', background: 'var(--color-danger-subtle)' }} role="alert">
          <span style={{ color: 'var(--color-danger)' }}>
            {failed.length} photo{failed.length === 1 ? '' : 's'} could not be saved ({failed[0].error}).
          </span>
          <button
            type="button"
            className="focus-ring px-3 py-1 text-sm font-medium"
            style={{ ...secondaryBtn, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
            onClick={() => { const f = failed; setFailed([]); f.forEach((u) => upload(u.sessionId, u.blob, u.options, u.replace)); }}
          >
            Retry upload
          </button>
        </div>
      )}

      <div className="grid gap-4 flex-1 min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:grid-rows-[minmax(0,1fr)]">
        {/* left: camera picker, options + Scan, live preview (fills the rest) */}
        <div className="flex flex-col min-h-0 min-w-0">
          <CameraPreview ref={cameraRef} flashKey={flashKey}>
            <div className="mb-2 flex flex-wrap items-stretch gap-2">
              <div className="flex-1" style={{ minWidth: '20rem' }}>
                <ScanOptionsPanel options={nextOptions} onChange={changeNextOptions} />
              </div>
              <button
                type="button"
                onClick={scan}
                onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                className="focus-ring px-8 py-2 text-xl font-bold"
                style={{
                  minWidth: '12rem',
                  background: retakeTarget ? 'var(--color-accent)' : 'var(--color-primary)',
                  color: '#fff', border: 'none', borderRadius: 'var(--radius-lg)', cursor: 'pointer', boxShadow: 'var(--shadow-md)',
                }}
              >
                {retakeTarget
                  ? `Retake page ${pages.findIndex((p) => p.id === retakeTarget) + 1}`
                  : 'Scan'}
                <span className="ml-2 text-sm font-medium" style={{ opacity: 0.8 }}>(Space)</span>
              </button>
              {retakeTarget && (
                <button type="button" className="focus-ring px-3 text-sm font-medium" style={secondaryBtn} onClick={() => setRetakeTarget(null)}>
                  Cancel retake
                </button>
              )}
            </div>
          </CameraPreview>
        </div>

        {/* right: export, then the page strip (the only part that scrolls) */}
        <div className="flex flex-col min-h-0 min-w-0 gap-2">
          <div className="px-3 py-2 flex flex-col gap-1" style={{ ...card, borderRadius: 'var(--radius-md)' }}>
            <button
              type="button"
              onClick={runExport}
              disabled={!canExport}
              className="focus-ring w-full px-4 py-2 text-sm font-semibold"
              style={{
                background: canExport ? 'var(--color-primary)' : 'var(--color-border)',
                color: canExport ? '#fff' : 'var(--color-ink-subtle)',
                border: 'none', borderRadius: 'var(--radius-md)', cursor: canExport ? 'pointer' : 'not-allowed',
              }}
            >
              {exporting
                ? exporting.total ? `Building PDF… ${exporting.current}/${exporting.total}` : 'Building PDF…'
                : 'Export searchable PDF'}
            </button>
            {exportHint && <p className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>{exportHint}</p>}
            {canExport && (
              <p className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                After export the original photos are deleted to save space; exported pages can then be retaken, not re-processed.
              </p>
            )}
            {session?.exportedAt && !exporting && (
              <p className="text-xs" style={{ color: 'var(--color-ink-subtle)' }}>
                Last exported {new Date(session.exportedAt).toLocaleString()} ·{' '}
                <a href={exportUrl(session.id, 'pdf')} className="underline" style={{ color: 'var(--color-primary)' }}>download again</a>
              </p>
            )}
          </div>
          {pageCount > 0 && (
            <button
              type="button"
              onClick={() => setViewer(0)}
              className="focus-ring w-full px-4 py-1.5 text-sm font-medium"
              style={secondaryBtn}
              title="Scroll through all pages at full size"
            >
              View pages ({pageCount})
            </button>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto p-2 max-lg:max-h-[70vh]" style={{ ...card, borderRadius: 'var(--radius-md)' }}>
            <PageStrip
              sessionId={session?.id ?? ''}
              pages={pages}
              retakeTarget={retakeTarget}
              onOpen={setViewer}
              onAction={onAction}
              onMove={move}
            />
          </div>
        </div>
      </div>

      {session && viewer !== null && pages[viewer] && (
        <ScanPageViewer
          sessionId={session.id}
          pages={pages}
          index={viewer}
          onClose={() => setViewer(null)}
          onOverride={onOverride}
          onDelete={(p) => { setViewer(null); onDelete(p); }}
        />
      )}
    </div>
  );
}

function ErrorBox({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 text-sm"
      style={{ background: 'var(--color-danger-subtle)', color: 'var(--color-danger)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-danger)' }}
    >
      <span className="flex-1">{message}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="focus-ring" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
      )}
    </div>
  );
}

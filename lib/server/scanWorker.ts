import type { ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { spawnPipeline } from './python';
import {
  listSessions, placePages, readSession, sessionDir, updateSession,
} from './scanStore';
import type { ScanCapture, ScanPageInfo } from '@/lib/scanTypes';

/**
 * One long-lived Python scan worker (scripts/scan_worker.py) fed from an
 * in-memory queue. Jobs run one at a time, in order. If the worker dies it
 * is restarted and the job it was on goes back to the front of the queue
 * (up to MAX_ATTEMPTS, so one bad photo can't crash-loop it). The queue
 * itself is rebuilt from the sessions on disk when the server starts, so
 * captures queued before a crash are processed after it.
 */

const MAX_ATTEMPTS = 3;
const RESTART_DELAY = 1000;

interface Job { sessionId: string; capture: number }

interface PyPage {
  id: string; capture: number; index: number; of: number; width: number; height: number;
  colour: boolean; warnings: string[]; ocr_words: number;
  split: { spread: boolean; confidence: number; source: string };
}

class ScanWorker {
  private proc: ChildProcess | null = null;
  private ready = false;
  private queue: Job[] = [];
  private current: (Job & { jobId: string }) | null = null;
  private seq = 0;
  private recovered: Promise<void> | null = null;
  restarts = 0;
  /** live progress per capture ("sessionId:capture" -> stage), not persisted */
  stages = new Map<string, string>();

  get running() { return this.proc !== null; }

  /** Rebuild the queue from disk once per server process. */
  ensureStarted(): Promise<void> {
    this.recovered ??= (async () => {
      const sessions = await listSessions();
      for (const s of sessions.reverse()) {
        const pending = Object.values(s.captures)
          .filter((c) => c.status === 'queued' || c.status === 'processing')
          .sort((a, b) => a.no - b.no);
        for (const c of pending) this.queue.push({ sessionId: s.id, capture: c.no });
      }
      if (this.queue.length) console.log(`[scan] resuming ${this.queue.length} queued capture(s)`);
      this.pump();
    })().catch((e) => { console.error('[scan] recovery failed', e); });
    return this.recovered;
  }

  enqueue(sessionId: string, capture: number) {
    if (this.queue.some((j) => j.sessionId === sessionId && j.capture === capture)) return;
    this.queue.push({ sessionId, capture });
    this.pump();
  }

  counts(sessionId: string) {
    return {
      queued: this.queue.filter((j) => j.sessionId === sessionId).length,
      processing: this.current?.sessionId === sessionId ? 1 : 0,
    };
  }

  stage(sessionId: string, capture: number) {
    return this.stages.get(`${sessionId}:${capture}`);
  }

  private start() {
    if (this.proc) return;
    console.log('[scan] starting worker');
    const proc = spawnPipeline('scan-worker', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ready = false;
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      let ev: { event?: string; id?: string; stage?: string; pages?: PyPage[]; error?: string };
      try { ev = JSON.parse(line); } catch { return; }
      this.onEvent(ev).catch((e) => console.error('[scan] event handling failed', e));
    });
    proc.on('error', (e) => console.error('[scan] worker spawn error', e));
    proc.on('exit', (code, signal) => {
      console.error(`[scan] worker exited code=${code} signal=${signal}`);
      this.proc = null;
      this.ready = false;
      const job = this.current;
      this.current = null;
      if (job) {
        this.stages.delete(`${job.sessionId}:${job.capture}`);
        this.failOrRetry(job, `worker exited (code ${code})`).finally(() => {
          setTimeout(() => this.pump(), RESTART_DELAY);
        });
      } else if (this.queue.length) {
        setTimeout(() => this.pump(), RESTART_DELAY);
      }
      this.restarts++;
    });
  }

  private async failOrRetry(job: Job, error: string) {
    const s = await updateSession(job.sessionId, (s) => {
      const c = s.captures[job.capture];
      if (!c) return;
      if (c.attempts >= MAX_ATTEMPTS) {
        c.status = 'error';
        c.error = error;
      } else {
        c.status = 'queued';
      }
    }).catch(() => null);
    const c = s?.captures[job.capture];
    if (c && c.status === 'queued') this.queue.unshift(job);
  }

  private pump() {
    if (!this.proc) {
      if (this.queue.length) this.start();
      return;
    }
    if (!this.ready || this.current || !this.queue.length) return;
    const job = this.queue.shift()!;
    const jobId = `j${++this.seq}`;
    this.current = { ...job, jobId };
    this.dispatch(this.current).catch((e) => {
      console.error('[scan] dispatch failed', e);
      this.current = null;
      this.pump();
    });
  }

  private async dispatch(job: Job & { jobId: string }) {
    let cap: ScanCapture | undefined;
    const s = await updateSession(job.sessionId, (s) => {
      cap = s.captures[job.capture];
      if (cap && cap.status !== 'done') {
        cap.status = 'processing';
        cap.attempts = (cap.attempts ?? 0) + 1;
      }
    }).catch(() => null);
    if (!s || !cap || cap.status !== 'processing') {
      // session deleted, or capture no longer pending
      this.current = null;
      this.pump();
      return;
    }
    const ov = cap.overrides ?? {};
    const perPage: Record<string, Record<string, unknown>> = {};
    for (const [idx, p] of Object.entries(ov.pages ?? {})) {
      perPage[idx] = {
        ...(p.colorMode ? { color_mode: p.colorMode } : {}),
        ...(typeof p.dewarp === 'boolean' ? { dewarp: p.dewarp } : {}),
        ...(typeof p.removeFingers === 'boolean' ? { remove_fingers: p.removeFingers } : {}),
      };
    }
    const msg = {
      id: job.jobId,
      type: 'process',
      session_dir: sessionDir(job.sessionId),
      capture: job.capture,
      options: {
        color_mode: cap.options.colorMode,
        dewarp: cap.options.dewarp,
        remove_fingers: cap.options.removeFingers,
        split: ov.split ?? cap.options.split,
        rotate: ov.rotate ?? {},
        keep_colour: ov.keepColour ?? {},
        per_page: perPage,
        crop: cap.options.crop ?? null,
      },
    };
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private async onEvent(ev: { event?: string; id?: string; stage?: string; pages?: PyPage[]; error?: string }) {
    if (ev.event === 'ready') {
      this.ready = true;
      this.pump();
      return;
    }
    const job = this.current;
    if (!job || ev.id !== job.jobId) return;
    const key = `${job.sessionId}:${job.capture}`;
    if (ev.event === 'progress') {
      if (ev.stage) this.stages.set(key, ev.stage);
      return;
    }
    if (ev.event === 'done' || ev.event === 'error') {
      this.stages.delete(key);
      await updateSession(job.sessionId, (s) => {
        const c = s.captures[job.capture];
        if (!c) return;
        // a new override arrived while this ran: it's queued again, keep it so
        const requeued = this.queue.some((j) => j.sessionId === job.sessionId && j.capture === job.capture);
        if (ev.event === 'error') {
          c.status = requeued ? 'queued' : 'error';
          c.error = ev.error || 'processing failed';
          return;
        }
        const infos: Record<string, ScanPageInfo> = {};
        for (const p of ev.pages ?? []) {
          infos[p.id] = {
            capture: p.capture, index: p.index, of: p.of, width: p.width, height: p.height,
            colour: p.colour, warnings: p.warnings ?? [], ocrWords: p.ocr_words,
            split: { spread: p.split.spread, confidence: p.split.confidence, source: p.split.source },
          };
        }
        placePages(s, c, (ev.pages ?? []).map((p) => p.id), infos);
        c.status = requeued ? 'queued' : 'done';
        c.error = undefined;
        c.attempts = 0;
        c.doneAt = new Date().toISOString();
      }).catch((e) => console.error('[scan] could not save result', e));
      this.current = null;
      this.pump();
    }
  }

  /** Kill the worker (server shutdown). */
  stop() {
    try { this.proc?.kill(); } catch { /* already gone */ }
  }
}

const g = globalThis as unknown as { __scanWorker?: ScanWorker };
export const scanWorker: ScanWorker = (g.__scanWorker ??= (() => {
  const w = new ScanWorker();
  process.once('exit', () => w.stop());
  return w;
})());

export async function getSessionChecked(id: string) {
  await scanWorker.ensureStarted();
  return readSession(id);
}

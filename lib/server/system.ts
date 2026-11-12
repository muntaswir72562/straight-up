import { cpus } from 'os';

/**
 * Is this a slow PC? Then Scan Book's "Auto" speed means "Fast".
 *
 * A 2-core Celeron laptop took over 15 minutes for one capture: it has no
 * AVX2 (Tesseract and OpenCV run their slow paths), its two cores are shared
 * with the live camera preview, and every Tesseract start is checked by the
 * antivirus. Slow: at most 2 logical CPUs, or a Celeron / Pentium Silver /
 * Atom / Athlon Silver-class chip (none of them has AVX2).
 */
const SLOW_CPU = /celeron|pentium\(r\) (silver|n\d)|pentium (silver|n\d)|\batom\b|athlon(\(tm\))? silver|\bamd (a4|a6|a9|e1|e2)-/i;

let cached: { slowPc: boolean; cpus: number; model: string } | null = null;

export function systemInfo() {
  if (!cached) {
    const list = cpus();
    const model = (list[0]?.model ?? '').trim();
    cached = { slowPc: list.length <= 2 || SLOW_CPU.test(model), cpus: list.length, model };
  }
  return cached;
}

/** The speed a capture is processed with: 'auto' resolved for this PC. */
export function resolveSpeed(speed: string | undefined): 'quality' | 'fast' {
  if (speed === 'quality' || speed === 'fast') return speed;
  return systemInfo().slowPc ? 'fast' : 'quality';
}

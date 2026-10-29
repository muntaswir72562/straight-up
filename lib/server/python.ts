import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { join } from 'path';

/**
 * Python pipeline names -> script file in scripts/. The name is also the
 * subcommand of the bundled engine (scripts/engine.py) in the desktop app.
 */
const SCRIPTS = {
  fullfix: 'fullfix_pdf.py',
  clean: 'clean_pdf.py',
  straighten: 'straighten_pdf.py',
  'replace-ocr': 'replace_ocr.py',
  inpaint: 'inpaint.py',
  'scan-worker': 'scan_worker.py',
  'scan-export': 'scan_export.py',
} as const;

export type PipelineName = keyof typeof SCRIPTS;

/**
 * Run a Python pipeline.
 *
 * - STRAIGHTUP_ENGINE set (desktop app): `<engine.exe> <name> ...args`
 * - otherwise (dev, Docker/Railway): `python scripts/<script>.py ...args`,
 *   exactly as the routes did before.
 */
export function spawnPipeline(name: PipelineName, args: string[], options: SpawnOptions = {}): ChildProcess {
  const engine = process.env.STRAIGHTUP_ENGINE;
  if (engine) {
    return spawn(engine, [name, ...args], { windowsHide: true, ...options });
  }
  const scriptPath = join(process.cwd(), 'scripts', SCRIPTS[name]);
  return spawn('python', [scriptPath, ...args], options);
}

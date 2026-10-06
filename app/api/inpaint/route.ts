import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const imageFile = formData.get('image') as File | null;
  const maskFile = formData.get('mask') as File | null;
  const radiusStr = formData.get('radius') as string | null;

  if (!imageFile || !maskFile) {
    return NextResponse.json({ error: 'Missing image or mask' }, { status: 400 });
  }

  const radius = parseInt(radiusStr || '5', 10);
  const jobId = randomUUID();
  const tempDir = join(tmpdir(), `straight-up-inpaint-${jobId}`);
  await mkdir(tempDir, { recursive: true });

  const imagePath = join(tempDir, 'image.jpg');
  const maskPath = join(tempDir, 'mask.png');
  const outputPath = join(tempDir, 'output.jpg');

  const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  const maskBuffer = Buffer.from(await maskFile.arrayBuffer());
  await writeFile(imagePath, imageBuffer);
  await writeFile(maskPath, maskBuffer);

  const scriptPath = join(process.cwd(), 'scripts', 'inpaint.py');

  try {
    await new Promise<void>((resolve, reject) => {
      const py = spawn('python', [scriptPath, imagePath, maskPath, outputPath, String(radius)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      py.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      py.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Inpaint failed (code ${code}): ${stderr}`));
      });
    });

    const resultBuffer = await readFile(outputPath);

    // Clean up temp files
    rm(tempDir, { recursive: true, force: true }).catch(() => {});

    return new NextResponse(resultBuffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(resultBuffer.length),
      },
    });
  } catch (err) {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

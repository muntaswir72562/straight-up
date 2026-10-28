/**
 * Normalize a rotation in degrees to one of 0, 90, 180, 270.
 */
export function normalizeRotation(degrees: number): number {
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

/**
 * Draw an image source onto a new canvas rotated clockwise by `degrees`
 * (multiple of 90) and encode it as JPEG.
 */
async function rotateSourceToBlob(
  source: CanvasImageSource,
  width: number,
  height: number,
  degrees: number,
  quality: number,
): Promise<Blob> {
  const rot = normalizeRotation(degrees);
  const swap = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? height : width;
  canvas.height = swap ? width : height;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Rotate an image Blob (JPEG/PNG/WebP) clockwise and return JPEG bytes.
 */
export async function rotateImageBlob(
  blob: Blob,
  degrees: number,
  quality: number,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    const out = await rotateSourceToBlob(bitmap, bitmap.width, bitmap.height, degrees, quality);
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * Rotate the image behind a blob URL clockwise and return a new blob URL.
 * The input URL is not revoked.
 */
export async function rotateImageUrl(url: string, degrees: number): Promise<string> {
  const res = await fetch(url);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const out = await rotateSourceToBlob(bitmap, bitmap.width, bitmap.height, degrees, 0.92);
    return URL.createObjectURL(out);
  } finally {
    bitmap.close();
  }
}

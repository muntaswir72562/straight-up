export interface DetectResult {
  angle: number;
  method: 'text' | 'edge' | 'none';
  confidence: number;
}

export interface StraightenResult {
  jpeg: Uint8Array;
  thumbnail: Uint8Array;
  croppedWidth: number;
  croppedHeight: number;
}

type PendingRequest = {
  resolve: (result: never) => void;
  reject: (error: Error) => void;
};

/**
 * Promise-based wrapper around the deskew Web Worker.
 * Call init() first (resolves when OpenCV is ready inside the worker).
 * Then call detectAngle() per page.
 */
export class DeskewClient {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;

  /** Start the worker and wait for OpenCV to initialize. */
  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker('/workers/deskew.worker.js?v=15');
      } catch (err) {
        reject(new Error('Failed to create deskew worker.'));
        return;
      }

      this.worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;

        if (msg.type === 'ready') {
          // Worker is initialized, switch to normal message handler
          this.worker!.onmessage = this.handleMessage.bind(this);
          resolve();
          return;
        }

        // In case a result/error arrives before 'ready' (shouldn't happen)
        this.handleMessage(e);
      };

      this.worker.onerror = (err) => {
        reject(new Error(`Worker error: ${err.message}`));
      };
    });

    return this.readyPromise;
  }

  private handleMessage(e: MessageEvent) {
    const msg = e.data;

    if (msg.type === 'result' || msg.type === 'straightened' || msg.type === 'error') {
      const req = this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);

      if (msg.type === 'result') {
        (req.resolve as (r: DetectResult) => void)({
          angle: msg.angle,
          method: msg.method,
          confidence: msg.confidence,
        });
      } else if (msg.type === 'straightened') {
        (req.resolve as (r: StraightenResult) => void)({
          jpeg: msg.jpeg,
          thumbnail: msg.thumbnail,
          croppedWidth: msg.croppedWidth,
          croppedHeight: msg.croppedHeight,
        });
      } else {
        req.reject(new Error(msg.message));
      }
    }
  }

  /**
   * Send a page image to the worker for angle detection.
   * imageData should be the raw RGBA pixel data from a canvas.
   */
  detectAngle(
    imageData: Uint8ClampedArray,
    width: number,
    height: number
  ): Promise<DetectResult> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized. Call init() first.'));
    }

    const id = this.nextId++;

    return new Promise<DetectResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // Transfer the buffer to avoid copying
      const buffer = imageData.buffer.slice(0);
      this.worker!.postMessage(
        {
          type: 'detect',
          id,
          imageData: new Uint8ClampedArray(buffer),
          width,
          height,
        },
        [buffer]
      );
    });
  }

  /**
   * Send a page image to the worker for straightening.
   * Returns the JPEG-encoded straightened image and a thumbnail.
   */
  straightenPage(
    imageData: Uint8ClampedArray,
    width: number,
    height: number,
    angle: number,
    autoCrop: boolean
  ): Promise<StraightenResult> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized. Call init() first.'));
    }

    const id = this.nextId++;

    return new Promise<StraightenResult>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: never) => void, reject });

      const buffer = imageData.buffer.slice(0);
      this.worker!.postMessage(
        {
          type: 'straighten',
          id,
          imageData: new Uint8ClampedArray(buffer),
          width,
          height,
          angle,
          autoCrop,
        },
        [buffer]
      );
    });
  }

  /** Terminate the worker. */
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Reject any pending requests
    for (const [, req] of this.pending) {
      req.reject(new Error('Worker destroyed.'));
    }
    this.pending.clear();
    this.readyPromise = null;
  }
}

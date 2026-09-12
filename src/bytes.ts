import { DEFAULT_MODEL_MAX_BYTES } from "./types.js";

/** Non-retryable acquisition failure; never contains a source URI or provider error. */
export class ModelResourceTooLargeError extends Error {
  readonly code = "MODEL_RESOURCE_TOO_LARGE";
  constructor() {
    super("Model resource exceeds maxBytes");
    this.name = "ModelResourceTooLargeError";
  }
}

export function byteLimit(value = DEFAULT_MODEL_MAX_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  return value;
}

export function checkSize(size: number, maxBytes: number): void {
  if (size > maxBytes) throw new ModelResourceTooLargeError();
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The model load was aborted", "AbortError");
}

export function acquisitionController(signal?: AbortSignal, timeoutMs = 30_000, parent?: AbortSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be a positive timer-safe integer");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  parent?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted || parent?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      parent?.removeEventListener("abort", abort);
    },
  };
}

/** Stop waiting even when an injected producer ignores cancellation. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("The model load was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Invoke cleanup without allowing an uncooperative producer to stall failure. */
export function cleanup(work: () => unknown): void {
  try { void Promise.resolve(work()).catch(() => {}); } catch { /* Preserve the original failure. */ }
}

export async function readBoundedStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // Geometric storage bounds both retained bytes and metadata for tiny/empty chunks.
  let bytes = new Uint8Array(0);
  let length = 0;
  let chunks = 0;
  const reader = "getReader" in source ? source.getReader() : undefined;
  const iterator = reader ? undefined : (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  try {
    while (true) {
      checkAbort(signal);
      if (++chunks % 256 === 0) await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
      const next = await abortable(reader ? reader.read() : iterator!.next(), signal);
      checkAbort(signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new TypeError("Model stream chunks must be Uint8Array");
      const chunk = next.value;
      if (chunk.byteLength > maxBytes - length) throw new ModelResourceTooLargeError();
      const required = length + chunk.byteLength;
      if (required > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(required, bytes.length * 2, 4096)));
        grown.set(bytes.subarray(0, length));
        bytes = grown;
      }
      bytes.set(chunk, length);
      length = required;
    }
    return bytes.length === length ? bytes : bytes.slice(0, length);
  } catch (error) {
    if (reader) cleanup(() => reader.cancel());
    else cleanup(() => iterator?.return?.());
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

export async function boundedBytes(input: ArrayBuffer | Blob | Uint8Array, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  checkSize(input instanceof Blob ? input.size : input.byteLength, maxBytes);
  if (input instanceof Blob) return readBoundedStream(input.stream(), maxBytes, signal);
  return new Uint8Array(input);
}

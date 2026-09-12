import { abortable, acquisitionController, byteLimit, checkAbort, checkSize, cleanup, ModelResourceTooLargeError, readBoundedStream } from "./bytes.js";
import { DEFAULT_MODEL_MAX_BYTES } from "./types.js";
import type {
  FetchPolicy,
  HashBytes,
  RuntimeFetch,
  Sleep,
  ResolveResourceOptions,
} from "./types.js";

const DEFAULT_POLICY: Required<FetchPolicy> = {
  maxBytes: DEFAULT_MODEL_MAX_BYTES,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  timeoutMs: 30_000,
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

class NonRetryableResourceError extends Error {}

export type FetchedResource = Readonly<{
  bytes: Uint8Array;
  contentType?: string;
  rangeSupported: boolean;
}>;

export function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(createAbortError());
    }, { once: true });
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 integrity checks require Web Crypto support or an injected hashBytes dependency");
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchResource(
  url: string,
  options: Readonly<{
    fetch: RuntimeFetch;
    hashBytes: HashBytes;
    sleep: Sleep;
    headers?: Readonly<Record<string, string>>;
    integrity?: string;
    policy?: FetchPolicy;
    resolveOptions?: ResolveResourceOptions;
  }>,
): Promise<FetchedResource> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const maxBytes = Math.min(byteLimit(policy.maxBytes), byteLimit(options.resolveOptions?.maxBytes ?? policy.maxBytes));
  const headers = new Headers(options.headers);
  if (options.resolveOptions?.range) {
    const { start, end } = options.resolveOptions.range;
    headers.set("Range", `bytes=${start}-${end ?? ""}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const controller = acquisitionController(options.resolveOptions?.signal, policy.timeoutMs);

    try {
      checkAbort(controller.signal);
      const response = await abortable(options.fetch(url, {
        headers,
        signal: controller.signal,
      }).then((response) => {
        if (controller.signal.aborted) {
          cleanup(() => response.body?.cancel());
          checkAbort(controller.signal);
        }
        return response;
      }), controller.signal);

      if (!response.ok) {
        cleanup(() => response.body?.cancel());
        if (!RETRYABLE_STATUSES.has(response.status)) {
          throw new NonRetryableResourceError(`Model resource request failed with HTTP ${response.status}`);
        }
        if (attempt === policy.maxAttempts) {
          throw new NonRetryableResourceError(`Model resource request failed with HTTP ${response.status}`);
        }
        lastError = new Error(`Retryable model resource response: HTTP ${response.status}`);
        await waitForRetry(options.sleep, attempt, policy, controller.signal);
        continue;
      }

      let bytes: Uint8Array;
      try {
        const declared = response.headers.get("content-length");
        if (declared !== null && /^\d+$/u.test(declared)) checkSize(Number(declared), maxBytes);
        bytes = response.body ? await readBoundedStream(response.body, maxBytes, controller.signal) : new Uint8Array(0);
        checkAbort(controller.signal);
      } catch (error) {
        if (!response.body?.locked) cleanup(() => response.body?.cancel());
        throw error;
      }
      await abortable(verifyIntegrity(bytes, options.integrity, options.hashBytes), controller.signal);
      return {
        bytes,
        contentType: response.headers.get("content-type") ?? undefined,
        rangeSupported: response.status === 206 || response.headers.get("accept-ranges")?.toLowerCase() === "bytes",
      };
    } catch (error) {
      if (isAbortError(error) || options.resolveOptions?.signal?.aborted) {
        throw createAbortError();
      }
      if (error instanceof NonRetryableResourceError || error instanceof ModelResourceTooLargeError) {
        throw error;
      }
      lastError = error;
      if (attempt === policy.maxAttempts) {
        throw error;
      }
      await waitForRetry(options.sleep, attempt, policy, controller.signal);
    } finally {
      controller.dispose();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Model resource request failed");
}

export async function verifyIntegrity(bytes: Uint8Array, integrity: string | undefined, hashBytes: HashBytes): Promise<void> {
  if (!integrity) {
    return;
  }

  const expected = integrity.replace(/^sha256-/iu, "").toLowerCase();
  const actualHex = (await hashBytes(bytes)).toLowerCase();
  const actualBase64 = bytesToBase64(await digestBytes(bytes, hashBytes));
  if (expected !== actualHex && expected !== actualBase64) {
    throw new NonRetryableResourceError("Model resource integrity check failed");
  }
}

async function digestBytes(bytes: Uint8Array, hashBytes: HashBytes): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  }

  const hex = await hashBytes(bytes);
  if (!/^[0-9a-f]{64}$/iu.test(hex)) {
    throw new Error("A base64 integrity check requires Web Crypto or a byte-level hash implementation");
  }
  return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function waitForRetry(sleep: Sleep, attempt: number, policy: Required<FetchPolicy>, signal: AbortSignal): Promise<void> {
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  await abortable(sleep(delay, signal), signal);
}

function createAbortError(): Error {
  return new DOMException("The model load was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

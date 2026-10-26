import type { AssetManifest, ModelResourceManifestQualificationInput } from "@plasius/asset-contracts";
import { abortable, acquisitionController } from "./bytes.js";
import { sha256Hex } from "./fetch.js";
import type { ModelRuntime } from "./runtime.js";
import type { LoadModelOptions, ModelLoadResult, ModelResourceInput } from "./types.js";

/** Tightened acquisition budgets for the opt-in complete-inventory boundary. */
export const MODEL_PACKAGE_LOAD_LIMITS = Object.freeze({
  files: 1024, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024,
  metadataValues: 65_536, metadataDepth: 16, timeoutMs: 60_000,
});

export type ModelPackageLoadInput = Omit<ModelResourceManifestQualificationInput, "signal" | "timeoutMs">;
/** Transport and legacy cache options deliberately do not apply to acquired packages. */
export type ModelPackageLoadOptions = Pick<LoadModelOptions, "signal" | "mode" | "formatId" | "adapterOptions" | "worker"> & Readonly<{ timeoutMs?: number }>;
export type ModelPackageLoadFailure = "invalid-input" | "limit-exceeded" | "package-invalid" | "load-failed" | "aborted" | "deadline-exceeded";

/** Fixed, value-free failure. Caller/parser exception objects are never forwarded. */
export class ModelPackageLoadError extends Error {
  constructor(public readonly code: ModelPackageLoadFailure) {
    super(`Model package load failed: ${code}`);
    this.name = "ModelPackageLoadError";
  }
}
const failures = new WeakMap<object, ModelPackageLoadFailure>();
function fail(code: ModelPackageLoadFailure = "invalid-input"): never {
  const error = new ModelPackageLoadError(code); failures.set(error, code); throw error;
}
function category(error: unknown): ModelPackageLoadFailure | undefined {
  return typeof error === "object" && error !== null ? failures.get(error) : undefined;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MODEL_PACKAGE_LOAD_LIMITS.metadataValues) fail("limit-exceeded");
  for (const key of keys) {
    if (typeof key !== "string" || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key)) fail();
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in property) || !property.enumerable) fail();
    result[key] = property.value;
  }
  return result;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  if (value.length > limit) fail("limit-exceeded");
  if (Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !("value" in property) || !property.enumerable) fail();
    result.push(property.value);
  }
  return result;
}
// Copies generic JSON metadata only; schema/paths/roles/digests remain contracts-owned.
function metadata(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (--budget.remaining < 0 || depth > MODEL_PACKAGE_LOAD_LIMITS.metadataDepth) fail("limit-exceeded");
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "string") { if (value.length > 2048) fail("limit-exceeded"); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return value; }
  if (Array.isArray(value)) return Object.freeze(list(value, MODEL_PACKAGE_LOAD_LIMITS.metadataValues).map((entry) => metadata(entry, budget, depth + 1)));
  const result = record(value);
  for (const key of Object.keys(result)) result[key] = metadata(result[key], budget, depth + 1);
  return Object.freeze(result);
}
const abortedOf = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
function parentAborted(signal: AbortSignal): boolean {
  try { return abortedOf.call(signal) as boolean; } catch { return false; }
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;

function snapshot(input: ModelPackageLoadInput): ModelPackageLoadInput {
  const root = record(input);
  if (Object.keys(root).length !== 3 || Object.keys(root).some((key) => !["manifest", "packageManifest", "files"].includes(key))) fail();
  const budget = { remaining: MODEL_PACKAGE_LOAD_LIMITS.metadataValues };
  const manifest = metadata(root.manifest, budget) as AssetManifest;
  const packageManifest = metadata(root.packageManifest, budget) as ModelPackageLoadInput["packageManifest"];
  let total = 0;
  const files = list(root.files, MODEL_PACKAGE_LOAD_LIMITS.files).map((value) => {
    const file = record(value);
    if (Object.keys(file).length !== 3 || Object.keys(file).some((key) => !["path", "bytes", "contentType"].includes(key))
      || typeof file.path !== "string" || file.path.length > 1024 || typeof file.contentType !== "string" || file.contentType.length > 128) fail();
    if (!(file.bytes instanceof Uint8Array) || Object.getPrototypeOf(file.bytes) !== Uint8Array.prototype) fail();
    const length = lengthOf.call(file.bytes) as number;
    const buffer = bufferOf.call(file.bytes) as ArrayBuffer;
    if (!(buffer instanceof ArrayBuffer)) fail();
    total += length;
    if (length > MODEL_PACKAGE_LOAD_LIMITS.fileBytes || total > MODEL_PACKAGE_LOAD_LIMITS.totalBytes) fail("limit-exceeded");
    return { path: file.path, contentType: file.contentType, length, buffer, offset: offsetOf.call(file.bytes) as number };
  });
  // Validate all byte budgets before allocating; never invoke caller iterators/slice.
  return { manifest, packageManifest, files: files.map((file) => ({
    path: file.path, contentType: file.contentType, bytes: new Uint8Array(new Uint8Array(file.buffer, file.offset, file.length)),
  })) };
}

/**
 * Qualifies a complete acquired package before parsing its declared entrypoint.
 * Host transport/rollout and adapter semantic validation retain their owners.
 * No undeclared file/network fallback or entrypoint-only cache reuse is allowed.
 */
export async function loadModelPackage<TCanonicalModel = unknown, TRendererReady = unknown>(
  runtime: ModelRuntime, input: ModelPackageLoadInput, options: ModelPackageLoadOptions = {},
): Promise<ModelLoadResult<TCanonicalModel, TRendererReady>> {
  let controller: ReturnType<typeof acquisitionController> | undefined;
  let parent: AbortSignal | undefined;
  let disconnect: (() => void) | undefined;
  let phase: ModelPackageLoadFailure = "invalid-input";
  const started = performance.now();
  let timeoutMs = 30_000;
  const check = (): void => {
    if (parent && parentAborted(parent)) fail("aborted");
    if (performance.now() - started >= timeoutMs) fail("deadline-exceeded");
    if (controller && parentAborted(controller.signal)) fail("deadline-exceeded");
  };
  try {
    const fields = record(options);
    if (Object.keys(fields).some((key) => !["signal", "timeoutMs", "mode", "formatId", "adapterOptions", "worker"].includes(key))) fail();
    const timeout = fields.timeoutMs ?? 30_000;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MODEL_PACKAGE_LOAD_LIMITS.timeoutMs) fail();
    if (fields.signal !== undefined) {
      // Intrinsic brand/read checks avoid own aborted getters and abort reasons.
      abortedOf.call(fields.signal);
    }
    timeoutMs = timeout;
    if (fields.mode !== undefined && !["strict", "tolerant", "forensic"].includes(fields.mode as string)) fail();
    if (fields.formatId !== undefined && (typeof fields.formatId !== "string" || !fields.formatId.length || fields.formatId.length > 128)) fail();
    let worker: LoadModelOptions["worker"];
    if (fields.worker !== undefined) {
      const policy = record(fields.worker);
      if (Object.keys(policy).some((key) => key !== "mode") || (policy.mode !== undefined && !["auto", "never", "always"].includes(policy.mode as string))) fail();
      worker = Object.freeze({ mode: policy.mode as "auto" | "never" | "always" | undefined });
    }
    parent = fields.signal as AbortSignal | undefined;
    const forwarded = new AbortController();
    if (parent) {
      const abort = (): void => { forwarded.abort(); };
      EventTarget.prototype.addEventListener.call(parent, "abort", abort, { once: true });
      disconnect = () => { EventTarget.prototype.removeEventListener.call(parent, "abort", abort); };
      if (parentAborted(parent)) forwarded.abort();
    }
    controller = acquisitionController(forwarded.signal, timeout);
    check();
    const retained = snapshot(input);
    check();
    const signal = controller.signal;
    const loadOptions: LoadModelOptions = {
      signal, mode: fields.mode as LoadModelOptions["mode"], formatId: fields.formatId as string | undefined,
      adapterOptions: fields.adapterOptions, worker,
      useCache: false, fetchPolicy: { timeoutMs: timeout, maxBytes: MODEL_PACKAGE_LOAD_LIMITS.fileBytes },
    };
    phase = "package-invalid";
    const { qualifyModelResourceManifest } = await abortable(import("@plasius/asset-contracts"), signal);
    const manifest = await abortable(qualifyModelResourceManifest({ ...retained, signal, timeoutMs: timeout }), signal);
    check();
    const descriptors = new Map(manifest.files.map((file) => [file.path, file]));
    const resources: Record<string, ModelResourceInput> = Object.create(null) as Record<string, ModelResourceInput>;
    for (const file of retained.files) {
      const descriptor = descriptors.get(file.path)!;
      resources[file.path] = Object.freeze({ bytes: file.bytes, contentType: descriptor.contentType, integrity: descriptor.sha256 });
    }
    Object.freeze(resources);
    const entrypoint = resources[manifest.entrypoint]!;
    const closureHash = await abortable(sha256Hex(new TextEncoder().encode(JSON.stringify({
      assetId: manifest.assetId, version: manifest.version, sourceAdapter: manifest.sourceAdapter,
      entrypoint: manifest.entrypoint, files: manifest.files.map(({ path, role, contentType, byteLength, sha256 }) => [path, role, contentType, byteLength, sha256]),
    }))), signal);
    check();
    phase = "load-failed";
    const result = await abortable(runtime.loadModel<TCanonicalModel, TRendererReady>({
      kind: "uint8-array", bytes: entrypoint.bytes as Uint8Array,
      fileNameHint: manifest.entrypoint, mimeTypeHint: entrypoint.contentType,
      package: Object.freeze({ entrypoint: manifest.entrypoint, resourcePolicy: "closed", resources }),
    }, { ...loadOptions, integrity: entrypoint.integrity }), signal);
    check();
    return { ...result, cacheKey: `model-package-v1:${closureHash}:${result.cacheKey}`, fromCache: false };
  } catch (error) {
    // Never inspect thrown proxies, constructors, names, messages or abort reasons.
    const code = parent && parentAborted(parent) ? "aborted" : controller && parentAborted(controller.signal) ? "deadline-exceeded" : category(error) ?? phase;
    throw new ModelPackageLoadError(code);
  } finally {
    controller?.dispose();
    disconnect?.();
  }
}

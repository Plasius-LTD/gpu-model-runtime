import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry, ModelRuntime, PackageResourceResolver, fetchResource, sha256Hex, type ModelSource, type ResolvedModelSource } from "../src/index.js";

const hashBytes = sha256Hex;
const sleep = async () => {};
const policy = { maxBytes: 4, maxAttempts: 3, timeoutMs: 100 };
function runtime() {
  const load = vi.fn(async (input: ResolvedModelSource) => ({ canonicalModel: Array.from(input.bytes as Uint8Array) }));
  const registry = new AdapterRegistry().register({ formatId: "test", sniff: () => true, load: async () => ({ formatId: "test", sniff: () => true, load }) });
  return { runtime: new ModelRuntime({ registry }), load, registry };
}
function stream(chunks: number[], cancel = vi.fn()) {
  return new ReadableStream<Uint8Array>({
    pull(controller) { const size = chunks.shift(); if (size === undefined) controller.close(); else controller.enqueue(new Uint8Array(size)); },
    cancel,
  });
}

describe("bounded model acquisition", () => {
  it("rejects declared oversize before consuming the body, without retry", async () => {
    const cancel = vi.fn();
    const body = stream([1], cancel);
    const fetch = vi.fn(async () => new Response(body, { headers: { "content-length": "5" } }));
    await expect(fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each([200, 206])("bounds actual response bytes even with ignored or misleading range/length, status %s", async (status) => {
    const cancel = vi.fn();
    const body = stream([3, 3, 1], cancel);
    const fetch = vi.fn(async () => new Response(body, { status, headers: { "content-length": "1" } }));
    await expect(fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy, resolveOptions: { range: { start: 0, end: 3 } } })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("accepts exact-bound streamed ranges and verifies their integrity", async () => {
    const bytes = new Uint8Array(4);
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(stream([2, 2]), { status: 206 }));
    const result = await fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy, integrity: await sha256Hex(bytes), resolveOptions: { range: { start: 0, end: 3 } } });
    expect(result.bytes).toEqual(bytes);
    expect(result.rangeSupported).toBe(true);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Range")).toBe("bytes=0-3");
  });

  it.each([0, -1, Infinity, NaN, 1.5])("rejects invalid byte ceiling %s before I/O", async (maxBytes) => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(1)));
    await expect(fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy: { ...policy, maxBytes } })).rejects.toThrow("maxBytes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["uint8-array", "array-buffer", "blob"] as const)("checks %s before adapter loading", async (kind) => {
    const { runtime: modelRuntime, load } = runtime();
    const source = kind === "blob" ? { kind, blob: new Blob([new Uint8Array(5)]) } : { kind, bytes: kind === "array-buffer" ? new ArrayBuffer(5) : new Uint8Array(5) };
    await expect(modelRuntime.loadModel(source as ModelSource, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(load).not.toHaveBeenCalled();
  });

  it("bounds async iterable accumulation and closes the producer", async () => {
    const closed = vi.fn();
    const source = (async function* () { try { yield new Uint8Array(3); yield new Uint8Array(3); } finally { closed(); } })();
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: source }, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("bounds ReadableStream accumulation and cancels/releases it", async () => {
    const cancel = vi.fn();
    const body = stream([3, 3, 1], cancel);
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: body }, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("rejects an oversize hint without reading", async () => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next }) };
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: source, byteLengthHint: 5 }, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(next).not.toHaveBeenCalled();
  });

  it("still checks observed size when hints underestimate", async () => {
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: stream([3, 3]), byteLengthHint: 1 }, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
  });

  it("aborts stalled streams and releases the reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const pending = runtime().runtime.loadModel({ kind: "stream", stream: body }, { fetchPolicy: policy, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("times out a stalled async iterator without waiting for its cleanup", async () => {
    const close = vi.fn(async () => new Promise<IteratorResult<Uint8Array>>(() => {}));
    const source = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: close }) };
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: source }, { fetchPolicy: { ...policy, timeoutMs: 5 } })).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch for pre-aborted loads", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(async () => new Response(new Uint8Array(1)));
    await expect(fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy, resolveOptions: { signal: controller.signal } })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds remote and memory package resources, with per-call tightening only", async () => {
    const resolver = new PackageResourceResolver({ sourceKind: "url", baseUrl: "https://example.test/model", fetch: async () => new Response(new Uint8Array(5)), hashBytes, sleep, fetchPolicy: policy, package: { resources: { small: { bytes: new Uint8Array(4) }, large: { bytes: new Blob([new Uint8Array(5)]) } } } });
    for (const path of ["large", "remote"]) await expect(resolver.resolve(path)).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    await expect(resolver.resolve("small", { maxBytes: 3 })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    await expect(resolver.resolve("large", { maxBytes: 10 })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect((await resolver.resolve("small")).bytes.length).toBe(4);
  });

  it("propagates the bounded policy to injected file providers and checks returned bytes", async () => {
    const { registry } = runtime();
    const readFile = vi.fn(async () => new Uint8Array(5));
    const modelRuntime = new ModelRuntime({ registry, dependencies: { readFile } });
    await expect(modelRuntime.loadModel({ kind: "file-path", path: "fixture" }, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
    expect(readFile).toHaveBeenCalledWith("fixture", expect.any(AbortSignal), { maxBytes: 4 });
  });

  it("does not reuse a cached model under a stricter resource budget", async () => {
    const registry = new AdapterRegistry().register({ formatId: "test", sniff: () => true, load: async () => ({ formatId: "test", sniff: () => true, load: async (input) => ({ canonicalModel: (await input.resourceResolver.resolve("texture")).bytes.length }) }) });
    const modelRuntime = new ModelRuntime({ registry });
    const source = { kind: "uint8-array" as const, bytes: new Uint8Array(1), package: { resources: { texture: { bytes: new Uint8Array(5) } } } };
    await expect(modelRuntime.loadModel(source, { fetchPolicy: { ...policy, maxBytes: 8 } })).resolves.toMatchObject({ canonicalModel: 5 });
    await expect(modelRuntime.loadModel(source, { fetchPolicy: policy })).rejects.toMatchObject({ code: "MODEL_RESOURCE_TOO_LARGE" });
  });
});


describe("acquisition cleanup and portability", () => {
  it("keeps the default ceiling and public error stable", async () => {
    const { DEFAULT_MODEL_MAX_BYTES, ModelResourceTooLargeError } = await import("../src/index.js");
    expect(DEFAULT_MODEL_MAX_BYTES).toBe(64 * 1024 * 1024);
    const error = new ModelResourceTooLargeError();
    expect(error.code).toBe("MODEL_RESOURCE_TOO_LARGE");
    expect(error.message).not.toContain("example.test");
  });

  it("rejects malformed stream chunks and preserves failure if cleanup throws", async () => {
    const source = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: "invalid" as unknown as Uint8Array }), return() { throw new Error("private provider detail"); } }) };
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: source }, { fetchPolicy: policy })).rejects.toThrow("Uint8Array");
  });

  it("propagates producer errors and releases a ReadableStream lock", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("fixture failure")); } });
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: body }, { fetchPolicy: policy })).rejects.toThrow("fixture failure");
    expect(body.locked).toBe(false);
  });

  it("stops an endless empty-chunk producer at its deadline", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: new Uint8Array(0) }), return: close }) };
    await expect(runtime().runtime.loadModel({ kind: "stream", stream: source }, { fetchPolicy: { ...policy, timeoutMs: 5 } })).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves many small reused chunks while growing bounded storage", async () => {
    const source = (async function* () { const bytes = new Uint8Array(10); for (let i = 0; i < 1000; i++) { bytes.fill(i % 256); yield bytes; } })();
    const result = await runtime().runtime.loadModel<number[]>({ kind: "stream", stream: source }, { fetchPolicy: { maxBytes: 10000 } });
    expect(result.canonicalModel.length).toBe(10000);
    expect(result.canonicalModel[10]).toBe(1);
    expect(result.canonicalModel[9999]).toBe(999 % 256);
  });

  it.each([0, -1, Infinity, 2147483648])("rejects invalid timeout %s", async (timeoutMs) => {
    await expect(runtime().runtime.loadModel({ kind: "uint8-array", bytes: new Uint8Array(1) }, { fetchPolicy: { ...policy, timeoutMs } })).rejects.toThrow("timeoutMs");
  });

  it("cancels the body of a fetch that resolves after timeout", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const pending = fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy: { ...policy, timeoutMs: 5 } });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await new Promise((done) => setTimeout(done, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("inherits caller cancellation in package resources without a per-call signal", async () => {
    const controller = new AbortController();
    const resolver = new PackageResourceResolver({ sourceKind: "uint8-array", signal: controller.signal, fetch: async () => new Response(), hashBytes, sleep, package: { resources: { file: { bytes: new Uint8Array(1) } } } });
    controller.abort();
    await expect(resolver.resolve("file")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds HTTP body reads at their deadline", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(async () => new Response(body));
    await expect(fetchResource("https://example.test/file", { fetch, hashBytes, sleep, policy: { ...policy, timeoutMs: 5 } })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("handles an empty HTTP body", async () => {
    const result = await fetchResource("https://example.test/file", { fetch: async () => new Response(null, { status: 204 }), hashBytes, sleep, policy });
    expect(result.bytes.length).toBe(0);
  });
});

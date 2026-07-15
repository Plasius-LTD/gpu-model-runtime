import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  createModelCacheKey,
  defaultSleep,
  MemoryModelCache,
  ModelRuntime,
  sha256Hex,
  type AdapterRegistration,
  type ModelAdapter,
  verifyIntegrity,
} from "../src/index.js";

function deterministicHash(bytes: Uint8Array): Promise<string> {
  return Promise.resolve(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function createAdapter(loads: { count: number }): ModelAdapter<{ name: string }, { upload: string }> {
  return {
    formatId: "fixture",
    supportsWorker: true,
    sniff: ({ bytes }) => bytes[0] === 0x46,
    async load(input, context) {
      loads.count += 1;
      const texture = await input.resourceResolver.resolve("textures/albedo.bin", { signal: context.signal });
      return {
        canonicalModel: { name: new TextDecoder().decode(input.bytes) },
        rendererReady: { upload: Array.from(texture.bytes).join(",") },
      };
    },
  };
}

function createRegistration(adapter: ModelAdapter<{ name: string }, { upload: string }>): AdapterRegistration<{ name: string }, { upload: string }> {
  return {
    formatId: "fixture",
    extensions: ["fixture"],
    sniff: adapter.sniff,
    load: async () => adapter,
  };
}

describe("ModelRuntime", () => {
  it("provides deterministic cache keys, SHA-256 integrity, and abortable sleep", async () => {
    const cache = new MemoryModelCache();
    const firstKey = createModelCacheKey("hash", "fixture", { z: [2, 1], a: { b: true } });
    const secondKey = createModelCacheKey("hash", "fixture", { a: { b: true }, z: [2, 1] });
    expect(firstKey).toBe(secondKey);
    await cache.set(firstKey, { value: 1 });
    expect(await cache.get(firstKey)).toEqual({ value: 1 });
    expect(await cache.delete(firstKey)).toBe(true);
    expect(await cache.delete(firstKey)).toBe(false);
    await cache.clear();

    const digest = await sha256Hex(new Uint8Array([0x46]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/iu);
    await expect(defaultSleep(0)).resolves.toBeUndefined();
    const controller = new AbortController();
    const sleeping = defaultSleep(100, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
    await verifyIntegrity(new Uint8Array([0x46]), digest, sha256Hex);
  });

  it("resolves memory package resources, returns canonical and renderer-ready data, caches, and invalidates", async () => {
    const loads = { count: 0 };
    const registry = new AdapterRegistry().register(createRegistration(createAdapter(loads)));
    const runtime = new ModelRuntime({
      registry,
      dependencies: { hashBytes: deterministicHash },
    });
    const source = {
      kind: "uint8-array" as const,
      bytes: new Uint8Array([0x46, 0x31]),
      fileNameHint: "model.fixture",
      package: {
        resources: {
          "textures/albedo.bin": { bytes: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream" },
        },
      },
    };

    const first = await runtime.loadModel(source, { adapterOptions: { quality: "preview" } });
    const second = await runtime.loadModel(source, { adapterOptions: { quality: "preview" } });
    expect(first).toMatchObject({
      canonicalModel: { name: "F1" },
      rendererReady: { upload: "1,2,3" },
      fromCache: false,
      contentHash: "4631",
    });
    expect(second.fromCache).toBe(true);
    expect(loads.count).toBe(1);

    await runtime.invalidate(first.contentHash);
    const afterInvalidation = await runtime.loadModel(source, { adapterOptions: { quality: "preview" } });
    expect(afterInvalidation.fromCache).toBe(false);
    expect(loads.count).toBe(2);
  });

  it("uses content type, byte ranges, bounded retries, and relative URL resolution", async () => {
    const requests: RequestInit[] = [];
    let attempts = 0;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      attempts += 1;
      if (attempts === 1) return new Response("retry", { status: 503 });
      return new Response(new Uint8Array([0x46, 0x32]), {
        status: 206,
        headers: { "content-type": "model/fixture", "accept-ranges": "bytes" },
      });
    });
    const resourceRequests: string[] = [];
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      mimeTypes: ["model/fixture"],
      sniff: ({ bytes }) => bytes[0] === 0x46,
      load: async () => ({
        formatId: "fixture",
        async load(input) {
          const resource = await input.resourceResolver.resolve("textures/albedo.bin", {
            range: { start: 2, end: 4 },
          });
          return { canonicalModel: { name: `${input.contentHash}:${resource.contentHash}` } };
        },
        sniff: () => true,
      }),
    });
    const runtime = new ModelRuntime({
      registry,
      dependencies: {
        fetch: async (url, init) => {
          resourceRequests.push(String(url));
          return fetch(url, init);
        },
        hashBytes: deterministicHash,
        sleep: async () => undefined,
      },
    });

    const result = await runtime.loadModel({
      kind: "url",
      url: "https://cdn.example.test/models/model.fixture",
    }, { fetchPolicy: { maxAttempts: 2 }, useCache: false });

    expect(result.canonicalModel).toEqual({ name: "4632:4632" });
    expect(attempts).toBe(3);
    expect(resourceRequests).toEqual([
      "https://cdn.example.test/models/model.fixture",
      "https://cdn.example.test/models/model.fixture",
      "https://cdn.example.test/models/textures/albedo.bin",
    ]);
    expect(requests.at(-1)?.headers).toBeInstanceOf(Headers);
    expect((requests.at(-1)?.headers as Headers).get("Range")).toBe("bytes=2-4");
    expect(result.contentType).toBe("model/fixture");
  });

  it("delegates to a worker only when requested and supported", async () => {
    const workerDispatch = vi.fn(async (request) => ({
      canonicalModel: { name: request.context.execution },
    }));
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({
        formatId: "fixture",
        supportsWorker: true,
        sniff: () => true,
        load: async () => ({ canonicalModel: { name: "main" } }),
      }),
    });
    const runtime = new ModelRuntime({
      registry,
      workerDispatcher: { dispatch: workerDispatch },
      dependencies: { hashBytes: deterministicHash },
    });

    const result = await runtime.loadModel({ kind: "uint8-array", bytes: new Uint8Array([1]) }, {
      worker: { mode: "always" },
      useCache: false,
    });

    expect(result.canonicalModel).toEqual({ name: "worker" });
    expect(workerDispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when a file source has no file reader", async () => {
    const runtime = new ModelRuntime({ dependencies: { hashBytes: deterministicHash } });
    await expect(runtime.loadModel({ kind: "file-path", path: "/models/example.fixture" })).rejects.toThrow(
      "file-path sources require a readFile dependency",
    );
  });

  it("supports injected file readers without importing filesystem adapters", async () => {
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: ({ bytes }) => bytes[0] === 0x46,
      load: async () => ({
        formatId: "fixture",
        sniff: ({ bytes }) => bytes[0] === 0x46,
        load: async (input) => ({ canonicalModel: { bytes: Array.from(input.bytes) } }),
      }),
    });
    const runtime = new ModelRuntime({
      registry,
      dependencies: {
        readFile: async () => new Uint8Array([0x46, 0x33]),
        hashBytes: deterministicHash,
      },
    });

    await expect(runtime.loadModel({ kind: "file-path", path: "/models/example.fixture" })).resolves.toMatchObject({
      canonicalModel: { bytes: [0x46, 0x33] },
    });
  });

  it("rejects a mismatched source integrity value", async () => {
    const fetch = async () => new Response(new Uint8Array([0x46]), { headers: { "content-type": "model/fixture" } });
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      mimeTypes: ["model/fixture"],
      sniff: () => true,
      load: async () => ({
        formatId: "fixture",
        sniff: () => true,
        load: async () => ({ canonicalModel: true }),
      }),
    });
    const runtime = new ModelRuntime({
      registry,
      dependencies: { fetch, hashBytes: deterministicHash, sleep: async () => undefined },
    });

    await expect(runtime.loadModel({ kind: "url", url: "https://cdn.example.test/model.fixture" }, {
      integrity: "deadbeef",
    })).rejects.toThrow("Model resource integrity check failed");
  });

  it("does not retry non-transient HTTP errors or unsupported URL schemes", async () => {
    let attempts = 0;
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({ formatId: "fixture", sniff: () => true, load: async () => ({ canonicalModel: true }) }),
    });
    const runtime = new ModelRuntime({
      registry,
      dependencies: {
        fetch: async () => {
          attempts += 1;
          return new Response("missing", { status: 404 });
        },
        hashBytes: deterministicHash,
        sleep: async () => undefined,
      },
    });
    await expect(runtime.loadModel({ kind: "url", url: "https://cdn.example.test/missing.fixture" })).rejects.toThrow("HTTP 404");
    expect(attempts).toBe(1);
    await expect(runtime.loadModel({ kind: "url", url: "data:text/plain,not-a-model" })).rejects.toThrow("Unsupported model resource URL scheme");
  });

  it("reads Blob, ArrayBuffer, async iterable, and ReadableStream sources", async () => {
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({
        formatId: "fixture",
        sniff: () => true,
        load: async (input) => ({ canonicalModel: Array.from(input.bytes) }),
      }),
    });
    const runtime = new ModelRuntime({ registry, dependencies: { hashBytes: deterministicHash } });
    const sources = [
      { kind: "blob" as const, blob: new Blob([new Uint8Array([1, 2])]) },
      { kind: "array-buffer" as const, bytes: new Uint8Array([3, 4]).buffer },
      { kind: "stream" as const, stream: (async function* () { yield new Uint8Array([5]); yield new Uint8Array([6]); })() },
      {
        kind: "stream" as const,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([7, 8]));
            controller.close();
          },
        }),
      },
    ];

    await expect(runtime.loadModel(sources[0], { useCache: false })).resolves.toMatchObject({ canonicalModel: [1, 2] });
    await expect(runtime.loadModel(sources[1], { useCache: false })).resolves.toMatchObject({ canonicalModel: [3, 4] });
    await expect(runtime.loadModel(sources[2], { useCache: false })).resolves.toMatchObject({ canonicalModel: [5, 6] });
    await expect(runtime.loadModel(sources[3], { useCache: false })).resolves.toMatchObject({ canonicalModel: [7, 8] });
  });

  it("resolves Blob-storage resources through an injected URL resolver and rejects package traversal", async () => {
    const resourceUrls: string[] = [];
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({
        formatId: "fixture",
        sniff: () => true,
        load: async (input) => {
          const resource = await input.resourceResolver.resolve("textures/albedo.bin");
          await expect(input.resourceResolver.resolve("../../secrets.txt")).rejects.toThrow("escapes its package");
          return { canonicalModel: Array.from(resource.bytes) };
        },
      }),
    });
    const runtime = new ModelRuntime({
      registry,
      dependencies: {
        fetch: async (url) => {
          resourceUrls.push(String(url));
          return new Response(new Uint8Array([9]), { headers: { "content-type": "application/octet-stream" } });
        },
        hashBytes: deterministicHash,
        blobStorageUrlResolver: (base, reference) => `${base.split("?")[0]}/${reference}?signed=1`,
      },
    });

    await expect(runtime.loadModel({
      kind: "blob-storage-url",
      url: "https://storage.example.test/models/scene.glb?token=redacted",
    }, { useCache: false })).resolves.toMatchObject({ canonicalModel: [9] });
    expect(resourceUrls).toEqual([
      "https://storage.example.test/models/scene.glb?token=redacted",
      "https://storage.example.test/models/scene.glb/textures/albedo.bin?signed=1",
    ]);
  });

  it("handles explicit adapter selection, no-match errors, duplicate registrations, and cache clearing", async () => {
    const adapter = {
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({ canonicalModel: true }),
    } satisfies ModelAdapter<boolean>;
    const registry = new AdapterRegistry().register({ formatId: "fixture", load: async () => adapter });
    expect(() => registry.register({ formatId: "fixture", load: async () => adapter })).toThrow("already registered");
    const runtime = new ModelRuntime({ registry, dependencies: { hashBytes: deterministicHash } });
    await expect(runtime.loadModel({ kind: "uint8-array", bytes: new Uint8Array([1]) }, { formatId: "fixture" })).resolves.toMatchObject({
      canonicalModel: true,
    });
    await expect(new ModelRuntime({ dependencies: { hashBytes: deterministicHash } }).loadModel({
      kind: "uint8-array",
      bytes: new Uint8Array([1]),
    })).rejects.toThrow("No model adapter matched");
    await runtime.invalidate();
  });

  it("fails closed for mandatory worker execution when no compatible worker exists", async () => {
    const registry = new AdapterRegistry().register({
      formatId: "fixture",
      sniff: () => true,
      load: async () => ({
        formatId: "fixture",
        supportsWorker: false,
        sniff: () => true,
        load: async () => ({ canonicalModel: true }),
      }),
    });
    const runtime = new ModelRuntime({ registry, dependencies: { hashBytes: deterministicHash } });
    await expect(runtime.loadModel({ kind: "uint8-array", bytes: new Uint8Array([1]) }, {
      worker: { mode: "always" },
    })).rejects.toThrow("does not support the requested worker execution");
  });
});

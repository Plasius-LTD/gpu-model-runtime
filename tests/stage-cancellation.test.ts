import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry, MemoryModelCache, ModelRuntime } from "../src/index.js";
import type { ModelAdapter, ModelLoadResult, WorkerDispatcher } from "../src/index.js";

const source = () => ({ kind: "uint8-array" as const, bytes: new Uint8Array([1]), fileNameHint: "model.fixture" });
const registry = (load: ModelAdapter<number[]>["load"]) => new AdapterRegistry().register({
  formatId: "fixture", extensions: ["fixture"], load: async () => ({ formatId: "fixture", supportsWorker: true, sniff: () => true, load }),
});

describe("runtime cancellation stage boundaries", () => {
  it("rejects pre-aborted input before registration and hides abort reasons", async () => {
    const parse = vi.fn(async () => ({ canonicalModel: [] }));
    const parent = new AbortController(); parent.abort("synthetic-private-reason");
    await expect(new ModelRuntime({ registry: registry(parse) }).loadModel(source(), { signal: parent.signal }))
      .rejects.toMatchObject({ name: "AbortError", message: "The model load was aborted" });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not return a late cache result or parse after abort (cache hit: %s)", async (hit) => {
    const gate = Promise.withResolvers<ModelLoadResult<unknown> | undefined>();
    const entered = Promise.withResolvers<void>();
    const cache = new MemoryModelCache();
    vi.spyOn(cache, "get").mockImplementation(() => { entered.resolve(); return gate.promise as Promise<undefined>; });
    const write = vi.spyOn(cache, "set");
    const parse = vi.fn(async () => ({ canonicalModel: [] }));
    const parent = new AbortController();
    const pending = new ModelRuntime({ registry: registry(parse), cache }).loadModel(source(), { signal: parent.signal });
    const outcome = pending.catch((error: unknown) => error);
    await entered.promise; parent.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    gate.resolve(hit ? { canonicalModel: [], contentHash: "hash", cacheKey: "key", fromCache: false, sourceKind: "uint8-array" } : undefined);
    await gate.promise;
    expect(parse).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it.each(["main", "worker"] as const)("does not cache a late %s producer result after abort", async (execution) => {
    const gate = Promise.withResolvers<{ canonicalModel: number[] }>();
    const entered = Promise.withResolvers<void>();
    const produce = vi.fn(() => { entered.resolve(); return gate.promise; });
    const cache = new MemoryModelCache(); const write = vi.spyOn(cache, "set");
    const runtime = new ModelRuntime({ registry: registry(produce), cache,
      workerDispatcher: execution === "worker" ? { dispatch: produce as unknown as WorkerDispatcher["dispatch"] } : undefined });
    const parent = new AbortController();
    const pending = runtime.loadModel(source(), { signal: parent.signal }).catch((error: unknown) => error);
    await entered.promise; parent.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    gate.resolve({ canonicalModel: [1] });
    await gate.promise;
    expect(produce).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  });

  it("stops waiting for a cache write already owned by the host", async () => {
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const cache = new MemoryModelCache();
    const write = vi.spyOn(cache, "set").mockImplementation(() => { entered.resolve(); return gate.promise; });
    const parent = new AbortController();
    const runtime = new ModelRuntime({ cache, registry: registry(async () => ({ canonicalModel: [] })) });
    const pending = runtime.loadModel(source(), { signal: parent.signal }).catch((error: unknown) => error);
    await entered.promise; parent.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    gate.resolve(); await gate.promise;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("retains ordinary adapter failures and healthy cache reuse", async () => {
    const failure = new Error("synthetic adapter failure");
    await expect(new ModelRuntime({ registry: registry(async () => { throw failure; }) }).loadModel(source())).rejects.toBe(failure);
    const parse = vi.fn(async () => ({ canonicalModel: [1] }));
    const runtime = new ModelRuntime({ registry: registry(parse) });
    expect((await runtime.loadModel(source())).fromCache).toBe(false);
    expect((await runtime.loadModel(source())).fromCache).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

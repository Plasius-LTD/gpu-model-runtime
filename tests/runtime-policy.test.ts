import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry, MemoryModelCache, ModelRuntime,
  type AdapterLoadResult, type ModelAdapter, type WorkerDispatcher,
} from "../src/index.js";

const source = { kind: "uint8-array" as const, bytes: new Uint8Array([1]) };

function registry(adapter: ModelAdapter<unknown>): AdapterRegistry {
  return new AdapterRegistry().register({ formatId: adapter.formatId, sniff: () => true, load: async () => adapter });
}

describe("runtime policy identity", () => {
  it("does not let tolerant or forensic cache entries bypass strict rejection", async () => {
    const load = vi.fn(async (_input, context) => {
      if (context.mode === "strict") throw new Error("Fixture requires repair");
      return { canonicalModel: context.mode, diagnostics: [{ mode: context.mode }] };
    }) satisfies ModelAdapter<unknown>["load"];
    const runtime = new ModelRuntime({ registry: registry({ formatId: "fixture", sniff: () => true, load }) });
    const tolerant = await runtime.loadModel(source, { mode: "tolerant" });
    const forensic = await runtime.loadModel(source, { mode: "forensic" });
    expect(forensic).toMatchObject({ canonicalModel: "forensic", diagnostics: [{ mode: "forensic" }], fromCache: false });
    expect(forensic.cacheKey).not.toBe(tolerant.cacheKey);
    await expect(runtime.loadModel(source)).rejects.toThrow("Fixture requires repair");
    await expect(runtime.loadModel(source, { mode: "strict" })).rejects.toThrow("Fixture requires repair");
    const cached = await runtime.loadModel(source, { mode: "tolerant" });
    expect(cached).toMatchObject({ diagnostics: tolerant.diagnostics, fromCache: true });
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("separates actual main/worker execution while sharing equivalent auto/always results", async () => {
    const load = vi.fn(async () => ({ canonicalModel: "main" }));
    const dispatch = vi.fn(async () => ({ canonicalModel: "worker" }));
    const runtime = new ModelRuntime({
      registry: registry({ formatId: "fixture", supportsWorker: true, sniff: () => true, load }),
      workerDispatcher: { dispatch: dispatch as WorkerDispatcher["dispatch"] },
    });
    const main = await runtime.loadModel(source, { worker: { mode: "never" } });
    const worker = await runtime.loadModel(source, { worker: { mode: "always" } });
    expect(main.canonicalModel).toBe("main");
    expect(worker).toMatchObject({ canonicalModel: "worker", fromCache: false });
    expect(worker.cacheKey).not.toBe(main.cacheKey);
    await expect(runtime.loadModel(source)).resolves.toMatchObject({ canonicalModel: "worker", fromCache: true });
    await expect(runtime.loadModel(source, { worker: { mode: "never" } })).resolves.toMatchObject({ canonicalModel: "main", fromCache: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("validates mandatory worker support before a shared cache hit (supportsWorker=%s)", async supportsWorker => {
    const cache = new MemoryModelCache();
    const adapter = { formatId: "fixture", supportsWorker, sniff: () => true, load: async () => ({ canonicalModel: "main" }) };
    const first = new ModelRuntime({ cache, registry: registry(adapter) });
    const main = await first.loadModel(source, { worker: { mode: "never" } });
    const second = new ModelRuntime({ cache, registry: registry(adapter) });
    await expect(second.loadModel(source, { worker: { mode: "always" } })).rejects.toThrow("does not support the requested worker execution");
    await expect(second.loadModel(source)).resolves.toMatchObject({ cacheKey: main.cacheKey, fromCache: true });
  });

  it("does not reuse another runtime's worker cache when no dispatcher exists", async () => {
    const cache = new MemoryModelCache();
    const adapter = { formatId: "fixture", supportsWorker: true, sniff: () => true, load: async () => ({ canonicalModel: "main" }) };
    const first = new ModelRuntime({ cache, registry: registry(adapter), workerDispatcher: {
      async dispatch<T, R>(): Promise<AdapterLoadResult<T, R>> { return { canonicalModel: "worker" as T }; },
    } });
    await first.loadModel(source, { worker: { mode: "always" } });
    const second = new ModelRuntime({ cache, registry: registry(adapter) });
    await expect(second.loadModel(source, { worker: { mode: "always" } })).rejects.toThrow("does not support the requested worker execution");
    await expect(second.loadModel(source)).resolves.toMatchObject({ canonicalModel: "main", fromCache: false });
  });
});

import {
  MODEL_RESOLUTION_CONTRACT_VERSION,
  type ModelAssetRef,
} from "@plasius/asset-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ModelResidencyManager,
  createModelResidencyKey,
  type ModelLoadRequest,
  type ModelLoadedResource,
} from "../src/index.js";

interface TestResource {
  readonly id: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assetRef(seed: string): ModelAssetRef {
  const contentHash = seed.repeat(64).slice(0, 64);
  return {
    contractVersion: MODEL_RESOLUTION_CONTRACT_VERSION,
    assetId: `model-${seed}`,
    version: "1.0.0",
    kind: "leaf",
    contentHash,
    runtimeManifestUri: `mcp://models/catalog/model-${seed}/versions/1.0.0/manifest`,
  };
}

function loaded(
  ref: ModelAssetRef,
  id: string,
  dispose: () => void,
  cpuBytes = 16,
  gpuBytes = 24,
): ModelLoadedResource<TestResource> {
  return {
    contentHash: ref.contentHash,
    resource: { id },
    cpuBytes,
    gpuBytes,
    dispose,
  };
}

function acquireOptions(
  ref: ModelAssetRef,
  overrides: Partial<{
    lod: 0 | 1 | 2 | 3;
    partitionId: string;
    priority: number;
    estimatedCpuBytes: number;
    estimatedGpuBytes: number;
    signal: AbortSignal;
    pinned: boolean;
  }> = {},
) {
  return {
    assetRef: ref,
    lod: overrides.lod ?? 0,
    priority: overrides.priority ?? 1,
    estimatedCpuBytes: overrides.estimatedCpuBytes ?? 16,
    estimatedGpuBytes: overrides.estimatedGpuBytes ?? 24,
    ...(overrides.partitionId === undefined
      ? {}
      : { partitionId: overrides.partitionId }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.pinned === undefined ? {} : { pinned: overrides.pinned }),
  };
}

describe("ModelResidencyManager", () => {
  it("builds content-addressed keys from hash, LOD, and partition identity", () => {
    const ref = assetRef("a");
    expect(createModelResidencyKey(ref, 2)).toBe(`${ref.contentHash}:lod2:whole`);
    expect(createModelResidencyKey(ref, 2, "cell-4-7")).toBe(
      `${ref.contentHash}:lod2:cell-4-7`,
    );
    expect(() => createModelResidencyKey({ ...ref, contentHash: "ABC" }, 0)).toThrow(
      /SHA-256/,
    );
    expect(() => createModelResidencyKey(ref, 0, "../unsafe")).toThrow(/partitionId/);
    expect(() => createModelResidencyKey(ref, 4 as 0)).toThrow(/lod/);
  });

  it("forwards partition identity through loading and the acquired lease", async () => {
    const ref = assetRef("a0");
    const load = vi.fn(async (request: ModelLoadRequest) =>
      loaded(ref, request.partitionId ?? "missing", vi.fn()),
    );
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load,
    });

    const lease = await manager.acquire(
      acquireOptions(ref, { partitionId: "cell-4-7" }),
    );
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ partitionId: "cell-4-7" }),
    );
    expect(lease.partitionId).toBe("cell-4-7");
    expect(lease.resource.id).toBe("cell-4-7");
    lease.release();
    await manager.shutdown();
  });

  it("deduplicates concurrent loads and reference-counts idempotent leases", async () => {
    const ref = assetRef("b");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    const dispose = vi.fn();
    const load = vi.fn(() => gate.promise);
    const manager = new ModelResidencyManager({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 2 },
      load,
    });

    const firstPromise = manager.acquire(acquireOptions(ref));
    const secondPromise = manager.acquire(acquireOptions(ref, { priority: 5 }));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    gate.resolve(loaded(ref, "shared", dispose));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.resource).toBe(second.resource);
    expect(manager.snapshot()).toMatchObject({
      residentCount: 1,
      referenceCount: 2,
      loadsStarted: 1,
      deduplicatedAcquires: 1,
    });

    first.release();
    first.release();
    expect(manager.snapshot().referenceCount).toBe(1);
    second.release();
    await manager.evictUnused();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().residentCount).toBe(0);
  });

  it("keeps a shared load alive when only one interested caller aborts", async () => {
    const ref = assetRef("c");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    let loaderSignal: AbortSignal | undefined;
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: (request) => {
        loaderSignal = request.signal;
        return gate.promise;
      },
    });
    const firstAbort = new AbortController();

    const first = manager.acquire(
      acquireOptions(ref, { signal: firstAbort.signal }),
    );
    const second = manager.acquire(acquireOptions(ref));
    firstAbort.abort();

    await expect(first).rejects.toMatchObject({ code: "acquire-aborted" });
    expect(loaderSignal?.aborted).toBe(false);
    gate.resolve(loaded(ref, "survivor", vi.fn()));
    const lease = await second;
    expect(lease.resource.id).toBe("survivor");
    lease.release();
    await manager.shutdown();
  });

  it("aborts an unwanted shared load and disposes a late result exactly once", async () => {
    const ref = assetRef("d");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    const dispose = vi.fn();
    let loaderSignal: AbortSignal | undefined;
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: (request) => {
        loaderSignal = request.signal;
        return gate.promise;
      },
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = manager.acquire(
      acquireOptions(ref, { signal: firstAbort.signal }),
    );
    const second = manager.acquire(
      acquireOptions(ref, { signal: secondAbort.signal }),
    );

    await vi.waitFor(() => expect(loaderSignal).toBeDefined());
    firstAbort.abort();
    secondAbort.abort();
    await expect(first).rejects.toMatchObject({ code: "acquire-aborted" });
    await expect(second).rejects.toMatchObject({ code: "acquire-aborted" });
    expect(loaderSignal?.aborted).toBe(true);

    gate.resolve(loaded(ref, "late", dispose));
    await manager.waitForIdle();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({ residentCount: 0, pendingCount: 0 });
    await manager.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("removes queued cancellations and rejects remaining queued work on shutdown", async () => {
    const activeRef = assetRef("d1");
    const cancelledRef = assetRef("d2");
    const shutdownRef = assetRef("d3");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    const activeDispose = vi.fn();
    const load = vi.fn(() => gate.promise);
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load,
    });
    const queuedAbort = new AbortController();

    const active = manager.acquire(acquireOptions(activeRef));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const cancelled = manager.acquire(
      acquireOptions(cancelledRef, { signal: queuedAbort.signal }),
    );
    await vi.waitFor(() => expect(manager.snapshot().queuedLoads).toBe(1));
    queuedAbort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "acquire-aborted" });
    expect(manager.snapshot()).toMatchObject({ inFlightLoads: 1, queuedLoads: 0 });

    const queuedAtShutdown = manager.acquire(acquireOptions(shutdownRef));
    await vi.waitFor(() => expect(manager.snapshot().queuedLoads).toBe(1));
    const shutdown = manager.shutdown();
    await expect(active).rejects.toMatchObject({ code: "manager-closed" });
    await expect(queuedAtShutdown).rejects.toMatchObject({ code: "manager-closed" });
    gate.resolve(loaded(activeRef, "late-active", activeDispose));
    await shutdown;

    expect(load).toHaveBeenCalledTimes(1);
    expect(activeDispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({ pendingCount: 0, queuedLoads: 0 });
  });

  it("does not retain failures and permits a later acquisition to retry", async () => {
    const ref = assetRef("e");
    const dispose = vi.fn();
    let attempt = 0;
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network unavailable");
        return loaded(ref, "retry", dispose);
      },
    });

    await expect(manager.acquire(acquireOptions(ref))).rejects.toThrow(
      "network unavailable",
    );
    expect(manager.snapshot().residentCount).toBe(0);
    const lease = await manager.acquire(acquireOptions(ref));
    expect(lease.resource.id).toBe("retry");
    expect(attempt).toBe(2);
    lease.release();
    await manager.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects hash-mismatched loads after disposing their resource", async () => {
    const ref = assetRef("f");
    const dispose = vi.fn();
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: async () => ({
        ...loaded(ref, "corrupt", dispose),
        contentHash: "0".repeat(64),
      }),
    });

    await expect(manager.acquire(acquireOptions(ref))).rejects.toMatchObject({
      code: "content-hash-mismatch",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot().residentCount).toBe(0);
  });

  it("disposes an underestimated result that cannot fit the hard budget", async () => {
    const ref = assetRef("f1");
    const dispose = vi.fn();
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 64, maxGpuBytes: 64, maxInFlightLoads: 1 },
      load: async () => loaded(ref, "oversize", dispose, 80, 32),
    });

    await expect(
      manager.acquire(
        acquireOptions(ref, {
          estimatedCpuBytes: 16,
          estimatedGpuBytes: 16,
        }),
      ),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({
      cpuBytes: 0,
      gpuBytes: 0,
      residentCount: 0,
      pendingCount: 0,
    });
  });

  it("evicts lowest-priority, least-recent unreferenced entries within hard budgets", async () => {
    const disposed: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 100, maxGpuBytes: 100, maxInFlightLoads: 2 },
      load: async ({ assetRef }) =>
        loaded(assetRef, assetRef.assetId, () => disposed.push(assetRef.assetId), 40, 40),
    });
    const high = assetRef("1");
    const low = assetRef("2");
    const incoming = assetRef("3");

    const highLease = await manager.acquire(
      acquireOptions(high, { priority: 8, estimatedCpuBytes: 40, estimatedGpuBytes: 40 }),
    );
    highLease.release();
    const lowLease = await manager.acquire(
      acquireOptions(low, { priority: 1, estimatedCpuBytes: 40, estimatedGpuBytes: 40 }),
    );
    lowLease.release();
    const incomingLease = await manager.acquire(
      acquireOptions(incoming, {
        priority: 10,
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );

    expect(disposed).toEqual([low.assetId]);
    expect(manager.snapshot()).toMatchObject({ cpuBytes: 80, gpuBytes: 80 });
    expect(manager.snapshot().residentKeys).toEqual([
      createModelResidencyKey(high, 0),
      createModelResidencyKey(incoming, 0),
    ]);
    incomingLease.release();
    await manager.shutdown();
    expect(new Set(disposed)).toEqual(
      new Set([low.assetId, high.assetId, incoming.assetId]),
    );
  });

  it("uses least-recent residency when eviction priorities are equal", async () => {
    const disposed: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 80, maxGpuBytes: 80, maxInFlightLoads: 1 },
      load: async ({ assetRef: ref }) =>
        loaded(ref, ref.assetId, () => disposed.push(ref.assetId), 40, 40),
    });
    const oldest = assetRef("31");
    const newest = assetRef("32");
    const incoming = assetRef("33");

    const oldestLease = await manager.acquire(
      acquireOptions(oldest, { estimatedCpuBytes: 40, estimatedGpuBytes: 40 }),
    );
    oldestLease.release();
    const newestLease = await manager.acquire(
      acquireOptions(newest, { estimatedCpuBytes: 40, estimatedGpuBytes: 40 }),
    );
    newestLease.release();
    const incomingLease = await manager.acquire(
      acquireOptions(incoming, { estimatedCpuBytes: 40, estimatedGpuBytes: 40 }),
    );

    expect(disposed).toEqual([oldest.assetId]);
    incomingLease.release();
    await manager.shutdown();
  });

  it("awaits async eviction disposal before starting a replacement load", async () => {
    const resident = assetRef("34");
    const replacement = assetRef("35");
    const disposal = deferred<void>();
    const starts: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 40, maxGpuBytes: 40, maxInFlightLoads: 1 },
      load: async ({ assetRef: ref }) => {
        starts.push(ref.assetId);
        return loaded(
          ref,
          ref.assetId,
          ref.contentHash === resident.contentHash
            ? () => disposal.promise
            : vi.fn(),
          40,
          40,
        );
      },
    });

    const residentLease = await manager.acquire(
      acquireOptions(resident, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );
    residentLease.release();
    const replacementAcquire = manager.acquire(
      acquireOptions(replacement, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );
    await vi.waitFor(() => expect(manager.snapshot().disposals).toBe(1));
    expect(starts).toEqual([resident.assetId]);
    expect(manager.snapshot().inFlightLoads).toBe(0);

    disposal.resolve();
    const replacementLease = await replacementAcquire;
    expect(starts).toEqual([resident.assetId, replacement.assetId]);
    replacementLease.release();
    await manager.shutdown();
  });

  it("cancels admission after an async eviction when its signal aborts", async () => {
    const resident = assetRef("36");
    const replacement = assetRef("37");
    const disposal = deferred<void>();
    const abort = new AbortController();
    const starts: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 40, maxGpuBytes: 40, maxInFlightLoads: 1 },
      load: async ({ assetRef: ref }) => {
        starts.push(ref.assetId);
        return loaded(
          ref,
          ref.assetId,
          ref.contentHash === resident.contentHash
            ? () => disposal.promise
            : vi.fn(),
          40,
          40,
        );
      },
    });
    const residentLease = await manager.acquire(
      acquireOptions(resident, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );
    residentLease.release();
    const replacementAcquire = manager.acquire(
      acquireOptions(replacement, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
        signal: abort.signal,
      }),
    );
    await vi.waitFor(() => expect(manager.snapshot().disposals).toBe(1));
    abort.abort();
    disposal.resolve();

    await expect(replacementAcquire).rejects.toMatchObject({
      code: "acquire-aborted",
    });
    expect(starts).toEqual([resident.assetId]);
    await manager.shutdown();
  });

  it("fails admission closed after shutdown interrupts an async eviction", async () => {
    const resident = assetRef("38");
    const replacement = assetRef("39");
    const disposal = deferred<void>();
    const load = vi.fn(async ({ assetRef: ref }: ModelLoadRequest) =>
      loaded(
        ref,
        ref.assetId,
        ref.contentHash === resident.contentHash
          ? () => disposal.promise
          : vi.fn(),
        40,
        40,
      ),
    );
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 40, maxGpuBytes: 40, maxInFlightLoads: 1 },
      load,
    });
    const residentLease = await manager.acquire(
      acquireOptions(resident, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );
    residentLease.release();
    const replacementAcquire = manager.acquire(
      acquireOptions(replacement, {
        estimatedCpuBytes: 40,
        estimatedGpuBytes: 40,
      }),
    );
    await vi.waitFor(() => expect(manager.snapshot().disposals).toBe(1));
    const shutdown = manager.shutdown();
    disposal.resolve();

    await expect(replacementAcquire).rejects.toMatchObject({
      code: "manager-closed",
    });
    await shutdown;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never evicts referenced or pinned entries to admit an over-budget load", async () => {
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 64, maxGpuBytes: 64, maxInFlightLoads: 1 },
      load: async ({ assetRef }) => loaded(assetRef, assetRef.assetId, vi.fn(), 48, 48),
    });
    const held = await manager.acquire(
      acquireOptions(assetRef("4"), {
        pinned: true,
        estimatedCpuBytes: 48,
        estimatedGpuBytes: 48,
      }),
    );

    await expect(
      manager.acquire(
        acquireOptions(assetRef("5"), {
          estimatedCpuBytes: 32,
          estimatedGpuBytes: 32,
        }),
      ),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(manager.snapshot()).toMatchObject({ residentCount: 1, referenceCount: 1 });
    held.setPinned(false);
    held.release();
    await manager.shutdown();
  });

  it("bounds in-flight work and starts queued loads by current priority", async () => {
    const refs = [assetRef("6"), assetRef("7"), assetRef("8")];
    const gates = refs.map(() => deferred<ModelLoadedResource<TestResource>>());
    const starts: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 256, maxGpuBytes: 256, maxInFlightLoads: 1 },
      load: (request: ModelLoadRequest) => {
        const index = refs.findIndex(
          (candidate) => candidate.contentHash === request.assetRef.contentHash,
        );
        starts.push(request.assetRef.assetId);
        return gates[index]!.promise;
      },
    });

    const first = manager.acquire(acquireOptions(refs[0]!));
    const low = manager.acquire(acquireOptions(refs[1]!, { priority: 1 }));
    const high = manager.acquire(acquireOptions(refs[2]!, { priority: 9 }));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts).toEqual([refs[0]!.assetId]);
    expect(manager.snapshot()).toMatchObject({ inFlightLoads: 1, queuedLoads: 2 });

    gates[0]!.resolve(loaded(refs[0]!, "first", vi.fn()));
    const firstLease = await first;
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]).toBe(refs[2]!.assetId);
    gates[2]!.resolve(loaded(refs[2]!, "high", vi.fn()));
    const highLease = await high;
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2]).toBe(refs[1]!.assetId);
    gates[1]!.resolve(loaded(refs[1]!, "low", vi.fn()));
    const lowLease = await low;

    firstLease.release();
    highLease.release();
    lowLease.release();
    await manager.shutdown();
  });

  it("keeps insertion order for queued loads with equal priority", async () => {
    const refs = [assetRef("81"), assetRef("82"), assetRef("83")];
    const gates = refs.map(() => deferred<ModelLoadedResource<TestResource>>());
    const starts: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 256, maxGpuBytes: 256, maxInFlightLoads: 1 },
      load: ({ assetRef: ref }) => {
        const index = refs.findIndex(
          (candidate) => candidate.contentHash === ref.contentHash,
        );
        starts.push(ref.assetId);
        return gates[index]!.promise;
      },
    });
    const acquisitions = refs.map((ref) =>
      manager.acquire(acquireOptions(ref, { priority: 4 })),
    );
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    gates[0]!.resolve(loaded(refs[0]!, "first", vi.fn()));
    const first = await acquisitions[0]!;
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]).toBe(refs[1]!.assetId);
    gates[1]!.resolve(loaded(refs[1]!, "second", vi.fn()));
    const second = await acquisitions[1]!;
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    gates[2]!.resolve(loaded(refs[2]!, "third", vi.fn()));
    const third = await acquisitions[2]!;

    first.release();
    second.release();
    third.release();
    await manager.shutdown();
  });

  it("times out loaders, aborts them, and disposes ignored late completion", async () => {
    const ref = assetRef("9");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    const lateDispose = vi.fn();
    const retryDispose = vi.fn();
    let loaderSignal: AbortSignal | undefined;
    let attempt = 0;
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      loadTimeoutMs: 10,
      load: ({ signal }) => {
        attempt += 1;
        loaderSignal = signal;
        return attempt === 1
          ? gate.promise
          : Promise.resolve(loaded(ref, "retry", retryDispose));
      },
    });

    const acquisition = manager.acquire(acquireOptions(ref));
    await expect(acquisition).rejects.toMatchObject({ code: "load-timeout" });
    expect(loaderSignal?.aborted).toBe(true);
    expect(manager.snapshot().inFlightLoads).toBe(0);
    const retryLease = await manager.acquire(acquireOptions(ref));
    expect(retryLease.resource.id).toBe("retry");
    await manager.waitForIdle();
    gate.resolve(loaded(ref, "too-late", lateDispose));
    await vi.waitFor(() => expect(lateDispose).toHaveBeenCalledTimes(1));
    retryLease.release();
    await manager.shutdown();
    expect(retryDispose).toHaveBeenCalledTimes(1);
  });

  it("does not double-count a timeout or failure after an aborted load", async () => {
    const ref = assetRef("90");
    const gate = deferred<ModelLoadedResource<TestResource>>();
    const abort = new AbortController();
    const load = vi.fn(() => gate.promise);
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      loadTimeoutMs: 1_000,
      load,
    });

    const acquisition = manager.acquire(
      acquireOptions(ref, { signal: abort.signal }),
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(acquisition).rejects.toMatchObject({ code: "acquire-aborted" });
    await manager.shutdown();
    gate.reject(new Error("late adapter failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.snapshot()).toMatchObject({
      loadsAborted: 1,
      loadsTimedOut: 0,
      loadsFailed: 0,
    });
  });

  it("fails closed for pre-aborted acquisitions and a shut down manager", async () => {
    const ref = assetRef("91");
    const load = vi.fn(async () => loaded(ref, "unused", vi.fn()));
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load,
    });
    const abort = new AbortController();
    abort.abort();

    await expect(
      manager.acquire(acquireOptions(ref, { signal: abort.signal })),
    ).rejects.toMatchObject({ code: "acquire-aborted" });
    await expect(
      manager.acquire(acquireOptions(ref, { priority: -1 })),
    ).rejects.toThrow(/priority/);
    await expect(
      manager.acquire(
        acquireOptions(ref, {
          estimatedCpuBytes: -1,
        }),
      ),
    ).rejects.toThrow(/estimatedCpuBytes/);
    expect(load).not.toHaveBeenCalled();
    await manager.shutdown();
    await expect(manager.acquire(acquireOptions(ref))).rejects.toMatchObject({
      code: "manager-closed",
    });
  });

  it("rejects an admission when shutdown wins the initial scheduling turn", async () => {
    const ref = assetRef("911");
    const load = vi.fn(async () => loaded(ref, "unused", vi.fn()));
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load,
    });

    const acquisition = manager.acquire(acquireOptions(ref));
    const shutdown = manager.shutdown();
    await expect(acquisition).rejects.toMatchObject({ code: "manager-closed" });
    await shutdown;
    expect(load).not.toHaveBeenCalled();
  });

  it("validates hard limits and records disposer failures without retrying disposal", async () => {
    expect(
      () =>
        new ModelResidencyManager<TestResource>({
          budget: { maxCpuBytes: 0, maxGpuBytes: 1, maxInFlightLoads: 1 },
          load: async () => {
            throw new Error("unused");
          },
        }),
    ).toThrow(/maxCpuBytes/);

    const ref = assetRef("92");
    const dispose = vi.fn(() => {
      throw new Error("device already lost");
    });
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: async () => loaded(ref, "dispose-failure", dispose),
    });
    const lease = await manager.acquire(acquireOptions(ref));
    lease.release();
    await manager.evictUnused();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({ disposals: 1, disposalFailures: 1 });
    await manager.shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects a reservation larger than one hard budget before loading", async () => {
    const ref = assetRef("93");
    const load = vi.fn(async () => loaded(ref, "never-loaded", vi.fn()));
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 64, maxGpuBytes: 64, maxInFlightLoads: 1 },
      load,
    });

    await expect(
      manager.acquire(
        acquireOptions(ref, {
          estimatedCpuBytes: 65,
          estimatedGpuBytes: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(load).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("rejects malformed adapter results and synchronous loader failures", async () => {
    const refs = [assetRef("94"), assetRef("95"), assetRef("96")];
    const dispose = vi.fn();
    let attempt = 0;
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("synchronous adapter failure");
        if (attempt === 2) {
          return Promise.resolve(
            null as unknown as ModelLoadedResource<TestResource>,
          );
        }
        return Promise.resolve({
          resource: { id: "missing-disposer" },
          contentHash: refs[2]!.contentHash,
          cpuBytes: 1,
          gpuBytes: 1,
        } as unknown as ModelLoadedResource<TestResource>);
      },
    });

    await expect(manager.acquire(acquireOptions(refs[0]!))).rejects.toThrow(
      "synchronous adapter failure",
    );
    await expect(manager.acquire(acquireOptions(refs[1]!))).rejects.toMatchObject({
      code: "invalid-load-result",
    });
    await expect(manager.acquire(acquireOptions(refs[2]!))).rejects.toMatchObject({
      code: "invalid-load-result",
    });
    expect(manager.snapshot()).toMatchObject({
      residentCount: 0,
      loadsFailed: 3,
      disposals: 2,
      disposalFailures: 2,
    });
    expect(dispose).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("evicts a cached model when actual replacement bytes exceed its estimate", async () => {
    const cached = assetRef("97");
    const replacement = assetRef("98");
    const disposed: string[] = [];
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 100, maxGpuBytes: 100, maxInFlightLoads: 1 },
      load: async ({ assetRef: ref }) =>
        ref.contentHash === cached.contentHash
          ? loaded(ref, "cached", () => disposed.push("cached"), 60, 60)
          : loaded(ref, "replacement", () => disposed.push("replacement"), 50, 50),
    });

    const cachedLease = await manager.acquire(
      acquireOptions(cached, {
        estimatedCpuBytes: 60,
        estimatedGpuBytes: 60,
      }),
    );
    cachedLease.release();
    const replacementLease = await manager.acquire(
      acquireOptions(replacement, {
        estimatedCpuBytes: 30,
        estimatedGpuBytes: 30,
      }),
    );

    expect(disposed).toEqual(["cached"]);
    expect(manager.snapshot()).toMatchObject({ cpuBytes: 50, gpuBytes: 50 });
    replacementLease.release();
    await manager.shutdown();
    expect(disposed).toEqual(["cached", "replacement"]);
  });

  it("updates lease priority and pin state without allowing stale lease mutations", async () => {
    const ref = assetRef("0");
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 128, maxGpuBytes: 128, maxInFlightLoads: 1 },
      load: async () => loaded(ref, "mutable-lease", vi.fn()),
    });
    const lease = await manager.acquire(acquireOptions(ref, { priority: 2 }));

    lease.setPriority(11);
    lease.setPinned(true);
    expect(manager.snapshot()).toMatchObject({ pinnedCount: 1 });
    expect(manager.snapshot().entries[0]).toMatchObject({ priority: 11, pinned: true });
    lease.release();
    lease.setPriority(99);
    lease.setPinned(false);
    expect(manager.snapshot()).toMatchObject({ referenceCount: 0, pinnedCount: 0 });
    expect(manager.snapshot().entries[0]).toMatchObject({ priority: 11, pinned: false });
    await manager.shutdown();
  });

  it("disposes resident and late in-flight resources exactly once during shutdown", async () => {
    const residentRef = assetRef("a1");
    const pendingRef = assetRef("b1");
    const residentDispose = vi.fn();
    const pendingDispose = vi.fn();
    const pending = deferred<ModelLoadedResource<TestResource>>();
    const load = vi.fn(({ assetRef: ref }: ModelLoadRequest) =>
      ref.contentHash === residentRef.contentHash
        ? Promise.resolve(loaded(ref, "resident", residentDispose))
        : pending.promise,
    );
    const manager = new ModelResidencyManager<TestResource>({
      budget: { maxCpuBytes: 256, maxGpuBytes: 256, maxInFlightLoads: 2 },
      load,
    });
    const residentLease = await manager.acquire(acquireOptions(residentRef));
    await vi.waitFor(() => expect(manager.snapshot().inFlightLoads).toBe(0));
    const pendingAcquire = manager.acquire(acquireOptions(pendingRef));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const shutdown = manager.shutdown();

    await expect(pendingAcquire).rejects.toMatchObject({ code: "manager-closed" });
    pending.resolve(loaded(pendingRef, "late-shutdown", pendingDispose));
    await shutdown;
    await vi.waitFor(() => expect(pendingDispose).toHaveBeenCalledTimes(1));
    expect(residentDispose).toHaveBeenCalledTimes(1);
    residentLease.release();
    await manager.shutdown();
    expect(residentDispose).toHaveBeenCalledTimes(1);
    expect(pendingDispose).toHaveBeenCalledTimes(1);
  });

  it("stays bounded across thousands of shared-zone acquisitions", async () => {
    const refs = Array.from({ length: 24 }, (_, index) =>
      assetRef(index.toString(16).padStart(2, "0")),
    );
    const loadCounts = new Map<string, number>();
    const disposeCounts = new Map<string, number>();
    const manager = new ModelResidencyManager<TestResource>({
      budget: {
        maxCpuBytes: 8 * 1024,
        maxGpuBytes: 8 * 1024,
        maxInFlightLoads: 4,
      },
      load: async ({ assetRef: ref }) => {
        loadCounts.set(ref.contentHash, (loadCounts.get(ref.contentHash) ?? 0) + 1);
        return loaded(
          ref,
          ref.assetId,
          () =>
            disposeCounts.set(
              ref.contentHash,
              (disposeCounts.get(ref.contentHash) ?? 0) + 1,
            ),
          256,
          256,
        );
      },
    });

    for (let index = 0; index < 2_400; index += 24) {
      const leases = await Promise.all(
        refs.map((ref, refIndex) =>
          manager.acquire(
            acquireOptions(ref, {
              priority: refIndex % 4,
              estimatedCpuBytes: 256,
              estimatedGpuBytes: 256,
            }),
          ),
        ),
      );
      for (const lease of leases) lease.release();
      expect(manager.snapshot().cpuBytes).toBeLessThanOrEqual(8 * 1024);
      expect(manager.snapshot().gpuBytes).toBeLessThanOrEqual(8 * 1024);
      expect(manager.snapshot().inFlightLoads).toBeLessThanOrEqual(4);
    }

    expect([...loadCounts.values()].every((count) => count === 1)).toBe(true);
    await manager.shutdown();
    expect([...disposeCounts.values()].every((count) => count === 1)).toBe(true);
  });
});

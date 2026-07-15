import type {
  ModelAssetRef,
  ModelLodLevel,
} from "@plasius/asset-contracts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PARTITION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

/** Hard CPU, GPU, and concurrent-load limits for one residency manager. */
export interface ModelResidencyBudget {
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxInFlightLoads: number;
}

/** Adapter request for one immutable model LOD or partition. */
export interface ModelLoadRequest {
  readonly assetRef: ModelAssetRef;
  readonly lod: ModelLodLevel;
  readonly partitionId?: string;
  readonly priority: number;
  readonly signal: AbortSignal;
}

/** Resource returned by a format-specific loader/upload adapter. */
export interface ModelLoadedResource<Resource> {
  readonly resource: Resource;
  readonly contentHash: string;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly dispose: () => void | Promise<void>;
}

/** Options for acquiring a shared model resource. */
export interface AcquireModelOptions {
  readonly assetRef: ModelAssetRef;
  readonly lod: ModelLodLevel;
  readonly partitionId?: string;
  readonly priority: number;
  readonly estimatedCpuBytes: number;
  readonly estimatedGpuBytes: number;
  readonly signal?: AbortSignal;
  readonly pinned?: boolean;
}

/** Idempotent reference to one shared resident model resource. */
export interface ModelResidencyLease<Resource> {
  readonly key: string;
  readonly assetRef: ModelAssetRef;
  readonly lod: ModelLodLevel;
  readonly partitionId?: string;
  readonly resource: Resource;
  release(): void;
  setPriority(priority: number): void;
  setPinned(pinned: boolean): void;
}

/** Construction boundary for adapter-driven model loading. */
export interface ModelResidencyManagerOptions<Resource> {
  readonly budget: ModelResidencyBudget;
  readonly load: (
    request: ModelLoadRequest,
  ) => Promise<ModelLoadedResource<Resource>>;
  readonly loadTimeoutMs?: number;
}

export type ModelResidencyErrorCode =
  | "acquire-aborted"
  | "budget-exceeded"
  | "content-hash-mismatch"
  | "invalid-load-result"
  | "load-timeout"
  | "manager-closed";

/** Stable operational error returned by residency-specific failure paths. */
export class ModelResidencyError extends Error {
  readonly code: ModelResidencyErrorCode;

  constructor(code: ModelResidencyErrorCode, message: string) {
    super(message);
    this.name = "ModelResidencyError";
    this.code = code;
  }
}

export interface ModelResidencyEntrySnapshot {
  readonly key: string;
  readonly state: "queued" | "loading" | "resident";
  readonly priority: number;
  readonly references: number;
  readonly pinned: boolean;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
}

/** Immutable accounting and lifetime metrics for diagnostics. */
export interface ModelResidencySnapshot {
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxInFlightLoads: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly reservedCpuBytes: number;
  readonly reservedGpuBytes: number;
  readonly residentCount: number;
  readonly pendingCount: number;
  readonly referenceCount: number;
  readonly pinnedCount: number;
  readonly inFlightLoads: number;
  readonly queuedLoads: number;
  readonly acquireCount: number;
  readonly cacheHits: number;
  readonly deduplicatedAcquires: number;
  readonly loadsStarted: number;
  readonly loadsCompleted: number;
  readonly loadsFailed: number;
  readonly loadsAborted: number;
  readonly loadsTimedOut: number;
  readonly evictions: number;
  readonly disposals: number;
  readonly disposalFailures: number;
  readonly residentKeys: readonly string[];
  readonly entries: readonly ModelResidencyEntrySnapshot[];
}

interface AcquisitionWaiter<Resource> {
  readonly id: number;
  priority: number;
  pinned: boolean;
  readonly signal?: AbortSignal;
  readonly resolve: (lease: ModelResidencyLease<Resource>) => void;
  readonly reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface LeaseRecord {
  readonly id: number;
  active: boolean;
  priority: number;
  pinned: boolean;
}

interface ResidencyEntry<Resource> {
  readonly key: string;
  readonly assetRef: ModelAssetRef;
  readonly lod: ModelLodLevel;
  readonly partitionId?: string;
  readonly estimatedCpuBytes: number;
  readonly estimatedGpuBytes: number;
  readonly queueOrder: number;
  state: "queued" | "loading" | "resident";
  priority: number;
  retainedPriority: number;
  lastUsed: number;
  abandoned: boolean;
  loadSlotReleased: boolean;
  waiters: Map<number, AcquisitionWaiter<Resource>>;
  leases: Map<number, LeaseRecord>;
  controller?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  loaded?: ModelLoadedResource<Resource>;
  loadTask?: Promise<void>;
}

interface MutableMetrics {
  acquireCount: number;
  cacheHits: number;
  deduplicatedAcquires: number;
  loadsStarted: number;
  loadsCompleted: number;
  loadsFailed: number;
  loadsAborted: number;
  loadsTimedOut: number;
  evictions: number;
  disposals: number;
  disposalFailures: number;
}

function requireSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requirePriority(priority: number): void {
  if (!Number.isFinite(priority) || priority < 0) {
    throw new RangeError("priority must be a non-negative finite number");
  }
}

function requireLod(lod: ModelLodLevel): void {
  if (!Number.isInteger(lod) || lod < 0 || lod > 3) {
    throw new RangeError("lod must be an integer from 0 to 3");
  }
}

/** Build the canonical content-hash, LOD, and optional partition cache key. */
export function createModelResidencyKey(
  assetRef: ModelAssetRef,
  lod: ModelLodLevel,
  partitionId?: string,
): string {
  if (!SHA256_PATTERN.test(assetRef.contentHash)) {
    throw new Error("ModelAssetRef.contentHash must be a lowercase SHA-256 value");
  }
  requireLod(lod);
  if (partitionId !== undefined && !PARTITION_ID_PATTERN.test(partitionId)) {
    throw new Error("partitionId must be a bounded runtime token");
  }
  return `${assetRef.contentHash}:lod${lod}:${partitionId ?? "whole"}`;
}

function closedError(): ModelResidencyError {
  return new ModelResidencyError(
    "manager-closed",
    "The model residency manager is closed",
  );
}

function abortedError(): ModelResidencyError {
  return new ModelResidencyError(
    "acquire-aborted",
    "The model residency acquisition was aborted",
  );
}

function signalIsAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * Content-addressed model cache with bounded work, reference-counted leases,
 * deterministic eviction, and exact-once adapter disposal.
 */
export class ModelResidencyManager<Resource = unknown> {
  readonly #budget: ModelResidencyBudget;
  readonly #load: (
    request: ModelLoadRequest,
  ) => Promise<ModelLoadedResource<Resource>>;
  readonly #loadTimeoutMs?: number;
  readonly #entries = new Map<string, ResidencyEntry<Resource>>();
  readonly #loadTasks = new Set<Promise<void>>();
  readonly #disposalTasks = new Set<Promise<void>>();
  readonly #metrics: MutableMetrics = {
    acquireCount: 0,
    cacheHits: 0,
    deduplicatedAcquires: 0,
    loadsStarted: 0,
    loadsCompleted: 0,
    loadsFailed: 0,
    loadsAborted: 0,
    loadsTimedOut: 0,
    evictions: 0,
    disposals: 0,
    disposalFailures: 0,
  };
  #nextIdentity = 1;
  #clock = 1;
  #inFlightLoads = 0;
  #closed = false;
  #admissionTail: Promise<void> = Promise.resolve();
  #shutdownPromise?: Promise<void>;

  constructor(options: ModelResidencyManagerOptions<Resource>) {
    requirePositiveSafeInteger(
      options.budget.maxCpuBytes,
      "budget.maxCpuBytes",
    );
    requirePositiveSafeInteger(
      options.budget.maxGpuBytes,
      "budget.maxGpuBytes",
    );
    requirePositiveSafeInteger(
      options.budget.maxInFlightLoads,
      "budget.maxInFlightLoads",
    );
    if (options.loadTimeoutMs !== undefined) {
      requirePositiveSafeInteger(options.loadTimeoutMs, "loadTimeoutMs");
    }
    this.#budget = Object.freeze({ ...options.budget });
    this.#load = options.load;
    this.#loadTimeoutMs = options.loadTimeoutMs;
  }

  /** Acquire one shared resource lease, loading it at most once per cache key. */
  acquire(options: AcquireModelOptions): Promise<ModelResidencyLease<Resource>> {
    try {
      if (this.#closed) throw closedError();
      requirePriority(options.priority);
      requireSafeNonNegativeInteger(
        options.estimatedCpuBytes,
        "estimatedCpuBytes",
      );
      requireSafeNonNegativeInteger(
        options.estimatedGpuBytes,
        "estimatedGpuBytes",
      );
      const key = createModelResidencyKey(
        options.assetRef,
        options.lod,
        options.partitionId,
      );
      if (signalIsAborted(options.signal)) throw abortedError();
      this.#metrics.acquireCount += 1;

      const existing = this.#entries.get(key);
      if (existing !== undefined) return this.#acquireExisting(existing, options);
      return this.#scheduleAdmission(key, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #acquireExisting(
    entry: ResidencyEntry<Resource>,
    options: AcquireModelOptions,
  ): Promise<ModelResidencyLease<Resource>> {
    this.#metrics.deduplicatedAcquires += 1;
    if (entry.state === "resident") {
      this.#metrics.cacheHits += 1;
      return Promise.resolve(
        this.#createLease(
          entry,
          options.priority,
          options.pinned ?? false,
        ),
      );
    }
    return this.#addWaiter(entry, options);
  }

  #scheduleAdmission(
    key: string,
    options: AcquireModelOptions,
  ): Promise<ModelResidencyLease<Resource>> {
    let resolveAcquisition!: (lease: ModelResidencyLease<Resource>) => void;
    let rejectAcquisition!: (reason: unknown) => void;
    const acquisition = new Promise<ModelResidencyLease<Resource>>(
      (resolve, reject) => {
        resolveAcquisition = resolve;
        rejectAcquisition = reject;
      },
    );
    const admission = this.#admissionTail.then(async () => {
      if (this.#closed) throw closedError();
      if (signalIsAborted(options.signal)) throw abortedError();
      const existing = this.#entries.get(key);
      if (existing !== undefined) {
        void this.#acquireExisting(existing, options).then(
          resolveAcquisition,
          rejectAcquisition,
        );
        return;
      }
      await this.#ensureCapacityForReservation(
        options.estimatedCpuBytes,
        options.estimatedGpuBytes,
      );
      if (this.#closed) throw closedError();
      if (signalIsAborted(options.signal)) throw abortedError();
      const entry: ResidencyEntry<Resource> = {
        key,
        assetRef: options.assetRef,
        lod: options.lod,
        ...(options.partitionId === undefined
          ? {}
          : { partitionId: options.partitionId }),
        estimatedCpuBytes: options.estimatedCpuBytes,
        estimatedGpuBytes: options.estimatedGpuBytes,
        queueOrder: this.#nextIdentity++,
        state: "queued",
        priority: options.priority,
        retainedPriority: options.priority,
        lastUsed: this.#clock++,
        abandoned: false,
        loadSlotReleased: true,
        waiters: new Map(),
        leases: new Map(),
      };
      this.#entries.set(key, entry);
      void this.#addWaiter(entry, options).then(
        resolveAcquisition,
        rejectAcquisition,
      );
      this.#pumpQueue();
    });
    this.#admissionTail = admission.catch(() => undefined);
    void admission.catch(rejectAcquisition);
    return acquisition;
  }

  /** Dispose every currently unreferenced, unpinned resident cache entry. */
  async evictUnused(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.#evictionCandidates()) {
      tasks.push(this.#evict(entry));
    }
    await Promise.all(tasks);
  }

  /** Wait until queued/loading work and its resulting disposal have settled. */
  async waitForIdle(): Promise<void> {
    await this.#admissionTail;
    do {
      this.#pumpQueue();
      const tasks = [...this.#loadTasks];
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
    } while (this.#loadTasks.size > 0 || this.#queuedCount() > 0);
    await Promise.allSettled([...this.#disposalTasks]);
  }

  /** Abort pending work and dispose every resident or late-completing resource. */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#closed = true;
    const error = closedError();
    const disposalTasks: Promise<void>[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.state === "resident") {
        this.#entries.delete(entry.key);
        disposalTasks.push(this.#disposeEntry(entry));
        continue;
      }
      this.#rejectWaiters(entry, error);
      if (entry.state === "queued") {
        this.#entries.delete(entry.key);
      } else {
        this.#abandonLoadingEntry(entry, error, false);
      }
    }
    this.#shutdownPromise = (async () => {
      await Promise.allSettled(disposalTasks);
      await this.waitForIdle();
      await Promise.allSettled([...this.#disposalTasks]);
    })();
    return this.#shutdownPromise;
  }

  /** Return immutable byte, queue, cache, and lifetime metrics. */
  snapshot(): ModelResidencySnapshot {
    let cpuBytes = 0;
    let gpuBytes = 0;
    let reservedCpuBytes = 0;
    let reservedGpuBytes = 0;
    let referenceCount = 0;
    let pinnedCount = 0;
    let residentCount = 0;
    let pendingCount = 0;
    const entries: ModelResidencyEntrySnapshot[] = [];

    for (const entry of this.#entries.values()) {
      const pinned = [...entry.leases.values()].some(
        (lease) => lease.active && lease.pinned,
      );
      const references = [...entry.leases.values()].filter(
        (lease) => lease.active,
      ).length;
      referenceCount += references;
      if (pinned) pinnedCount += 1;
      if (entry.state === "resident") {
        residentCount += 1;
        cpuBytes += entry.loaded!.cpuBytes;
        gpuBytes += entry.loaded!.gpuBytes;
      } else {
        pendingCount += 1;
        reservedCpuBytes += entry.estimatedCpuBytes;
        reservedGpuBytes += entry.estimatedGpuBytes;
      }
      entries.push(
        Object.freeze({
          key: entry.key,
          state: entry.state,
          priority: entry.priority,
          references,
          pinned,
          cpuBytes:
            entry.state === "resident"
              ? entry.loaded!.cpuBytes
              : entry.estimatedCpuBytes,
          gpuBytes:
            entry.state === "resident"
              ? entry.loaded!.gpuBytes
              : entry.estimatedGpuBytes,
        }),
      );
    }
    entries.sort((left, right) => left.key.localeCompare(right.key));
    return Object.freeze({
      ...this.#budget,
      cpuBytes,
      gpuBytes,
      reservedCpuBytes,
      reservedGpuBytes,
      residentCount,
      pendingCount,
      referenceCount,
      pinnedCount,
      inFlightLoads: this.#inFlightLoads,
      queuedLoads: this.#queuedCount(),
      ...this.#metrics,
      residentKeys: Object.freeze(
        entries
          .filter((entry) => entry.state === "resident")
          .map((entry) => entry.key),
      ),
      entries: Object.freeze(entries),
    });
  }

  #addWaiter(
    entry: ResidencyEntry<Resource>,
    options: AcquireModelOptions,
  ): Promise<ModelResidencyLease<Resource>> {
    const id = this.#nextIdentity++;
    let resolvePromise!: (lease: ModelResidencyLease<Resource>) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<ModelResidencyLease<Resource>>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );
    const waiter: AcquisitionWaiter<Resource> = {
      id,
      priority: options.priority,
      pinned: options.pinned ?? false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    if (options.signal !== undefined) {
      waiter.onAbort = () => this.#abortWaiter(entry, waiter);
      options.signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    entry.waiters.set(id, waiter);
    entry.retainedPriority = Math.max(entry.retainedPriority, options.priority);
    this.#recalculatePriority(entry);
    return promise;
  }

  #abortWaiter(
    entry: ResidencyEntry<Resource>,
    waiter: AcquisitionWaiter<Resource>,
  ): void {
    entry.waiters.delete(waiter.id);
    this.#detachWaiterSignal(waiter);
    waiter.reject(abortedError());
    this.#recalculatePriority(entry);
    if (entry.waiters.size > 0) return;
    if (entry.state === "queued") {
      this.#entries.delete(entry.key);
      this.#pumpQueue();
      return;
    }
    this.#abandonLoadingEntry(entry, abortedError(), true);
  }

  #createLease(
    entry: ResidencyEntry<Resource>,
    priority: number,
    pinned: boolean,
  ): ModelResidencyLease<Resource> {
    const id = this.#nextIdentity++;
    const record: LeaseRecord = {
      id,
      active: true,
      priority,
      pinned,
    };
    entry.leases.set(id, record);
    entry.retainedPriority = priority;
    entry.lastUsed = this.#clock++;
    this.#recalculatePriority(entry);
    const lease = {
      key: entry.key,
      assetRef: entry.assetRef,
      lod: entry.lod,
      ...(entry.partitionId === undefined
        ? {}
        : { partitionId: entry.partitionId }),
      resource: entry.loaded!.resource,
      release: () => {
        if (!record.active) return;
        record.active = false;
        entry.leases.delete(id);
        entry.lastUsed = this.#clock++;
        this.#recalculatePriority(entry);
      },
      setPriority: (nextPriority: number) => {
        if (!record.active || this.#entries.get(entry.key) !== entry) return;
        requirePriority(nextPriority);
        record.priority = nextPriority;
        entry.retainedPriority = nextPriority;
        entry.lastUsed = this.#clock++;
        this.#recalculatePriority(entry);
      },
      setPinned: (nextPinned: boolean) => {
        if (!record.active || this.#entries.get(entry.key) !== entry) return;
        record.pinned = nextPinned;
      },
    } satisfies ModelResidencyLease<Resource>;
    return Object.freeze(lease);
  }

  #recalculatePriority(entry: ResidencyEntry<Resource>): void {
    let priority = entry.retainedPriority;
    for (const waiter of entry.waiters.values()) {
      priority = Math.max(priority, waiter.priority);
    }
    for (const lease of entry.leases.values()) {
      priority = Math.max(priority, lease.priority);
    }
    entry.priority = priority;
  }

  #pumpQueue(): void {
    if (this.#closed) return;
    while (this.#inFlightLoads < this.#budget.maxInFlightLoads) {
      const candidate = [...this.#entries.values()]
        .filter(
          (entry) =>
            entry.state === "queued" &&
            !entry.abandoned &&
            entry.waiters.size > 0,
        )
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.queueOrder - right.queueOrder,
        )[0];
      if (candidate === undefined) return;
      this.#startLoad(candidate);
    }
  }

  #startLoad(entry: ResidencyEntry<Resource>): void {
    entry.state = "loading";
    entry.loadSlotReleased = false;
    entry.controller = new AbortController();
    this.#inFlightLoads += 1;
    this.#metrics.loadsStarted += 1;
    if (this.#loadTimeoutMs !== undefined) {
      entry.timeout = setTimeout(() => {
        this.#metrics.loadsTimedOut += 1;
        this.#abandonLoadingEntry(
          entry,
          new ModelResidencyError(
            "load-timeout",
            `Model load exceeded ${this.#loadTimeoutMs} ms`,
          ),
          true,
        );
      }, this.#loadTimeoutMs);
    }

    let adapterPromise: Promise<ModelLoadedResource<Resource>>;
    try {
      adapterPromise = this.#load({
        assetRef: entry.assetRef,
        lod: entry.lod,
        ...(entry.partitionId === undefined
          ? {}
          : { partitionId: entry.partitionId }),
        priority: entry.priority,
        signal: entry.controller.signal,
      });
    } catch (error) {
      adapterPromise = Promise.reject(error);
    }
    const task = Promise.resolve(adapterPromise)
      .then((result) => this.#completeLoad(entry, result))
      .catch((error: unknown) => this.#failLoad(entry, error))
      .finally(() => {
        if (entry.timeout !== undefined) clearTimeout(entry.timeout);
        entry.timeout = undefined;
        entry.controller = undefined;
        this.#releaseLoadSlot(entry);
        entry.loadTask = undefined;
      });
    entry.loadTask = task;
    this.#loadTasks.add(task);
  }

  async #completeLoad(
    entry: ResidencyEntry<Resource>,
    result: ModelLoadedResource<Resource>,
  ): Promise<void> {
    if (entry.abandoned) {
      await this.#disposeLoaded(result);
      return;
    }

    try {
      this.#validateLoadedResource(entry, result);
      const evictions = this.#ensureCapacityForLoadedResult(entry, result);
      await Promise.all(evictions);
    } catch (error) {
      await this.#disposeLoaded(result);
      this.#entries.delete(entry.key);
      this.#rejectWaiters(entry, error);
      this.#metrics.loadsFailed += 1;
      return;
    }

    entry.state = "resident";
    entry.loaded = result;
    entry.lastUsed = this.#clock++;
    this.#metrics.loadsCompleted += 1;
    const waiters = [...entry.waiters.values()];
    entry.waiters.clear();
    for (const waiter of waiters) {
      this.#detachWaiterSignal(waiter);
      waiter.resolve(this.#createLease(entry, waiter.priority, waiter.pinned));
    }
  }

  #failLoad(entry: ResidencyEntry<Resource>, error: unknown): void {
    if (entry.abandoned) return;
    this.#entries.delete(entry.key);
    this.#metrics.loadsFailed += 1;
    this.#rejectWaiters(entry, error);
  }

  #abandonLoadingEntry(
    entry: ResidencyEntry<Resource>,
    error: ModelResidencyError,
    rejectWaiters: boolean,
  ): void {
    entry.abandoned = true;
    this.#metrics.loadsAborted += 1;
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    entry.timeout = undefined;
    this.#entries.delete(entry.key);
    if (rejectWaiters) this.#rejectWaiters(entry, error);
    entry.controller?.abort(error);
    this.#releaseLoadSlot(entry);
  }

  #releaseLoadSlot(entry: ResidencyEntry<Resource>): void {
    if (entry.loadSlotReleased) return;
    entry.loadSlotReleased = true;
    this.#inFlightLoads -= 1;
    this.#loadTasks.delete(entry.loadTask!);
    this.#pumpQueue();
  }

  #rejectWaiters(entry: ResidencyEntry<Resource>, error: unknown): void {
    const waiters = [...entry.waiters.values()];
    entry.waiters.clear();
    for (const waiter of waiters) {
      this.#detachWaiterSignal(waiter);
      waiter.reject(error);
    }
    this.#recalculatePriority(entry);
  }

  #detachWaiterSignal(waiter: AcquisitionWaiter<Resource>): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.onAbort = undefined;
  }

  #validateLoadedResource(
    entry: ResidencyEntry<Resource>,
    result: ModelLoadedResource<Resource>,
  ): void {
    if (result === null || typeof result !== "object") {
      throw new ModelResidencyError(
        "invalid-load-result",
        "The model loader returned an invalid resource",
      );
    }
    if (typeof result.dispose !== "function") {
      throw new ModelResidencyError(
        "invalid-load-result",
        "The model loader must return a disposer",
      );
    }
    requireSafeNonNegativeInteger(result.cpuBytes, "loaded.cpuBytes");
    requireSafeNonNegativeInteger(result.gpuBytes, "loaded.gpuBytes");
    if (result.contentHash !== entry.assetRef.contentHash) {
      throw new ModelResidencyError(
        "content-hash-mismatch",
        "The loaded model content hash does not match its canonical reference",
      );
    }
  }

  async #ensureCapacityForReservation(
    cpuBytes: number,
    gpuBytes: number,
  ): Promise<void> {
    if (
      cpuBytes > this.#budget.maxCpuBytes ||
      gpuBytes > this.#budget.maxGpuBytes
    ) {
      throw this.#budgetError();
    }
    let usage = this.#totalAccountedBytes();
    for (const candidate of this.#evictionCandidates()) {
      if (
        usage.cpu + cpuBytes <= this.#budget.maxCpuBytes &&
        usage.gpu + gpuBytes <= this.#budget.maxGpuBytes
      ) {
        return;
      }
      await this.#evict(candidate);
      usage = this.#totalAccountedBytes();
    }
    if (
      usage.cpu + cpuBytes > this.#budget.maxCpuBytes ||
      usage.gpu + gpuBytes > this.#budget.maxGpuBytes
    ) {
      throw this.#budgetError();
    }
  }

  #ensureCapacityForLoadedResult(
    loadingEntry: ResidencyEntry<Resource>,
    result: ModelLoadedResource<Resource>,
  ): Promise<void>[] {
    const usage = this.#totalAccountedBytes();
    usage.cpu += result.cpuBytes - loadingEntry.estimatedCpuBytes;
    usage.gpu += result.gpuBytes - loadingEntry.estimatedGpuBytes;
    const disposals: Promise<void>[] = [];
    for (const candidate of this.#evictionCandidates()) {
      if (
        usage.cpu <= this.#budget.maxCpuBytes &&
        usage.gpu <= this.#budget.maxGpuBytes
      ) {
        return disposals;
      }
      usage.cpu -= candidate.loaded!.cpuBytes;
      usage.gpu -= candidate.loaded!.gpuBytes;
      disposals.push(this.#evict(candidate));
    }
    if (
      usage.cpu > this.#budget.maxCpuBytes ||
      usage.gpu > this.#budget.maxGpuBytes
    ) {
      throw this.#budgetError();
    }
    return disposals;
  }

  #budgetError(): ModelResidencyError {
    return new ModelResidencyError(
      "budget-exceeded",
      "Pinned, referenced, or pending models leave insufficient residency budget",
    );
  }

  #totalAccountedBytes(): { cpu: number; gpu: number } {
    let cpu = 0;
    let gpu = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "resident") {
        cpu += entry.loaded!.cpuBytes;
        gpu += entry.loaded!.gpuBytes;
      } else {
        cpu += entry.estimatedCpuBytes;
        gpu += entry.estimatedGpuBytes;
      }
    }
    return { cpu, gpu };
  }

  #evictionCandidates(): ResidencyEntry<Resource>[] {
    return [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.state === "resident" &&
          entry.leases.size === 0,
      )
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.lastUsed - right.lastUsed,
      );
  }

  #evict(entry: ResidencyEntry<Resource>): Promise<void> {
    this.#entries.delete(entry.key);
    this.#metrics.evictions += 1;
    return this.#disposeEntry(entry);
  }

  #disposeEntry(entry: ResidencyEntry<Resource>): Promise<void> {
    const result = entry.loaded!;
    entry.loaded = undefined;
    return this.#disposeLoaded(result);
  }

  #disposeLoaded(result: ModelLoadedResource<Resource>): Promise<void> {
    this.#metrics.disposals += 1;
    let disposal: Promise<void>;
    try {
      disposal = Promise.resolve(result.dispose());
    } catch (error) {
      disposal = Promise.reject(error);
    }
    const tracked = disposal
      .catch(() => {
        this.#metrics.disposalFailures += 1;
      })
      .finally(() => {
        this.#disposalTasks.delete(tracked);
      });
    this.#disposalTasks.add(tracked);
    return tracked;
  }

  #queuedCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "queued") count += 1;
    }
    return count;
  }
}

import { MemoryModelCache, createModelCacheKey } from "./cache.js";
import { defaultSleep, fetchResource, sha256Hex } from "./fetch.js";
import type {
  AdapterLoadResult,
  AdapterModule,
  AdapterRegistration,
  HashBytes,
  LoadModelOptions,
  ModelAdapter,
  ModelCache,
  ModelLoadResult,
  ModelPackage,
  ModelResourceInput,
  ModelSource,
  ModelSourceKind,
  ReadFile,
  ResolveResourceOptions,
  ResolvedModelSource,
  ResolvedResource,
  ResourceReference,
  ResourceResolver,
  RuntimeDependencies,
  RuntimeFetch,
  Sleep,
  SniffInput,
  WorkerDispatcher,
  WorkerLoadRequest,
} from "./types.js";

export class AdapterRegistry {
  private readonly registrations = new Map<string, AdapterRegistration>();

  register<TCanonicalModel, TRendererReady>(registration: AdapterRegistration<TCanonicalModel, TRendererReady>): this {
    if (this.registrations.has(registration.formatId)) {
      throw new Error(`An adapter is already registered for format ${registration.formatId}`);
    }
    this.registrations.set(registration.formatId, registration as AdapterRegistration);
    return this;
  }

  async resolve<TCanonicalModel = unknown, TRendererReady = unknown>(
    input: SniffInput,
    formatId?: string,
  ): Promise<ModelAdapter<TCanonicalModel, TRendererReady>> {
    if (formatId) {
      const registration = this.registrations.get(formatId);
      if (!registration) {
        throw new Error(`No model adapter is registered for format ${formatId}`);
      }
      return unwrapAdapter(await registration.load()) as ModelAdapter<TCanonicalModel, TRendererReady>;
    }

    const candidates = [...this.registrations.values()]
      .map((registration) => ({ registration, score: scoreRegistration(registration, input) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);

    const selected = candidates[0]?.registration;
    if (!selected) {
      throw new Error("No model adapter matched the source content, MIME type, or extension");
    }

    return unwrapAdapter(await selected.load()) as ModelAdapter<TCanonicalModel, TRendererReady>;
  }
}

export class PackageResourceResolver implements ResourceResolver {
  private readonly memoryResources: Readonly<Record<string, ModelResourceInput>>;
  private readonly baseUrl?: string;
  private readonly sourceKind: ModelSourceKind;
  private readonly fetch: RuntimeFetch;
  private readonly hashBytes: HashBytes;
  private readonly sleep: Sleep;
  private readonly fetchPolicy: LoadModelOptions["fetchPolicy"];
  private readonly headers?: Readonly<Record<string, string>>;
  private readonly blobStorageUrlResolver?: RuntimeDependencies["blobStorageUrlResolver"];

  public constructor(options: Readonly<{
    sourceKind: ModelSourceKind;
    baseUrl?: string;
    package?: ModelPackage;
    fetch: RuntimeFetch;
    hashBytes: HashBytes;
    sleep: Sleep;
    fetchPolicy?: LoadModelOptions["fetchPolicy"];
    headers?: Readonly<Record<string, string>>;
    blobStorageUrlResolver?: RuntimeDependencies["blobStorageUrlResolver"];
  }>) {
    this.sourceKind = options.sourceKind;
    this.baseUrl = options.package?.baseUrl ?? options.baseUrl;
    this.memoryResources = options.package?.resources ?? {};
    this.fetch = options.fetch;
    this.hashBytes = options.hashBytes;
    this.sleep = options.sleep;
    this.fetchPolicy = options.fetchPolicy;
    this.headers = options.headers;
    this.blobStorageUrlResolver = options.blobStorageUrlResolver;
  }

  async resolve(reference: string | ResourceReference, options: ResolveResourceOptions = {}): Promise<ResolvedResource> {
    const requested = typeof reference === "string" ? { path: reference } : reference;
    const memoryKey = normalizePackagePath(requested.path);
    const memoryResource = this.memoryResources[memoryKey] ?? this.memoryResources[`./${memoryKey}`];
    if (memoryResource) {
      const bytes = await toBytes(memoryResource.bytes);
      await verifyResourceIntegrity(bytes, requested.integrity ?? memoryResource.integrity, this.hashBytes);
      return {
        path: memoryKey,
        bytes,
        contentType: requested.contentType ?? memoryResource.contentType,
        contentHash: await this.hashBytes(bytes),
        rangeSupported: false,
      };
    }

    const url = await this.resolveUrl(requested.path);
    const result = await fetchResource(url, {
      fetch: this.fetch,
      hashBytes: this.hashBytes,
      sleep: this.sleep,
      headers: this.headers,
      integrity: requested.integrity,
      policy: this.fetchPolicy,
      resolveOptions: options,
    });
    return {
      path: memoryKey,
      bytes: result.bytes,
      contentType: requested.contentType ?? result.contentType,
      contentHash: await this.hashBytes(result.bytes),
      rangeSupported: result.rangeSupported,
    };
  }

  private async resolveUrl(reference: string): Promise<string> {
    if (/^[a-z][a-z\d+.-]*:/iu.test(reference)) {
      return ensureHttpUrl(reference);
    }
    if (!this.baseUrl) {
      throw new Error(`Cannot resolve relative model resource ${reference} without a package base URL or memory resource`);
    }
    if (this.sourceKind === "blob-storage-url" && this.blobStorageUrlResolver) {
      return this.blobStorageUrlResolver(this.baseUrl, reference);
    }
    return ensureHttpUrl(new URL(reference, this.baseUrl).href);
  }
}

export class ModelRuntime {
  private readonly registry: AdapterRegistry;
  private readonly cache: ModelCache;
  private readonly fetch: RuntimeFetch;
  private readonly readFile?: ReadFile;
  private readonly hashBytes: HashBytes;
  private readonly sleep: Sleep;
  private readonly workerDispatcher?: WorkerDispatcher;
  private readonly blobStorageUrlResolver?: RuntimeDependencies["blobStorageUrlResolver"];
  private readonly cacheKeys = new Set<string>();

  public constructor(options: Readonly<{
    registry?: AdapterRegistry;
    cache?: ModelCache;
    dependencies?: RuntimeDependencies;
    workerDispatcher?: WorkerDispatcher;
  }> = {}) {
    this.registry = options.registry ?? new AdapterRegistry();
    this.cache = options.cache ?? new MemoryModelCache();
    this.fetch = options.dependencies?.fetch ?? defaultFetch;
    this.readFile = options.dependencies?.readFile;
    this.hashBytes = options.dependencies?.hashBytes ?? sha256Hex;
    this.sleep = options.dependencies?.sleep ?? defaultSleep;
    this.workerDispatcher = options.workerDispatcher;
    this.blobStorageUrlResolver = options.dependencies?.blobStorageUrlResolver;
  }

  public get adapters(): AdapterRegistry {
    return this.registry;
  }

  public async invalidate(contentHash?: string): Promise<void> {
    if (!contentHash) {
      await this.cache.clear();
      this.cacheKeys.clear();
      return;
    }

    for (const key of this.cacheKeys) {
      if (key.includes(`:${contentHash}:`)) {
        await this.cache.delete(key);
        this.cacheKeys.delete(key);
      }
    }
  }

  public async loadModel<TCanonicalModel, TRendererReady = unknown>(
    source: ModelSource,
    options: LoadModelOptions = {},
  ): Promise<ModelLoadResult<TCanonicalModel, TRendererReady>> {
    const input = await this.resolveSource(source, options);
    const adapter = await this.registry.resolve<TCanonicalModel, TRendererReady>({
      bytes: input.bytes,
      contentType: input.contentType,
      fileName: input.fileName,
      sourceKind: source.kind,
    }, options.formatId);
    const cacheKey = createModelCacheKey(input.contentHash, adapter.formatId, options.adapterOptions);
    const useCache = options.useCache ?? true;
    if (useCache) {
      const cached = await this.cache.get<ModelLoadResult<TCanonicalModel, TRendererReady>>(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true };
      }
    }

    const context = {
      signal: options.signal ?? new AbortController().signal,
      mode: options.mode ?? "strict",
      execution: "main" as const,
      adapterOptions: options.adapterOptions ?? null,
    };
    const adapterResult = await this.loadWithExecution<TCanonicalModel, TRendererReady>(adapter, input, context, options);
    const result: ModelLoadResult<TCanonicalModel, TRendererReady> = {
      ...adapterResult,
      contentHash: input.contentHash,
      cacheKey,
      fromCache: false,
      contentType: input.contentType,
      sourceKind: source.kind,
    };
    if (useCache) {
      await this.cache.set(cacheKey, result);
      this.cacheKeys.add(cacheKey);
    }
    return result;
  }

  private async loadWithExecution<TCanonicalModel, TRendererReady>(
    adapter: ModelAdapter<TCanonicalModel, TRendererReady>,
    input: ResolvedModelSource,
    context: Parameters<ModelAdapter<TCanonicalModel, TRendererReady>["load"]>[1],
    options: LoadModelOptions,
  ): Promise<AdapterLoadResult<TCanonicalModel, TRendererReady>> {
    const workerMode = options.worker?.mode ?? "auto";
    const canUseWorker = workerMode !== "never" && Boolean(this.workerDispatcher) && Boolean(adapter.supportsWorker);
    if (workerMode === "always" && !canUseWorker) {
      throw new Error(`Adapter ${adapter.formatId} does not support the requested worker execution`);
    }
    if (canUseWorker && this.workerDispatcher) {
      const workerRequest: WorkerLoadRequest = {
        formatId: adapter.formatId,
        input,
        context: { ...context, execution: "worker" },
      };
      return this.workerDispatcher.dispatch<TCanonicalModel, TRendererReady>(workerRequest);
    }
    return adapter.load(input, context);
  }

  private async resolveSource(source: ModelSource, options: LoadModelOptions): Promise<ResolvedModelSource> {
    const fileName = sourceFileName(source);
    const baseUrl = "url" in source ? source.url : undefined;
    const headers = "headers" in source ? source.headers : undefined;
    let bytes: Uint8Array;
    let contentType: string | undefined = "mimeTypeHint" in source ? source.mimeTypeHint : undefined;
    let rangeSupported = false;

    if (source.kind === "file-path") {
      if (!this.readFile) {
        throw new Error("file-path sources require a readFile dependency");
      }
      bytes = await this.readFile(source.path, options.signal);
    } else if (source.kind === "url" || source.kind === "blob-storage-url") {
      const result = await fetchResource(ensureHttpUrl(source.url), {
        fetch: this.fetch,
        hashBytes: this.hashBytes,
        sleep: this.sleep,
        headers,
        integrity: options.integrity,
        policy: options.fetchPolicy,
        resolveOptions: { signal: options.signal },
      });
      bytes = result.bytes;
      contentType ??= result.contentType;
      rangeSupported = result.rangeSupported;
    } else {
      bytes = await sourceToBytes(source);
    }

    const contentHash = await this.hashBytes(bytes);
    const resourceResolver = new PackageResourceResolver({
      sourceKind: source.kind,
      baseUrl,
      package: source.package,
      fetch: this.fetch,
      hashBytes: this.hashBytes,
      sleep: this.sleep,
      fetchPolicy: options.fetchPolicy,
      headers,
      blobStorageUrlResolver: this.blobStorageUrlResolver,
    });
    return {
      source,
      bytes,
      contentType,
      fileName,
      contentHash,
      rangeSupported,
      resourceResolver,
    };
  }
}

function scoreRegistration(registration: AdapterRegistration, input: SniffInput): number {
  const extension = input.fileName?.split(".").pop()?.toLowerCase();
  const extensionScore = extension && registration.extensions?.some((item) => item.replace(/^\./u, "").toLowerCase() === extension) ? 2 : 0;
  const mimeScore = input.contentType && registration.mimeTypes?.some((item) => item.toLowerCase() === input.contentType?.toLowerCase()) ? 3 : 0;
  const sniffScore = registration.sniff?.(input) ?? 0;
  const normalizedSniffScore = sniffScore === true ? 1 : sniffScore === false ? 0 : sniffScore;
  return extensionScore + mimeScore + normalizedSniffScore;
}

function unwrapAdapter<TCanonicalModel, TRendererReady>(module: AdapterModule<TCanonicalModel, TRendererReady>): ModelAdapter<TCanonicalModel, TRendererReady> {
  return "default" in module ? module.default : module;
}

function normalizePackagePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error("Model resource paths cannot contain null bytes");
  }
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`Model resource path escapes its package: ${path}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

async function sourceToBytes(source: Exclude<ModelSource, { kind: "file-path" | "url" | "blob-storage-url" }>): Promise<Uint8Array> {
  if (source.kind === "blob") {
    return toBytes(source.blob);
  }
  if (source.kind === "array-buffer") {
    return new Uint8Array(source.bytes);
  }
  if (source.kind === "uint8-array") {
    return new Uint8Array(source.bytes);
  }

  const chunks: Uint8Array[] = [];
  if (Symbol.asyncIterator in Object(source.stream)) {
    for await (const chunk of source.stream as AsyncIterable<Uint8Array>) {
      chunks.push(new Uint8Array(chunk));
    }
  } else {
    const reader = (source.stream as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(new Uint8Array(next.value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function toBytes(input: ArrayBuffer | Blob | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input instanceof Uint8Array) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input);
}

async function verifyResourceIntegrity(bytes: Uint8Array, integrity: string | undefined, hashBytes: HashBytes): Promise<void> {
  if (!integrity) return;
  const expected = integrity.replace(/^sha256-/iu, "").toLowerCase();
  const actual = (await hashBytes(bytes)).toLowerCase();
  if (actual !== expected) {
    throw new Error("Model resource integrity check failed");
  }
}

const defaultFetch: RuntimeFetch = (input, init) => {
  if (!globalThis.fetch) {
    throw new Error("URL sources require fetch or an injected fetch dependency");
  }
  return globalThis.fetch(input, init);
};

function sourceFileName(source: ModelSource): string | undefined {
  if ("fileNameHint" in source && source.fileNameHint) {
    return source.fileNameHint;
  }
  if (source.kind === "file-path") {
    return source.path.split(/[\\/]/u).pop();
  }
  if (source.kind === "url" || source.kind === "blob-storage-url") {
    try {
      return new URL(source.url).pathname.split("/").pop() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function ensureHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported model resource URL scheme: ${url.protocol}`);
  }
  return url.href;
}

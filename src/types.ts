export type ModelSourceKind =
  | "file-path"
  | "url"
  | "blob-storage-url"
  | "blob"
  | "array-buffer"
  | "uint8-array"
  | "stream";

export type ModelProvenance = Readonly<{
  sourceId?: string;
  sourceSystem?: string;
  acquiredAt?: string;
  licenseHint?: string;
}>;

export type ModelResourceInput = Readonly<{
  bytes: ArrayBuffer | Blob | Uint8Array;
  contentType?: string;
  integrity?: string;
}>;

export type ModelPackage = Readonly<{
  entrypoint?: string;
  baseUrl?: string;
  resources?: Readonly<Record<string, ModelResourceInput>>;
}>;

export type ModelSource =
  | Readonly<{
      kind: "file-path";
      path: string;
      mimeTypeHint?: string;
      fileNameHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "url";
      url: string;
      headers?: Readonly<Record<string, string>>;
      mimeTypeHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "blob-storage-url";
      url: string;
      credentialMode?: "anonymous" | "signed" | "runtime-resolved";
      mimeTypeHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "blob";
      blob: Blob;
      fileNameHint?: string;
      mimeTypeHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "array-buffer";
      bytes: ArrayBuffer;
      fileNameHint?: string;
      mimeTypeHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "uint8-array";
      bytes: Uint8Array;
      fileNameHint?: string;
      mimeTypeHint?: string;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>
  | Readonly<{
      kind: "stream";
      stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
      fileNameHint?: string;
      mimeTypeHint?: string;
      byteLengthHint?: number;
      package?: ModelPackage;
      provenance?: ModelProvenance;
    }>;

export type ResourceReference = Readonly<{
  path: string;
  contentType?: string;
  integrity?: string;
}>;

export type ResolvedResource = Readonly<{
  path: string;
  bytes: Uint8Array;
  contentType?: string;
  contentHash: string;
  rangeSupported: boolean;
}>;

export interface ResourceResolver {
  resolve(reference: string | ResourceReference, options?: ResolveResourceOptions): Promise<ResolvedResource>;
}

export type ResolveResourceOptions = Readonly<{
  signal?: AbortSignal;
  range?: Readonly<{ start: number; end?: number }>;
}>;

export type FetchPolicy = Readonly<{
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}>;

export type RuntimeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ReadFile = (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
export type HashBytes = (bytes: Uint8Array) => Promise<string>;
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type BlobStorageUrlResolver = (baseUrl: string, reference: string) => string | Promise<string>;

export type RuntimeDependencies = Readonly<{
  fetch?: RuntimeFetch;
  readFile?: ReadFile;
  hashBytes?: HashBytes;
  sleep?: Sleep;
  blobStorageUrlResolver?: BlobStorageUrlResolver;
}>;

export type ResolvedModelSource = Readonly<{
  source: ModelSource;
  bytes: Uint8Array;
  contentType?: string;
  fileName?: string;
  contentHash: string;
  rangeSupported: boolean;
  resourceResolver: ResourceResolver;
}>;

export type SniffInput = Readonly<{
  bytes: Uint8Array;
  contentType?: string;
  fileName?: string;
  sourceKind: ModelSourceKind;
}>;

export type AdapterLoadContext = Readonly<{
  signal: AbortSignal;
  mode: "strict" | "tolerant" | "forensic";
  execution: "main" | "worker";
  adapterOptions: unknown;
}>;

export type AdapterLoadResult<TCanonicalModel, TRendererReady = unknown> = Readonly<{
  canonicalModel: TCanonicalModel;
  rendererReady?: TRendererReady;
  diagnostics?: readonly unknown[];
}>;

export interface ModelAdapter<TCanonicalModel, TRendererReady = unknown> {
  readonly formatId: string;
  readonly supportsWorker?: boolean;
  sniff(input: SniffInput): number | boolean;
  load(
    input: ResolvedModelSource,
    context: AdapterLoadContext,
  ): Promise<AdapterLoadResult<TCanonicalModel, TRendererReady>>;
}

export type AdapterModule<TCanonicalModel, TRendererReady = unknown> =
  | ModelAdapter<TCanonicalModel, TRendererReady>
  | Readonly<{ default: ModelAdapter<TCanonicalModel, TRendererReady> }>;

export type AdapterRegistration<TCanonicalModel = unknown, TRendererReady = unknown> = Readonly<{
  formatId: string;
  extensions?: readonly string[];
  mimeTypes?: readonly string[];
  sniff?: (input: SniffInput) => number | boolean;
  load: () => Promise<AdapterModule<TCanonicalModel, TRendererReady>>;
}>;

export type WorkerLoadRequest = Readonly<{
  formatId: string;
  input: ResolvedModelSource;
  context: AdapterLoadContext;
}>;

export interface WorkerDispatcher {
  dispatch<TCanonicalModel, TRendererReady = unknown>(
    request: WorkerLoadRequest,
  ): Promise<AdapterLoadResult<TCanonicalModel, TRendererReady>>;
}

export type ModelCache = Readonly<{
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
}>;

export type LoadModelOptions = Readonly<{
  signal?: AbortSignal;
  mode?: "strict" | "tolerant" | "forensic";
  adapterOptions?: unknown;
  formatId?: string;
  fetchPolicy?: FetchPolicy;
  integrity?: string;
  useCache?: boolean;
  worker?: Readonly<{
    mode?: "auto" | "never" | "always";
  }>;
}>;

export type ModelLoadResult<TCanonicalModel, TRendererReady = unknown> = Readonly<{
  canonicalModel: TCanonicalModel;
  rendererReady?: TRendererReady;
  diagnostics?: readonly unknown[];
  contentHash: string;
  cacheKey: string;
  fromCache: boolean;
  contentType?: string;
  sourceKind: ModelSourceKind;
}>;

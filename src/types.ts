import type {
  GpuModelDiagnosticMode, GpuModelDocument,
  ModelSource as CoreModelSource, ModelProvenance as CoreModelProvenance,
} from "@plasius/gpu-model-core";

export type { GpuModelDiagnosticMode, GpuModelDocument, GpuModelConversionDiagnostic } from "@plasius/gpu-model-core";

/** Default ceiling per entrypoint or related resource: 64 MiB. */
export const DEFAULT_MODEL_MAX_BYTES = 64 * 1024 * 1024;

/** Canonical source and policy contracts stay owned by the published core. */
export type ModelSourceKind = CoreModelSource["kind"];
export type ModelProvenance = CoreModelProvenance;

export type ModelResourceInput = Readonly<{
  bytes: ArrayBuffer | Blob | Uint8Array;
  contentType?: string;
  integrity?: string;
}>;

export type ModelPackage = Readonly<{
  entrypoint?: string;
  baseUrl?: string;
  resources?: Readonly<Record<string, ModelResourceInput>>;
  /** Closed packages refuse aliases, missing files and all network fallback. */
  resourcePolicy?: "closed";
}>;

/** Runtime acquisition extends canonical IO with package-resource resolution. */
export type ModelSource = CoreModelSource & Readonly<{ package?: ModelPackage }>;

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
  /** Tightens the inherited acquisition ceiling for this resource. */
  maxBytes?: number;
  signal?: AbortSignal;
  range?: Readonly<{ start: number; end?: number }>;
}>;

export type FetchPolicy = Readonly<{
  /** Maximum bytes per entrypoint/resource, including non-HTTP sources. Default 64 MiB. */
  maxBytes?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}>;

export type RuntimeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Providers must enforce maxBytes during I/O; runtime also checks returned bytes. */
export type ReadFile = (path: string, signal?: AbortSignal, options?: Readonly<{ maxBytes: number }>) => Promise<Uint8Array>;
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
  mode: GpuModelDiagnosticMode;
  execution: "main" | "worker";
  adapterOptions: unknown;
}>;

export type AdapterLoadResult<TCanonicalModel = GpuModelDocument, TRendererReady = unknown> = Readonly<{
  canonicalModel: TCanonicalModel;
  rendererReady?: TRendererReady;
  diagnostics?: readonly unknown[];
}>;

export interface ModelAdapter<TCanonicalModel = GpuModelDocument, TRendererReady = unknown> {
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
  mode?: GpuModelDiagnosticMode;
  adapterOptions?: unknown;
  formatId?: string;
  fetchPolicy?: FetchPolicy;
  integrity?: string;
  useCache?: boolean;
  worker?: Readonly<{
    mode?: "auto" | "never" | "always";
  }>;
}>;

export type ModelLoadResult<TCanonicalModel = GpuModelDocument, TRendererReady = unknown> = Readonly<{
  canonicalModel: TCanonicalModel;
  rendererReady?: TRendererReady;
  diagnostics?: readonly unknown[];
  contentHash: string;
  cacheKey: string;
  fromCache: boolean;
  contentType?: string;
  sourceKind: ModelSourceKind;
}>;

# @plasius/gpu-model-runtime

Adapter discovery, source resolution, loading orchestration, bounded residency,
and worker offload.

This repository is the dedicated package boundary defined by ADR 0094.

The runtime owns orchestration only. Canonical model documents, diagnostics, and
renderer-specific data remain owned by the corresponding `@plasius/gpu-model-*`
packages. Published `@plasius/gpu-model-core@0.6.0` supplies source, provenance,
diagnostic-mode and canonical document types; runtime `ModelSource` adds the
optional package-resource descriptor. Existing explicit generic model types
remain supported. `ModelAdapter`, `AdapterLoadResult` and `ModelLoadResult` now
have `GpuModelDocument` as their optional type default. `loadModel<T>()` remains
explicitly generic; an unannotated call still returns an unknown model.

Core imports in runtime source are type-only, so importing this runtime does not
execute core validators or eagerly load concrete adapters. Adapters own canonical
validation and strict/tolerant/forensic policy through the core factories and
evaluator. Runtime returns the resulting document and diagnostic ledger without
rewriting them. Its `ModelAdapter` is an acquisition/worker port, distinct from
core's inspect/load/export/validate conversion interface: bind a format adapter's
factory to the provided resource resolver and map its result in that port;
do not cast a format module directly to a runtime adapter.

## Runtime behavior

- `ModelSource` accepts file paths through an injected reader, URLs, Blob-storage
  style URLs, `Blob`, `ArrayBuffer`, `Uint8Array`, and async/readable streams.
- `AdapterRegistry` keeps format modules lazy: registrations provide a cheap
  content/MIME/extension sniff function and dynamically import the adapter only
  after a match.
- `PackageResourceResolver` keeps package-relative buffers and textures on the
  same resource boundary. Memory resources are resolved without a network hop;
  URL resources inherit the source base URL, and Blob-storage sources may use an
  injected signed-URL resolver.
- Remote reads use explicit timeouts, bounded retries for transient HTTP
  statuses, abort signals, optional byte ranges, response content types, and
  SHA-256 integrity checks.
- `MemoryModelCache` keys loaded output by content hash, adapter format, and
  stable adapter options, acquisition byte ceiling, diagnostic mode and actual
  execution path. Call `runtime.invalidate()` to clear all entries or entries
  for one content hash.
- Worker execution is opt-in through a `WorkerDispatcher`; consumers that do
  not provide one stay on the main execution path.

Example:

```ts
import { AdapterRegistry, ModelRuntime, type GpuModelDocument } from "@plasius/gpu-model-runtime";

const registry = new AdapterRegistry().register({
  formatId: "gltf",
  extensions: ["gltf", "glb"],
  sniff: ({ bytes }) => bytes[0] === 0x67,
  // A consumer-owned bridge implementing this runtime's ModelAdapter port.
  // Its factory binds the format adapter to input.resourceResolver.
  load: () => import("./model-adapters/gltf.js"),
});

const runtime = new ModelRuntime({ registry });
const result = await runtime.loadModel<GpuModelDocument>({
  kind: "blob-storage-url",
  url: "https://storage.example.invalid/models/scene.glb?<signed-url>",
});

result.canonicalModel;
result.rendererReady;
```

A tolerant or forensic cache entry cannot satisfy a strict request. Mandatory
worker support is checked before cache lookup; main and worker results have
separate keys, while `auto` and `always` can share a result when both select the
worker. Adapters and dispatchers injected by the consumer are trusted execution
ports; they must honor signals, enforce their own parsing/decoding budgets, and
return core-validated documents. This package does not supply a Worker script or
serialize resolver functions across threads. A dispatcher binds its own RPC and
resource-resolution transport.

New cache keys intentionally cold-start existing external caches. This is a
patch-compatible policy fix with additive canonical type defaults and one exact
published dependency (core 0.6.0, previously absent); no concrete adapter is added.
The new dependency has no runtime dependencies and requires the already-supported
Node 24. Installed package and strict ESM/CJS declaration checks verify the
published boundary. Do not use local workspace links.

## Bounded source acquisition

Every entrypoint and related resource has a default ceiling of 64 MiB
(`DEFAULT_MODEL_MAX_BYTES`). `fetchPolicy.maxBytes` applies to URLs, memory,
Blobs, streams, and injected file reads. Opt into a larger finite positive safe
integer only after budgeting for that workload:

```ts
await runtime.loadModel(source, {
  fetchPolicy: { maxBytes: 128 * 1024 * 1024, timeoutMs: 30_000 },
  signal: controller.signal,
});
// In an adapter, tighten the inherited ceiling for one texture:
await input.resourceResolver.resolve("textures/albedo.png", {
  maxBytes: 8 * 1024 * 1024,
  signal: context.signal,
});
```

A per-resolution limit can tighten the inherited ceiling, never enlarge it.
Known lengths are checked before reading/copying, and actual streamed bytes are
checked before retention even when a server omits/misstates Content-Length or
ignores Range. `byteLengthHint` can reject an oversized stream early; an
underestimate never disables actual-byte checks. Hashes still cover the admitted
bytes, including a returned range. Limits apply to decoded Fetch body bytes;
compressed Content-Length is only an additional early check.

In-memory ArrayBuffer and Uint8Array entrypoints and related package resources
are copied into runtime-owned storage after the byte ceiling is checked. Hashing,
integrity verification and adapters use that same snapshot, so changing the
caller's backing storage while asynchronous checks run cannot change the admitted
resource. A typed view copies only its declared range, including Node Buffer and
cross-realm views. Blob/stream ownership remains unchanged. This adds one bounded
copy for ArrayBuffer inputs; acquisition does not retain the caller's backing
buffer or allocate a second owned snapshot for typed-array inputs.

Integrity accepts a 64-character SHA-256 hex digest (case-insensitive) or its
standard padded base64 encoding (case-sensitive), with an optional `sha256-`
prefix. The same verifier applies to fetched and in-memory package resources;
malformed or mismatched digests fail without retry. Cross-realm `Uint8Array`
stream chunks are accepted with the same limits and copy ownership, while other
typed-array kinds, DataViews and spoofed byte-array tags are rejected.

Oversize throws `ModelResourceTooLargeError` with code
`MODEL_RESOURCE_TOO_LARGE` and a fixed message containing no source identifiers.
It is not retried. Cancellation and acquisition deadlines stop pending reads,
cancel/release readers, and request iterator cleanup. An uncooperative producer
cannot delay the rejection, although its own background work cannot be forcibly
stopped. File-provider callbacks now receive a third `{ maxBytes }` argument;
they must enforce it incrementally during their own I/O and honor the signal.
The runtime checks returned file bytes before hashing or adapter use. Existing
two-argument providers remain callable but need review for pre-allocation limits.

The 30-second default `timeoutMs` now covers local/stream acquisition too;
for ModelRuntime it includes entrypoint fetching, retries and hashing. Each
related-resource resolution gets its own deadline and inherits caller abort.
Direct `fetchResource` retains a deadline per attempt, including retry delay.
Timeouts must be positive integers no larger than 2,147,483,647 milliseconds.

The ceiling is per resource, not a total process/model budget. Stream storage
grows geometrically with no per-chunk metadata list; live runtime copy storage
is at most twice the configured ceiling (excluding producer/network buffers and
hashing). Many tiny/empty chunks yield to the event loop periodically so timers
can cancel work. Adapters still own total resource count/bytes, decoded image or
mesh budgets, concurrency and format validation. ModelResidencyManager separately
bounds resident CPU/GPU resources. Cache identity includes maxBytes so a model
loaded with a larger ceiling cannot bypass a later stricter request.

This behavior requires a **minor release in the current 0.x series**: previously
accepted resources above 64 MiB require an explicit larger budget. The release
pipeline allocates the version; consumers must wait for a verified npm release.
Disabling `gpu.model.conversion.enabled` at the consumer prevents conversion and
restores its tested fallback. Byte limits remain enforced whenever this runtime
is called; there is no safety-check bypass flag.

The implementation uses browser Web Streams, Blob, AbortController, timers and
Web Crypto (or injected hashing), with no filesystem dependency. Node 24 tests
exercise those APIs, streaming/range/integrity semantics and both ESM/CJS builds;
real-browser integration remains a consumer validation responsibility. See
[ADR-0008](docs/adrs/adr-0008-bounded-source-acquisition.md).

## Model residency

`ModelResidencyManager` owns the lifetime of promoted runtime models shared by
world tiles, zones, editor previews, and other GPU consumers. Cache identity is
the canonical `ModelAssetRef.contentHash` plus LOD and optional partition ID, so
many spatial instances can share one adapter load and one GPU resource.

The manager provides:

- reference-counted, idempotent leases;
- per-acquisition cancellation without aborting other interested consumers;
- cancellation of a shared load once every interested consumer has gone away;
- separate hard CPU/GPU byte budgets and bounded in-flight adapter work;
- release of timed-out concurrency slots even when an adapter ignores abort;
- completion of asynchronous eviction disposal before replacement loading;
- deterministic eviction by lowest retained priority, least-recent use, and
  cache key;
- exact-once disposal for evicted, failed-integrity, cancelled, timed-out,
  late-completing, and shutdown resources; and
- immutable accounting metrics for runtime diagnostics.

Loaders remain adapter-driven. The package does not eagerly import any model
format implementation.

```ts
import { ModelResidencyManager } from "@plasius/gpu-model-runtime";

const models = new ModelResidencyManager({
  budget: {
    maxCpuBytes: 256 * 1024 * 1024,
    maxGpuBytes: 384 * 1024 * 1024,
    maxInFlightLoads: 4,
  },
  load: async ({ assetRef, lod, partitionId, signal }) => {
    const loaded = await modelAdapter.load({
      assetRef,
      lod,
      partitionId,
      signal,
    });
    return {
      resource: loaded.resource,
      contentHash: loaded.contentHash,
      cpuBytes: loaded.cpuBytes,
      gpuBytes: loaded.gpuBytes,
      dispose: loaded.dispose,
    };
  },
});

const lease = await models.acquire({
  assetRef,
  lod: 0,
  priority: 100,
  estimatedCpuBytes: 4 * 1024 * 1024,
  estimatedGpuBytes: 12 * 1024 * 1024,
  signal,
});

render(lease.resource);
lease.release();
```

Call `setPriority` and `setPinned` on a live lease as visibility changes. Call
`shutdown()` when the owning renderer is destroyed; it aborts pending work and
disposes resident resources without waiting indefinitely for an adapter that
ignores abort. If detached adapter work eventually completes, its late resource
is still disposed exactly once.

Canonical model identity comes from `@plasius/asset-contracts`; this package
does not define a parallel asset catalog. See
[`docs/adrs/adr-0006-content-addressed-model-residency.md`](docs/adrs/adr-0006-content-addressed-model-residency.md).

## Rollout

- Feature flag: gpu.model.conversion.enabled
- Origin-shard integration flag: world.persistent-atlas.enabled
- Capability: none for this package-only layer
- Rollback: disable the feature flag and keep the published package version pinned to the last validated release

## Development

Requires Node.js 24 and npm.

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

## Load an integrity-qualified exported package

`loadModelPackage(runtime, { manifest, packageManifest, files }, options)` is an
opt-in complete-inventory loader. It reuses published asset-contracts0.8.3
qualification before parsing the declared entrypoint. Each file is
`{ path, bytes: Uint8Array, contentType }`; the manifest supplies exact lengths,
SHA256 digests and roles. Hosts acquire the files through their existing bounded,
authorized transport. This API does not extract archives or fetch inventory URLs.

```ts
import { loadModelPackage } from "@plasius/gpu-model-runtime";

// runtime already has the desired lazy format adapter registered.
const loaded = await loadModelPackage(runtime, exportedPackage, {
  signal: abortController.signal, timeoutMs: 10_000, mode: "strict",
});
```

The loader copies metadata/byte ranges before its first await and rejects the
whole package before adapter use if any declared file is missing or invalid.
Related resources resolve only exact declared paths relative to the entrypoint directory, with mandatory native digest
checks; URL/missing-file fallback and content-type overrides are refused. Each
read returns an independent byte array. No failure silently retries the same
invalid package through legacy loading.

Limits (`MODEL_PACKAGE_LOAD_LIMITS`): 1,024 files, 16 MiB per file, 64 MiB total,
65,536 metadata values/16 levels/2,048 characters per metadata string; all byte
budgets checked before copies. Default total deadline30s, maximum60s. Cancellation
also stops waiting for uncooperative asynchronous adapters; hosts own worker/CPU
termination for synchronous parsing. Runtime stage boundaries check the propagated
signal after source acquisition, adapter registration and cache reads, immediately
before parser/worker execution, and before cache writes. A registration that
settles after cancellation cannot start parsing or dispatch a worker; a late
parser result cannot start a cache write. Waiting for an already-started host
cache write can be cancelled, but its side effects remain host-owned. The same
signal checks apply to legacy `loadModel` without changing its cache keys or
acquisition timeout policy. There are no retries. Errors are fresh,
value-free `ModelPackageLoadError` instances with invalid-input, limit-exceeded,
package-invalid, load-failed, aborted or deadline-exceeded codes.

The new path does not read/write the legacy entrypoint-only cache. Its returned
`model-package-v1:<closure SHA256>:<policy key>` cacheKey binds sorted descriptor
identities and asset/version/entrypoint; retain the full key for host caches.
Legacy loadModel and its cache/source kinds are unchanged. The contracts module
is imported dynamically only when this API is called.

Hosts evaluate the existing remotely stored `gpu.model.conversion.enabled` flag.
Disabled/unavailable/rollback selects their existing compatible consumer route;
mandatory integrity never becomes optional. No capability or env rollout gate is
introduced. See [ADR0011](docs/adrs/adr-0011-integrity-qualified-model-package-loading.md)
and the [design](docs/design/qualified-model-packages.md). This boundary does not
certify a parser, renderer, promotion or human approval. Producer and renderer
bridge must share their required core instance/module format; otherwise reverify
transferred documents in the receiving core using a trusted verification port,
as the bridge documents. Do not cast or bypass a private verification brand.

## License

Apache-2.0. See LICENSE, SECURITY.md, and the files under legal/.

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI accepts only branch pushes
in this repository and uses the `Public CI - Quarantined` runner group with
explicit `[self-hosted, Linux, X64]` labels. Pull requests and fork events cannot
execute these jobs. The group admits the reviewed `ci.yml` on `main`; a reviewed
branch ref can be temporarily admitted for PR validation after its exact workflow
commit SHA is reviewed and recorded, then removed after merge. A SHA-only entry
does not admit a branch-triggered run; use the exact reviewed branch ref. Each job has a timeout and a newer push
cancels stale validation for the same ref. Publication uses the GitHub-hosted `production` job with
Node 24 and a pinned npm 11.6.2 client. It is token-free and proceeds only while the prepared SHA
is the exact `main` head after successful push-triggered CI. Do not dispatch CD
until the npm trusted-publisher binding is verified.

The parent rollout flag `platform.public-artifact-integrity.enabled` stages public
distribution; enabled, disabled and rollback states all retain mandatory artifact
admission and runner/publication boundaries. To roll back an unsafe channel,
disable the affected workflow through GitHub Actions and restore the last reviewed
workflow through a forward PR; never add hosted CI fallback, token publication or
restore excluded administrative files. See [ADR-0009](docs/adrs/adr-0009-quarantined-self-hosted-ci.md).
<!-- END PLASIUS RELEASE INTEGRITY -->

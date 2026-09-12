# @plasius/gpu-model-runtime

Adapter discovery, source resolution, loading orchestration, bounded residency,
and worker offload.

This repository is the dedicated package boundary defined by ADR 0094.

The runtime owns orchestration only. Canonical model documents, diagnostics, and
renderer-specific data remain owned by the corresponding `@plasius/gpu-model-*`
packages and are carried through generic type parameters until the core package
is released.

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
  stable adapter options and acquisition byte ceiling. Call `runtime.invalidate()` to clear all entries or
  entries for one content hash.
- Worker execution is opt-in through a `WorkerDispatcher`; consumers that do
  not provide one stay on the main execution path.

Example:

```ts
const registry = new AdapterRegistry().register({
  formatId: "gltf",
  extensions: ["gltf", "glb"],
  sniff: ({ bytes }) => bytes[0] === 0x67,
  load: () => import("@plasius/gpu-model-gltf"),
});

const runtime = new ModelRuntime({ registry });
const result = await runtime.loadModel({
  kind: "blob-storage-url",
  url: "https://storage.example.invalid/models/scene.glb?<signed-url>",
});

result.canonicalModel;
result.rendererReady;
```

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

## License

Apache-2.0. See LICENSE, SECURITY.md, and the files under legal/.

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI runs on explicit
GitHub-hosted runners. Publication uses the GitHub-hosted `production` job with
Node 24 and a pinned npm 11.6.2 client. It is token-free and proceeds only while the prepared SHA
is the exact `main` head after successful push-triggered CI. Do not dispatch CD
until the npm trusted-publisher binding is verified.
<!-- END PLASIUS RELEASE INTEGRITY -->

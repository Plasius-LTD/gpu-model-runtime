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
  stable adapter options. Call `runtime.invalidate()` to clear all entries or
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

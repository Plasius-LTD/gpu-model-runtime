# ADR-0005: On-Demand Loading Runtime Boundary

- Status: Accepted
- Date: 2026-07-15
- Feature flag: `gpu.model.conversion.enabled`

## Context

The runtime must load model packages from local files, memory, HTTP, and
Blob-storage style URLs while preserving relative buffers and textures. The
canonical document and diagnostics contracts belong to
`@plasius/gpu-model-core`; format adapters and renderer bridges are separate
packages. The core package is not yet published, so the runtime cannot take a
local or unpublished dependency without violating the package boundary.

## Decision

`@plasius/gpu-model-runtime` exposes generic orchestration ports:

- `ModelSource` and `PackageResourceResolver` resolve entrypoint and related
  resources through injected file, fetch, and Blob-storage URL dependencies.
- `AdapterRegistry` stores cheap sniff metadata and invokes adapter module
  loaders only after format selection. Runtime entrypoints do not import heavy
  concrete adapters by default.
- `ModelRuntime` computes a content hash, selects an adapter, applies bounded
  fetch/retry/abort/integrity policy, and returns generic canonical and optional
  renderer-ready values supplied by the adapter.
- `MemoryModelCache` keys results by content hash, format, and stable adapter
  options. Invalidation is explicit and can target one content hash or the
  complete cache.
- Worker execution is optional. A consumer supplies `WorkerDispatcher` when it
  has a worker environment; otherwise loading remains on the main path.

The runtime deliberately does not define `GpuModelDocument`, diagnostics
taxonomy, parser SDKs, filesystem imports, storage credentials, or renderer
upload code. The published core package will supply those types to consumers
through the generic runtime boundary.

## Alternatives considered

- Import `@plasius/gpu-model-core` from a local checkout: rejected because it
  would create an unpublished/local package reference and break reproducible
  package installation.
- Import every format adapter from the runtime entrypoint: rejected because it
  increases first-load cost and couples unrelated parser dependencies.
- Let each adapter fetch its own relative resources: rejected because it would
  duplicate credential, retry, timeout, integrity, and cache policy.

## Rollout and rollback

The runtime package exposes the inherited `gpu.model.conversion.enabled` rollout
key as package metadata but does not evaluate remote flags itself. The consumer
or orchestration service is the source-of-truth evaluator. Disable the flag and
pin consumers to the last validated package version to roll back; no runtime
cache or source data migration is required.

## NFR impact

- Security/privacy: credentials stay in injected headers/resolvers and are not
  copied into diagnostics; source bytes are not logged.
- Reliability: timeouts, abort propagation, bounded retries, and explicit
  integrity failures prevent indefinite or silently corrupt loads.
- Performance: format modules and worker execution are lazy/optional, and cache
  keys avoid repeated adapter work for identical inputs.
- Accessibility/SEO: not applicable to this package-only runtime boundary.

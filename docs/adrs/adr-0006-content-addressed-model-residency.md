# ADR-0006: Content-Addressed Model Residency

## Status

- Accepted
- Date: 2026-07-13
- Version: 1.0
- Supersedes: N/A
- Superseded by: N/A

## Tags

models, residency, gpu, cache, disposal, cancellation

## Context

World zones, editor previews, and other GPU consumers can reference the same
promoted model through many visible instances. Loading per instance wastes CPU
and GPU memory, while ad hoc cleanup risks leaking or disposing one GPU resource
more than once. Fast camera movement also makes pending low-priority loads
obsolete before they complete.

Canonical `ModelAssetRef` identity and partition metadata are owned by
`@plasius/asset-contracts`; this package must consume that identity rather than
create a second asset catalog.

## Decision

Add `ModelResidencyManager` with content-addressed, reference-counted lifetime
management.

- The cache key is the canonical content hash plus requested asset/partition
  LOD identity. Equivalent references acquire one shared load and resource.
- `acquire` accepts an abort signal, byte estimate, and LOD priority. A caller
  receives one idempotent lease whose `release` decrements the reference count
  exactly once.
- A pending load is aborted when every interested acquisition is cancelled or
  released. One caller aborting does not cancel work still required elsewhere.
- CPU and GPU byte totals are observed separately. Unreferenced resources are
  evicted by lowest LOD priority and least-recent use until both hard limits are
  satisfied.
- The loader returns an explicit disposer. Successful resources are disposed
  exactly once, including late completion after cancellation and manager-wide
  shutdown.
- Failed loads are not retained as resident resources; subsequent acquisition
  may retry.

## Alternatives Considered

- Instance-keyed caches were rejected because intersecting world zones would
  load identical model bytes repeatedly.
- Garbage-collection-only cleanup was rejected because GPU resources require
  deterministic explicit disposal.
- Cancelling a shared load on the first aborted consumer was rejected because
  it can break other visible zones that still reference the model.

## Consequences

- Consumers can compose many spatial instances over one bounded model cache.
- Resource accounting and disposal are deterministic and stress-testable.
- Callers must hold and release leases deliberately and must supply accurate
  post-load byte usage when it differs from the estimate.

## Related Decisions

- `gpu-world-generator` ADR-0010: Destination-Owned World Streaming
- `asset-contracts` ADR-0002: Model Resolution Contracts

## References

- Plasius-LTD/plasius-ltd-site#1517
- Plasius-LTD/gpu-model-runtime#3

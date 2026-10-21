# ADR-0010: Published Core Contracts and Policy-Aware Load Caching

- Status: Accepted
- Date: 2026-10-21
- Project: runtime#1, site#1164, Feature site#1149, Epic site#1147
- Feature flag: `gpu.model.conversion.enabled`; no capability
- Refines ADR-0005's temporary unpublished-core accommodation

## Problem

Core is now published, but runtime still duplicates its source/provenance/mode
types and calls it a future dependency. Existing cache keys omit diagnostic mode
and execution. Regression tests prove that a tolerant result can satisfy strict
loading, and main/shared-worker caches can bypass mandatory worker checks.

## Decision

Depend on the exact registry release `@plasius/gpu-model-core@0.6.0` (previously
absent). Alias its source/provenance/mode contracts and extend ModelSource only
with runtime package resources. Re-export document/diagnostic types and provide
optional canonical defaults for adapter/result types. Preserve existing explicit
generics and unannotated loadModel's unknown result. Imports are type-only; core
validation/repair policy stays in the adapter, not in a second runtime validator.
The generic acquisition/worker port is distinct from core's conversion registry;
format factories must be bound to acquisition/resource ports by a bridge. No
concrete format dependency or renderer upload code belongs in this package.

Choose effective execution and validate mandatory worker support before cache
access. Include mode and effective main/worker execution alongside source hash,
format, options and byte ceiling. Auto and always may share worker output only
when both actually choose a worker. Preserve adapter diagnostics by reference;
strict rejection cannot be replaced by cached repairs from another mode.

## Alternatives

- Copying types or using a local core link retains drift and violates published
  package reuse. The registry dependency is required by site bootstrap1164.
- Replacing runtime's generic port with core's complete conversion registry breaks
  existing adapters and mixes acquisition/worker policy with conversion ownership.
- Merely annotating loadModel's inferred result as canonical would overpromise
  validation for existing arbitrary generic adapters.
- Disabling caching or keying only by requested worker mode loses useful reuse;
  validating after cache lookup still permits policy bypass.

## Verification and NFRs

Five regression cases fail against previous source. Test real published core
document/resource verification and strict/tolerant/forensic diagnostics, lazy
factory invocation, generic/source compatibility and unchanged diagnostics.
Retain full bounded acquisition, cancellation, integrity, residency, workflow and
package admission suites; require >=80% coverage and every changed runtime file
in LCOV. Validate strict ESM/CJS declarations and installed modules.

Security/privacy: no new IO, logs, credentials or payload retention; core remains
the policy owner. Performance/reliability: finite key fields and separate policy
entries prevent incorrect reuse; existing byte/concurrency/timeout controls stay
mandatory. Consumers still own aggregate cache capacity and worker RPC/budgets.
Accessibility, SEO and backend secretRefs are N/A for this standalone package.

## Release and rollback

This is a patch-compatible correction plus additive type defaults and the exact
published core dependency, which has no runtime dependencies and supports the
existing Node24 baseline. Old external cache entries become cold misses; callers
must not parse cacheKey as a public schema. No data migration is needed.

Use a reviewed PR, quarantined exact-ref branch/main CI, and existing main cd.yml
production OIDC publication. Only the pipeline allocates/promotes release metadata.
Verify registry integrity/provenance and consumer installation before closing.
Consumer-owned remote flag enabled admits conversion; disabled/rollback uses its
tested fallback and pinned prior package. Safety checks remain unconditional.
Do not enable new consumer surfaces or mutate the flag for this package release.

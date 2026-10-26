# ADR-0011: Integrity-qualified model package loading

- Status: Accepted
- Date: 2026-10-26
- Project: [runtime Task35](https://github.com/Plasius-LTD/gpu-model-runtime/issues/35), site Feature1153 / ADR0094
- Inherited adoption flag: `gpu.model.conversion.enabled`; capability N/A

## Problem

Generic ModelPackage resources resolve related bytes but do not qualify a durable
manifest, entrypoint and complete inventory. The site Story1162 design requires a
separate package-loader integration. Entrypoint-only caches can also reuse stale
textures when two exported packages have the same entrypoint bytes.

## Decision

Add opt-in `loadModelPackage(runtime, input, options)`. Reuse the published
`@plasius/asset-contracts@0.8.3` manifest qualifier, loaded dynamically. The runtime
snapshots bounded JSON metadata and exact typed-array ranges synchronously, then
qualifies every file before passing the declared entrypoint to existing
`ModelRuntime.loadModel`. Schema, package paths/roles/content/hash validation stay
contracts-owned; format parsing and semantic diagnostics stay adapter/core-owned.

This acquired-inventory boundary accepts Uint8Array files, not archives, paths or
URLs. Hosts obtain a complete inventory through their existing bounded transport.
No new network, SDK, archive extraction, renderer or promotion policy is added.
The existing file/memory/URL/Blob-storage loadModel sources remain compatible.

Closed resource resolution accepts only exact declared paths relative to the entrypoint directory. It refuses aliases,
undeclared files/URLs, MIME overrides and digest bypasses. Native SHA256 checks
bind every related-resource read, even if a legacy runtime uses an injected hash
provider. Returned byte arrays are independent per resolution. Trusted adapters
can read their package bytes; mutation cannot make changed bytes pass integrity.

The new API disables the legacy entrypoint-only cache, without changing legacy
cache policy. Its returned cacheKey prefixes the existing policy key with a native
SHA256 closure identity over asset/version/source-adapter, entrypoint and sorted
file path/role/type/length/digests. Equivalent inventory order is stable. Hosts
must preserve the full key for any external cache and own its capacity/retention.

Budgets: 1,024 files, 16 MiB per file, 64 MiB total bytes, 65,536 metadata values,
16 levels, 2,048 characters per metadata string. All file/aggregate limits are
checked before allocating byte copies. These tighter acquisition limits do not
change the qualifier's own limits. Default total deadline30s, maximum60s; the
caller may tighten it. Cancellation/deadline spans lazy import, qualification,
hashing and adapter execution. An uncooperative promise cannot hold the caller
open; hosts still own worker termination/CPU preemption for synchronous parsers.
No retries or partially accepted output are introduced.

Fixed fresh `ModelPackageLoadError` codes contain no caller/parser exception,
path, URI, payload, or abort reason. Input descriptors are inspected without
calling getters; only private error categories are recognized. JSON snapshot
budgets protect acquisition, without duplicating manifest schema validation.

## Alternatives

- Treat generic memory resources as an integrity-qualified package: rejected;
  it omits durable inventory/entrypoint qualification.
- Duplicate manifest validation in runtime: rejected; contracts already owns it.
- Eagerly import contracts or a format SDK: rejected; legacy consumers should not
  execute the opt-in qualifier dependency graph before adoption.
- Cache by entrypoint alone: rejected; resource changes would collide.
- Add archive/network loading in this change: deferred; it requires separately
  bounded transports and authorization, beyond this integration boundary.

## Rollout, compatibility and release

Hosts evaluate the registered backend flag `gpu.model.conversion.enabled` and
choose this API only for qualified consumers. Disabled/unavailable/rollback keeps
the previous consumer route; integrity failures must remain failures and must
never trigger an unsafe legacy retry of the same invalid package. No env override
or user entitlement is introduced. Mandatory safety is unconditional.

Public APIs are additive; existing core0.6.0 and loader/cache behavior stay.
Required dependency changes only: contracts range^0.4.5 becomes exact0.8.3;
its released shader/core transitives follow its own lock resolution. No unrelated
upgrade. Qualification uses published packages, never local workspace links.

Unit/integration tests cover pre-parse qualification, mutation isolation, reload,
closed references, cache isolation, hostile exceptions/signals, budgets, deadline
and rollout composition. Full coverage/changed-source LCOV, lint/types/build,
audit/artifact/pack and actual packed/public ESM/CJS/types/browser checks gate
normal PR/exact-main CI and main cd.yml/production hosted OIDC publication.
No site or ACA deployment is part of this standalone package release.

## NFR implications

Security/privacy: complete inventory verification, no unlisted I/O, bounded
payload-free failures and synthetic fixtures. Reliability/performance: bounded
copying, lazy qualification, linear descriptor lookup, total deadlines and no
retries. Testability/maintainability: existing canonical owners and explicit
public limits/errors. Observability: stable codes; hosts own redacted telemetry.
Portability: Web APIs and dual modules, no Node runtime import. Accessibility/SEO
are N/A to the headless API. Actual cross-format/physical renderer qualification
remains Story1160's independent gate; this API does not certify CAD parsers.

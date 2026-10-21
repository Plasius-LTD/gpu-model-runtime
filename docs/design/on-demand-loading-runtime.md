# On-Demand Loading Runtime Design

## Scope

This design implements Story #1159 under the `gpu.model.conversion.enabled`
feature boundary. It covers source acquisition and related-resource resolution;
format-specific parsing remains in lazy adapter packages.

## Flow

1. `ModelRuntime` converts the declared source into bytes using an injected file
   reader, fetch policy, Blob reader, or stream reader.
2. The runtime records response content type, range support, source filename, and
   a content hash. It builds a `PackageResourceResolver` using the same fetch
   policy and source base URL.
3. `AdapterRegistry` scores registrations by explicit format, MIME type,
   extension, and magic-byte sniffing. Only the selected registration is
   dynamically imported.
4. The runtime returns a cached result when the content hash, format, and
   adapter options, acquisition ceiling, diagnostic mode and effective execution
   match. Otherwise it calls the adapter on the main path or through an injected
   worker dispatcher.
5. Adapters return generic canonical and optional renderer-ready values. The
   published `@plasius/gpu-model-core@0.6.0` dependency supplies canonical IO,
   provenance, diagnostic-mode and document contracts. The generic runtime API
   remains compatible; its narrower acquisition port does not replace the core
   conversion registry or implement format parsing.

## Failure behavior

- Missing injected file readers or fetch implementations fail fast with a
  controlled error.
- HTTP 408, 425, 429, and 5xx responses receive a bounded retry budget with
  backoff. Other error responses fail immediately.
- Caller abort signals and request timeouts cancel the active request and
  propagate an `AbortError`.
- Integrity mismatches fail the load; they never enter the model cache.
- A requested worker path fails closed when the adapter or dispatcher cannot
  support it. Automatic worker mode falls back to the main path.

## Verification matrix

The runtime test suite covers memory package resources, relative URL resources,
content type and range propagation, transient retries, integrity failure,
cache/invalidation behavior, injected file reads, lazy adapter selection, and
worker dispatch.

## Acquisition budget extension (runtime#6)

ADR-0008 defines the implementation plan and verification matrix for per-resource
64 MiB default ceilings. `fetchPolicy.maxBytes` is inherited across entrypoint
and related resources; a resolver's maxBytes can tighten it. Known lengths reject
before materialization, and streamed data is checked before retention. Local
source reads receive the same bounded cancellation/deadline behavior as HTTP.
Injected file readers receive the budget and own enforcement during their I/O.

The adapter still owns aggregate model and decoded-resource quotas; runtime
residency owns retained CPU/GPU accounting. The adapter must consume a verified
published runtime version, with runtime#7's release prerequisites resolved first.
No unpublished reference or duplicated resolver is an acceptable dependency path.

Runtime#7 now has verified 0.2.5 release evidence. Runtime#6's final conformance
pass accepts byte chunks from other JavaScript realms via intrinsic element-kind
checks, rejects spoofed/non-byte views, and keeps incremental limits/copy ownership.
Fetched and memory resources share encoding-aware SHA-256 verification: hex is
case-insensitive and padded base64 is case-sensitive. The documented minor release
must include these regressions before downstream broad-import adoption.

## Canonical bootstrap completion (runtime#1)

ADR-0010 replaces the temporary unpublished-core accommodation in ADR-0005.
The runtime extends core ModelSource only with optional package resources. Core
factories/evaluator remain adapter-owned; no duplicate validator or repair policy
is introduced. Main/worker execution is decided and mandatory support validated
before cache access. Cache identity includes mode and execution, preserving strict
rejection after tolerant/forensic loads and worker requirements across shared
caches. Auto/always share worker results only when both actually select a worker.

Tests use a genuine core-verified point-mesh document and real diagnostic policy,
plus independent regression cases for mode isolation and worker cache behavior.
Full acquisition/residency suites, changed-file LCOV, frozen installation, dual
module/declaration consumers and approved exact-main CI/CD remain release gates.
This scoped runtime bootstrap does not complete parent Feature1149's downstream
adapter/renderer adoption or the separate PVOX loading Task11.

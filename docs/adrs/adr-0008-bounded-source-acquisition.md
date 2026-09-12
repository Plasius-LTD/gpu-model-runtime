# ADR-0008: Bounded Source Acquisition

- Status: Accepted for implementation; publication pending runtime#7
- Date: 2026-09-12
- Parent Feature: Plasius-LTD/plasius-ltd-site#1149
- Implementation Task: Plasius-LTD/gpu-model-runtime#6
- Dependent Task: Plasius-LTD/gpu-model-gltf#13
- Feature flag: `gpu.model.conversion.enabled`

## Context

The format adapter receives bytes after runtime acquisition. It cannot enforce
an allocation ceiling after an entire response or accumulated stream has already
been materialized. The published 0.2.0 resolver has retry/range/abort controls but
no byte budget. The broad glTF importer requires this owning-package extension
before it can meet its external-resource acceptance criteria.

## Decision

Use one finite `FetchPolicy.maxBytes` ceiling for entrypoint and related-resource
acquisition, defaulting to 64 MiB. `ResolveResourceOptions.maxBytes` can only
tighten it. Reject known oversize before acquisition/copy; check observed chunks
before retention and before bounded final copy. A geometric contiguous buffer
avoids unbounded chunk-metadata growth. Yield every 256 reads so an endless
empty-chunk source cannot starve cancellation timers. Do not assume Content-Length
or a Range request bounds actual returned/decompressed data.

Expose `ModelResourceTooLargeError` with fixed code/message; never retry oversize.
Preserve integrity over exactly the admitted bytes. Race pending producer work
against cancellation and a finite acquisition deadline; request cleanup without
awaiting an indefinitely stalled iterator. Cancel late HTTP responses after an
aborted fetch. Release listeners/readers on success and failure.

Apply source limits before hashing/cache/adapter work. Pass maxBytes to injected
file readers as an optional third argument, retaining source compatibility;
provider-owned I/O must enforce it internally, and runtime checks the result.
No filesystem adapter or dependency is added. Snapshot resolver policy and inherit
caller cancellation. Cache keys include the effective ceiling to prevent broader
cached resource admission from satisfying a stricter request.

This is a per-resource policy, not an aggregate model or decoded-resource quota.
Adapters/orchestrators retain those responsibilities. Safety checks always apply;
the remotely evaluated consumer feature flag governs discovery/adoption and the
consumer's fallback, with no package network flag lookup or bypass control.

## Alternatives

- Validate size only in each adapter: too late for acquisition allocation and
  duplicates the shared boundary.
- Buffer all chunks then check: permits retained byte/metadata growth first.
- Trust Content-Length or Range alone: ignores chunked/decompressed bodies and
  servers returning a full response instead of a range.
- Add local-only runtime references to the glTF adapter: violates publication
  and reproducibility policy. Publish the runtime first.

## Compatibility and release

The new finite default and local timeout narrow previously accepted inputs.
Use a minor bump in the current 0.x series with these migration instructions;
main/cd.yml prepares the actual unused version. Existing larger callers must set
an explicit reviewed ceiling. Existing injected file callbacks remain callable,
but must adopt the supplied budget for pre-allocation enforcement.

Release remains blocked by runtime#7 (publisher verification, release controls
and runner-policy acceptance). This ADR changes no CI runner or publication
policy. Only the existing approved cd.yml/main/production OIDC route may publish.
After exact-SHA CI and verified registry/provenance, consuming adapters can adopt
the new released version. Rollback disables the consumer flag and retains its
validated fallback/pinned version; do not disable byte checks to pass bad inputs.

## NFR and verification

Requirements-derived regression tests cover exact/over bounds, declared/chunked
responses, ranges/integrity, related URL/memory resources, Blob/array/file inputs,
stream hints, cancellation/timeouts, malformed policy/chunks, provider errors,
late responses and budget-sensitive caching. A many-small-chunk case verifies
copy ownership and bounded geometric growth. Test coverage includes every changed
source file; lint/typecheck/build/pack and runtime dependency audit are required.

New diagnostics expose no source URL/provider strings or payload bytes. No new
dependency or parser coupling is introduced. Web API tests run on Node24 and
ESM/CJS are verified; browser integrations remain consumer-owned. UI accessibility,
SEO and Azure secretref verification are N/A to this npm-only change. Publication
and consumer integration remain pending and cannot be inferred from local tests.

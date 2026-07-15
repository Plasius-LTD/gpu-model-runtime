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
   adapter options match. Otherwise it calls the adapter on the main path or
   through an injected worker dispatcher.
5. Adapters return generic canonical and optional renderer-ready values. The
   future `@plasius/gpu-model-core` package provides the concrete canonical
   types without changing the runtime orchestration API.

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

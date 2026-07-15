# @plasius/gpu-model-runtime

Adapter discovery, source resolution, loading orchestration, caching, and worker offload.

This repository is the dedicated package boundary defined by ADR 0094.

## Bootstrap status

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

## Rollout

- Feature flag: gpu.model.conversion.enabled
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

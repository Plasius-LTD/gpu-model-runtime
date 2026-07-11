# @plasius/gpu-model-runtime

Adapter discovery, source resolution, loading orchestration, caching, and worker offload.

This repository is the dedicated package boundary defined by ADR 0094.

## Bootstrap status

This initial repository contains the approved schema baseline, legal and governance files, and a package smoke-test surface. Functional model conversion work is tracked in the repository's [TASK] issues and must flow through the canonical GPU model boundary.

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

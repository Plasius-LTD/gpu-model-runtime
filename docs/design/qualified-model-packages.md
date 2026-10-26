# Qualified model packages

Task35 implements the acquired-inventory slice of site Feature1153 and the
Story1162 runtime-manifest design. [ADR0011](../adrs/adr-0011-integrity-qualified-model-package-loading.md)
defines acquisition limits, compatibility, alternatives and release obligations.

Flow: synchronous bounded metadata/byte snapshot -> dynamically loaded published
asset-contracts qualification -> native deterministic closure identity -> existing
adapter resolution -> declared-file-only resources -> canonical/renderer result.
No adapter sees bytes until the whole inventory has qualified. Every related read
checks its immutable descriptor's digest before returning a private byte copy.
Legacy cache entries cannot substitute for the new path, and its returned full
cache key distinguishes changed resource inventories.

Tests derive from Task35 acceptance: good complete packages, reordered inventory,
mutated source/returned buffers, bad paths/types/lengths/digests/entrypoints,
missing/extra files, unlisted network references, cache collisions, exception and
signal containment, metadata/file ceilings, cancellation and hung adapters.
Cancellation tests hold adapter registration until after abort/deadline rejection,
then observe the actual runtime continuation and require zero parser/worker calls.
Runtime stage waits respect the propagated signal; checks after asynchronous
source/registration/cache reads and before parser/worker or cache writes prevent
new work after cancellation. Late parser results cannot start cache writes;
already-started host cache side effects and synchronous CPU interruption remain
host-owned. Healthy legacy cache identity/reuse stays compatible.
Real published format adapters are qualified separately as packed/public consumer
integration. Unit fixtures do not imply six-format renderer/CAD conformance.

Host transport must enforce budgets while acquiring bytes, authorize resource
access and avoid logging signed URLs/user models. The API starts from acquired
Uint8Array files and cannot prevent an upstream transport from over-allocating.
Host workers own synchronous decoder CPU interruption. Disabling the stored
adoption flag selects the old consumer route for compatible inputs; it never
weakens package integrity or permits fallback after a failed qualification.

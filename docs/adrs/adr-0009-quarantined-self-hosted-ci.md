# ADR-0009: Quarantined Self-Hosted CI

- Status: Accepted
- Date: 2026-10-20
- Project: [runtime Task #7](https://github.com/Plasius-LTD/gpu-model-runtime/issues/7), under site Feature #1597 and Story #1626
- Supersedes: ADR-0007's CI runner choice only

## Context

The organisation Project requires explicit self-hosted Linux/X64 CI without a
hosted fallback, isolation from fork code, and separate GitHub-hosted OIDC
publication. ADR-0007 instead described hosted CI. The current automation prompt
makes the Project authoritative for work definition and acceptance criteria and
explicitly gives that rule precedence over repository guidance. Keeping the older
runner choice would leave Task #7's acceptance unsatisfied.

## Decision

Run CI only for branch pushes in `Plasius-LTD/gpu-model-runtime`, using literal
`[self-hosted, Linux, X64]` labels and the existing `Public CI - Quarantined` group.
Select that group explicitly so jobs cannot use the unrestricted Default group.
Do not subscribe this workflow to pull requests, `pull_request_target`, reusable
callers or dispatch inputs. Repository identity and push-event conditions apply
to every job; fork copies therefore cannot schedule these jobs.

The runner group's workflow allowlist admits `ci.yml@refs/heads/main`. For a PR,
a maintainer may temporarily admit the reviewed immutable workflow commit SHA;
remove that exact entry after branch validation and merge. Preserve other allowed
workflows and repositories. A new branch commit requires a fresh reviewed entry.
Do not expand the group to arbitrary branch patterns or change organisation-wide
runner access. CI has per-job timeouts and cancels stale runs on the same ref.

Retain ADR-0007's hosted publication boundary unchanged: `cd.yml` uses
`ubuntu-latest`, `main`, the `production` environment, exact-SHA push-CI proof,
immutable package validation, OIDC provenance and no long-lived npm write token.
The parent flag `platform.public-artifact-integrity.enabled` stages distribution;
enabled, disabled and rollback states cannot bypass artifact or workflow gates.
No user entitlement surface or capability is involved.

## Alternatives

- Retaining hosted CI contradicts the Project's explicit acceptance criteria.
- Selecting only runner labels can route to an unintended runner group.
- PR-triggered self-hosted jobs introduce an unnecessary untrusted-code route.
- Hosted fallback or a caller-selected runner weakens the required boundary.

## Impact, tests and release

Public runtime APIs and dependencies do not change. Workflow contracts inspect
every CI job's group, labels, event/repository guard, steps and timeout, reject
unsafe triggers/selectors, and preserve the hosted OIDC publication assertions.
Actionlint validates GitHub workflow syntax. Full package tests, coverage, build,
pack admission and exact branch/main CI remain required. Publish only through
the existing `cd.yml` after verifying npm binding, package version and exact-main
CI; require registry integrity/provenance and the public GitHub release before
closing Task #7. No site deployment or backend secretRef check applies to this
standalone package.

## Rollback

Disable the affected CI/publication workflow to stop an unsafe channel. Restore
the last reviewed workflow through a normal forward PR, revalidate its runner
allowlist and exact-SHA CI, then resume the ordinary release channel. Remove any
temporary immutable-SHA entry when it is no longer needed. Never restore the
excluded administrative path, add a hosted CI fallback or publish locally.

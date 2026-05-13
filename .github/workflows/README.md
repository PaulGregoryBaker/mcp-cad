# CI/CD Workflows

This directory contains GitHub Actions workflow definitions.

## Workflows

| File | Trigger | Jobs |
|------|---------|------|
| `ci.yml` | PR + merge to main | pr-ci, merge-ci, nightly, release-gate |
| `release-evidence.yml` | Release tag | Full matrix + evidence bundle |

See `docs/TESTING_STRATEGY.md` for the full testing strategy.

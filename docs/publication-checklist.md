# Publication Checklist — Governing Document

**Status:** FROZEN as of R0 (2026-07-17). Executed at R5.

## Clean Public Export Policy

Create a **fresh repository** from an audited, allowlisted file set. Do not push private development history. Private paths, experimental artifacts, and internal records stay out of the public repo entirely.

### Export method (execution assertion #4)

Build the public repository from an **explicit export manifest** — an allowlisted set of files copied into a clean directory. Do NOT rely solely on `.gitignore` and `git add -A` inside the private development tree.

The export process **must fail** when:
- An intended public file is missing
- An unexpected file is included
- An allowlisted legacy token disappears without its allowlist entry being removed
- An unauthorized legacy token appears
- A generated manifest or adapter configuration differs from its canonical source

This makes the clean public export reproducible and reduces reliance on an ever-growing ignore file.

## Pre-Commit Audit (staged tree, not working directory)

```bash
# After git add -A in the clean export directory:
git ls-files                                          # verify what's staged
git grep -n "MONETA_" -- $(git ls-files)              # no unauthorized legacy env vars
git grep -n "moneta_cap_" -- $(git ls-files)          # only in allowlisted files
git grep -n "100\.64\." -- $(git ls-files)            # no private IPs
git grep -n "C:\\\\Next-Era" -- $(git ls-files)        # no personal paths
git grep -n "bearer\|private.key" -- $(git ls-files)  # no secrets
git grep -n "ghp_\|sk-" -- $(git ls-files)            # no real tokens (test fixtures OK if allowlisted)
```

Old identifiers checked against `docs/ola-legacy-allowlist.json` (machine-readable). Any hit outside the allowlist blocks the commit.

## Clean-Clone Installation Gate

Must pass on **both Windows and Linux**:

```bash
git clone <fresh-export> /tmp/ola-test
cd /tmp/ola-test
node tests/run-all.cjs               # must pass
# platform-appropriate setup script verification
# ZCode contract tests
# all completed agent contract tests
# path and line-ending assumptions work cross-platform
# absence of ignored personal files
```

## Required Publication Artifacts

| Artifact | Status at R0 | Owner stage |
|---|---|---|
| `README.md` | Missing | R5 |
| `LICENSE` (full MIT text) | Missing (declared in plugin.json only) | R5 |
| `package.json` (with `"private": true`) | Missing | R5 |
| `.gitignore` | Missing | R5 |
| `CONTRIBUTING.md` | Missing | R5 |
| `SECURITY.md` | Missing | R5 |
| `CHANGELOG.md` | Missing | R5 |
| `docs/data-and-privacy.md` | Missing | R5 |
| `docs/migration-from-moneta.md` | Missing | R5 |
| `docs/agent-support.md` | This document, published version | R5 |

## Documentation Policy

Choose ONE:
- **Curated history** under `docs/history/` — scrubbed of secrets AND private paths (not just moved)
- **Excluded entirely** from public repository

A directory cannot simultaneously be "archived publicly" and gitignored. Internal documents must be scrubbed before inclusion.

## Secret Scrubbing Actions

| Item | Location | Action | Stage |
|---|---|---|---|
| `100.64.0.2:1234` | `hooks/lib/shared.js` default | Remove hardcoded default, require env var | R1 |
| `100.64.0.2:1234` | `.zcode-plugin/plugin.json` env value | Set to empty string | R1 |
| `C:\Next-Era\` paths | `STORE.md` | Replace with `<your-install-path>` | R5 |
| `.chatgpt-collaboration.json` | root | DELETE | R5 |
| `phase0/samples/` | `phase0/` | Exclude from public export | R5 |
| `eval/runs/*.json` | `eval/runs/` | Exclude from public export | R5 |
| Internal docs (`phase-*.md`, `b0-*.md`, etc.) | `docs/` | Exclude or scrub into `docs/history/` | R5 |
| Dev scripts (`phase0-*.cjs`, `_extract-sample.cjs`) | `bin/` | Move to `bin/internal/` or exclude | R5 |

## `package.json` Requirements

```json
{
  "name": "ola",
  "private": true,
  "version": "0.1.0",
  ...
}
```

`"private": true` prevents accidental npm publication.

## Embedding URL Policy

`OLA_EMBEDDING_URL` is optional. Removing the private IP default (R1) does NOT make it mandatory. Lexical retrieval works without embeddings.

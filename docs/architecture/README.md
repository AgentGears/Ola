# Ola Architecture

## Current governing architecture

**ADR-0001 — Ola Unified Product Architecture** is the current governing architecture for the Ola programme.

- **Package version:** `v1.4` (research-evidence update)
- **Status:** Architecture unchanged; research-derived conformance obligations added. M1 remains pending named assignees, approvals, and signatures.
- **Candidate package root:** `94c68edcceec5b8cd6b6b8a188e0f067a242b221dbcc423d70ebabb4e8090bf9`

> The current package is a **ratification candidate**, not a final signed release. It must not be promoted to a final `v1.4` release before owner assignment (M1) and detached approval/signature completion.

## Programme-gate status

| Gate | Status |
| --- | --- |
| **M0** | Ouroboros 0.22A closed. **Ola R2 open.** |
| **M1** | Owner assignment pending. 24 normative decisions pending. 12 signatures pending. |
| **M2** | **Blocked** until M0 and M1 close. |

See [`docs/roadmap/current-gates.md`](../roadmap/current-gates.md) for the canonical gate record. Normative detail lives in the ratification manifest and must not be duplicated here.

## Normative sources

The standalone parent and annex files are the **normative editable sources**. The consolidated document is **generated** and must never be edited independently.

- Parent: [ADR-0001-Ola-Unified-Product-Architecture.md](adr-0001/ADR-0001-Ola-Unified-Product-Architecture.md)
- Ratification: [ADR-0001-R-Ratification-Manifest.md](adr-0001/ADR-0001-R-Ratification-Manifest.md)
- Research evidence: [RESEARCH-EVIDENCE-0001-Long-Context-and-Memory-to-Skills.md](adr-0001/RESEARCH-EVIDENCE-0001-Long-Context-and-Memory-to-Skills.md)

## Scope boundary

M0 and M1 are open. Permitted work is documentation, ADR package installation, package-integrity automation, repository/interface inventories, M2 planning, contract schemas/fixtures that do not alter production paths, evaluation-protocol design, and governance.

**Prohibited until M0/M1 close:** convergence runtime implementation, shared runtime routing, production ingestion changes, authority cutover, direct cross-store integration, public MCP convergence, and removal of qualified legacy paths.

## Integrity

ADR package integrity is enforced by CI via [`adr-0001/verify_adr_package.py`](adr-0001/verify_adr_package.py), driven from [`PACKAGE-MANIFEST.json`](adr-0001/PACKAGE-MANIFEST.json), [`PACKAGE-DIGESTS.txt`](adr-0001/PACKAGE-DIGESTS.txt), and [`PACKAGE-ROOT.sha256`](adr-0001/PACKAGE-ROOT.sha256).

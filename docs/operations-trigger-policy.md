# Operations Trigger Policy

Defines when operational checks are required before changes are considered complete.

Status: FINAL (E3 — commands filled from E1/E2)

## CI status

```
CI enforcement is not implemented. Until CI exists, these checks are manually
required and must be cited in closeout records.
```

## Trigger table

| Event | Required check | Blocking? | Command/artifact |
|---|---|---:|---|
| phase closeout | E1 closeout verifier | yes | `node tools/verify-phase-closeout.cjs --claims eval/phase-e-claims/<phase>-claims.json` |
| corpus mutation | E1 verifier + E2 smoke | yes | E1 command + `node tools/run-retrieval-smoke.cjs` |
| tombstone/merge cleanup | E1 verifier + E2 smoke | yes | E1 command + smoke |
| durable memory promotion | E1 memory scan + E2 smoke if retrieval-relevant | yes | E1 command (includes memory scan) + smoke |
| retrieval code change | E2 smoke | yes | `node tools/run-retrieval-smoke.cjs` |
| resolver/data-dir change | E1 artifact check + E2 smoke | yes | E1 command + smoke |
| dense/fusion proposal | E4 corpus-growth gate | yes | `docs/corpus-growth-gate.md` must be produced |

## Required closeout footer

Every future phase closeout must include:

```
Required operations checks:
- E1 closeout verifier:
  - command: node tools/verify-phase-closeout.cjs --claims eval/phase-e-claims/<phase>-claims.json
  - artifact: phase-e-closeout-verification.json
  - status: <PASS / FAIL / N/A with reason>
- E2 retrieval smoke:
  - command: node tools/run-retrieval-smoke.cjs
  - artifact: eval/smoke/results/<timestamp>-smoke.json
  - status: <PASS / FAIL / N/A with reason>
- durable-memory scan:
  - artifact: phase-e-closeout-verification.json (memory_scan section)
  - status: <scanned / skipped with reason>
```

## E1 verifier output

The verifier produces three status types per claim:
- `pass`: regex extracted the asserted value AND it matches the computed value
- `fail`: regex extracted the asserted value AND it does NOT match (real count mismatch)
- `extraction_failed`: regex did not match (bad regex OR genuine missing assertion — requires manual review)

The durable-memory scan produces:
- `stale_number_candidate`: memory body contains a value superseded during reconciliation
- `requires_manual_review`: number-shaped token not in authority table (expected startup noise)

## Future CI

```
TODO: promote E1/E2 checks to CI for pull requests touching closeout docs,
memory corpus artifacts, retrieval code, resolver/data-dir code, or memory
mutation tooling.
```

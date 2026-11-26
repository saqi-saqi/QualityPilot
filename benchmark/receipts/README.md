# Benchmark receipts

Committed, human-readable proof for the numbers quoted in the main README.
Scratch output stays in `benchmark/results/` (gitignored); only curated receipts live here.

## Naming

`<YYYY-MM-DD>-<target>-<kind>.{json,md}`.

## Juice Shop recall receipt

Each receipt must record:

- Testigator (formerly QualityPilot) version and git commit SHA (when a receipt predates provenance
  capture in the harness, say so explicitly and leave the SHA null — never guess)
- Target and exact version
- Command and benchmark parameters
- Recall, missed expectations, and false-positive-guard violations
- Wall-clock time

Review each file before committing. Receipts must contain no session cookies,
tokens, private URLs, or other sensitive scan data.

## RealWorld/Conduit false-positive triage

The Conduit receipt should identify every finding family, explain whether each
family is consistent with the public demo specification, and separately call
out active-injection and authorization findings.

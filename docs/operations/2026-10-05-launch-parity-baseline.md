# Pons launch parity baseline — 2026-10-05

Status: **not run**. No launch completeness claim follows from this report.

| Factory source | Configured start block | Finalized audit fence | Chain / Envio / app counts | Result |
| --- | ---: | ---: | --- | --- |
| `pons-v1-legacy` | 8,600,612 | not pinned | not measured | not run |
| `pons-v1-active` | 8,991,118 | not pinned | not measured | not run |
| `pons-v2` | 26,841,846 | not pinned | not measured | not run |

The read-only CLI probe for `pons-v1-legacy` stopped before any RPC log query or app write:
the configured Envio PostgreSQL endpoint refused the connection (`ECONNREFUSED`, local port
5433). The app database was reachable. The same unavailable Envio source prevents a valid
three-way baseline for all three factories. Do not substitute the app's launch count or Envio
head metadata for event-key parity.

When Envio is available, pin an observed head, audit adjacent finalized ranges from each
source start through `head - 500`, and retain the JSON reports. Each range requires exact
chain/Envio/app key and block-hash parity plus contiguous Envio/app processed watermarks.
Resolve layer-specific mismatches and rerun their ranges before calling any source complete.

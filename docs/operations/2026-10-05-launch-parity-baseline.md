# Pons launch parity baseline — 2026-10-05

Status: **full historical baseline not run**. No launch completeness claim follows from this report.

| Factory source | Configured start block | Finalized audit fence | Chain / Envio / app counts | Result |
| --- | ---: | ---: | --- | --- |
| `pons-v1-legacy` | 8,600,612 | not pinned | not measured | not run |
| `pons-v1-active` | 8,991,118 | not pinned | not measured | not run |
| `pons-v2` | 26,841,846 | not pinned | not measured | not run |

The first read-only CLI probe for `pons-v1-legacy` stopped before any RPC log query or app
write because the configured Envio PostgreSQL endpoint refused the connection (`ECONNREFUSED`,
local port 5433). A disposable bounded Envio stack was subsequently used for live samples
below. There is still no persistent historical Envio database in this Docker context. Do not
substitute the app's launch count or Envio head metadata for event-key parity.

When Envio is available, pin an observed head, audit adjacent finalized ranges from each
source start through `head - 500`, and retain the JSON reports. Each range requires exact
chain/Envio/app key and block-hash parity plus contiguous Envio/app processed watermarks.
Resolve layer-specific mismatches and rerun their ranges before calling any source complete.

## Bounded live smoke test

A disposable Envio stack was started with the same event handlers and a temporary config
restricted to blocks `27027321`–`27027323` on chain `4663`. HyperSync returned the events,
Envio processed through block `27027323`, and `envio."RawLaunchV2"` contained one launch
at block `27027321`. The read-only parity CLI compared this range against an independent
chain RPC and the migrated app **test** database: chain `1`, Envio `1`, app `0`. It reported
`missingEnvio=[]`, one `missingApp` key, and status `mismatch`, as expected for the test
database. This confirms the three-way audit runs with live chain/Envio data on a bounded
range; it does not establish historical completeness.

At the time of the first smoke test, the local app **main** database lacked migration `0029`
and the CLI failed there with PostgreSQL error `42703`. Migrations `0024`–`0032` were then
applied to that database; uncommitted migrations `0033`–`0034` were excluded. Three separate
three-block live audits against the main app database produced:

| Source | Audited blocks | Chain / Envio / app | Status | Finding |
| --- | --- | --- | --- | --- |
| `pons-v1-legacy` | 8621658–8621660 | 1 / 1 / 1 | complete | No key/hash mismatch |
| `pons-v1-active` | 9019252–9019254 | 1 / 1 / 1 | complete | No key/hash mismatch |
| `pons-v2` | 27027321–27027323 | 1 / 1 / 1 | pending | App watermark 10636448 is below the audited block |

All three runs used independent chain RPC logs and disposable Envio databases that were
removed afterward. They are samples only. The V2 launch row exists in the app, but its
source watermark does not establish contiguous promotion through that block. The full
historical audit requires a persistent Envio index through the fixed finalized fence and
contiguous app source watermarks; neither condition is met here.

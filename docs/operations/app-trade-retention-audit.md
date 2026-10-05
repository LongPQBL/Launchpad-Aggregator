# App trade retention audit (Task 1)

Date: 2026-10-05. Plan: `docs/superpowers/plans/2026-10-05-app-trade-retention-implementation.md`.

## Measured sizes (read-only, live `launchpad` database)

| Relation | Total | Indexes | Estimated rows |
| --- | --- | --- | --- |
| `raw_logs` | 5546 MB | 1928 MB | 3.56M |
| `trades` | 3554 MB | 1098 MB | 3.22M |
| `trades_envio_staging` | 151 MB | 31 MB | 218K |
| `launches` | 132 MB | 40 MB | 166K |
| `venues` | 105 MB | 43 MB | 166K |
| `scan_jobs` | 71 MB | 45 MB | 90K |

Database total: 9568 MB. `raw_logs` is legacy data from the removed RPC indexer and is not a growth driver. `trades` is the growth driver.

## Provenance cascade (found and fixed)

`launches.source_log_id`, `venues.source_log_id`, `lifecycle_transitions.source_log_id`, and `trades.source_log_id` referenced `raw_logs(id)` with `ON DELETE CASCADE`. Deleting a legacy raw log silently deleted live launches, venues, lifecycle rows, and trades.

- Test first: `be/src/db/provenance.integration.test.ts` failed on the unfixed schema (the launch was deleted).
- Fix: the four FKs now use `ON DELETE SET NULL`. The columns were already nullable. Migration `0043_pink_nemesis.sql` changes only constraints. No data is rewritten. Adding each FK revalidates its table, so run it in a maintenance window on the live database.

## Consumers of `raw_logs` / `source_log_id`

- Writers: `be/src/launchpads/pons/v1/adapter.ts` and `v2/adapter.ts` build `RawLog` records for the old RPC path. `be/src/domain/types.ts` defines the type.
- Readers: `be/src/coverage/launchParity.ts` (parity audit).
- The Envio sync path does not read `raw_logs`.

## Not done in Task 1

- `be/src/cli/auditStorageConsumers.ts` and the report template were not created. The inventory above was done by hand.
- Dropping `scan_jobs` or `raw_logs` is a separate, reviewed migration after backup and restore. Neither is proposed here.
- Partitioning, archive format, and object storage (Tasks 2–6) need a storage vendor decision first. That decision is open.

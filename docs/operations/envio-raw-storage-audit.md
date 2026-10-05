# Envio raw storage audit

Date: 2026-10-05. Plan: `docs/superpowers/plans/2026-10-05-envio-raw-storage-implementation.md`, Task 1.

## Status

- Static consumer audit: done (this document).
- Byte and row measurements: **not run**. The Envio database at `127.0.0.1:5433` was unreachable and no Envio container was running when this audit was made. The queries in "Measurement queries" below must be run once that database is up, and their results recorded here before any storage decision.
- Schema, live Envio tables, and HyperIndex state: unchanged. Nothing was pruned, deleted, or reindexed.

## Placeholder writes

`envio/src/EventHandlers.ts` writes constants for these fields, not decoded event values:

| Entity | Field | Written as | Source of truth in the event |
| --- | --- | --- | --- |
| `RawSwap` (V1 legacy pool swap) | `sender` | `""` | `Swap.sender` |
| `RawSwap` | `recipient` | `""` | `Swap.recipient` |
| `RawSwap` | `liquidity` | `0` | `Swap.liquidity` (V3 math internal) |
| `RawSwap` | `tick` | `0` | `Swap.tick` (V3 math internal) |
| `RawV4Swap` | `liquidity` | `0` | `Swap.liquidity` (V4 math internal) |
| `RawV4Swap` | `tick` | `0` | `Swap.tick` (V4 math internal) |

`RawV4Swap.sender` is **not** a placeholder. It is written from `event.params.sender`.

## Consumer matrix

| Field | Consumer in `be/` | Verdict |
| --- | --- | --- |
| `RawSwap.sender`, `.recipient` | None. `hydrateV1SwapFromDecoded` reads `txFrom` and `sqrtPriceX96`. | Unused. Safe to remove in a future reindex-gated migration. |
| `RawSwap.liquidity`, `.tick` | None. | Unused. Same as above. |
| `RawV4Swap.liquidity`, `.tick` | None today. Pool math for the future `Pools` section is not yet specified. | Keep until the pool-math audit. Removing them now would force a reindex to save almost nothing. |
| `RawV4Swap.sender` | `be/src/envioSync/incrementalSync.ts` (V4 row → `EnvioRawV4SwapRow.sender`), `be/src/envioSync/transformV4.ts:88` (hook-initiated detection), `be/src/launchpads/pons/v2/v4Swaps.ts:22` | Real data used for protocol-activity labels. Keep. |
| `RawV3Swap.sender`, `RawV2Swap.sender` | `be/src/pools/syncV3V2Pools.ts:98` (`senderAddress`) | Real data used by Pools. Keep. These tables are not placeholder writers. |
| `txFrom` (all swap streams) | Trader attribution in V1, V2 curve, V4, and V3/V2 pool sync | Keep. |

## Decision

1. Do not remove any raw field in this plan. The placeholder values already store empty strings and zeros, so removal saves little per row. It would still change the Envio entity fingerprint and force a full reindex, which the plan gates on backup, rebuild, parity, and rollback evidence.
2. The only candidates for a later removal are `RawSwap.sender`, `RawSwap.recipient`, `RawSwap.liquidity`, and `RawSwap.tick`. Removing them still needs a reindex plan and a parity check.
3. `RawV4Swap.liquidity` and `RawV4Swap.tick` stay until the `Pools` pool-math audit decides whether price impact or pool-level metrics need them.

## Measurement queries (run when the Envio database is reachable)

Run read-only against the Envio database (`default_transaction_read_only = on`):

```sql
SELECT c.relname AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
       c.reltuples::bigint AS estimated_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND c.relname LIKE 'Raw%'
ORDER BY pg_total_relation_size(c.oid) DESC;
```

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
```

Use `reltuples` rather than `count(*)` on multi-million-row tables. Record the sampled block height with each result, because the row counts move as the indexer runs.

## Open items

- Record the table-size results above once the Envio database is running.
- Candidate A/B benchmarks (plan Task 2) and the reindex/restore proof (plan Task 3) are not started. They need a disposable Envio copy.

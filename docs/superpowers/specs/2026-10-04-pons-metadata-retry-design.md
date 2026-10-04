# Pons metadata retry design

## Goal

Keep new launches visible when optional RPC reads fail, and recover `logo`,
`description`, `socials` (website and Twitter), and launch block timestamp after
temporary RPC failures. Existing launches with missing values should also be
eligible for gradual recovery. A contract that does not implement an optional
function must still index successfully with a null value.

## Current behavior and cause

`readExtendedTokenMetadata` converts every rejected `readContract` call to
`null`. The Envio V1/V2 sync writes those nulls to `launches` and only reads
extended metadata for new launches or launches being rebuilt in the last 500
blocks. `getBlock` failures similarly become a null `launchTimestamp`. Thus a
temporary failure and a genuine empty/unsupported field become
indistinguishable once stored. Old launches are not selected again.

## Approach

Add durable, per-function read state on `launches` for `logo`, `description`,
`socials`, and timestamp. Each state is `pending` or `done`; `pending` is the
default for new rows. Store a shared `metadataRetryAt` and retry count to bound
the rate of repeated attempts. A successful call is `done` even if the returned
string is empty. A confirmed contract-level unsupported/revert result is also
`done` with null values. A transport failure, timeout, rate limit, or unknown
error stays `pending`. Keep the function state separate from field values:
`socials()` resolves both website and Twitter together.

The additive migration seeds existing rows: a non-null logo/description/
timestamp is `done`; otherwise it is `pending`. Socials is `done` if either
website or Twitter is already non-null, otherwise `pending`. This may read some
old contracts whose stored null was legitimate, once; that is necessary because
the old schema cannot tell why the field is null. No mass RPC operation runs in
the migration.

Use one bounded enrichment runner that selects due Pons V1/V2 launches, newest
first for prompt enrichment of recent launches, while reserving half of each
batch for oldest pending rows so historical data does not starve. The default
batch is 10 launches per minute; an unused half can be filled from the other
side. It calls only pending functions, updates successful fields and states
independently, and backs off transient errors exponentially from one minute to
one hour. The batch limit is configurable and one RPC worker protects provider
quota. Run this worker alongside the Envio real-table sync loop at one-minute
intervals, including while a sync cycle is in progress. The one-shot Envio
real-table sync also runs one enrichment pass. A short DB transaction claims due rows with a persisted
lease ID and expiry, so the network read holds no DB lock. A result updates the
row only when its lease ID and original launch identity still match, preventing
two runners or a reorg replacement from accepting a stale result. Envio
staging-only sync does not enrich real rows. Runner failures are logged and
contained; they do not fail a scan/sync cycle.

Envio V1/V2 keep their current immediate reads, but their results must
carry `done`/`pending` state into the launch insert. The migration marks
previously stored launches with missing values as pending, including rows
written by the retired RPC indexer. Retrying
metadata never rolls back launch or trade indexing and never changes scan
cursors. Reorg deletion and reinsertion naturally resets state for an Envio
launch; enrichment updates should apply only to the current launch row.

## Error classification

Inspect viem's wrapped cause chain. Treat typed contract execution reverts and
zero return data as terminal for that function. Treat HTTP errors, timeouts,
rate limits, and all unrecognized errors as retryable. Do not infer permanent
absence merely from a generic error message. Timestamp reads have no
contract-level unsupported case; failures remain retryable. Log counts and
sanitized error categories without RPC URLs or secrets.

## Verification

- Unit tests distinguish successful empty strings, typed contract failure,
  transport/timeout failure, and unknown errors independently per function.
- DB integration tests show that a new launch persists during a transient
  failure, then gains metadata after a later successful read, including after
  moving outside the 500-block window.
- Migration/integration tests cover old null rows, old non-null rows, both
  writers, bounded selection, retry backoff, and concurrent claims.
- Reorg tests confirm that an enrichment result cannot attach to a replaced
  launch and that source/trade reconciliation still works.

## Limits

The reader uses current contract state, as the existing reader does. If a token
owner changes an on-chain metadata value later, this retry mechanism does not
periodically refresh fields already marked `done`. Historical recovery is
gradual and its throughput depends on provider limits. The UI continues to use
null for values still unavailable.

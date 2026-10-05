import type { Address } from 'viem';
import type { QuoteAsset } from '../../domain/types.js';
import { readOne, type ReadOutcome } from './extendedMetadata.js';
import { readV1TokenMetadata, readV1Graduation, type V1ReadClient } from './v1/state.js';
import { readV2TokenMetadata, resolveV2QuoteAsset, type V2QuoteClient } from './v2/adapter.js';

// Core identity fields (name/symbol/decimals, and for V1 graduation / for V2 an unknown ERC20 quote
// asset) deferred out of the near-realtime ingestion path — see docs/superpowers/specs/
// 2026-10-05-envio-near-realtime-sync-design.md's "Immediate launch records and enrichment". Reuses
// extendedMetadata.ts's readOne/ReadOutcome transient-vs-terminal classification so a transient RPC
// failure here retries with the same backoff discipline as logo/description/socials/timestamp.
export interface CoreMetadataReadResults {
  name: ReadOutcome<string>;
  symbol: ReadOutcome<string>;
  decimals: ReadOutcome<number>;
  graduated: ReadOutcome<boolean>;
  quoteAssetSymbol: ReadOutcome<string>;
  quoteAssetDecimals: ReadOutcome<number>;
}

const DONE_NULL = { state: 'done', value: null } as const;

export async function readV1CoreMetadataOutcomes(client: V1ReadClient, token: Address, factory: Address): Promise<CoreMetadataReadResults> {
  const [metadata, graduated] = await Promise.all([
    readOne(() => readV1TokenMetadata(client, token)),
    readOne(() => readV1Graduation(client, token, factory)),
  ]);
  return {
    name: metadata.state === 'done' ? { state: 'done', value: metadata.value?.name ?? null } : metadata,
    symbol: metadata.state === 'done' ? { state: 'done', value: metadata.value?.symbol ?? null } : metadata,
    decimals: metadata.state === 'done' ? { state: 'done', value: metadata.value?.decimals ?? null } : metadata,
    graduated,
    quoteAssetSymbol: DONE_NULL,
    quoteAssetDecimals: DONE_NULL,
  };
}

export async function readV2CoreMetadataOutcomes(
  client: V2QuoteClient, token: Address, pairToken: Address, needsQuoteAsset: boolean,
): Promise<CoreMetadataReadResults> {
  const [metadata, quoteAsset] = await Promise.all([
    readOne(() => readV2TokenMetadata(client, token)),
    needsQuoteAsset ? readOne(() => resolveV2QuoteAsset(pairToken, client)) : Promise.resolve<ReadOutcome<QuoteAsset>>(DONE_NULL),
  ]);
  return {
    name: metadata.state === 'done' ? { state: 'done', value: metadata.value?.name ?? null } : metadata,
    symbol: metadata.state === 'done' ? { state: 'done', value: metadata.value?.symbol ?? null } : metadata,
    decimals: metadata.state === 'done' ? { state: 'done', value: metadata.value?.decimals ?? null } : metadata,
    graduated: DONE_NULL,
    quoteAssetSymbol: quoteAsset.state === 'done' ? { state: 'done', value: quoteAsset.value?.symbol ?? null } : quoteAsset,
    quoteAssetDecimals: quoteAsset.state === 'done' ? { state: 'done', value: quoteAsset.value?.decimals ?? null } : quoteAsset,
  };
}

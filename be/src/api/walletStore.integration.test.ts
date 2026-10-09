import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createWalletStore } from './walletStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const store = createWalletStore(pool);

const chainId = 4663;
const source = 'wallet-test-src';
const token = `0x${'8a'.repeat(20)}`;
const quote = `0x${'00'.repeat(20)}`;
const wallet = `0x${'8b'.repeat(20)}`;
const other = `0x${'8c'.repeat(20)}`;
const venue = 'wallet-test-venue';
const hash = (c: string) => `0x${c.repeat(64)}`;

async function addTrade(txChar: string, side: 'buy' | 'sell', timestamp: number, quoteRaw: string, trader: string) {
  await pool.query(`INSERT INTO trades (chain_id, token_address, venue_id, block_number, block_hash, tx_hash, log_index, timestamp,
    side, token_amount_raw, quote_amount_raw, quote_asset_address, source_event, activity_kind, trader_address)
    VALUES ($1,$2,$3,1,$4,$5,0,$6,$7,'1000',$8,$9,'CurveBuy','user_trade',$10)`,
  [chainId, token, venue, hash('a'), hash(txChar), timestamp, side, quoteRaw, quote, trader]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO sources (id, chain_id, version, factory_address, start_block, scanned_to_block, confirmed_to_block, status)
    VALUES ($1, $2, 'v2', $3, 0, 0, 0, 'caught_up') ON CONFLICT DO NOTHING`, [source, chainId, `0x${'8d'.repeat(20)}`]);
  await pool.query(`INSERT INTO launches (chain_id, token_address, source_id, name, symbol, token_decimals, platform,
    protocol_version, factory_address, deployer_address, launch_block, launch_tx_hash, launch_log_index,
    quote_asset_address, quote_asset_symbol, quote_asset_decimals, lifecycle_status)
    VALUES ($1, $2, $3, 'Wallet Token', 'WLT', 18, 'pons', 'v2', $2, $2, 1, $4, 0, $5, 'ETH', 18, 'trading') ON CONFLICT DO NOTHING`,
  [chainId, token, source, hash('1'), quote]);
  await pool.query(`INSERT INTO venues (id, chain_id, token_address, kind, ref, source_id, effective_from_block, official)
    VALUES ($1, $2, $3, 'curve', $3, $4, 1, true) ON CONFLICT DO NOTHING`, [venue, chainId, token, source]);
  await addTrade('2', 'buy', 1000, (3n * 10n ** 18n).toString(), wallet);
  await addTrade('3', 'buy', 2000, (10n ** 18n).toString(), wallet);
  await addTrade('4', 'sell', 3000, (2n * 10n ** 18n).toString(), wallet);
  await addTrade('5', 'buy', 4000, (10n ** 18n).toString(), other);
});

afterAll(async () => {
  await pool.query('DELETE FROM trades WHERE venue_id = $1', [venue]);
  await pool.query('DELETE FROM venues WHERE id = $1', [venue]);
  await pool.query('DELETE FROM launches WHERE source_id = $1', [source]);
  await pool.query('DELETE FROM sources WHERE id = $1', [source]);
  await pool.end();
});

describe('wallet positions', () => {
  it("summarises one wallet's trades per launch, in whole quote units, without mixing in other wallets", async () => {
    const { items } = await store.listPositions(undefined, wallet.toUpperCase().replace('0X', '0x'), 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      token: { tokenAddress: token, symbol: 'WLT', decimals: 18 },
      tradeCount: 3, buyCount: 2, sellCount: 1, firstTradeAt: 1000, lastTradeAt: 3000,
      quoteAsset: { symbol: 'ETH' }, quoteSpent: '4', quoteReceived: '2', priceUsd: null,
    });
  });

  it('returns nothing for a wallet with no trades or another chain', async () => {
    expect((await store.listPositions(undefined, `0x${'99'.repeat(20)}`, 10)).items).toEqual([]);
    expect((await store.listPositions(999_999, wallet, 10)).items).toEqual([]);
  });
});

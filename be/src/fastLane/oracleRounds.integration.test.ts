import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { createDatabase } from '../db/client.js';
import { answerUpdatedEvent, createOracleRounds, type OracleLog, type OracleSource } from './oracleRounds.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const { pool } = createDatabase(databaseUrl);
const chainId = 910_005; // private to this file
const feedA = '0x9a00000000000000000000000000000000000f01';
const aggA = '0x9a00000000000000000000000000000000000a01';
const feedB = '0x9a00000000000000000000000000000000000f02';
const aggB = '0x9a00000000000000000000000000000000000a02';
const quoteA = '0x9a00000000000000000000000000000000000c01';
const quoteB = '0x9a00000000000000000000000000000000000c02';

function answerLog(aggregator: string, answer: bigint, roundId: bigint, updatedAt: number, blockNumber: bigint, logIndex: number, removed = false): OracleLog {
  const topics = encodeEventTopics({ abi: [answerUpdatedEvent], eventName: 'AnswerUpdated', args: { current: answer, roundId } });
  return { address: aggregator, topics: topics as string[], data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(updatedAt)]), blockNumber, logIndex, removed };
}

interface FakeSource extends OracleSource { subscriptions: string[][]; unsubscribed: number; push(logs: OracleLog[]): void; decimalsCalls: string[] }
function fakeSource(): FakeSource {
  let handler: ((logs: OracleLog[]) => void) | null = null;
  const fake: FakeSource = {
    subscriptions: [], unsubscribed: 0, decimalsCalls: [],
    async readDecimals(aggregator) { fake.decimalsCalls.push(aggregator); return 8; },
    subscribeAnswerUpdated(addresses, onLogs) { fake.subscriptions.push([...addresses]); handler = onLogs; return () => { fake.unsubscribed += 1; }; },
    push(logs) { handler?.(logs); },
  };
  return fake;
}

const listener = new Client({ connectionString: databaseUrl });
const notifications: Record<string, unknown>[] = [];
async function feedRow(feed: string, aggregator: string, quote: string, status = 'verified') {
  await pool.query(`INSERT INTO quote_usd_feeds (chain_id, quote_asset_address, feed_address, aggregator_address, discovery_source, verification_status, last_checked_at)
    VALUES ($1,$2,$3,$4,'test',$5,now()) ON CONFLICT (chain_id, quote_asset_address) DO UPDATE SET feed_address = EXCLUDED.feed_address, aggregator_address = EXCLUDED.aggregator_address, verification_status = EXCLUDED.verification_status`,
  [chainId, quote, feed, aggregator, status]);
}
const rounds = async () => (await pool.query('SELECT feed_address, round_id, answer_raw, decimals, block_number, log_index FROM quote_usd_price_rounds WHERE chain_id = $1 ORDER BY round_id', [chainId])).rows;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeAll(async () => {
  await listener.connect();
  await listener.query('LISTEN launchpad_events');
  listener.on('notification', (message) => { if (message.payload) notifications.push(JSON.parse(message.payload)); });
});
beforeEach(async () => {
  notifications.length = 0;
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [chainId]);
});
afterAll(async () => {
  await pool.query('DELETE FROM quote_usd_price_rounds WHERE chain_id = $1', [chainId]);
  await pool.query('DELETE FROM quote_usd_feeds WHERE chain_id = $1', [chainId]);
  await listener.query('UNLISTEN launchpad_events');
  await listener.end();
  await pool.end();
});

describe('oracle rounds over the WebSocket', () => {
  it('subscribes to the verified feeds\' aggregators only, and stores a new round at once with its decimals', async () => {
    await feedRow(feedA, aggA, quoteA);
    await feedRow(feedB, aggB, quoteB, 'unverified');
    const source = fakeSource();
    const oracle = createOracleRounds({ source, pool, chainId });
    await oracle.start();
    expect(source.subscriptions).toEqual([[aggA]]);

    await oracle.handleLogs([answerLog(aggA, 3_000_12345678n, 77n, 1_790_000_000, 88_400_000n, 3)]);
    expect(await rounds()).toEqual([expect.objectContaining({ feed_address: feedA, round_id: '77', answer_raw: '300012345678', decimals: 8, block_number: '88400000', log_index: 3 })]);
    await settle();
    expect(notifications).toContainEqual({ type: 'coverage.changed', chainId });
    expect(oracle.stats()).toMatchObject({ aggregators: 1, rounds: 1 });
    oracle.stop();
  });

  it('keeps one row for a repeated log, ignores other contracts and a non-positive answer, and deletes the round of a removed log', async () => {
    await feedRow(feedA, aggA, quoteA);
    const oracle = createOracleRounds({ source: fakeSource(), pool, chainId });
    await oracle.start();
    await oracle.handleLogs([answerLog(aggA, 100n, 1n, 1_790_000_000, 10n, 0), answerLog(aggA, 100n, 1n, 1_790_000_000, 10n, 0)]);
    await oracle.handleLogs([answerLog('0x9a00000000000000000000000000000000000bad', 100n, 2n, 1_790_000_001, 11n, 0), answerLog(aggA, 0n, 3n, 1_790_000_002, 12n, 0)]);
    expect((await rounds()).map((row) => row.round_id)).toEqual(['1']);
    expect(oracle.stats()).toMatchObject({ rounds: 1, ignored: 2 });

    await oracle.handleLogs([answerLog(aggA, 100n, 1n, 1_790_000_000, 10n, 0, true)]);
    expect(await rounds()).toEqual([]);
    expect(oracle.stats().removed).toBe(1);
    oracle.stop();
  });

  it('resubscribes when a feed is added, reads each aggregator\'s decimals once, and stops cleanly', async () => {
    await feedRow(feedA, aggA, quoteA);
    const source = fakeSource();
    const oracle = createOracleRounds({ source, pool, chainId });
    await oracle.start();
    await oracle.refresh(); // nothing changed: no new subscription
    expect(source.subscriptions).toHaveLength(1);
    await feedRow(feedB, aggB, quoteB);
    await oracle.refresh();
    expect(source.subscriptions).toEqual([[aggA], [aggA, aggB]]);
    expect(source.unsubscribed).toBe(1);
    expect(source.decimalsCalls.filter((address) => address === aggA)).toHaveLength(1);
    oracle.stop();
    expect(source.unsubscribed).toBe(2);
  });

  it('does not subscribe at all when there is no verified feed', async () => {
    const source = fakeSource();
    const oracle = createOracleRounds({ source, pool, chainId });
    await oracle.start();
    expect(source.subscriptions).toEqual([]);
    oracle.stop();
  });
});

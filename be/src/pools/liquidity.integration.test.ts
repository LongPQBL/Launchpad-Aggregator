import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { readPoolLiquidityAnswer } from './liquidity.js';
import type { LiquidityClient } from './liquidityRead.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test';
if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Integration tests require a database ending in _test');
const pool = new Pool({ connectionString: databaseUrl });
const chainId = 4663;
const a = '0x7171717171717171717171717171717171717171';
const b = '0x7272727272727272727272727272727272727272';
const v3Pool = '0x7373737373737373737373737373737373737373';
const v2Pair = '0x7474747474747474747474747474747474747474';
const tx = (digit: string) => `0x${digit.repeat(64)}`;
const L = 10n ** 18n;

function client(options: { liquidity?: bigint; ticks?: Record<number, bigint>; failTicks?: boolean } = {}): LiquidityClient {
  const ticks = options.ticks ?? { [-200]: L, 200: -L };
  return {
    async getBlockNumber() { return 900n; },
    async readContract({ functionName, args, address }: { functionName: string; args?: readonly unknown[]; address: string }) {
      if (functionName === 'decimals') return 18;
      if (functionName === 'slot0') return [2n ** 96n, 0, 0, 0, 0, 0, true];
      if (functionName === 'liquidity') return options.liquidity ?? L;
      if (functionName === 'tickBitmap') {
        const word = Number(args![0]); let bitmap = 0n;
        for (const tick of Object.keys(ticks).map(Number)) { const compressed = tick / 200; if (Math.floor(compressed / 256) === word) bitmap |= 1n << BigInt(((compressed % 256) + 256) % 256); }
        return bitmap;
      }
      if (functionName === 'ticks') { if (options.failTicks) throw new Error('down'); return [0n, ticks[Number(args![0])], 0n, 0n, 0n, 0n, 0, true]; }
      throw new Error(`${functionName} @ ${address}`);
    },
  } as unknown as LiquidityClient;
}

beforeAll(async () => {
  for (const [protocol, id] of [['uniswap_v3', v3Pool], ['uniswap_v2', v2Pair]] as const) {
    await pool.query(`INSERT INTO pool_catalog (chain_id,protocol,pool_id,currency0,currency1,fee,tick_spacing,hooks,block_number,block_hash,tx_hash,log_index,verified,coverage_status)
      VALUES ($1,$2,$3,$4,$5,3000,200,'0x0000000000000000000000000000000000000000',99,$6,$7,0,true,'caught_up') ON CONFLICT DO NOTHING`, [chainId, protocol, id, a, b, tx('1'), tx('2')]);
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM pool_catalog WHERE chain_id=$1 AND pool_id IN ($2,$3)', [chainId, v3Pool, v2Pair]);
  await pool.end();
});

describe('readPoolLiquidityAnswer', () => {
  const key = { chainId, protocol: 'uniswap_v3' as const, poolId: v3Pool };
  it('returns the ranges, the active one, prices and a depth view for a consistent V3 pool', async () => {
    const answer = (await readPoolLiquidityAnswer(pool, client(), key, 3))!;
    expect(answer).toMatchObject({ complete: true, unavailableReason: null, currentTick: 0, blockNumber: '900', activeLiquidity: L.toString(), feePips: 3000 });
    expect(answer.ranges).toHaveLength(1);
    expect(answer.ranges[0]).toMatchObject({ tickLower: -200, tickUpper: 200, active: true, liquidity: L.toString() });
    expect(answer.price).toBeCloseTo(1, 9);
    expect(answer.depth!.asks).toHaveLength(3);
    expect(answer.depth!.spreadPercent).toBeCloseTo(0.6, 9);
  });
  it('treats a pool without liquidity as a real, complete answer with no ranges', async () => {
    const answer = (await readPoolLiquidityAnswer(pool, client({ liquidity: 0n, ticks: {} }), key))!;
    expect(answer).toMatchObject({ complete: true, ranges: [], activeLiquidity: '0' });
  });
  it('gives no ranges when the ticks do not add up to the reported liquidity', async () => {
    const answer = (await readPoolLiquidityAnswer(pool, client({ liquidity: L * 2n }), key))!;
    expect(answer).toMatchObject({ complete: false, unavailableReason: 'liquidity_mismatch', ranges: [], depth: null });
  });
  it('reports a failed read instead of a partial answer', async () => {
    expect(await readPoolLiquidityAnswer(pool, client({ failTicks: true }), key)).toMatchObject({ complete: false, unavailableReason: 'read_failed', ranges: [] });
  });
  it('answers null for a V2 pair and for an unknown pool', async () => {
    expect(await readPoolLiquidityAnswer(pool, client(), { chainId, protocol: 'uniswap_v2', poolId: v2Pair })).toBeNull();
    expect(await readPoolLiquidityAnswer(pool, client(), { chainId, protocol: 'uniswap_v3', poolId: '0x7575757575757575757575757575757575757575' })).toBeNull();
  });
});

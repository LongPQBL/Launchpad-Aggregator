import { decodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { SIMULATION_ACCOUNT, type CallClient } from './erc20-state-override';

// Some tokens take a cut on every transfer (fee-on-transfer) or only when the pool is on one side (buy / sell tax), or refuse
// to move at all. A quoter reports what the POOL pays out, so none of that shows in the quote or in amountOutMinimum, and the
// user receives less than the screen promised. Uniswap's own interface detects it with an on-chain FeeOnTransferDetector
// contract; none is deployed on Robinhood Chain (checked against Uniswap's deployment lists and the official deployer's
// contracts), so the same measurement is made here by simulating plain ERC-20 transfers with eth_simulateV1 (one request per token).

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

// Large enough to avoid rounding noise in basis points, small enough that any pool holds it.
const PROBE_AMOUNT = 1_000_000n;
// The two follow-up legs each move this much out of what the buy leg delivered.
const LEG_AMOUNT = PROBE_AMOUNT / 4n;
// A fresh address that holds nothing, so a balance read after a transfer is exactly what arrived.
const RECEIVER: Address = '0x00000000000000000000000000000000000c0de1';
// Below this the difference is rounding (rebasing tokens can be off by a unit), not a fee.
const FEE_NOISE_BPS = 5;

export interface SimulateClient extends CallClient {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export type TokenFeeCheck =
  | { status: 'checked'; transferFeeBps: number | null; buyFeeBps: number | null; sellFeeBps: number | null; reverted: ('transfer' | 'buy' | 'sell')[] }
  | { status: 'unchecked'; reason: string };

interface SimCall { from?: Address; to: Address; data: Hex }
interface SimCallResult { status?: string; returnData?: Hex }

const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
const balanceData = (who: Address) => encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] });

/**
 * The simulated sequence for one token. `holder` already holds the token and is the counterparty a swap moves tokens to and
 * from (the pool, or the PoolManager for V4). Everything starts from the holder, so no storage layout has to be known:
 *   0 transfer holder -> wallet (a buy)       1 wallet balance
 *   2 transfer wallet -> fresh address        3 fresh address balance
 *   4 holder balance before                   5 transfer wallet -> holder (a sell)      6 holder balance after
 */
export function buildFeeProbe(token: Address, holder: Address): SimCall[] {
  const balance = (who: Address): SimCall => ({ to: token, data: balanceData(who) });
  return [
    { from: holder, to: token, data: transferData(SIMULATION_ACCOUNT, PROBE_AMOUNT) },
    balance(SIMULATION_ACCOUNT),
    { from: SIMULATION_ACCOUNT, to: token, data: transferData(RECEIVER, LEG_AMOUNT) },
    balance(RECEIVER),
    balance(holder),
    { from: SIMULATION_ACCOUNT, to: token, data: transferData(holder, LEG_AMOUNT) },
    balance(holder),
  ];
}

const asBalance = (result: SimCallResult | undefined): bigint | null => {
  if (!result || result.status !== '0x1' || !result.returnData || result.returnData === '0x') return null;
  try { return decodeAbiParameters([{ type: 'uint256' }], result.returnData)[0]; } catch { return null; }
};
const feeBps = (sent: bigint, received: bigint): number => (received >= sent ? 0 : Number(((sent - received) * 10_000n) / sent));

export function interpretFeeProbe(results: readonly SimCallResult[]): TokenFeeCheck {
  const reverted: ('transfer' | 'buy' | 'sell')[] = [];
  const ok = (index: number) => results[index]?.status === '0x1';
  let buyFeeBps: number | null = null;
  let transferFeeBps: number | null = null;
  let sellFeeBps: number | null = null;

  if (!ok(0)) reverted.push('buy');
  else { const received = asBalance(results[1]); buyFeeBps = received === null ? null : feeBps(PROBE_AMOUNT, received); }

  // The later legs spend what the buy leg delivered. If the buy leg delivered too little to fund them (a fee above 50%) or
  // never delivered at all, they fail for that reason, which the buy result already reports; do not blame them too.
  const funded = buyFeeBps !== null && buyFeeBps <= 5_000;
  if (funded) {
    if (!ok(2)) reverted.push('transfer');
    else { const received = asBalance(results[3]); transferFeeBps = received === null ? null : feeBps(LEG_AMOUNT, received); }
    if (!ok(5)) reverted.push('sell');
    else {
      const before = asBalance(results[4]); const after = asBalance(results[6]);
      sellFeeBps = before === null || after === null ? null : feeBps(LEG_AMOUNT, after - before);
    }
  }
  return { status: 'checked', transferFeeBps, buyFeeBps, sellFeeBps, reverted };
}

/** Plain-language warning, or null when nothing worth telling the user was found. */
export function feeWarning(check: TokenFeeCheck, symbol: string): string | null {
  if (check.status === 'unchecked') return null;
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const parts: string[] = [];
  if (check.reverted.length > 0) {
    parts.push(`${symbol} refused a simulated ${check.reverted.join('/')} transfer, so this trade may fail or the tokens may not be sellable`);
  }
  const fees: [string, number | null][] = [['buy', check.buyFeeBps], ['sell', check.sellFeeBps], ['transfer', check.transferFeeBps]];
  const charged: [string, number][] = [];
  for (const [kind, bps] of fees) if (bps !== null && bps > FEE_NOISE_BPS) charged.push([kind, bps]);
  if (charged.length > 0) {
    parts.push(`${symbol} charges a fee on ${charged.map(([kind, bps]) => `${kind} (${pct(bps)})`).join(', ')}; you will receive less than the quote shows`);
  }
  return parts.length > 0 ? `${parts.join('. ')}.` : null;
}

export interface FeeCheckOptions {
  /** Test seam: state overrides merged into the simulation, so a script can plant a token's code and storage. */
  extraOverrides?: Record<string, { code?: Hex; stateDiff?: Record<Hex, Hex> }>;
}

/** Measures what a token actually delivers. Never throws: a failure to measure is `unchecked`, not "no fee". */
export async function checkTokenFee(client: SimulateClient, token: Address, holder: Address, options: FeeCheckOptions = {}): Promise<TokenFeeCheck> {
  try {
    const response = await client.request({
      method: 'eth_simulateV1',
      params: [{ blockStateCalls: [{ ...(options.extraOverrides ? { stateOverrides: options.extraOverrides } : {}), calls: buildFeeProbe(token, holder) }], validation: false }, 'latest'],
    }) as { calls?: SimCallResult[] }[];
    const results = response?.[0]?.calls;
    if (!results || results.length !== 7) return { status: 'unchecked', reason: 'unexpected simulation response' };
    return interpretFeeProbe(results);
  } catch (error) {
    return { status: 'unchecked', reason: error instanceof Error ? error.message.slice(0, 120) : 'simulation failed' };
  }
}

import { parseAbi, type Address } from 'viem';
import type { Pool } from 'pg';
import { v2FactoryStateAbi } from '../launchpads/pons/v2/abi.js';
import type { DepthResult, DepthRow } from './liquidityMath.js';
import type { LiquidityClient } from './liquidityRead.js';

const STEP = 1.01; // each row is 1% in price

export interface CurveDepthState {
  quoteReserve: bigint; tokenReserve: bigint; feeBps: bigint; realQuoteReserve: bigint; graduationThreshold: bigint;
}
export interface CurveDepthResult extends DepthResult { asksEndAtGraduation: boolean; bidsEndAtEmptyReserve: boolean }

/**
 * Depth of a constant-product bonding curve with virtual reserves and a fee (quote x token = k). Buying lifts the price up to the graduation
 * threshold (the curve then graduates); selling lowers it until the real quote reserve is paid out (a curve cannot pay more than it took in).
 * Rows are 1% in price; `total1` is the quote paid (asks, grossed up by the fee) or received (bids, after the fee), `amount0` the tokens.
 * Excludes any creator tax and snipe protection, which depend on the trade.
 */
export function buildCurveDepth(state: CurveDepthState, decimals: { quote: number; token: number }, maxRows = 40): CurveDepthResult {
  const reserveQuote = Number(state.quoteReserve);
  const reserveToken = Number(state.tokenReserve);
  const fee = Number(state.feeBps) / 10_000;
  const k = reserveQuote * reserveToken;
  const scaleQuote = 10 ** decimals.quote;
  const scaleToken = 10 ** decimals.token;
  const displayPrice = (quote: number) => (quote * quote / k) * 10 ** (decimals.token - decimals.quote);
  const upRoom = Math.max(0, Number(state.graduationThreshold - state.realQuoteReserve));
  const downRoom = Number(state.realQuoteReserve);
  const side = (direction: 1 | -1): { rows: DepthRow[]; ended: boolean } => {
    const rows: DepthRow[] = [];
    // Room smaller than a millionth of the quote asset is dust (a curve nobody has traded on): no rows rather than a meaningless one.
    const dust = 10 ** Math.max(0, decimals.quote - 6);
    const room = (direction === 1 ? upRoom : downRoom) < dust ? 0 : direction === 1 ? upRoom : downRoom;
    let moved = 0; // quote moved from the current virtual reserve (net for asks, gross for bids)
    let cumulative = 0;
    let ended = room <= 0;
    for (let index = 1; index <= maxRows && !ended; index += 1) {
      const target = Math.abs(reserveQuote * STEP ** ((direction * index) / 2) - reserveQuote);
      const next = Math.min(target, room);
      ended = next >= room;
      const before = reserveQuote + direction * moved;
      const after = reserveQuote + direction * next;
      const tokens = Math.abs(k / after - k / before);
      const quote = direction === 1 ? (next - moved) / (1 - fee) : (next - moved) * (1 - fee);
      cumulative += quote / scaleQuote;
      rows.push({ price: displayPrice(after), amount0: tokens / scaleToken, total1: quote / scaleQuote, cumulative1: cumulative });
      moved = next;
    }
    return { rows, ended };
  };
  const asks = side(1);
  const bids = side(-1);
  return { asks: asks.rows, bids: bids.rows, spreadPercent: (2 * Number(state.feeBps)) / 100, asksEndAtGraduation: asks.ended, bidsEndAtEmptyReserve: bids.ended };
}

const curveAbi = parseAbi([
  'function quoteReserve() view returns (uint256)', 'function tokenReserve() view returns (uint256)',
  'function feeBps() view returns (uint256)', 'function realQuoteReserve() view returns (uint256)',
]);

export interface CurveDepthAnswer {
  blockNumber: string | null; price: number | null; priceInverse: number | null; feeBps: number | null; creatorTaxBps: number | null;
  graduationThreshold: string | null; realQuoteReserve: string | null;
  /** The curve's virtual reserves (raw) and the asset decimals: enough to draw the whole curve, price against graduation progress. */
  quoteReserve: string | null; tokenReserve: string | null; quoteDecimals: number | null; tokenDecimals: number | null;
  asksEndAtGraduation: boolean; bidsEndAtEmptyReserve: boolean; depth: DepthResult | null; complete: boolean;
  unavailableReason: 'read_failed' | 'graduated' | 'decimals_unavailable' | null;
}

/** Depth of the launch's bonding curve from on-chain state at one block; null when the launch has no curve venue. */
export async function readCurveDepthAnswer(pool: Pool, client: LiquidityClient, identity: { chainId: number; tokenAddress: string }): Promise<CurveDepthAnswer | null> {
  const token = identity.tokenAddress.toLowerCase();
  const found = await pool.query(`SELECT v.ref AS curve, l.factory_address, l.token_decimals, l.quote_asset_decimals FROM venues v
    JOIN launches l ON l.chain_id = v.chain_id AND l.token_address = v.token_address
    WHERE v.chain_id = $1 AND v.token_address = $2 AND v.kind = 'curve' AND v.official = true LIMIT 1`, [identity.chainId, token]);
  const row = found.rows[0] as { curve: string; factory_address: string; token_decimals: number | null; quote_asset_decimals: number | null } | undefined;
  if (!row) return null;
  const base: CurveDepthAnswer = { blockNumber: null, price: null, priceInverse: null, feeBps: null, creatorTaxBps: null, graduationThreshold: null, realQuoteReserve: null,
    quoteReserve: null, tokenReserve: null, quoteDecimals: null, tokenDecimals: null,
    asksEndAtGraduation: false, bidsEndAtEmptyReserve: false, depth: null, complete: false, unavailableReason: null };
  if (row.token_decimals === null || row.quote_asset_decimals === null) return { ...base, unavailableReason: 'decimals_unavailable' };
  try {
    const blockNumber = await client.getBlockNumber();
    const curve = row.curve as Address;
    const [quoteReserve, tokenReserve, feeBps, realQuoteReserve, launched] = await Promise.all([
      ...(['quoteReserve', 'tokenReserve', 'feeBps', 'realQuoteReserve'] as const).map((functionName) => client.readContract({ address: curve, abi: curveAbi, functionName, blockNumber })),
      client.readContract({ address: row.factory_address as Address, abi: v2FactoryStateAbi, functionName: 'getLaunchedToken', args: [token as Address], blockNumber }),
    ]);
    const info = launched as { phase: number; graduationThreshold: bigint; creatorTaxBps: number; exists: boolean } | undefined;
    if (![quoteReserve, tokenReserve, feeBps, realQuoteReserve].every((value) => typeof value === 'bigint') || !info?.exists || typeof info.graduationThreshold !== 'bigint') return { ...base, unavailableReason: 'read_failed' };
    const state: CurveDepthState = { quoteReserve: quoteReserve as bigint, tokenReserve: tokenReserve as bigint, feeBps: feeBps as bigint,
      realQuoteReserve: realQuoteReserve as bigint, graduationThreshold: info.graduationThreshold };
    if (state.quoteReserve <= 0n || state.tokenReserve <= 0n) return { ...base, blockNumber: blockNumber.toString(), unavailableReason: 'read_failed' };
    const common = { blockNumber: blockNumber.toString(), feeBps: Number(feeBps), creatorTaxBps: Number(info.creatorTaxBps), graduationThreshold: info.graduationThreshold.toString(),
      realQuoteReserve: state.realQuoteReserve.toString(), quoteReserve: state.quoteReserve.toString(), tokenReserve: state.tokenReserve.toString(),
      quoteDecimals: row.quote_asset_decimals, tokenDecimals: row.token_decimals };
    if (info.phase !== 0) return { ...base, ...common, unavailableReason: 'graduated' };
    const decimals = { quote: row.quote_asset_decimals, token: row.token_decimals };
    const price = (Number(state.quoteReserve) / Number(state.tokenReserve)) * 10 ** (decimals.token - decimals.quote);
    const depth = buildCurveDepth(state, decimals);
    return { ...base, ...common, price, priceInverse: price > 0 ? 1 / price : null, asksEndAtGraduation: depth.asksEndAtGraduation, bidsEndAtEmptyReserve: depth.bidsEndAtEmptyReserve,
      depth: { asks: depth.asks, bids: depth.bids, spreadPercent: depth.spreadPercent }, complete: true, unavailableReason: null };
  } catch {
    return { ...base, unavailableReason: 'read_failed' };
  }
}

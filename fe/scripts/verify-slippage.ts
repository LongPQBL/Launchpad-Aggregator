// Manual on-chain check (not part of CI): proves the V3 and bonding-curve calldata built by the app enforces the minimum output.
// Nothing is sent; every call is an eth_call from a funded throwaway account (stateOverride).
// Usage: RH_HTTP_RPC_URL=... npx tsx scripts/verify-slippage.ts v3 <token> <fee>        (native ETH -> token through WETH)
//        RH_HTTP_RPC_URL=... npx tsx scripts/verify-slippage.ts curve <curveAddress>    (native ETH -> token on the curve)
// Each runs once with a minimum of 1 (must succeed) and once with an unreachable minimum (must revert).
import { createPublicClient, http, parseEther, type Address } from 'viem';
import { curveTradeAbi } from '../src/trading/curveAbi';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from '../src/trading/universalRouterAbi';
import { ADDRESS_THIS, encodeExecuteCommands, encodeV3SwapInput, encodeWrapEthInput, MSG_SENDER, WETH_ADDRESS } from '../src/trading/v3SwapEncoding';

const [mode, target, fee] = process.argv.slice(2);
if (!mode || !target || !process.env.RH_HTTP_RPC_URL) throw new Error('usage: see header');
const client = createPublicClient({ transport: http(process.env.RH_HTTP_RPC_URL) });
const account: Address = '0x00000000000000000000000000000000DeaDBeef';
const amountIn = parseEther('0.001');
const stateOverride = [{ address: account, balance: parseEther('1') }];
const IMPOSSIBLE = 1n << 200n;

async function attempt(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'success'; } catch (error) { return `reverted: ${(error as Error).message.split('\n')[0]}`; }
}

function v3(minOut: bigint) {
  return attempt(() => client.simulateContract({
    address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute', account, value: amountIn, stateOverride,
    args: [encodeExecuteCommands({ needsPermit: false, nativeIn: true, nativeOut: false }), [
      encodeWrapEthInput({ recipient: ADDRESS_THIS, amountMinimum: amountIn }),
      encodeV3SwapInput({ tokenIn: WETH_ADDRESS, tokenOut: target as Address, fee: Number(fee), amountIn, amountOutMinimum: minOut, payerIsUser: false, recipient: MSG_SENDER }),
    ], BigInt(Math.floor(Date.now() / 1000) + 1800)],
  }));
}

function curve(minOut: bigint) {
  return attempt(() => client.simulateContract({
    address: target as Address, abi: curveTradeAbi, functionName: 'buy', account, value: amountIn, stateOverride, args: [amountIn, minOut, account],
  }));
}

const run = mode === 'v3' ? v3 : curve;
const loose = await run(1n);
const impossible = await run(IMPOSSIBLE);
console.log({ mode, loose, impossible });
process.exit(loose === 'success' && impossible.startsWith('reverted') ? 0 : 1);

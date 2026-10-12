// Manual on-chain check (not part of CI): proves the V4 swap calldata built by the app really enforces amountOutMinimum.
// Usage: RH_HTTP_RPC_URL=... npx tsx scripts/verify-v4-slippage.ts <currency1> <fee> <tickSpacing> <hooks>
// Simulates (eth_call, nothing is sent) a native-ETH -> token swap from a funded throwaway account:
//   1. amountOutMinimum = 1                -> must succeed
//   2. amountOutMinimum = 2^128 - 1        -> must revert (the router refuses to pay out less than asked)
import { createPublicClient, http, parseEther, zeroAddress, type Address } from 'viem';
import { encodeExecuteCommands, encodeV4SwapInput } from '../src/trading/v4SwapEncoding';
import { universalRouterAbi, UNIVERSAL_ROUTER_ADDRESS } from '../src/trading/universalRouterAbi';

const [currency1, fee, tickSpacing, hooks] = process.argv.slice(2);
if (!currency1 || !process.env.RH_HTTP_RPC_URL) throw new Error('usage: see header');
const client = createPublicClient({ transport: http(process.env.RH_HTTP_RPC_URL) });
const account: Address = '0x00000000000000000000000000000000DeaDBeef';
const poolKey = { currency0: zeroAddress, currency1: currency1 as Address, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: (hooks ?? zeroAddress) as Address };
const amountIn = parseEther('0.001');

async function simulate(amountOutMinimum: bigint): Promise<string> {
  try {
    await client.simulateContract({
      address: UNIVERSAL_ROUTER_ADDRESS, abi: universalRouterAbi, functionName: 'execute', account, value: amountIn,
      args: [encodeExecuteCommands({ needsPermit: false }), [encodeV4SwapInput({ poolKey, zeroForOne: true, amountIn, amountOutMinimum })],
        BigInt(Math.floor(Date.now() / 1000) + 1800)],
      stateOverride: [{ address: account, balance: parseEther('1') }],
    });
    return 'success';
  } catch (error) {
    return `reverted: ${(error as Error).message.split('\n')[0]}`;
  }
}

const loose = await simulate(1n);
const impossible = await simulate((1n << 128n) - 1n);
console.log({ loose, impossible });
process.exit(loose === 'success' && impossible.startsWith('reverted') ? 0 : 1);

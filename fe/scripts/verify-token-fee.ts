// Manual check (not CI): runs checkTokenFee against the real Robinhood RPC (eth_simulateV1) on tokens planted by state override.
// Planted: a 5% and a 60% fee-on-transfer token, a 0% token, and a token that reverts on any transfer to the pool (sell-blocked).
// Usage: RH_HTTP_RPC_URL=... npx tsx scripts/verify-token-fee.ts /tmp/fot/fot.hex
import { readFileSync } from 'node:fs';
import { createPublicClient, encodeAbiParameters, http, keccak256, numberToHex, pad, type Address, type Hex } from 'viem';
import { checkTokenFee, feeWarning, type SimulateClient } from '../src/trading/token-fee-check';

const code = ('0x' + readFileSync(process.argv[2], 'utf8').trim().replace(/^0x/, '')) as Hex;
const client = createPublicClient({ transport: http(process.env.RH_HTTP_RPC_URL) }) as unknown as SimulateClient;
const word = (v: bigint): Hex => pad(numberToHex(v), { size: 32 });
const slot = (key: Address, base: bigint) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, base]));
const POOL: Address = '0x00000000000000000000000000000000000000a1';

async function run(name: string, address: Address, feeBps: bigint, blocked: Address | null) {
  const storage: Record<Hex, Hex> = { [pad('0x1')]: word(feeBps), [pad('0x2')]: blocked ? pad(blocked) : word(0n), [slot(POOL, 0n)]: word(10n ** 12n) };
  const result = await checkTokenFee(client, address, POOL, { extraOverrides: { [address]: { code, stateDiff: storage } } });
  console.log(name.padEnd(28), JSON.stringify(result), '\n   ->', feeWarning(result, 'TEST') ?? '(no warning)');
}
await run('5% fee on every transfer', '0x00000000000000000000000000000000000f0001', 500n, null);
await run('60% fee', '0x00000000000000000000000000000000000f0002', 6000n, null);
await run('0% fee (clean token)', '0x00000000000000000000000000000000000f0003', 0n, null);
await run('sells to pool blocked', '0x00000000000000000000000000000000000f0004', 0n, POOL);

import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad, parseAbi,
  type Address, type Hex, type StateOverride,
} from 'viem';

// A fixed address used only inside eth_call simulations: it is given a balance and an allowance
// by state override, so the reverse quote never depends on the connected wallet's own state.
export const SIMULATION_ACCOUNT: Address = '0x00000000000000000000000000000000000a11ce';
export const MAX_UINT256 = (1n << 256n) - 1n;

export interface CallClient {
  call: (args: { to: Address; data: Hex; account?: Address; value?: bigint; stateOverride?: StateOverride }) => Promise<{ data?: Hex }>;
}

const erc20ProbeAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

const PROBE_SPENDER: Address = '0x00000000000000000000000000000000000b0b00';
const PROBE_VALUE = 4_294_967_295n;
// OpenZeppelin 5 keeps ERC20 state at a fixed ERC-7201 namespaced slot: _balances at +0, _allowances at +1.
const OZ5_ERC20_STORAGE = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00');
const STAGE_ONE = [OZ5_ERC20_STORAGE, 0n, 1n, 2n, 3n];
const STAGE_TWO = [4n, 5n, 6n, 7n, 8n, 9n];

export type BalanceSlot = (owner: Address) => Hex;
export type AllowanceSlot = (owner: Address, spender: Address) => Hex;
export interface Erc20Layouts {
  balanceSlot: BalanceSlot | null;
  allowanceSlot: AllowanceSlot | null;
}

const mappingSlot = (key: Address, base: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, base]));

// mapping(address => uint256) _balances at `base`
export const balanceSlotAt = (base: bigint): BalanceSlot => (owner) => mappingSlot(owner, base);
// mapping(address => mapping(address => uint256)) _allowances at `base`
export const allowanceSlotAt = (base: bigint): AllowanceSlot => (owner, spender) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [spender, BigInt(mappingSlot(owner, base))]));

const word = (value: bigint): Hex => pad(numberToHex(value), { size: 32 });

// Write a probe value into a candidate slot and read it back through the token's OWN view
// function: if the view returns the probe, that slot is where the token keeps this value.
async function probe(
  client: CallClient,
  token: Address,
  functionName: 'balanceOf' | 'allowance',
  slot: Hex,
): Promise<boolean> {
  try {
    const data = functionName === 'balanceOf'
      ? encodeFunctionData({ abi: erc20ProbeAbi, functionName, args: [SIMULATION_ACCOUNT] })
      : encodeFunctionData({ abi: erc20ProbeAbi, functionName, args: [SIMULATION_ACCOUNT, PROBE_SPENDER] });
    const { data: out } = await client.call({
      to: token,
      data,
      stateOverride: [{ address: token, stateDiff: [{ slot, value: word(PROBE_VALUE) }] }],
    });
    if (!out) return false;
    return decodeFunctionResult({ abi: erc20ProbeAbi, functionName, data: out }) === PROBE_VALUE;
  } catch {
    return false;
  }
}

async function discover(client: CallClient, token: Address): Promise<Erc20Layouts> {
  let balanceSlot: BalanceSlot | null = null;
  let allowanceSlot: AllowanceSlot | null = null;
  for (const stage of [STAGE_ONE, STAGE_TWO]) {
    const [balanceHits, allowanceHits] = await Promise.all([
      balanceSlot
        ? Promise.resolve<boolean[]>([])
        : Promise.all(stage.map((base) => probe(client, token, 'balanceOf', balanceSlotAt(base)(SIMULATION_ACCOUNT)))),
      allowanceSlot
        ? Promise.resolve<boolean[]>([])
        : Promise.all(stage.map((base) => probe(client, token, 'allowance', allowanceSlotAt(base === OZ5_ERC20_STORAGE ? base + 1n : base)(SIMULATION_ACCOUNT, PROBE_SPENDER)))),
    ]);
    const balanceIndex = balanceHits.indexOf(true);
    if (balanceIndex !== -1) balanceSlot = balanceSlotAt(stage[balanceIndex]);
    const allowanceIndex = allowanceHits.indexOf(true);
    if (allowanceIndex !== -1) {
      const base = stage[allowanceIndex];
      allowanceSlot = allowanceSlotAt(base === OZ5_ERC20_STORAGE ? base + 1n : base);
    }
    if (balanceSlot && allowanceSlot) break;
  }
  return { balanceSlot, allowanceSlot };
}

// One chain only (Robinhood Chain, 4663), so the token address alone is a sufficient cache key.
const cache = new Map<string, Promise<Erc20Layouts>>();
export function discoverErc20Layouts(client: CallClient, token: Address): Promise<Erc20Layouts> {
  const key = token.toLowerCase();
  let hit = cache.get(key);
  if (!hit) {
    hit = discover(client, token);
    cache.set(key, hit);
  }
  return hit;
}
export function clearErc20LayoutCache(): void { cache.clear(); }

export function spendStateOverride(
  { layouts, token, owner, spender }: { layouts: Erc20Layouts; token: Address; owner: Address; spender: Address },
): StateOverride | null {
  if (!layouts.balanceSlot || !layouts.allowanceSlot) return null;
  return [{
    address: token,
    stateDiff: [
      { slot: layouts.balanceSlot(owner), value: word(MAX_UINT256) },
      { slot: layouts.allowanceSlot(owner, spender), value: word(MAX_UINT256) },
    ],
  }];
}

export function nativeBalanceOverride(owner: Address): StateOverride {
  return [{ address: owner, balance: 10n ** 30n }];
}

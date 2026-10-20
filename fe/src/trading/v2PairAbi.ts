import { parseAbi } from 'viem';

// The two reads a Uniswap V2 quote needs. The pair's own reserves are the whole price: there is no quoter contract to ask.
export const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);

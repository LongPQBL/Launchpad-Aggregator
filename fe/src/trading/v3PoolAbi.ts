import { parseAbi } from 'viem';

// A V3 pool's fee is immutable once the pool is created — this is the standard
// IUniswapV3PoolImmutables interface, not Robinhood-chain-specific.
export const v3PoolAbi = parseAbi([
  'function fee() view returns (uint24)',
]);

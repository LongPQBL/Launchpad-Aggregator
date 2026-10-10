import type { SearchResults, SearchTokenHit } from '@/api/client';

const CHAIN_ID = 4663;
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

const tokens: SearchTokenHit[] = Array.from({ length: 8 }, (_, index) => {
  const number = index + 1;
  return {
    chainId: CHAIN_ID,
    tokenAddress: `0x${number.toString(16).padStart(40, '0')}`,
    name: `Demo Token ${number}`,
    symbol: `DEMO${number}`,
    logoUri: null,
    platform: 'pons',
    priceUsd: (number / 100).toFixed(2),
    change1d: index % 2 === 0 ? '4.25' : '-2.10',
  };
});

const pools: SearchResults['pools'] = tokens.map((token, index) => ({
  chainId: CHAIN_ID,
  protocol: 'uniswap_v4',
  poolId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  fee: 3000,
  currency0: token.tokenAddress,
  currency1: NATIVE_ADDRESS,
  currency0Symbol: token.symbol,
  currency0LogoUri: null,
  currency1Symbol: 'ETH',
  currency1LogoUri: null,
  volume24hUsd: String((index + 1) * 12500),
  ponsDesignated: false,
  launchToken: { address: token.tokenAddress, name: token.name, symbol: token.symbol, logoUri: null },
}));

export function demoSearchResults(query: string, chainIds: readonly number[] | undefined, limit: number, offset: number): SearchResults {
  if (chainIds && !chainIds.includes(CHAIN_ID)) return { tokens: [], pools: [] };
  const needle = query.trim().toLowerCase();
  const matchingTokens = tokens.filter((token) => `${token.name} ${token.symbol}`.toLowerCase().includes(needle));
  const matchingPools = pools.filter((pool) => `${pool.launchToken.name} ${pool.launchToken.symbol} ETH`.toLowerCase().includes(needle));
  return { tokens: matchingTokens.slice(offset, offset + limit), pools: matchingPools.slice(offset, offset + limit) };
}

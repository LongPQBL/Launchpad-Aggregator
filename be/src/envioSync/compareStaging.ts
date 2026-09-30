export interface CountDiff {
  onlyInReal: string[];
  onlyInStaging: string[];
  matching: number;
}

export function compareLaunchCounts(
  real: readonly { tokenAddress: string }[],
  staging: readonly { tokenAddress: string }[],
): CountDiff {
  const realSet = new Set(real.map((row) => row.tokenAddress));
  const stagingSet = new Set(staging.map((row) => row.tokenAddress));
  return {
    onlyInReal: [...realSet].filter((address) => !stagingSet.has(address)).sort(),
    onlyInStaging: [...stagingSet].filter((address) => !realSet.has(address)).sort(),
    matching: [...realSet].filter((address) => stagingSet.has(address)).length,
  };
}

export function compareTradeCounts(
  real: readonly { txHash: string; logIndex: number }[],
  staging: readonly { txHash: string; logIndex: number }[],
): CountDiff {
  const key = (row: { txHash: string; logIndex: number }) => `${row.txHash}:${row.logIndex}`;
  const realSet = new Set(real.map(key));
  const stagingSet = new Set(staging.map(key));
  return {
    onlyInReal: [...realSet].filter((k) => !stagingSet.has(k)).sort(),
    onlyInStaging: [...stagingSet].filter((k) => !realSet.has(k)).sort(),
    matching: [...realSet].filter((k) => stagingSet.has(k)).length,
  };
}

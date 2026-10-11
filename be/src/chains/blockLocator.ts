export interface BlockClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/** Finds the latest block whose timestamp is <= a target time, narrowing with interpolation between known blocks and sharing what it learns. */
export function createBlockLocator(client: BlockClient) {
  const known = new Map<bigint, number>();
  const timestampOf = async (blockNumber: bigint): Promise<number> => {
    const cached = known.get(blockNumber);
    if (cached !== undefined) return cached;
    const timestamp = Number((await client.getBlock({ blockNumber })).timestamp);
    known.set(blockNumber, timestamp);
    return timestamp;
  };
  return async function blockAtOrBefore(targetSeconds: number): Promise<{ block: bigint; timestamp: number } | null> {
    let high = await client.getBlockNumber();
    let low = 1n;
    const lowTs = await timestampOf(low);
    if (lowTs > targetSeconds) return null;
    if ((await timestampOf(high)) <= targetSeconds) return { block: high, timestamp: await timestampOf(high) };
    // Tighten with the closest blocks already known on either side of the target.
    for (const [block, timestamp] of known) {
      if (timestamp <= targetSeconds && block > low) low = block;
      if (timestamp > targetSeconds && block < high) high = block;
    }
    for (let step = 0; step < 64 && high - low > 1n; step += 1) {
      const lowT = known.get(low) ?? await timestampOf(low);
      const highT = known.get(high) ?? await timestampOf(high);
      const ratio = highT === lowT ? 0.5 : (targetSeconds - lowT) / (highT - lowT);
      let guess = low + BigInt(Math.floor(Number(high - low) * Math.min(0.99, Math.max(0.01, ratio))));
      if (guess <= low) guess = low + 1n;
      if (guess >= high) guess = high - 1n;
      if ((await timestampOf(guess)) <= targetSeconds) low = guess; else high = guess;
    }
    return { block: low, timestamp: await timestampOf(low) };
  };
}

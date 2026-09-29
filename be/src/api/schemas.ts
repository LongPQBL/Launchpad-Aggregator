const quoteAsset = { type: 'object', properties: {
  address: { type: 'string' }, symbol: { type: 'string' }, decimals: { type: 'integer' },
} } as const;

export const launchSummary = { type: 'object', properties: {
  chainId: { type: 'integer' }, tokenAddress: { type: 'string' }, name: { type: 'string' }, symbol: { type: 'string' },
  platform: { type: 'string' }, protocolVersion: { type: 'string' }, quoteAsset,
  lifecycleStatus: { type: 'string' }, officialVolume24h: { type: 'string', nullable: true }, coverageStatus: { type: 'string' },
} } as const;

export const launchDetail = { type: 'object', properties: {
  ...launchSummary.properties,
  officialVenues: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, kind: { type: 'string' }, ref: { type: 'string' },
    effectiveFromBlock: { type: 'string' }, effectiveToBlock: { type: 'string', nullable: true },
  } } },
  priceQuote: { type: 'string', nullable: true },
  priceStale: { type: 'boolean' },
} } as const;

export const trade = { type: 'object', properties: {
  venueId: { type: 'string' }, blockNumber: { type: 'string' }, txHash: { type: 'string' },
  logIndex: { type: 'integer' }, timestamp: { type: 'integer' }, side: { type: 'string' }, activityKind: { type: 'string' },
  tokenAmount: { type: 'string' }, quoteAmount: { type: 'string' }, priceQuote: { type: 'string', nullable: true },
} } as const;

export const candle = { type: 'object', properties: {
  intervalSeconds: { type: 'integer' }, bucketStart: { type: 'integer' },
  open: { type: 'string' }, high: { type: 'string' }, low: { type: 'string' }, close: { type: 'string' },
  quoteVolume: { type: 'string' },
} } as const;

export function pageSchema(item: object) {
  return { type: 'object', properties: { items: { type: 'array', items: item }, nextCursor: { type: 'string', nullable: true } } } as const;
}

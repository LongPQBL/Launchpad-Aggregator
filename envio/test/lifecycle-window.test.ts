import { describe, expect, it } from 'vitest';
import { createTestIndexer } from 'envio';

const v2Factory = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as const;
const launched = '0x1111111111111111111111111111111111111111' as const;
const earlier = '0x3333333333333333333333333333333333333333' as const;
const curve = '0x4444444444444444444444444444444444444444' as const;
const quoteToken = '0x2222222222222222222222222222222222222222' as const;
const deployer = '0x5555555555555555555555555555555555555555' as const;

const launchV2 = { contract: 'PonsV2Factory' as const, event: 'TokenLaunchedV2' as const, srcAddress: v2Factory,
  block: { number: 91503100 },
  params: { token: launched, curve, deployer, pairToken: quoteToken, launchConfigId: 0n, graduationThreshold: 1n } };

describe('PonsV2Factory lifecycle events', () => {
  it('stores a transition for a launch created inside the indexed window', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [launchV2, { contract: 'PonsV2Factory', event: 'LaunchSwept', srcAddress: v2Factory,
      block: { number: 91503200 }, params: { token: launched, quoteOut: 1n, tokenOut: 1n } }] } } });
    const rows = await indexer.RawLifecycleTransition.getAll();
    expect(rows.map((row) => row.kind)).toEqual(['swept']);
  });

  it('drops a transition for a launch created before the indexed window', async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 4663: { simulate: [
      { contract: 'PonsV2Factory', event: 'LaunchSwept', srcAddress: v2Factory, block: { number: 91503200 },
        params: { token: earlier, quoteOut: 1n, tokenOut: 1n } },
      { contract: 'PonsV2Factory', event: 'PoolGraduated', srcAddress: v2Factory, block: { number: 91503201 },
        params: { token: earlier, positionId: 1n, tokenAmount: 1n, pairTokenAmount: 1n } },
      { contract: 'PonsV2Factory', event: 'LaunchGraduationRescued', srcAddress: v2Factory, block: { number: 91503202 },
        params: { token: earlier, recipient: deployer, quoteAmount: 1n, tokenAmount: 1n } },
    ] } } });
    expect(await indexer.RawLifecycleTransition.getAll()).toHaveLength(0);
  });
});

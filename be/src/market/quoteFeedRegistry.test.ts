import { describe, expect, it, vi } from 'vitest';
import { createQuoteFeedRegistry } from './quoteFeedRegistry.js';

const nvda = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const tsla = '0x322f0929c4625ed5bad873c95208d54e1c003b2d';
const fakeNvda = '0x1111111111111111111111111111111111111111';

describe('quote feed discovery', () => {
  it('resolves only the canonical chain-4663 asset address to its USD feed', async () => {
    const fetchJson = vi.fn(async (url: string) => url.includes('/rhj/assets')
      ? { assets: [{ tokenSymbol: 'NVDA', status: 'ASSET_STATUS_ACTIVE', deployments: [
        { chainId: 4663, contractAddress: nvda }, { chainId: 1, contractAddress: fakeNvda },
      ] }] }
      : [{ name: 'Robinhood NVDA / USD', proxyAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' }]);
    const registry = createQuoteFeedRegistry(fetchJson, () => 1000);
    expect(await registry.resolve(nvda)).toBe('0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15');
    expect(await registry.resolve(fakeNvda)).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('discovers a quote added after the cache expires', async () => {
    let time = 1000;
    let expanded = false;
    const fetchJson = vi.fn(async (url: string) => url.includes('/rhj/assets')
      ? { assets: [{ tokenSymbol: 'NVDA', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: nvda }] },
        ...(expanded ? [{ tokenSymbol: 'TSLA', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: tsla }] }] : [])] }
      : [{ name: 'Robinhood NVDA / USD', proxyAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
        ...(expanded ? [{ name: 'Robinhood TSLA / USD', proxyAddress: '0x4A1166a659A55625345e9515b32adECea5547C38' }] : [])]);
    const registry = createQuoteFeedRegistry(fetchJson, () => time);
    expect(await registry.resolve(tsla)).toBeNull();
    expanded = true;
    time += 3_600_001;
    expect(await registry.resolve(tsla)).toBe('0x4A1166a659A55625345e9515b32adECea5547C38');
  });
});

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
    expect(fetchJson).toHaveBeenCalledTimes(3);
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

  it('keeps a verified mapping and retries later when a directory refresh fails', async () => {
    let time = 1000;
    let fail = false;
    const fetchJson = vi.fn(async (url: string) => {
      if (fail) throw new Error('directory unavailable');
      return url.includes('/rhj/assets')
        ? { assets: [{ tokenSymbol: 'NVDA', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: nvda }] }] }
        : [{ name: 'Robinhood NVDA / USD', proxyAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' }];
    });
    const registry = createQuoteFeedRegistry(fetchJson, () => time);
    expect(await registry.resolve(nvda)).not.toBeNull();
    fail = true;
    time += 3_600_001;
    expect(await registry.resolve(nvda)).not.toBeNull();
    expect(await registry.resolve(tsla)).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(6);
  });

  it('resolves a crypto quote feed named without the "Robinhood" prefix (e.g. "ETH / USD")', async () => {
    const eth = '0x0000000000000000000000000000000000000000';
    const fetchJson = vi.fn(async (url: string) => url.includes('/rhj/assets')
      ? { assets: [{ tokenSymbol: 'ETH', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: eth }] }] }
      : [{ name: 'ETH / USD', proxyAddress: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' }]);
    const registry = createQuoteFeedRegistry(fetchJson, () => 1000);
    expect(await registry.resolve(eth)).toBe('0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9');
  });

  it('resolves an asset\'s name/logo even when it has no USD feed match', async () => {
    const fetchJson = vi.fn(async (url: string) => url.includes('/rhj/assets')
      ? { assets: [{ tokenSymbol: 'NVDA', tokenName: 'NVIDIA • Robinhood Token',
        logoUrl: 'https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png',
        status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: nvda }] }] }
      : []);
    const registry = createQuoteFeedRegistry(fetchJson, () => 1000);
    expect(await registry.resolveMetadata(nvda)).toEqual({
      name: 'NVIDIA • Robinhood Token',
      logoUri: 'https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png',
    });
    expect(await registry.resolveMetadata(fakeNvda)).toBeNull();
  });

  it('resolves the stock symbol of a directory asset, uppercase, and null for an unknown address', async () => {
    const fetchJson = vi.fn(async (url: string) => url.includes('/rhj/assets')
      ? { assets: [{ tokenSymbol: 'ttwo', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: nvda }] }] }
      : []);
    const registry = createQuoteFeedRegistry(fetchJson, () => 1000);
    expect(await registry.resolveSymbol(nvda)).toBe('TTWO');
    expect(await registry.resolveSymbol(fakeNvda)).toBeNull();
  });

  describe('Chainlink CCIP token directory', () => {
    const cbbtc = '0xcec185eb182c47d1ba1efc84e6959e18cd620be4';
    const impostor = '0x2222222222222222222222222222222222222222';
    const feeds = [{ name: 'CBBTC / USD', proxyAddress: '0x0009cD492adf8167f9eEBf1293556A673530a21a' }];
    const ccip = { data: { cbBTC: {
      '4663': { chainId: 4663, symbol: 'cbBTC', tokenAddress: '0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4' },
      '8453': { chainId: 8453, symbol: 'cbBTC', tokenAddress: impostor },
    } } };
    const route = (ccipResponse: () => unknown) => vi.fn(async (url: string) => {
      if (url.includes('/rhj/assets')) return { assets: [] };
      if (url.includes('ccip')) return ccipResponse();
      return feeds;
    });

    it('maps a token the directory lists on chain 4663 to the feed with the same symbol, and only that address', async () => {
      const registry = createQuoteFeedRegistry(route(() => ccip), () => 1000);
      expect(await registry.resolve(cbbtc)).toBe('0x0009cD492adf8167f9eEBf1293556A673530a21a');
      expect(await registry.resolve(impostor)).toBeNull();
    });

    it('does not turn a CCIP token into a stock symbol', async () => {
      const registry = createQuoteFeedRegistry(route(() => ccip), () => 1000);
      expect(await registry.resolveSymbol(cbbtc)).toBeNull();
    });

    it('keeps working when the directory request fails or answers something unexpected', async () => {
      const failing = createQuoteFeedRegistry(route(() => { throw new Error('down'); }), () => 1000);
      expect(await failing.resolve(cbbtc)).toBeNull();
      const odd = createQuoteFeedRegistry(route(() => ({ nope: true })), () => 1000);
      expect(await odd.resolve(cbbtc)).toBeNull();
    });

    it('lets the Robinhood asset directory win when both list the address', async () => {
      const fetchJson = vi.fn(async (url: string) => {
        if (url.includes('/rhj/assets')) return { assets: [{ tokenSymbol: 'NVDA', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: cbbtc }] }] };
        if (url.includes('ccip')) return ccip;
        return [...feeds, { name: 'Robinhood NVDA / USD', proxyAddress: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' }];
      });
      expect(await createQuoteFeedRegistry(fetchJson, () => 1000).resolve(cbbtc)).toBe('0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15');
    });
  });
});

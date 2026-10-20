import { describe, expect, it, vi } from 'vitest';
import { ApiEventBus } from './events.js';
import { withLaunchListCache } from './listCache.js';

function setup() {
  let time = 0;
  const listLaunches = vi.fn(async () => ({ items: [], nextCursor: null }));
  const events = new ApiEventBus();
  const cached = withLaunchListCache({ listLaunches } as never, events, 1_000, () => time);
  return { cached, listLaunches, events, advance: (ms: number) => { time += ms; } };
}

describe('withLaunchListCache', () => {
  it('shares one computation among identical first-page requests within the interval', async () => {
    const { cached, listLaunches, advance } = setup();
    await Promise.all([cached.listLaunches({ limit: 50 }), cached.listLaunches({ limit: 50 })]);
    expect(listLaunches).toHaveBeenCalledTimes(1);
    await cached.listLaunches({ limit: 20 });
    expect(listLaunches).toHaveBeenCalledTimes(2);
    advance(1_100);
    await cached.listLaunches({ limit: 50 });
    expect(listLaunches).toHaveBeenCalledTimes(3);
  });

  it('drops an entry on an announced change once it is at least half a second old, but not before', async () => {
    const { cached, listLaunches, events, advance } = setup();
    await cached.listLaunches({ limit: 50 });
    events.publish({ type: 'launch.changed', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
    await cached.listLaunches({ limit: 50 });
    expect(listLaunches).toHaveBeenCalledTimes(1); // just computed: kept, so a hot list is recomputed at most twice a second
    advance(600);
    events.publish({ type: 'launch.changed', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
    await cached.listLaunches({ limit: 50 });
    expect(listLaunches).toHaveBeenCalledTimes(2);
  });

  it('ignores events that change nothing the list reads', async () => {
    const { cached, listLaunches, events, advance } = setup();
    await cached.listLaunches({ limit: 50 });
    advance(600);
    events.publish({ type: 'trade.created', chainId: 4663, tokenAddress: '0x1111111111111111111111111111111111111111' });
    events.publish({ type: 'pool.changed', chainId: 4663, poolId: `0x${'ab'.repeat(32)}` });
    await cached.listLaunches({ limit: 50 });
    expect(listLaunches).toHaveBeenCalledTimes(1);
  });

  it('does not cache paged or searched requests, nor a failed one', async () => {
    const { cached, listLaunches } = setup();
    await cached.listLaunches({ limit: 50, cursor: 'c' });
    await cached.listLaunches({ limit: 50, cursor: 'c' });
    await cached.listLaunches({ limit: 50, search: 'a' });
    await cached.listLaunches({ limit: 50, search: 'a' });
    expect(listLaunches).toHaveBeenCalledTimes(4);
    listLaunches.mockRejectedValueOnce(new Error('down'));
    await expect(cached.listLaunches({ limit: 7 })).rejects.toThrow('down');
    await cached.listLaunches({ limit: 7 });
    expect(listLaunches).toHaveBeenCalledTimes(6);
  });

  it('is a pass-through without an event bus', async () => {
    const listLaunches = vi.fn(async () => ({ items: [], nextCursor: null }));
    const data = withLaunchListCache({ listLaunches } as never);
    await data.listLaunches({ limit: 50 });
    await data.listLaunches({ limit: 50 });
    expect(listLaunches).toHaveBeenCalledTimes(2);
  });

  it('shares a token\'s first page of transactions for two seconds, but never a paged request', async () => {
    let time = 0;
    const listTransactions = vi.fn(async () => ({ items: [], nextCursor: null }));
    const cached = withLaunchListCache({ listTransactions } as never, new ApiEventBus(), 1_000, () => time);
    const token = '0xAbC0000000000000000000000000000000000001';
    await Promise.all([cached.listTransactions(4663, token, { limit: 50 }), cached.listTransactions(4663, token.toLowerCase(), { limit: 50 })]);
    expect(listTransactions).toHaveBeenCalledTimes(1);
    await cached.listTransactions(4663, token, { limit: 50, cursor: 'next' });
    expect(listTransactions).toHaveBeenCalledTimes(2);
    time += 2_500;
    await cached.listTransactions(4663, token, { limit: 50 });
    expect(listTransactions).toHaveBeenCalledTimes(3);
  });
});

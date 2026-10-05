import type { ChangeNotification } from '../../envioSync/notifyChanges.js';
import type { LaunchKey } from './store.js';

export function launchKeysFromChanges(changes: readonly ChangeNotification[]): LaunchKey[] {
  const keys = new Map<string, LaunchKey>();
  for (const change of changes) {
    if (change.tokenAddress === undefined) continue;
    keys.set(`${change.chainId}:${change.tokenAddress}`, { chainId: change.chainId, tokenAddress: change.tokenAddress });
  }
  return [...keys.values()];
}

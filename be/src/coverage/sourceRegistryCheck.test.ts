import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPonsFactorySources } from '../launchpads/pons/sourceRegistry.js';
import { validateLaunchSourceConfig } from './sourceRegistryCheck.js';

const config = readFileSync(new URL('../../../envio/config.yaml', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../../../envio/src/EventHandlers.ts', import.meta.url), 'utf8');
const sources = getPonsFactorySources();

describe('Pons launch source registry', () => {
  it('matches both V1 factories and V2 to Envio config and handlers', () => {
    expect(sources.map((s) => [s.id, s.startBlock])).toEqual([
      ['pons-v1-legacy', 8600612n], ['pons-v1-active', 8991118n], ['pons-v2', 26841846n],
    ]);
    expect(sources.every((s) => s.enabled && s.registryVersion === 1)).toBe(true);
    expect(sources[0]?.launchTopic).toBe(sources[1]?.launchTopic);
    expect(sources[2]?.launchTopic).not.toBe(sources[0]?.launchTopic);
    expect(validateLaunchSourceConfig(sources, config, handlers)).toEqual([]);
  });

  it('rejects a duplicated or unconfigured factory', () => {
    expect(validateLaunchSourceConfig([...sources, { ...sources[0]!, id: 'duplicate' }], config, handlers)
      .some((i) => i.code === 'duplicate_factory')).toBe(true);
    expect(validateLaunchSourceConfig([...sources, { ...sources[0]!, id: 'future', factory: '0x1111111111111111111111111111111111111111' }], config, handlers)
      .some((i) => i.code === 'missing_config')).toBe(true);
  });

  it('rejects a missing handler or configured factory', () => {
    expect(validateLaunchSourceConfig(sources, config.replace(/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB/, '0x2222222222222222222222222222222222222222'), handlers)
      .some((i) => i.code === 'missing_config')).toBe(true);
    expect(validateLaunchSourceConfig(sources, config, handlers.replaceAll('PonsV2Factory', 'RemovedV2Factory'))
      .some((i) => i.code === 'missing_handler')).toBe(true);
  });
});

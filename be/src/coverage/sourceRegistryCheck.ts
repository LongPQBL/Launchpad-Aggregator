import { toEventSelector } from 'viem';
import type { FactorySource } from '../launchpads/pons/sourceRegistry.js';

export interface SourceConfigIssue {
  code: 'duplicate_factory' | 'missing_config' | 'missing_handler' | 'wrong_topic' | 'wrong_start' | 'unknown_config_factory';
  sourceId: string;
}

interface ConfiguredFactory { name: string; address: string; startBlock: bigint; event: string | null }

// This reads only the small, known Envio config shape. Fail closed if a factory declaration
// changes shape; it is a consistency audit, not a general YAML parser.
function parseFactories(config: string): ConfiguredFactory[] {
  const split = config.split(/^chains:\s*$/m);
  if (split.length !== 2) return [];
  const definitions = split[0]!;
  const chain = split[1]!;
  const chainStart = BigInt(chain.match(/^\s+start_block:\s*(\d+)\s*$/m)?.[1] ?? '0');
  const definitionByName = new Map<string, string>();
  for (const block of definitions.split(/^ {2}- name: /m).slice(1)) {
    const newline = block.indexOf('\n');
    if (newline < 0) continue;
    definitionByName.set(block.slice(0, newline).trim(), block.slice(newline + 1));
  }
  const result: ConfiguredFactory[] = [];
  for (const block of chain.split(/^ {6}- name: /m).slice(1)) {
    const newline = block.indexOf('\n');
    if (newline < 0) continue;
    const name = block.slice(0, newline).trim();
    if (!/^PonsV\w+Factory$/.test(name)) continue;
    const body = block.slice(newline + 1);
    const address = body.match(/^\s+- ["']?(0x[0-9a-fA-F]{40})["']?\s*$/m)?.[1];
    if (!address) continue;
    const event = definitionByName.get(name)?.match(/^\s+- event: ["']([^"']+)["']/m)?.[1] ?? null;
    const override = body.match(/^\s+start_block:\s*(\d+)\s*$/m)?.[1];
    result.push({ name, address, startBlock: override ? BigInt(override) : chainStart, event });
  }
  return result;
}

export function validateLaunchSourceConfig(
  sources: readonly FactorySource[], envioConfig: string, handlers: string,
): SourceConfigIssue[] {
  const issues: SourceConfigIssue[] = [];
  const configured = parseFactories(envioConfig);
  const seen = new Set<string>();
  for (const source of sources.filter((item) => item.enabled)) {
    const address = source.factory.toLowerCase();
    if (seen.has(address)) issues.push({ code: 'duplicate_factory', sourceId: source.id });
    seen.add(address);
    const match = configured.find((item) => item.address.toLowerCase() === address && item.name === source.envioContractName);
    if (!match) { issues.push({ code: 'missing_config', sourceId: source.id }); continue; }
    if (match.startBlock > source.startBlock) issues.push({ code: 'wrong_start', sourceId: source.id });
    if (!match.event || toEventSelector(match.event).toLowerCase() !== source.launchTopic.toLowerCase()) {
      issues.push({ code: 'wrong_topic', sourceId: source.id });
    }
    if (!handlers.includes(`contract: "${source.envioContractName}", event: "${source.version === 'v2' ? 'TokenLaunchedV2' : 'TokenLaunched'}"`)) {
      issues.push({ code: 'missing_handler', sourceId: source.id });
    }
  }
  for (const item of configured) {
    if (!sources.some((source) => source.factory.toLowerCase() === item.address.toLowerCase())) {
      issues.push({ code: 'unknown_config_factory', sourceId: item.name });
    }
  }
  return issues;
}

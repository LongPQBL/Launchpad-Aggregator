import { toEventSelector, type Address, type Hash } from 'viem';

export interface FactorySource {
  id: string;
  chainId: 4663;
  version: 'v1' | 'v2';
  factory: Address;
  startBlock: bigint;
  launchTopic: Hash;
  launchEventSignature: string;
  envioContractName: string;
  enabled: boolean;
  registryVersion: number;
}

const v1LaunchEventSignature = 'TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)';
const v2LaunchEventSignature = 'TokenLaunched(address,address,address,address,uint256,uint256)';
const v1LaunchTopic = toEventSelector(v1LaunchEventSignature);
const v2LaunchTopic = toEventSelector(v2LaunchEventSignature);

const sources: readonly FactorySource[] = [
  {
    id: 'pons-v1-legacy',
    chainId: 4663,
    version: 'v1',
    factory: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
    startBlock: 8600612n,
    launchTopic: v1LaunchTopic,
    launchEventSignature: v1LaunchEventSignature,
    envioContractName: 'PonsV1LegacyFactory', enabled: true, registryVersion: 1,
  },
  {
    id: 'pons-v1-active',
    chainId: 4663,
    version: 'v1',
    factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
    startBlock: 8991118n,
    launchTopic: v1LaunchTopic,
    launchEventSignature: v1LaunchEventSignature,
    envioContractName: 'PonsV1ActiveFactory', enabled: true, registryVersion: 1,
  },
  {
    id: 'pons-v2',
    chainId: 4663,
    version: 'v2',
    factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    startBlock: 26841846n,
    launchTopic: v2LaunchTopic,
    launchEventSignature: v2LaunchEventSignature,
    envioContractName: 'PonsV2Factory', enabled: true, registryVersion: 1,
  },
];

export function getPonsFactorySources(): readonly FactorySource[] {
  return sources;
}

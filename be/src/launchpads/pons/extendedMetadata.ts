import { parseAbi, type Address } from 'viem';

export const ponsExtendedMetadataAbi = parseAbi([
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'function socials() view returns (string twitter, string telegram, string discord, string website, string farcaster)',
]);

export interface ExtendedTokenMetadata {
  logoUri: string | null;
  description: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
}

export interface ExtendedMetadataReadClient {
  readContract(parameters: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readOneOrNull<T>(promise: Promise<T>): Promise<T | null> {
  try { return await promise; } catch { return null; }
}

export async function readExtendedTokenMetadata(client: ExtendedMetadataReadClient, token: Address): Promise<ExtendedTokenMetadata> {
  const [logo, description, socials] = await Promise.all([
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'logo' })),
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'description' })),
    readOneOrNull(client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'socials' })),
  ]);
  const socialsTuple = Array.isArray(socials) ? socials : [];
  return {
    logoUri: stringOrNull(logo),
    description: stringOrNull(description),
    // socials() returns [twitter, telegram, discord, website, farcaster] — verified order against
    // a real Pons token this session; do not reorder without re-verifying on-chain.
    twitterUrl: stringOrNull(socialsTuple[0]),
    websiteUrl: stringOrNull(socialsTuple[3]),
  };
}

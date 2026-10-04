import {
  ContractFunctionRevertedError, ContractFunctionZeroDataError,
  HttpRequestError, TimeoutError, parseAbi, type Address,
} from 'viem';

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

export interface BlockReadClient {
  getBlock(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export type ReadOutcome<T> =
  | { state: 'done'; value: T | null }
  | { state: 'pending'; value: null; errorKind: 'transport' | 'unknown' };

export interface MetadataReadResults {
  logo: ReadOutcome<string>;
  description: ReadOutcome<string>;
  socials: ReadOutcome<{ websiteUrl: string | null; twitterUrl: string | null }>;
  timestamp: ReadOutcome<number>;
}

export type ExtendedMetadataReadResults = Pick<MetadataReadResults, 'logo' | 'description' | 'socials'>;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function classifyReadError(error: unknown): ReadOutcome<never> {
  let cause: unknown = error;
  let contractFailure = false;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof HttpRequestError || cause instanceof TimeoutError) {
      return { state: 'pending', value: null, errorKind: 'transport' };
    }
    if (cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) {
      contractFailure = true;
    }
    cause = cause.cause;
  }
  return contractFailure ? { state: 'done', value: null } : { state: 'pending', value: null, errorKind: 'unknown' };
}

async function readOne<T>(read: () => Promise<T>): Promise<ReadOutcome<T>> {
  try { return { state: 'done', value: await read() }; }
  catch (error) { return classifyReadError(error); }
}

export async function readExtendedTokenMetadataOutcomes(
  client: ExtendedMetadataReadClient, token: Address,
  functions: readonly ('logo' | 'description' | 'socials')[] = ['logo', 'description', 'socials'],
): Promise<ExtendedMetadataReadResults> {
  const skipped = { state: 'done', value: null } as const;
  const [logo, description, socials] = await Promise.all([
    functions.includes('logo')
      ? readOne(() => client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'logo' })) : skipped,
    functions.includes('description')
      ? readOne(() => client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'description' })) : skipped,
    functions.includes('socials')
      ? readOne(() => client.readContract({ address: token, abi: ponsExtendedMetadataAbi, functionName: 'socials' })) : skipped,
  ]);
  const socialsTuple = Array.isArray(socials.value) ? socials.value : [];
  return {
    logo: logo.state === 'done' ? { state: 'done', value: stringOrNull(logo.value) } : logo,
    description: description.state === 'done' ? { state: 'done', value: stringOrNull(description.value) } : description,
    // socials() returns [twitter, telegram, discord, website, farcaster] — verified order against
    // a real Pons token this session; do not reorder without re-verifying on-chain.
    socials: socials.state === 'done'
      ? { state: 'done', value: { twitterUrl: stringOrNull(socialsTuple[0]), websiteUrl: stringOrNull(socialsTuple[3]) } }
      : socials,
  };
}

export async function readLaunchTimestamp(client: BlockReadClient, blockNumber: bigint): Promise<ReadOutcome<number>> {
  const result = await readOne(() => client.getBlock({ blockNumber }));
  return result.state === 'done' ? { state: 'done', value: Number(result.value?.timestamp) } : result;
}

export function mapMetadataReadResults(results: MetadataReadResults) {
  return {
    logoUri: results.logo.value,
    description: results.description.value,
    websiteUrl: results.socials.value?.websiteUrl ?? null,
    twitterUrl: results.socials.value?.twitterUrl ?? null,
    launchTimestamp: results.timestamp.value,
    logoReadState: results.logo.state,
    descriptionReadState: results.description.state,
    socialsReadState: results.socials.state,
    timestampReadState: results.timestamp.state,
  };
}

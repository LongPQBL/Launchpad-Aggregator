export type ScanLane = 'certified' | 'provisional';
export type ScanJobStatus = 'pending' | 'leased' | 'complete' | 'failed';

export interface ScanJob {
  id: string;
  sourceId: string;
  lane: ScanLane;
  fromBlock: bigint;
  toBlock: bigint;
  generation: bigint;
  status: ScanJobStatus;
  leaseOwner: string | null;
  leaseUntil: Date | null;
}

export interface NewScanJob {
  sourceId: string;
  lane: ScanLane;
  fromBlock: bigint;
  toBlock: bigint;
}

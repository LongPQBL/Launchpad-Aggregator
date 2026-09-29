export type ApiEventType = 'launch.changed' | 'trade.created' | 'coverage.changed';
export interface ApiEvent { type: ApiEventType; chainId: number; tokenAddress?: string }
export interface SequencedApiEvent extends ApiEvent { id: string }

export class ApiEventBus {
  private nextId = 0;
  private listeners = new Set<(event: SequencedApiEvent) => void>();

  publish(event: ApiEvent): void {
    const sequenced = { ...event, id: String(++this.nextId) };
    for (const listener of this.listeners) listener(sequenced);
  }

  subscribe(listener: (event: SequencedApiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

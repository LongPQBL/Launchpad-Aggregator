export interface TradeStatusProps {
  status: 'idle' | 'pending' | 'confirming' | 'confirmed' | 'failed';
  txHash: `0x${string}` | undefined;
  errorMessage: string | null;
  explorerBase: string | null;
}

export function TradeStatus({ status, txHash, errorMessage, explorerBase }: TradeStatusProps) {
  if (status === 'idle') return null;

  const explorerLink = explorerBase && txHash ? (
    <a href={`${explorerBase}/tx/${txHash}`} target="_blank" rel="noreferrer noopener" className="underline hover:text-primary">
      View transaction
    </a>
  ) : null;

  if (status === 'pending') return <p className="text-sm text-muted-foreground">Confirm in your wallet…</p>;
  if (status === 'confirming') return <p className="text-sm text-muted-foreground">Confirming on-chain… {explorerLink}</p>;
  if (status === 'confirmed') return <p className="text-sm text-emerald-600">Confirmed. {explorerLink}</p>;
  return (
    <p role="alert" className="text-sm text-destructive">
      {errorMessage ?? 'Transaction failed.'} {explorerLink}
    </p>
  );
}

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TradeStatus } from './trade-status';

describe('TradeStatus', () => {
  it('shows nothing while idle', () => {
    const { container } = render(<TradeStatus status="idle" txHash={undefined} errorMessage={null} explorerBase={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a pending message while the wallet prompt is open', () => {
    render(<TradeStatus status="pending" txHash={undefined} errorMessage={null} explorerBase={null} />);
    expect(screen.getByText(/confirm in your wallet/i)).toBeInTheDocument();
  });

  it('links to the explorer once a hash exists', () => {
    render(<TradeStatus status="confirming" txHash="0xabc" errorMessage={null} explorerBase="https://robinhoodchain.blockscout.com" />);
    expect(screen.getByRole('link', { name: /view transaction/i })).toHaveAttribute('href', 'https://robinhoodchain.blockscout.com/tx/0xabc');
  });

  it('shows the decoded error message on failure', () => {
    render(<TradeStatus status="failed" txHash={undefined} errorMessage="User rejected the request" explorerBase={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('User rejected the request');
  });

  it('shows a confirmed message', () => {
    render(<TradeStatus status="confirmed" txHash="0xabc" errorMessage={null} explorerBase="https://robinhoodchain.blockscout.com" />);
    expect(screen.getByText(/confirmed/i)).toBeInTheDocument();
  });
});

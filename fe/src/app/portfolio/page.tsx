import { PortfolioView } from '@/features/portfolio/portfolio-view';

export default function PortfolioPage() {
  return (
    <>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Portfolio</h1>
        <PortfolioView />
      </div>
    </>
  );
}

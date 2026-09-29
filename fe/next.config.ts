import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Playwright/manual local checks load the dev server via 127.0.0.1; without this, Next blocks
  // its own HMR dev-resource requests from that origin (cosmetic in prod, noisy in dev logs).
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;

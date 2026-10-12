import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Playwright/manual local checks load the dev server via 127.0.0.1; without this, Next blocks
  // its own HMR dev-resource requests from that origin (cosmetic in prod, noisy in dev logs).
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        // Content-Security-Policy is set per request (with a nonce) in src/proxy.ts.
      ],
    }];
  },
};

export default nextConfig;

import nextConfig from 'eslint-config-next';

const config = [
  { ignores: ['.next/**', 'playwright-report/**', 'test-results/**'] },
  ...nextConfig,
  {
    // Playwright fixture files declare a `use` callback parameter; react-hooks/rules-of-hooks
    // mistakes it for the React `use()` hook. This directory has no React components/hooks.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
];

export default config;

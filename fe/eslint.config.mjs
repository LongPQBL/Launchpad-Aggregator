import nextConfig from 'eslint-config-next';

const config = [{ ignores: ['.next/**', 'playwright-report/**', 'test-results/**'] }, ...nextConfig];

export default config;

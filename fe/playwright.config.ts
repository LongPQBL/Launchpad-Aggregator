import { defineConfig, devices } from '@playwright/test';

const MOCK_API_PORT = 3101;
const APP_PORT = 3100;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const BE_URL = `http://127.0.0.1:${MOCK_API_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `npx tsx e2e/mock-api.ts ${MOCK_API_PORT}`,
      url: `${BE_URL}/v1/sources`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx next dev -p ${APP_PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      env: { BE_API_URL: BE_URL, NEXT_PUBLIC_BE_API_URL: BE_URL },
    },
  ],
});

import { test as base } from '@playwright/test';

// Fails the test if the app throws a client-side runtime error (e.g. the Lightweight Charts
// "data must be asc ordered by time" crash a real, wrongly-ordered candle page triggered —
// a bug the component tests' ascending-order fixtures didn't catch).
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await use(page);
    if (errors.length > 0) {
      throw new Error(`Page threw ${errors.length} runtime error(s):\n${errors.map((error) => error.stack ?? error.message).join('\n')}`);
    }
  },
});

export { expect } from '@playwright/test';

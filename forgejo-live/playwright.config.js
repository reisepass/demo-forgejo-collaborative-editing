import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Headless throwaway Chromium against a real Forgejo. The whole stack (Forgejo, editor service,
// proxy) is started once by e2e/global-setup.js in a new folder under E2E_SCRATCH and stopped
// again by e2e/global-teardown.js.
const scratch = process.env.E2E_SCRATCH || path.join(os.tmpdir(), 'forgejo-live-e2e');
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.js$/,
  workers: 1,
  fullyParallel: false,
  timeout: 180000,
  expect: { timeout: 20000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  outputDir: path.join(scratch, 'playwright-output'),
  use: { headless: true, viewport: { width: 1300, height: 900 }, trace: 'off', video: 'off' },
});

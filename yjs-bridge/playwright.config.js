import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Headless throwaway Chromium. Each spec starts its own service on a free port.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  outputDir: path.join(process.env.BRIDGE_SCRATCH || path.join(os.tmpdir(), 'yjs-bridge-tests'), 'playwright-output'),
  use: { headless: true, viewport: { width: 1300, height: 900 }, trace: 'off', video: 'off' },
});

import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Smoke tests against the mock Live, using the installed Google Chrome (no browser download).
// A fresh data dir per run so the first-run setup screen always shows. The mock setup (dev:mock) runs its
// own server on 7310 and mock Live on 12000, so a test can never reach the SetDeck app or the real Live set.
const home = mkdtempSync(join(tmpdir(), 'setdeck-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173', channel: 'chrome' },
  webServer: {
    command: `SETDECK_HOME=${home} npm run dev:mock`,
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

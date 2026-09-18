import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // GitHub Actions runs the full web suite across nine viewport projects.
  // Two workers keep the exact same coverage while avoiding the recurring
  // 30-minute single-worker timeout seen on otherwise healthy candidates.
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:3999',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-small', use: { viewport: { width: 360, height: 800 } } },
    { name: 'mobile-standard', use: { viewport: { width: 390, height: 844 } } },
    { name: 'mobile-large', use: { viewport: { width: 430, height: 932 } } },
    { name: 'tablet-portrait', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'tablet-air', use: { viewport: { width: 820, height: 1180 } } },
    { name: 'tablet-ipad', use: { viewport: { width: 834, height: 1194 } } },
    { name: 'tablet-pro-portrait', use: { viewport: { width: 1024, height: 1366 } } },
    { name: 'tablet-landscape', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'NEXT_PUBLIC_API_BASE_URL=http://localhost:3999/api/v1 npx next start -p 3999',
    port: 3999,
    timeout: 60000,
    reuseExistingServer: !process.env.CI,
  },
});

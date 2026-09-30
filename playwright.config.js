const { defineConfig } = require('@playwright/test');

const suites = { storefront: /@storefront/, admin: /@admin/, api: /@api/ };

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /session\.spec\.js/,
  timeout: 30000,
  retries: 1,
  grep: suites[process.env.SUITE], // undefined (suite === 'all') runs everything
  reporter: [['list'], ['./tests/supabase-reporter.js']],
  use: {
    baseURL: (process.env.TARGET_URL || '').replace(/\/?$/, '/'),
    screenshot: 'only-on-failure',
  },
});

const { defineConfig } = require(process.env.EPICD_PLAYWRIGHT_ROOT + "/@playwright/test");
module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 8000,
  expect: { timeout: 3000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.EPICD_BROWSER_OUTPUT,
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: process.env.EPICD_BROWSER_EXECUTABLE },
  },
  webServer: {
    command: '"$EPICD_BROWSER_NODE" tools/browser-server.cjs',
    url: "http://127.0.0.1:4173/health",
    reuseExistingServer: false,
    timeout: 10000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

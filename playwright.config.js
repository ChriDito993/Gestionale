const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const python = process.env.E2E_PYTHON || 'python3';
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

module.exports = defineConfig({
    testDir: './tests/e2e',
    testMatch: '**/*.spec.js',
    fullyParallel: false,
    workers: 1, // The in-memory test database is reset before each test.
    retries: process.env.CI ? 1 : 0,
    forbidOnly: !!process.env.CI,
    timeout: 30_000,
    expect: { timeout: 7_000 },
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:39781', // Intentionally cannot target a deployed service.
        timezoneId: 'Europe/Rome',
        locale: 'it-IT',
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
        { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } },
        { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: `${shellQuote(python)} ${shellQuote(path.join(__dirname, 'tests/e2e/server.py'))}`,
        url: 'http://127.0.0.1:39781/__e2e__/ready',
        reuseExistingServer: false,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});

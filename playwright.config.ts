import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const systemEdge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const localLaunchOptions = process.platform === "win32" && existsSync(systemEdge)
  ? { executablePath: systemEdge }
  : {};
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: !!process.env.CI,
  workers: process.env.CI ? 4 : 1,
  globalTimeout: 300_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], launchOptions: localLaunchOptions } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], launchOptions: localLaunchOptions } },
  ],
  webServer: externalBaseUrl ? undefined : {
    command: "node ./node_modules/vite/bin/vite.js --config vite.static.config.ts --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

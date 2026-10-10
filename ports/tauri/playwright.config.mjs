// Playwright configuration: the web server serves src/ and the fixture tree; the
// suite runs against Chromium (the same engine class as the Tauri WebView2/WKWebView).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/spec",
  timeout: 30000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://localhost:4173/",
    reuseExistingServer: true,
    timeout: 15000,
  },
});

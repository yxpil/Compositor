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
    // CI's SwiftShader-driven Chromium renders canvas with a display color
    // profile, shifting pixels a few levels off the sRGB values the math
    // expects; pin everything to sRGB and software paths.
    launchOptions: {
      args: [
        "--force-color-profile=srgb",
        "--disable-color-correct-rendering",
        "--disable-lcd-text",
        "--disable-font-subpixel-positioning",
        "--disable-skia-runtime-opts",
      ],
    },
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://localhost:4173/",
    reuseExistingServer: true,
    timeout: 15000,
  },
});

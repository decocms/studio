import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI: cap at 4 to keep host CPU + Postgres connection pool predictable.
  // Local: let Playwright pick (defaults to half the CPU count). Each test
  // creates its own user + org with randomized slugs, so cross-worker DB
  // contention should be limited to the auth.user row insert.
  workers: process.env.CI ? 4 : undefined,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${process.env.PORT || "3000"}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // dev:servers was removed (it gave both Vite and the API the same env,
    // including PORT). Invoke the CLI directly to get the orchestrated
    // dual-port spawn. The CLI listens on PORT (user-facing) and auto-picks
    // API_PORT internally.
    // MCP_CACHE_ENABLED=true: e2e exercises production-like behavior; the
    // cache is on in prod but off in dev by default, so opt back in here
    // to keep cache-dependent specs (proxy roundtrip, no-re-handshake) green.
    command: "MCP_CACHE_ENABLED=true bun src/cli.ts dev",
    url: `http://localhost:${process.env.PORT || "3000"}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

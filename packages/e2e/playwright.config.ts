import { defineConfig, devices } from "@playwright/test";

const serverPort = process.env.PORT || "3000";
const appPort = process.env.VITE_PORT || "4000";
const appOrigin = process.env.BASE_URL || `http://localhost:${appPort}`;

// e2e exercises production-like behavior; the MCP read/list cache is on in prod
// but defaults off under NODE_ENV=development (which `dev:server` sets), so opt
// it back in here. Without this, cache-dependent specs (e.g. proxy roundtrip's
// no-re-handshake assertion) fail against the dev server.
const webServerCommand = `MCP_CACHE_ENABLED=true BASE_URL=${appOrigin} PORT=${serverPort} VITE_PORT=${appPort} bun run dev:servers`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Whole-suite backstop: even if a single spec wedges (a dangling fetch /
  // long-poll loop keeping a worker alive), the ENTIRE run fails fast at 30 min
  // instead of hanging to the job ceiling. Recent green runs finish in ~15-20
  // min; per-spec/per-fetch timeouts are the first line of defence, this is the
  // last-resort ceiling.
  globalTimeout: 30 * 60 * 1000,
  retries: process.env.CI ? 2 : 0,
  // CI: cap at 4 to keep host CPU + the Postgres connection budget predictable
  // (each worker opens its own pg client alongside the app pool). Local: let
  // Playwright pick (half the CPU count). Every test mints its own user + org
  // with randomized slugs, so DB assertions stay tenant-scoped and parallel-safe.
  workers: process.env.CI ? 4 : undefined,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: appOrigin,
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
    command: webServerCommand,
    // The dev server (dev:servers) is an apps/mesh script — run it from there.
    // This is the suite's ONLY tie to the app, and it's a process boundary
    // (spawn + HTTP), not a code import, so the black-box contract holds.
    cwd: "../../apps/mesh",
    url: `${appOrigin}/api/config`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Whole-suite backstop: even if a single spec wedges (a dangling fetch /
  // long-poll loop keeping a worker alive — the C-bis link-proxy CI hang that
  // ran to the 6 h job ceiling), the ENTIRE run fails fast at 30 min instead of
  // hanging. Recent green e2e runs finish in ~15-20 min, so 30 min is a
  // comfortable headroom that still converts a hang into a bounded, debuggable
  // failure. Per-spec/per-fetch timeouts are the first line of defence; this is
  // the last-resort ceiling.
  globalTimeout: 30 * 60 * 1000,
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
    command: "bun run dev:servers",
    url: `http://localhost:${process.env.PORT || "3000"}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

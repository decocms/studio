import { defineConfig, devices } from "@playwright/test";

interface PlaywrightEnv {
  [key: string]: string | undefined;
  BASE_URL?: string;
  PORT?: string;
  VITE_PORT?: string;
}

export function resolvePlaywrightDevServerConfig(
  env: PlaywrightEnv = process.env,
): {
  appOrigin: string;
  webServerCommand: string;
} {
  const serverPort = env.PORT || "3000";
  const appPort = env.VITE_PORT || "4000";
  const appOrigin = env.BASE_URL || `http://localhost:${appPort}`;

  return {
    appOrigin,
    // e2e exercises production-like behavior; the MCP read/list cache is on in
    // prod but defaults off under NODE_ENV=development (which `dev:server` sets),
    // so opt it back in here. Without this, cache-dependent specs (e.g. proxy
    // roundtrip's no-re-handshake assertion) fail against the dev server.
    webServerCommand: `MCP_CACHE_ENABLED=true BASE_URL=${appOrigin} PORT=${serverPort} VITE_PORT=${appPort} bun run dev:servers`,
  };
}

const { appOrigin, webServerCommand } = resolvePlaywrightDevServerConfig();

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
    url: `${appOrigin}/api/config`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

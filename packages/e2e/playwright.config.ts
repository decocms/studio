import { defineConfig, devices } from "@playwright/test";

const serverPort = process.env.PORT || "3000";
const appPort = process.env.VITE_PORT || "4000";
const apiOrigin = `http://localhost:${serverPort}`;
const appOrigin = process.env.BASE_URL || `http://localhost:${appPort}`;

// Commerce Discovery setup mints a one-time client token by calling the
// commerce-skills internal upgrade API. We point the studio server at a local
// mock (commerce-upgrade-mock.ts, started as a webServer below) so onboarding
// specs exercise the real setup path without hitting the production worker.
const commerceMockPort = process.env.COMMERCE_MOCK_PORT || "4100";
const commerceMockOrigin = `http://localhost:${commerceMockPort}`;
const commerceMockKey = "e2e-commerce-key";

// e2e exercises production-like behavior; the MCP read/list cache is on in prod
// but defaults off under NODE_ENV=development (which the API `dev` script sets),
// so opt it back in here. Without this, cache-dependent specs (e.g. proxy
// roundtrip's no-re-handshake assertion) fail against the dev server.
//
// RUN_IDLE_TIMEOUT_MS shortens the unified-control-plane liveness window
// (production default: 10 minutes — see run-registry.ts) so
// decopilot-unified-control-plane.spec.ts's "executor dies mid-run" proof can
// observe the liveness terminal without a real 10-minute wait. Read ONCE at
// server boot (run-registry.ts module load), so this applies to the whole e2e
// run, not per-test. Chosen with headroom above every OTHER spec's
// held-open-turn windows in this suite (the widest being
// decopilot-thread-queue.spec.ts's `nextWorkItem(..., { timeoutMs: 35_000 })`
// waits for a queued turn to reach the fake daemon — the consume step's idle
// timer is already ticking during that wait, since dispatch marks the run
// in_progress and opens the live tail before the daemon ever receives
// anything) so no other spec's legitimately-slow-but-alive turn is
// misclassified as dead.
// deployment-admin@e2e.local + deployment-admin-2@e2e.local are reserved for
// deployment-admin.spec.ts only (consistent with the suite's unique-domain-per-
// run rule). The second admin exists so an admin-impersonating-an-admin test can
// reach the 409 re-impersonation guard — impersonating a NON-admin is rejected
// by requireDeploymentAdmin first, before that guard runs.
// Shared internal service bearer for the service-token routes (credential
// vault, task-board import, commerce-diagnostic share-invite). Kept in sync by
// hand with the literal in commerce-diagnostic-share.spec.ts (no shared import:
// the config isn't a spec module).
const vaultServiceToken = "e2e-vault-service-token";

const apiServerCommand = `MCP_CACHE_ENABLED=true VAULT_SERVICE_TOKEN=${vaultServiceToken} COMMERCE_DISCOVERY_INTERNAL_API_URL=${commerceMockOrigin} COMMERCE_DISCOVERY_INTERNAL_API_KEY=${commerceMockKey} BASE_URL=${appOrigin} PORT=${serverPort} VITE_PORT=${appPort} RUN_IDLE_TIMEOUT_MS=120000 DEPLOYMENT_ADMIN_EMAILS=deployment-admin@e2e.local,deployment-admin-2@e2e.local bun run dev`;
const webServerCommand = `BASE_URL=${appOrigin} PORT=${serverPort} VITE_PORT=${appPort} bun run dev`;

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
  webServer: [
    {
      // Mock commerce-skills upgrade API. Started before the studio server so
      // COMMERCE_DISCOVERY_SETUP can mint a token over HTTP without reaching
      // the production worker. Standalone process (no app imports).
      command: `COMMERCE_MOCK_PORT=${commerceMockPort} bun run fixtures/commerce-upgrade-mock.ts`,
      url: `${commerceMockOrigin}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: apiServerCommand,
      // The API and web apps are launched as separate processes. These cwd
      // entries are the suite's ONLY ties to app implementation, and both stay
      // behind process + HTTP boundaries so the black-box contract holds.
      cwd: "../../apps/api",
      url: `${apiOrigin}/api/config`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: webServerCommand,
      cwd: "../../apps/web",
      url: `${appOrigin}/api/config`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

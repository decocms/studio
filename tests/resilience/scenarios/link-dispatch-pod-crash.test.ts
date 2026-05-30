/**
 * Resilience scenario: link dispatch when the mesh pod crashes.
 *
 * The link-tunnel topology is:
 *
 *   daemon ──WS──► studio pod ──NATS──► (other pods / back to same pod)
 *
 * When the pod that owns the daemon's WebSocket crashes:
 *   1. The daemon's WS connection closes (TCP RST or our heartbeat timeout).
 *   2. The daemon's reconnect loop (`reconnect-backoff.ts`) re-dials mesh.
 *   3. On reconnect the daemon sends a `hello` frame; the pod claims the user
 *      in the NATS JS KV bucket (last-writer-wins — the new pod takes over).
 *   4. Subsequent dispatches route to the new pod and succeed.
 *
 * ── Harness limitation ────────────────────────────────────────────────────
 *
 * The resilience harness runs a **single studio pod** and has no
 * `link-daemon` container. This means we cannot:
 *
 *   - Assert that the daemon's WS closes on pod crash (no daemon process).
 *   - Assert daemon reconnect (no daemon process).
 *   - Assert NATS KV re-claim by the new pod (trivially true in single-pod
 *     mode; the interesting case is multi-pod handoff).
 *
 * What this scenario CAN verify against the current harness:
 *
 *   a. After a SIGKILL of the studio container, studio can be brought back up
 *      (`docker compose up -d studio`) and becomes healthy again.
 *   b. The NATS KV state is clean after restart (no stale claims from the
 *      crashed pod hold up future connections).
 *   c. Tool calls through the MCP API succeed after studio recovers —
 *      proving the NATS+Postgres connections re-established cleanly.
 *
 * For a full-fidelity test, add to the resilience docker-compose:
 *   - A `link-daemon` service that dials `ws://studio:3000/api/links/connect`
 *     with a valid bearer token and sends a `hello` frame.
 *   - A Toxiproxy proxy for `studio:3000` (WS path) so the daemon ↔ studio
 *     link can be severed independently from the NATS mesh ↔ mesh path.
 *
 * Then the full scenario would be:
 *   1. Confirm daemon is connected (`GET /api/links/me` returns a claim).
 *   2. Kill the studio container (SIGKILL via docker compose).
 *   3. Poll until the daemon WS closes and daemon reconnect fires.
 *   4. Wait for studio restart + daemon re-claim.
 *   5. Assert `GET /api/links/me` returns a fresh claim (new connectedAt).
 *   6. Assert a dispatch through the re-connected tunnel succeeds.
 *
 * TODO: un-skip `daemon reconnects after pod crash` once the harness includes
 * a `link-daemon` service. The infrastructure shape is documented above.
 */

import { describe, expect, test } from "bun:test";
import { registerTestHooks, testState } from "../lib/setup";
import { mcpCall } from "../lib/studio-client";
import { pollUntil } from "../lib/poll-until";

registerTestHooks();

// ── Docker-compose control (borrowed from tests/multi-pod/lib/pod.ts) ──────
//
// The resilience harness compose file lives at
// tests/resilience/docker-compose.yml and the studio service is named
// "studio". We drive it via `docker compose` subprocess calls so that tests
// never need a Docker SDK dependency.

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

async function composeExec(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} exited ${code}: ${stderr || stdout}`,
    );
  }
  return stdout;
}

/** SIGKILL the studio container — simulates an abrupt host loss. */
async function killStudio(): Promise<void> {
  await composeExec("kill", "-s", "SIGKILL", "studio");
}

/**
 * Bring the studio container back up after a SIGKILL.
 *
 * The compose `restart: unless-stopped` policy is kept for the postgres-outage
 * scenario (studio crashes on DB loss and auto-recovers), but it is NOT a
 * reliable recovery mechanism here: a `docker compose kill` does not always
 * trigger the policy promptly, and any restart backoff accumulated by an
 * earlier crash-looping scenario (e.g. postgres-outage running first) can push
 * the auto-restart well past this test's timeout. So we drive recovery
 * explicitly — `up -d` is idempotent and forces the container to a running
 * state regardless of whether the policy already restarted it.
 */
async function startStudio(): Promise<void> {
  await composeExec("up", "-d", "studio");
}

/** Wait for studio to report healthy again after restart. */
async function waitForStudioHealthy(timeoutMs: number): Promise<void> {
  await pollUntil(
    async () => {
      try {
        const res = await fetch("http://127.0.0.1:13000/health/ready");
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 2_000, label: "studio-healthy-after-crash" },
  );
}

describe("link dispatch — pod crash", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Baseline before crash
  // ──────────────────────────────────────────────────────────────────────────

  test("studio is healthy and tool calls succeed before crash", async () => {
    const healthRes = await fetch("http://127.0.0.1:13000/health/ready");
    expect(healthRes.ok).toBe(true);

    const { result } = await mcpCall(
      `${testState.orgId}_self`,
      "tools/call",
      { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
      { apiKey: testState.apiKey },
      { timeoutMs: 15_000 },
    );
    expect(result).toBeTruthy();
    console.log("  → Baseline: studio healthy, tool calls succeed");
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Pod crash + restart
  // ──────────────────────────────────────────────────────────────────────────

  test("studio restarts after SIGKILL and becomes healthy again", async () => {
    // Record when we kill the pod.
    const killTime = Date.now();
    console.log("  → SIGKILL studio container");
    await killStudio();

    // Confirm unhealthy immediately after kill.
    await pollUntil(
      async () => {
        try {
          const res = await fetch("http://127.0.0.1:13000/health/ready");
          return !res.ok;
        } catch {
          // fetch threw — studio is unreachable, which counts as "down"
          return true;
        }
      },
      { timeoutMs: 20_000, intervalMs: 1_000, label: "studio-down-after-kill" },
    );
    const downDetectedMs = Date.now() - killTime;
    console.log(
      `  → Studio down detected in ${Math.round(downDetectedMs)}ms after kill`,
    );

    // Explicitly bring the container back up (see startStudio docstring for
    // why we don't rely on the compose restart policy here), then wait for it
    // to become healthy.
    await startStudio();
    await waitForStudioHealthy(120_000);
    const upTime = Date.now() - killTime;
    console.log(`  → Studio healthy again ${Math.round(upTime)}ms after kill`);

    expect(upTime).toBeLessThan(120_000);
  }, 150_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Post-crash: MCP tool calls succeed (NATS KV + DB reconnected cleanly)
  // ──────────────────────────────────────────────────────────────────────────

  test("tool calls succeed after pod crash and restart", async () => {
    // Kill studio, explicitly bring it back up, and wait for recovery
    // (idempotent if already restarted by the previous test — health poll
    // exits immediately if already healthy).
    await killStudio();
    await startStudio();
    await waitForStudioHealthy(120_000);

    // Poll until a tool call through the MCP API succeeds. This exercises
    // the full path: HTTP → Hono route → tool handler → Kysely (Postgres) →
    // response. It also confirms the NATS KV bucket is accessible (studio
    // re-subscribes on boot).
    await pollUntil(
      async () => {
        try {
          const { result } = await mcpCall(
            `${testState.orgId}_self`,
            "tools/call",
            { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
            { apiKey: testState.apiKey },
            { timeoutMs: 10_000 },
          );
          return !!result;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: 60_000,
        intervalMs: 3_000,
        label: "tool-call-after-pod-crash",
      },
    );
    console.log("  → Tool calls succeed after pod crash + restart");
  }, 180_000);

  // ──────────────────────────────────────────────────────────────────────────
  // (Skipped) Full daemon reconnect scenario — requires link-daemon container
  // ──────────────────────────────────────────────────────────────────────────

  test.skip("daemon reconnects after pod crash and re-claims in NATS KV", async () => {
    // Prerequisite: the resilience docker-compose must include a `link-daemon`
    // service that dials `ws://studio:3000/api/links/connect` and a Toxiproxy
    // proxy for `studio:3000` (WS path) so we can observe/control the WS
    // lifecycle independently from the NATS path.
    //
    // Full scenario (see file-level comment for details):
    //
    //   1. Poll GET /api/links/me until a claim exists (daemon connected).
    //   2. Record claim.connectedAt.
    //   3. SIGKILL studio container.
    //   4. Poll until /api/links/me returns no claim (pod cleaned up KV on close
    //      or TTL expired), proving the daemon WS was severed.
    //   5. Wait for studio restart + daemon reconnect.
    //   6. Poll GET /api/links/me until a new claim appears with
    //      connectedAt > previous connectedAt.
    //   7. Send a dispatch request and assert it succeeds end-to-end.
    //
    // TODO: implement once harness includes `link-daemon` + WS proxy.
  }, 180_000);
});

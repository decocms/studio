/**
 * Multi-pod Tool List Cache Simulation
 *
 * Simulates N pods sharing a JetStream KV tool-list cache.
 * Measures cold-start vs warm-start latency and verifies cross-pod sharing.
 *
 * Prerequisites:
 *   docker run -p 4222:4222 nats:latest -js
 *
 * Run from repo root:
 *   bun run --cwd apps/mesh scripts/sim-tool-list-cache.ts
 *   NATS_URL=nats://localhost:4222 POD_COUNT=6 ROUNDS=4 bun run --cwd apps/mesh scripts/sim-tool-list-cache.ts
 */

import { connect } from "nats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  JetStreamKVToolListCache,
  InMemoryToolListCache,
  type ToolListCache,
} from "../src/mcp-clients/tool-list-cache";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const POD_COUNT = Number(process.env.POD_COUNT ?? "4");
const ROUNDS = Number(process.env.ROUNDS ?? "3");
const CONNECTION_IDS = ["conn_abc123", "conn_def456", "conn_ghi789"];

// Simulates an expensive downstream MCP listTools() call (~80-120ms)
async function fakeDownstreamListTools(connectionId: string): Promise<Tool[]> {
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 40));
  return [
    {
      name: `${connectionId}_tool_1`,
      description: "Tool 1",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: `${connectionId}_tool_2`,
      description: "Tool 2",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: `${connectionId}_tool_3`,
      description: "Tool 3",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];
}

interface PodStats {
  podId: number;
  hits: number;
  misses: number;
  totalMs: number;
}

async function runPod(
  podId: number,
  cache: ToolListCache,
  connectionIds: string[],
  rounds: number,
): Promise<PodStats> {
  let hits = 0;
  let misses = 0;
  let totalMs = 0;

  for (let round = 0; round < rounds; round++) {
    for (const connId of connectionIds) {
      const start = performance.now();
      const cached = await cache.get(connId);
      const elapsed = () => (performance.now() - start).toFixed(1);

      if (cached) {
        hits++;
        totalMs += performance.now() - start;
        console.log(`  Pod-${podId} round-${round} ${connId}: HIT  (${elapsed()}ms)`);
      } else {
        const tools = await fakeDownstreamListTools(connId);
        await cache.set(connId, tools);
        misses++;
        totalMs += performance.now() - start;
        console.log(
          `  Pod-${podId} round-${round} ${connId}: MISS (${elapsed()}ms, fetched ${tools.length} tools)`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  return { podId, hits, misses, totalMs };
}

async function runScenario(label: string, cacheFactory: () => ToolListCache) {
  console.log(`\n${"=".repeat(62)}`);
  console.log(`Scenario: ${label}`);
  console.log(
    `  Pods: ${POD_COUNT}  |  Rounds: ${ROUNDS}  |  Connections: ${CONNECTION_IDS.length}`,
  );
  console.log("=".repeat(62));

  const caches = Array.from({ length: POD_COUNT }, () => cacheFactory());

  // Stagger pod starts to simulate rolling deployment
  const podPromises = caches.map(
    (cache, i) =>
      new Promise<PodStats>((resolve) => {
        setTimeout(() => resolve(runPod(i + 1, cache, CONNECTION_IDS, ROUNDS)), i * 30);
      }),
  );

  const stats = await Promise.all(podPromises);
  for (const cache of caches) cache.teardown();

  const totalHits = stats.reduce((s, p) => s + p.hits, 0);
  const totalMisses = stats.reduce((s, p) => s + p.misses, 0);
  const totalCalls = totalHits + totalMisses;
  const avgMs =
    stats.reduce((s, p) => s + p.totalMs, 0) /
    stats.reduce((s, p) => s + p.hits + p.misses, 0);

  console.log(`\nResults:`);
  console.log(`  Total listTools calls : ${totalCalls}`);
  console.log(
    `  Cache hits           : ${totalHits} (${((totalHits / totalCalls) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  Cache misses         : ${totalMisses} (${((totalMisses / totalCalls) * 100).toFixed(1)}%)`,
  );
  console.log(`  Avg latency          : ${avgMs.toFixed(1)}ms per call`);
  console.log(`  Downstream calls avoided: ${totalHits} / ${totalCalls}`);
}

async function main() {
  console.log("Tool List Cache — Multi-Pod Simulation");
  console.log(`Config: NATS=${NATS_URL}  PODS=${POD_COUNT}  ROUNDS=${ROUNDS}\n`);

  // ── Scenario 1: No cache (baseline) ────────────────────────────────────────
  await runScenario("No cache (baseline — every pod hits downstream every time)", () => ({
    async get() {
      return null;
    },
    async set() {},
    async invalidate() {},
    teardown() {},
  }));

  // ── Scenario 2: Per-pod InMemoryToolListCache ───────────────────────────────
  await runScenario(
    "InMemoryToolListCache (per-pod, no cross-pod sharing)",
    () => new InMemoryToolListCache(),
  );

  // ── Scenario 3: JetStream KV (shared across all pods) ──────────────────────
  let nc: Awaited<ReturnType<typeof connect>>;
  try {
    nc = await connect({ servers: NATS_URL });
    console.log(`\n[NATS] Connected to ${NATS_URL}`);
  } catch {
    console.warn(`\n[NATS] Could not connect to ${NATS_URL} — skipping JetStream scenarios.`);
    console.warn("  Start NATS with: docker run -p 4222:4222 nats:latest -js");
    process.exit(0);
  }

  // Clean up any stale KV entries from a previous run
  try {
    const kv = await nc.jetstream().views.kv("MESH_TOOL_LISTS");
    for (const connId of CONNECTION_IDS) {
      await kv.delete(`tools.${connId}`).catch(() => {});
    }
    console.log("[NATS] Purged stale KV entries from previous run");
  } catch {
    // Bucket may not exist yet — fine
  }

  // Cold start: each pod initialises its own KV handle pointing at the shared bucket
  await runScenario(
    "JetStreamKVToolListCache (cross-pod, cold bucket)",
    () => {
      const cache = new JetStreamKVToolListCache({
        getJetStream: () => nc.jetstream(),
        getConnection: () => nc,
      });
      cache.init().catch(() => {});
      return cache;
    },
  );

  // Pre-warmed: seed one connection before pods start to show immediate cross-pod hits
  console.log("\n--- Pre-warming bucket with conn_abc123 tools ---");
  const seed = new JetStreamKVToolListCache({
    getJetStream: () => nc.jetstream(),
    getConnection: () => nc,
  });
  await seed.init();
  await seed.set(CONNECTION_IDS[0]!, await fakeDownstreamListTools(CONNECTION_IDS[0]!));
  seed.teardown();
  console.log("  Seeded. All pods should get an immediate HIT for conn_abc123 round-0.");

  await runScenario(
    "JetStreamKVToolListCache (cross-pod, pre-warmed bucket)",
    () => {
      const cache = new JetStreamKVToolListCache({
        getJetStream: () => nc.jetstream(),
        getConnection: () => nc,
      });
      cache.init().catch(() => {});
      return cache;
    },
  );

  await nc.drain();
  console.log("\n[NATS] Done. Connection drained.");
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});

/**
 * Headless `deco link` daemon entrypoint for the resilience harness.
 *
 * Runs inside the `link-daemon` container. Authenticates with a pre-minted
 * Better Auth API key (injected as DAEMON_API_KEY by the test that mints it),
 * dials studio through the Toxiproxy `studio_ws` proxy (MESH_CLUSTER_URL), and
 * spawns real sandboxes on demand. No OAuth.
 *
 * The session is persisted to disk under `DATA_DIR` before the daemon starts.
 * The daemon resolves the bearer for every (re)connect via `getValidSession`,
 * which reads `dataDir/session.<host>.json`. Production's `deco link` command
 * writes this file via `ensureSession` before invoking `startLinkDaemon`; the
 * resilience harness must mirror that or the first connect fails fatally with
 * `Session for ${clusterUrl} is no longer valid`.
 */
import { startLinkDaemon } from "../../apps/mesh/src/link-daemon/index";
import { writeSession } from "../../apps/mesh/src/cli/lib/session";
import type { Session } from "../../apps/mesh/src/cli/lib/session";

export function buildDaemonSession(input: {
  apiKey: string;
  clusterUrl: string;
  nowIso: string;
}): Session {
  if (!input.apiKey) {
    throw new Error("DAEMON_API_KEY is required to start the link daemon");
  }
  return {
    target: input.clusterUrl,
    clientId: "resilience-link-daemon",
    user: { sub: "resilience-link-daemon" },
    accessToken: input.apiKey,
    createdAt: input.nowIso,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.DAEMON_API_KEY ?? "";
  const clusterUrl = process.env.MESH_CLUSTER_URL ?? "http://toxiproxy:3010";
  const dataDir = process.env.DATA_DIR ?? "/app/data/link-daemon";
  const port = Number(process.env.LINK_DAEMON_PORT ?? "4500");

  const session = buildDaemonSession({
    apiKey,
    clusterUrl,
    nowIso: new Date().toISOString(),
  });

  // Persist the API-key session to disk so the daemon's `getAccessToken`
  // callback (which calls `getValidSession({ dataDir, target })`) finds it on
  // first connect. Without this, `getValidSession` returns null, the daemon
  // throws `{ fatal: true }`, and the reconnect loop exits before opening
  // the WebSocket — see resilience CI failure on commit a83e96e.
  await writeSession(dataDir, session);

  console.log(
    `[resilience-link-daemon] starting; cluster=${clusterUrl} port=${port}`,
  );
  const handle = await startLinkDaemon({
    port,
    clusterBaseUrl: clusterUrl,
    dataDir,
    session,
  });

  const code = await handle.stopped;
  console.log(`[resilience-link-daemon] stopped (code ${code})`);
  process.exit(code);
}

// Only run the daemon when executed directly (not when imported by the test).
if (import.meta.main) {
  main().catch((err) => {
    console.error("[resilience-link-daemon] fatal:", err);
    process.exit(1);
  });
}

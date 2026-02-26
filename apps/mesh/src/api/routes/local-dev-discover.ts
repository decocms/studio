/**
 * Local-Dev Auto-Discovery Routes
 *
 * GET  /discover     — probe localhost ports for running local-dev daemons
 * POST /add-project  — create connection + project + bind object-storage plugin
 *
 * Also exports reconcileLocalDevConnection() for use by the MCP proxy
 * to fix port drift on-the-fly when a connection is accessed.
 */

import { Hono } from "hono";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { fetchToolsFromMCP } from "../../tools/connection/fetch-tools";
import { pickRandomCapybaraIcon } from "../../constants/capybara-icons";
import type { Env } from "../env";

interface ReadyResponse {
  ready: boolean;
  version: string;
  root: string;
}

interface DiscoveredInstance {
  port: number;
  root: string;
  version: string;
}

const PORT_START = 4201;
const PORT_END = 4210;
const PROBE_TIMEOUT_MS = 500;

// ---- Port drift reconciliation (used by proxy + discovery) ----

/**
 * TTL cache for reconciliation results. Prevents probing all ports
 * on every single MCP request. Keyed by connection ID.
 */
const reconcileCache = new Map<string, { url: string; expiresAt: number }>();
const RECONCILE_TTL_MS = 30_000; // 30 seconds

/**
 * Reconcile a local-dev connection's port. Called by the MCP proxy before
 * proxying a request to ensure the connection_url points to the right daemon.
 *
 * For connections with metadata.localDevRoot:
 * 1. Quick-check: is the stored port serving the expected root?
 * 2. If yes, return as-is (cache hit path is instant)
 * 3. If no, probe all ports to find the correct daemon and update the DB
 * 4. If daemon not found on any port, return null (don't proxy to wrong project)
 *
 * Returns the (possibly updated) connection_url, or null if the daemon
 * is offline. Non-local-dev connections pass through unchanged.
 */
export async function reconcileLocalDevConnection(
  connection: {
    id: string;
    connection_url: string | null;
    metadata: Record<string, unknown> | null;
  },
  storage: {
    connections: {
      update: (
        id: string,
        data: { connection_url: string },
      ) => Promise<unknown>;
    };
  },
): Promise<{ connection_url: string | null }> {
  const meta = connection.metadata as { localDevRoot?: string } | null;
  if (!meta?.localDevRoot || !connection.connection_url) {
    return { connection_url: connection.connection_url };
  }

  // Check cache first
  const cached = reconcileCache.get(connection.id);
  if (cached && cached.expiresAt > Date.now()) {
    // Empty string means daemon was confirmed offline
    if (cached.url === "") {
      return { connection_url: null };
    }
    if (cached.url === connection.connection_url) {
      return { connection_url: connection.connection_url };
    }
    // Cache says URL should be different — return updated URL
    return { connection_url: cached.url };
  }

  const expectedRoot = meta.localDevRoot;
  const currentPortMatch = connection.connection_url.match(
    /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/,
  );
  const currentPort = currentPortMatch?.[1]
    ? parseInt(currentPortMatch[1], 10)
    : null;

  // Quick-check: is the current port serving the expected root?
  if (currentPort) {
    const instance = await probePort(currentPort);
    if (instance?.root === expectedRoot) {
      // Port is correct — cache and return
      reconcileCache.set(connection.id, {
        url: connection.connection_url,
        expiresAt: Date.now() + RECONCILE_TTL_MS,
      });
      return { connection_url: connection.connection_url };
    }
  }

  // Port is wrong or unreachable — probe all ports to find the right daemon
  const probes = [];
  for (let port = PORT_START; port <= PORT_END; port++) {
    probes.push(probePort(port));
  }
  const results = await Promise.all(probes);
  const correctInstance = results.find(
    (r): r is DiscoveredInstance => r !== null && r.root === expectedRoot,
  );

  if (correctInstance) {
    const newUrl = `http://localhost:${correctInstance.port}/mcp`;
    if (newUrl !== connection.connection_url) {
      console.log(
        `[local-dev] Port drift detected for connection ${connection.id}: ` +
          `${currentPort} → ${correctInstance.port}, updating connection_url`,
      );
      await storage.connections.update(connection.id, {
        connection_url: newUrl,
      });
    }
    reconcileCache.set(connection.id, {
      url: newUrl,
      expiresAt: Date.now() + RECONCILE_TTL_MS,
    });
    return { connection_url: newUrl };
  }

  // Daemon not found on any port. Return null so the proxy refuses to
  // connect rather than silently routing to the wrong project's daemon.
  // Use a very short TTL so we re-probe quickly once the daemon starts.
  reconcileCache.set(connection.id, {
    url: "",
    expiresAt: Date.now() + 2_000, // 2s — retry fast when offline
  });
  return { connection_url: null };
}

const app = new Hono<Env>();

// ---- Discovery ----

app.get("/discover", async (c) => {
  const meshContext = c.var.meshContext;

  if (!meshContext.auth.user?.id && !meshContext.auth.apiKey?.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const organizationId = meshContext.organization?.id;
  if (!organizationId) {
    return c.json({ instances: [] });
  }

  // Probe all ports in parallel
  const probes = [];
  for (let port = PORT_START; port <= PORT_END; port++) {
    probes.push(probePort(port));
  }
  const results = await Promise.all(probes);

  // Filter out nulls (ports that didn't respond)
  const discovered = results.filter((r): r is DiscoveredInstance => r !== null);

  if (discovered.length === 0) {
    return c.json({ instances: [] });
  }

  // Get existing connections and determine which discovered instances are already linked.
  // New connections store metadata.localDevRoot (set by /add-project) — match by root.
  // Legacy connections without it fall back to port matching.
  const connections =
    await meshContext.storage.connections.list(organizationId);
  const linkedRoots = new Set<string>();
  const legacyLinkedPorts = new Set<number>();

  for (const conn of connections) {
    const meta = conn.metadata as { localDevRoot?: string } | null;
    if (meta?.localDevRoot) {
      linkedRoots.add(meta.localDevRoot);

      // Reconcile port drift for this connection
      await reconcileLocalDevConnection(conn, meshContext.storage);

      continue;
    }
    if (conn.connection_url) {
      const match = conn.connection_url.match(
        /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/,
      );
      if (match?.[1]) {
        legacyLinkedPorts.add(parseInt(match[1], 10));
      }
    }
  }

  const unlinked = discovered.filter(
    (inst) => !linkedRoots.has(inst.root) && !legacyLinkedPorts.has(inst.port),
  );

  return c.json({ instances: unlinked });
});

// ---- Add project (server-side orchestration) ----

app.post("/add-project", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  const organizationId = ctx.organization?.id;
  const userId = getUserId(ctx);
  if (!organizationId || !userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { port, root } = (await c.req.json()) as {
    port: number;
    root: string;
  };
  if (port < 4201 || port > 4210) {
    return c.json({ error: "Invalid port" }, 400);
  }
  const connectionUrl = `http://localhost:${port}/mcp`;
  const name = root.replace(/\/+$/, "").split("/").pop() || root;
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // 1. Fetch tools from the local-dev MCP server
  let tools: Awaited<ReturnType<typeof fetchToolsFromMCP>> = null;
  try {
    tools = await fetchToolsFromMCP({
      id: `pending-${Date.now()}`,
      title: name,
      connection_type: "HTTP",
      connection_url: connectionUrl,
    });
    console.log(
      `[local-dev] Fetched ${tools?.length ?? 0} tools from port ${port}`,
    );
  } catch (err) {
    console.error("[local-dev] Failed to fetch tools:", err);
  }

  // 2. Create connection with fetched tools
  const connection = await ctx.storage.connections.create({
    title: name,
    connection_type: "HTTP",
    connection_url: connectionUrl,
    organization_id: organizationId,
    created_by: userId,
    tools: tools?.length ? tools : null,
    metadata: { localDevRoot: root },
  });

  // 3. Create project with object-storage and preview enabled
  const project = await ctx.storage.projects.create({
    organizationId,
    slug,
    name,
    description: `Local development project (${root})`,
    enabledPlugins: ["object-storage", "preview", "declare"],
    ui: {
      banner: null,
      bannerColor: "#10B981",
      icon: null,
      themeColor: "#10B981",
    },
  });

  // 4. Bind object-storage and preview plugins to the connection
  await ctx.storage.projectPluginConfigs.upsert(project.id, "object-storage", {
    connectionId: connection.id,
  });
  await ctx.storage.projectPluginConfigs.upsert(project.id, "preview", {
    connectionId: connection.id,
  });
  await ctx.storage.projectPluginConfigs.upsert(project.id, "declare", {
    connectionId: connection.id,
  });

  // 5. Create a Virtual MCP (agent) so the local-dev tools are available in chat
  const virtualMcp = await ctx.storage.virtualMcps.create(
    organizationId,
    userId,
    {
      title: name,
      description: `Local development agent for ${root}`,
      icon: pickRandomCapybaraIcon(),
      status: "active",
      connections: [{ connection_id: connection.id }],
      metadata: {
        instructions: [
          "## Dev Server Preview",
          "This project has a preview plugin that shows the dev server in an iframe.",
          "The preview config is stored at `.deco/preview.json` with this format:",
          '```json\n{ "command": "bun run dev", "port": 3000 }\n```',
          "When the user asks to set up or configure the dev server preview:",
          "1. Analyze package.json scripts and config files (vite.config.ts, next.config.js, etc.) to determine the correct command and port",
          "2. Write the config to `.deco/preview.json` using the write_file tool",
          "3. Tell the user to refresh the Preview panel in the sidebar",
          "The command should use the project's package manager (check for bun.lockb, yarn.lock, pnpm-lock.yaml, or package-lock.json).",
        ].join("\n"),
      },
    },
  );

  return c.json({
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
    },
    connectionId: connection.id,
    virtualMcpId: virtualMcp.id,
  });
});

async function probePort(port: number): Promise<DiscoveredInstance | null> {
  try {
    const res = await fetch(`http://localhost:${port}/_ready`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ReadyResponse;
    if (!data.ready || !data.root) return null;
    return { port, root: data.root, version: data.version };
  } catch {
    return null;
  }
}

export default app;

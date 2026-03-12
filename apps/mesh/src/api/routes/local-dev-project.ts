/**
 * Local Dev Project Routes (local mode only)
 *
 * POST /pick-folder     — open native OS folder picker
 * POST /validate-folder — validate folder path + derive name/slug
 * POST /create-project  — create project + connection + virtual MCP + bind plugins
 * GET  /watch/:id       — SSE filesystem watch for a local connection
 * GET  /files/:id/*     — serve files for presigned URLs
 */

import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { requireAuth, getUserId } from "../../core/mesh-context";
import { pickRandomCapybaraIcon } from "../../constants/capybara-icons";
import { LocalFileStorage } from "@decocms/local-dev";
import type { Env } from "../hono-env";
import {
  createLocalClient,
  getLocalStorage,
  PREVIEW_TOOL_NAME,
} from "../../mcp-clients/local";

const app = new Hono<Env>();

// ---- Native Folder Picker ----

app.post("/pick-folder", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  try {
    const proc = Bun.spawn(
      [
        "osascript",
        "-e",
        'set selectedFolder to choose folder with prompt "Select a project folder"',
        "-e",
        "return POSIX path of selectedFolder",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // User cancelled the dialog
      return c.json({ cancelled: true });
    }
    const path = (await new Response(proc.stdout).text()).trim();
    // Remove trailing slash
    const cleaned = path.endsWith("/") ? path.slice(0, -1) : path;
    return c.json({ path: cleaned });
  } catch {
    return c.json({ error: "Failed to open folder picker" }, 500);
  }
});

// ---- Validate Folder ----

app.post("/validate-folder", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  const { folderPath } = (await c.req.json()) as { folderPath: string };
  if (!folderPath) {
    return c.json({ valid: false, error: "Missing folderPath" }, 400);
  }

  const resolvedPath = resolve(folderPath);

  try {
    const info = await stat(resolvedPath);
    if (!info.isDirectory()) {
      return c.json({ valid: false, error: "Not a directory" });
    }
  } catch {
    return c.json({ valid: false, error: "Path not found" });
  }

  const name = basename(resolvedPath);
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // Check if a project already exists for this folder
  const organizationId = ctx.organization?.id;
  let existingProjectSlug: string | undefined;

  if (organizationId) {
    const connections = await ctx.storage.connections.list(organizationId);
    const existing = connections.find(
      (conn: { metadata: Record<string, unknown> | null }) => {
        const meta = conn.metadata as { localDevRoot?: string } | null;
        return meta?.localDevRoot === resolvedPath;
      },
    );
    if (existing) {
      // Find project that binds to this connection
      const projects = await ctx.storage.projects.list(organizationId);
      // Check plugin configs for binding
      for (const project of projects) {
        const configs = await ctx.storage.projectPluginConfigs.list(project.id);
        if (configs.some((cfg) => cfg.connectionId === existing.id)) {
          existingProjectSlug = project.slug;
          break;
        }
      }
    }
  }

  return c.json({
    valid: true,
    name,
    slug: slug || "project",
    folderPath: resolvedPath,
    existingProjectSlug,
  });
});

// ---- Create Project ----

app.post("/create-project", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  const organizationId = ctx.organization?.id;
  const userId = getUserId(ctx);
  if (!organizationId || !userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = (await c.req.json()) as {
    folderPath: string;
    name?: string;
    slug?: string;
    bannerColor?: string;
  };

  const resolvedPath = resolve(body.folderPath);

  // Validate folder exists
  try {
    const info = await stat(resolvedPath);
    if (!info.isDirectory()) {
      return c.json({ error: "Not a directory" }, 400);
    }
  } catch {
    return c.json({ error: "Folder not found" }, 404);
  }

  const folderName = basename(resolvedPath);
  const name = body.name || folderName;
  const slug =
    body.slug ||
    folderName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") ||
    "project";
  const bannerColor = body.bannerColor || "#10B981";

  // Idempotency: check if connection already exists for this folder
  const connections = await ctx.storage.connections.list(organizationId);
  const existingConn = connections.find((conn) => {
    const meta = conn.metadata as { localDevRoot?: string } | null;
    return meta?.localDevRoot === resolvedPath;
  });

  if (existingConn) {
    // Find the associated project and virtual MCP
    const projects = await ctx.storage.projects.list(organizationId);
    for (const project of projects) {
      const configs = await ctx.storage.projectPluginConfigs.list(project.id);
      if (configs.some((cfg) => cfg.connectionId === existingConn.id)) {
        return c.json({
          project: { id: project.id, slug: project.slug, name: project.name },
          connectionId: existingConn.id,
          existing: true,
        });
      }
    }
  }

  // 1. Create a temporary local client to discover tools
  const tempConnection = {
    id: `pending-${Date.now()}`,
    title: name,
    connection_type: "HTTP" as const,
    connection_url: "",
    metadata: {
      sourceProvider: "local-filesystem",
      localDevRoot: resolvedPath,
    },
  };
  let toolsList: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }> | null = null;
  try {
    const client = await createLocalClient(tempConnection as any, resolvedPath);
    const result = await client.listTools();
    toolsList = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    await client.close();
  } catch (err) {
    console.error("[local-dev] Failed to list tools:", err);
  }

  // 2. Create connection
  const connection = await ctx.storage.connections.create({
    title: name,
    connection_type: "HTTP",
    connection_url: "",
    organization_id: organizationId,
    created_by: userId,
    tools: toolsList?.length
      ? toolsList.map((t) => ({
          ...t,
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        }))
      : null,
    metadata: {
      sourceProvider: "local-filesystem",
      localDevRoot: resolvedPath,
    },
  });

  // 3. Create project
  const project = await ctx.storage.projects.create({
    organizationId,
    slug,
    name,
    description: `Local project (${resolvedPath})`,
    enabledPlugins: ["object-storage"],
    ui: {
      banner: null,
      bannerColor,
      icon: null,
      themeColor: bannerColor,
      pinnedViews: [
        {
          connectionId: connection.id,
          toolName: PREVIEW_TOOL_NAME,
          label: "Preview",
          icon: null,
        },
      ],
    },
  });

  // 4. Bind object-storage plugin to the connection
  await ctx.storage.projectPluginConfigs.upsert(project.id, "object-storage", {
    connectionId: connection.id,
  });

  // 5. Create Virtual MCP so tools are available in chat
  const virtualMcp = await ctx.storage.virtualMcps.create(
    organizationId,
    userId,
    {
      title: name,
      description: `Local development agent for ${resolvedPath}`,
      icon: pickRandomCapybaraIcon(),
      status: "active",
      connections: [{ connection_id: connection.id }],
      metadata: {},
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

// ---- File Watch (SSE) ----

app.get("/watch/:connectionId", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  const connectionId = c.req.param("connectionId");
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const connection = await ctx.storage.connections.findById(connectionId);
  if (!connection || connection.organization_id !== organizationId) {
    return c.json({ error: "Connection not found" }, 404);
  }

  const meta = connection.metadata as { localDevRoot?: string } | null;
  if (!meta?.localDevRoot) {
    return c.json({ error: "Not a local connection" }, 400);
  }

  // Use Hono's streaming response for SSE
  return c.newResponse(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const rootPath = meta.localDevRoot!;

        // Use node:fs.watch for filesystem events
        const watcher = require("node:fs").watch(
          rootPath,
          { recursive: true },
          (eventType: string, filename: string | null) => {
            if (!filename) return;
            const data = JSON.stringify({
              path: filename,
              type: eventType,
              timestamp: Date.now(),
            });
            try {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch {
              // Stream closed
            }
          },
        );

        // Keepalive every 30s
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30_000);

        // Cleanup on close
        c.req.raw.signal.addEventListener("abort", () => {
          watcher.close();
          clearInterval(keepalive);
          controller.close();
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
});

// ---- File Serving (Presigned URLs) ----

app.get("/files/:connectionId/*", async (c) => {
  const ctx = c.var.meshContext;
  requireAuth(ctx);

  const connectionId = c.req.param("connectionId");
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const connection = await ctx.storage.connections.findById(connectionId);
  if (!connection || connection.organization_id !== organizationId) {
    return c.json({ error: "Connection not found" }, 404);
  }

  const meta = connection.metadata as { localDevRoot?: string } | null;
  if (!meta?.localDevRoot) {
    return c.json({ error: "Not a local connection" }, 400);
  }

  // Extract file key from URL (everything after /files/:connectionId/)
  const url = new URL(c.req.url);
  const prefix = `/api/local-dev/files/${connectionId}/`;
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!key) {
    return c.json({ error: "Missing file key" }, 400);
  }

  const storage =
    getLocalStorage(meta.localDevRoot) ??
    new LocalFileStorage(meta.localDevRoot);

  try {
    const absolutePath = storage.resolvePath(key);
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
    };
    const ext = extname(absolutePath).toLowerCase();
    const contentType = mimeTypes[ext] ?? "application/octet-stream";

    const nodeStream = createReadStream(absolutePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return c.newResponse(webStream, {
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return c.json({ error: "Forbidden" }, 403);
  }
});

export default app;

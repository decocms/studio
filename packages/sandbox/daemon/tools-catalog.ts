/**
 * Materializes an org's Virtual MCP tool catalog onto the sandbox filesystem so
 * an agent can discover and script against tools from disk (see the typegen CLI
 * / generated client). Writes one raw JSON Schema file per tool under
 * `<repo>/.deco/tools/`. Deliberately keeps only JSON Schema — no TypeScript
 * codegen — so it pulls no prettier / json-schema-to-typescript into the daemon
 * bundle. Agents wanting the typed client run `@decocms/typegen` themselves.
 */
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureGitExclude } from "./git-exclude";
import { safePath } from "./paths";

/** Where the catalog lands, relative to the repo root. */
export const CATALOG_DIR = ".deco/tools";

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface CatalogFile {
  filename: string;
  content: string;
}

/**
 * One JSON Schema file per tool: `<TOOL>.json` holding
 * `{ name, description?, inputSchema, outputSchema? }`. Pure — the caller writes
 * them. Filenames are sanitized to filesystem-safe chars while the original
 * tool name is preserved inside the file. Distinct tools whose names sanitize to
 * the same string (e.g. `a/b` and `a_b`) get a `-2`, `-3`… suffix so no tool is
 * silently dropped; stable for a given input order.
 */
export function toolCatalogFiles(tools: CatalogTool[]): CatalogFile[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    const body: Record<string, unknown> = { name: tool.name };
    if (tool.description) body.description = tool.description;
    body.inputSchema = tool.inputSchema ?? { type: "object" };
    if (tool.outputSchema) body.outputSchema = tool.outputSchema;
    const base = tool.name.replace(/[^A-Za-z0-9_.-]/g, "_") || "tool";
    let filename = `${base}.json`;
    for (let i = 2; used.has(filename); i++) filename = `${base}-${i}.json`;
    used.add(filename);
    return { filename, content: `${JSON.stringify(body, null, 2)}\n` };
  });
}

/**
 * Connect to a Virtual MCP endpoint and list its tools, following the MCP
 * pagination cursor so large orgs aren't silently truncated to the first page.
 */
export async function fetchToolCatalog(
  mcp: McpEndpoint,
): Promise<CatalogTool[]> {
  const client = new Client({
    name: "@decocms/sandbox-tools-catalog",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: mcp.headers },
    }),
  );
  try {
    const out: CatalogTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: (t as { outputSchema?: unknown }).outputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  } finally {
    await client.close();
  }
}

/**
 * Write the catalog under `<repoDir>/.deco/tools/`, clamped to `appRoot`, and
 * prune stale `*.json` left by a previous sync (renamed/removed tools).
 * Registers the dir in `.git/info/exclude` so the daemon's shutdown
 * `git add -A` never commits the catalog onto the user's branch. Returns the
 * tool names written. Throws only on a real filesystem failure.
 */
export async function writeToolCatalog(
  tools: CatalogTool[],
  opts: { appRoot: string; repoDir: string },
): Promise<{ count: number; tools: string[] }> {
  const files = toolCatalogFiles(tools);
  const dir = safePath(opts.appRoot, opts.repoDir, CATALOG_DIR);
  if (!dir) return { count: 0, tools: [] }; // escapes the workspace root
  await mkdir(dir, { recursive: true });
  await ensureGitExclude(opts.repoDir, `/${CATALOG_DIR}/`);

  // Async fs: this can fire during dispatch, and the daemon runs a single
  // event loop — sync writes would stall it. Writes run concurrently.
  const written = await Promise.all(
    files.map(async (file, i) => {
      const target = safePath(
        opts.appRoot,
        opts.repoDir,
        `${CATALOG_DIR}/${file.filename}`,
      );
      if (!target) return null; // escapes the workspace root — skip
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf-8");
      return { filename: file.filename, name: tools[i].name };
    }),
  );
  const ok = written.filter((w): w is { filename: string; name: string } =>
    Boolean(w),
  );
  const keep = new Set(ok.map((w) => w.filename));

  // Prune files from a previous sync that this one didn't write, so a
  // renamed/removed tool doesn't linger as a stale catalog entry.
  const existing = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    existing
      .filter((name) => name.endsWith(".json") && !keep.has(name))
      .map((name) => unlink(join(dir, name)).catch(() => {})),
  );

  return { count: ok.length, tools: ok.map((w) => w.name) };
}

/** Fetch the catalog from the endpoint and write it to disk. */
async function syncToolCatalog(
  mcp: McpEndpoint,
  opts: { appRoot: string; repoDir: string },
): Promise<{ count: number; tools: string[] }> {
  const tools = await fetchToolCatalog(mcp);
  return writeToolCatalog(tools, opts);
}

/**
 * Wraps `syncToolCatalog` for the fire-and-forget dispatch hook: coalesces
 * concurrent syncs and skips re-listing the same endpoint more often than
 * `minIntervalMs`. The catalog rarely changes within a sandbox's lifetime, so
 * re-syncing on every single run is wasted work (and a write race). Errors are
 * logged, never thrown. `now` is injectable for tests.
 */
export function makeCatalogSync(
  opts: { appRoot: string; repoDir: string; minIntervalMs?: number },
  deps: {
    now?: () => number;
    sync?: (mcp: McpEndpoint) => Promise<unknown>;
  } = {},
): (mcp: McpEndpoint) => void {
  const now = deps.now ?? Date.now;
  const sync = deps.sync ?? ((mcp: McpEndpoint) => syncToolCatalog(mcp, opts));
  const minInterval = opts.minIntervalMs ?? 60_000;
  const lastRun = new Map<string, number>();
  const inFlight = new Set<string>();
  return (mcp) => {
    const key = mcp.url;
    if (inFlight.has(key)) return;
    const last = lastRun.get(key);
    if (last !== undefined && now() - last < minInterval) return;
    inFlight.add(key);
    void Promise.resolve(sync(mcp))
      .catch((err) => console.error("[tools] catalog sync failed", err))
      .finally(() => {
        inFlight.delete(key);
        lastRun.set(key, now());
      });
  };
}

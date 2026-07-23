/**
 * Ephemeral dev-server connection resolver.
 *
 * Materializes an in-memory `ConnectionEntity` for the synthetic id
 * `dev_<virtualMcpId>`, pointing at the running sandbox dev
 * server (`${previewUrl}/api/mcp`, authless by default). Never persisted — the
 * proxy chokepoints call this instead of `connections.findById` when they see a
 * `dev_` id (mirrors the `_self` synthetic-id bypass).
 *
 * Shared hosted sessions resolve from the org registry; user-desktop sessions
 * continue to resolve from `sandboxMap[actingUserId]`.
 *
 * Returns `null` unless the agent is the dev side of a dev/live pair (the
 * MCP-app signal — see the gate below), so plain website/Hydrogen sandbox
 * agents never get a dev connection.
 *
 * Auth: authless by default — the preview URL is open (its unguessable handle
 * is the secret, Vercel-style). If the app gates /mcp behind a query token
 * (`MCP_AUTH_TOKEN`), it's appended to the URL — query params survive the
 * sandbox daemon proxy, which strips `Authorization` (so bearer/OAuth header
 * auth needs a daemon change; deferred).
 */

import {
  getDevConnectionId,
  parseBranchMap,
  type SandboxMap,
} from "@decocms/mesh-sdk";
import type { StudioContext } from "../../core/studio-context";
import type { ConnectionEntity } from "../../tools/connection/schema";
import {
  SecretAccessDeniedError,
  SecretNotFoundError,
} from "../../storage/secrets";
import { readValidatedRuntimeEnv } from "../../tools/sandbox/helpers";
import { readSandboxMap } from "../../tools/sandbox/sandbox-map";
import {
  type BranchMapEntryLike,
  selectVmEntry,
} from "../../tools/sandbox/select-vm-entry";

/** Env var the dev MCP app gates `/mcp` behind (matches the prod connection). */
const MCP_AUTH_TOKEN_KEY = "MCP_AUTH_TOKEN";

// MCP-readiness probe, memoized per dev-server URL (the URL embeds the unique
// sandbox handle + token, so it's per-sandbox). A confirmed MCP app sticks
// (`true` cached for the lifetime of the process); a non-MCP or still-booting
// server is re-probed only every PROBE_BACKOFF_MS, so the hot path neither
// re-probes a known-good server nor permanently rejects one that comes up later.
const mcpReadyUrls = new Set<string>();
const mcpProbedAt = new Map<string, number>();
const PROBE_BACKOFF_MS = 10_000;

/**
 * True iff `connectionUrl` answers an MCP `initialize`. A Vite SPA fallback
 * returns 200 with HTML, so we require a real MCP result (protocolVersion /
 * serverInfo) — not just a 2xx.
 */
async function servesMcp(connectionUrl: string): Promise<boolean> {
  if (mcpReadyUrls.has(connectionUrl)) return true;
  const now = Date.now();
  if (now - (mcpProbedAt.get(connectionUrl) ?? 0) < PROBE_BACKOFF_MS) {
    return false;
  }
  mcpProbedAt.set(connectionUrl, now);
  try {
    const res = await fetch(connectionUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mesh-dev-probe", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(4000),
    });
    const body = res.ok ? await res.text() : "";
    const ok = /"protocolVersion"|"serverInfo"/.test(body);
    if (ok) mcpReadyUrls.add(connectionUrl);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the synthetic dev connection for `agentId` and the acting user.
 * Returns `null` unless the acting user has a running sandbox for this agent AND
 * that sandbox's dev server actually speaks MCP at `/api/mcp` (probed once,
 * memoized). Repo/pairing-agnostic — the real signal is "a sandbox serving an
 * MCP app", so a freshly imported (or even repo-less) MCP-app sandbox surfaces
 * its tools/views, while a Start-Website/Hydrogen sandbox (a Vite site, no MCP)
 * does not. A missing dev token is NOT a null condition: it just yields an
 * authless connection (the default; the URL handle is the secret).
 */
export async function resolveDevConnection(
  ctx: StudioContext,
  agentId: string,
  actingUserId: string,
  branch?: string,
): Promise<ConnectionEntity | null> {
  const orgId = ctx.organization?.id;
  if (!orgId) return null;

  const vm = await ctx.storage.virtualMcps.findById(agentId);
  if (!vm || vm.organization_id !== orgId) return null;

  const metadata = (vm.metadata ?? {}) as Record<string, unknown>;
  const userMap = readSandboxMap(metadata)[actingUserId];
  const sharedSession = branch
    ? await ctx.storage.agentSandboxSessions.find({
        organizationId: orgId,
        virtualMcpId: agentId,
        branch,
      })
    : await ctx.storage.agentSandboxSessions.findLatestReadyByVirtualMcp(
        orgId,
        agentId,
      );
  const sharedEntry =
    sharedSession?.desiredState === "running" &&
    sharedSession.status === "ready" &&
    sharedSession.sandboxHandle &&
    sharedSession.previewUrl
      ? {
          sandboxHandle: sharedSession.sandboxHandle,
          previewUrl: sharedSession.previewUrl,
          sandboxProviderKind: "agent-sandbox" as const,
        }
      : null;
  const picked = sharedEntry
    ? {
        entry: sharedEntry,
      }
    : userMap
      ? branch
        ? pickEntryForBranch(userMap, branch)
        : pickMostRecentEntry(userMap)
      : null;
  if (!picked?.entry.previewUrl) return null;

  // Authless by default — most dev servers run open. If the app gates /mcp
  // behind a query token (MCP_AUTH_TOKEN in runtime.env), append it: query
  // params survive the sandbox daemon proxy, which strips the Authorization
  // header (so bearer/OAuth header auth is a follow-up needing a daemon change).
  const token = await resolveDevToken(ctx, metadata, orgId, actingUserId);
  const base = picked.entry.previewUrl.replace(/\/+$/, "");
  // The deco runtime serves MCP at `/api/mcp` on the Vite dev server (which
  // proxies `/api/*` to the worker); a bare `/mcp` hits Vite directly and
  // 404s. (The deployed worker serves `/mcp` — that's prod, not the dev server.)
  const connection_url = token
    ? `${base}/api/mcp?token=${encodeURIComponent(token)}`
    : `${base}/api/mcp`;

  // The real gate: only surface a connection if the dev server actually speaks
  // MCP. This is what makes it repo/pairing-agnostic — any sandbox serving an
  // MCP app qualifies, a Vite-site sandbox (Start-Website/Hydrogen) does not.
  // Memoized per URL so the hot path doesn't re-probe (see servesMcp).
  if (!(await servesMcp(connection_url))) return null;

  return {
    id: getDevConnectionId(agentId),
    organization_id: orgId,
    title: `${vm.title} (dev)`,
    description: "Ephemeral sandbox dev-server connection",
    icon: vm.icon ?? null,
    app_name: vm.title ?? null,
    app_id: null,
    slug: null,
    connection_type: "HTTP",
    connection_url,
    // Authless, or the app's query token rides inline in connection_url —
    // never persisted as a separate credential.
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDevConnection: true,
      virtualMcpId: agentId,
      branch:
        sharedEntry && sharedSession
          ? sharedSession.branch
          : "branch" in picked
            ? picked.branch
            : branch,
    },
    // null forces live tool/resource discovery (the dev server hot-reloads).
    tools: null,
    bindings: null,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
  };
}

function pickEntryForBranch(
  userMap: SandboxMap[string],
  branch: string,
): { branch: string; entry: BranchMapEntryLike } | null {
  const entry = selectVmEntry(
    parseBranchMap(userMap[branch]) as Record<string, BranchMapEntryLike>,
  );
  return entry ? { branch, entry } : null;
}

/**
 * No explicit branch → pick the user's most recently created sandbox across all
 * branches. Ambiguous only when a user keeps several live branches at once; the
 * explicit `?branch=` override (follow-up) disambiguates.
 */
function pickMostRecentEntry(
  userMap: SandboxMap[string],
): { branch: string; entry: BranchMapEntryLike } | null {
  let best: { branch: string; entry: BranchMapEntryLike } | null = null;
  for (const [branch, raw] of Object.entries(userMap)) {
    const entry = selectVmEntry(
      parseBranchMap(raw) as Record<string, BranchMapEntryLike>,
    );
    if (!entry) continue;
    if (!best || (entry.createdAt ?? 0) > (best.entry.createdAt ?? 0)) {
      best = { branch, entry };
    }
  }
  return best;
}

/**
 * Resolve `MCP_AUTH_TOKEN` from the agent's `metadata.runtime.env`: literal
 * inline, or a vault secret (same per-user/org ACL `SANDBOX_START` enforces). A
 * missing/unauthorized secret resolves to `null` → no dev connection.
 */
async function resolveDevToken(
  ctx: StudioContext,
  metadata: Record<string, unknown>,
  orgId: string,
  actingUserId: string,
): Promise<string | null> {
  const entry = readValidatedRuntimeEnv(metadata)?.find(
    (e) => e.key === MCP_AUTH_TOKEN_KEY,
  );
  if (!entry) return null;
  if (entry.kind === "literal") return entry.value || null;
  try {
    const { value } = await ctx.storage.secrets.resolveById(
      entry.secretId,
      orgId,
      actingUserId,
    );
    return value || null;
  } catch (err) {
    if (
      err instanceof SecretNotFoundError ||
      err instanceof SecretAccessDeniedError
    ) {
      return null;
    }
    throw err;
  }
}

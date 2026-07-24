/**
 * E2E helpers for bringing a desktop link online through the tunnel contract.
 *
 * The production CLI serves commands with `@decocms/tunnel` under the user's
 * hostname and answers `GET /api/links/status` so the cluster can probe its
 * liveness + capabilities live. These helpers do the same directly from
 * Playwright so route tests can exercise the optimistic cluster side: presence
 * is whatever the live status probe returns, with no `studio_links` claim and
 * no heartbeat bucket.
 */

import { readFileSync } from "node:fs";
import { sleep } from "@decocms/shared/std";
import { serve, type TunnelServer } from "@decocms/tunnel";
import { encodeSubjectToken } from "@decocms/tunnel/subject";
import { expect, type APIRequestContext } from "@playwright/test";
import { connect } from "@nats-io/transport-node";
import { credsAuthenticator, type NatsConnection } from "@nats-io/nats-core";
import type { Capability } from "@decocms/sandbox/dispatch";
import { workItemSchema, type WorkItem } from "./work-item-schema";

const DEFAULT_NATS_URL = "nats://localhost:4222";

/**
 * Inlined contract: the tunnel hostname the cluster's status probe addresses.
 * Mirrors the app's `src/links/tunnel-host.ts` — the format `user-<token>.link`
 * IS the wire contract this fake daemon must serve under.
 */
function buildUserTunnelHostname(userId: string): string {
  return `user-${encodeSubjectToken(userId)}.link`;
}
const DEFAULT_WORK_ITEM_TIMEOUT_MS = 35_000;

type WorkItemMatcher = (item: WorkItem) => boolean;

interface WorkItemWaiter {
  matcher: WorkItemMatcher;
  resolve: (item: WorkItem) => void;
}

export interface TunnelLinkDaemon {
  readonly tunnelHostname: string;
  nextWorkItem(
    runIdOrMatcher?: string | WorkItemMatcher,
    opts?: { timeoutMs?: number },
  ): Promise<WorkItem>;
  close(): Promise<void>;
}

export async function openNats(): Promise<NatsConnection> {
  // CI provisions an unauthenticated NATS (no NATS_CREDS). A local `deco
  // services` / dev stack runs NATS in operator mode, where the same creds file
  // the cluster uses (NATS_CREDS) is required — honor it so the relay suite is
  // runnable against the local dev NATS too.
  const credsPath = process.env.NATS_CREDS;
  return await connect({
    servers: process.env.NATS_URL ?? DEFAULT_NATS_URL,
    ...(credsPath
      ? { authenticator: credsAuthenticator(readFileSync(credsPath)) }
      : {}),
  });
}

/**
 * Poll the cluster's live presence read until it reports online. Under the
 * optimistic model `/api/links/me` calls `linkStatusProbe`, which fetches
 * `GET /api/links/status` over the tunnel — so this only flips non-null once
 * the daemon's tunnel server (below) is answering that route.
 */
async function waitForPresence(api: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/links/me");
        if (res.status() !== 200) return null;
        return (await res.json()) as unknown;
      },
      { timeout: 10_000, intervals: [200, 500, 1_000] },
    )
    .not.toBeNull();
}

function normalizeMatcher(
  runIdOrMatcher: string | WorkItemMatcher | undefined,
): WorkItemMatcher {
  if (typeof runIdOrMatcher === "function") return runIdOrMatcher;
  if (typeof runIdOrMatcher === "string") {
    return (item) => item.runId === runIdOrMatcher;
  }
  return () => true;
}

function takeQueued(
  queue: WorkItem[],
  matcher: WorkItemMatcher,
): WorkItem | null {
  const index = queue.findIndex(matcher);
  if (index === -1) return null;
  const [item] = queue.splice(index, 1);
  return item ?? null;
}

export async function createTunnelLinkDaemon(
  api: APIRequestContext,
  userId: string,
  capabilities: Capability[],
): Promise<TunnelLinkDaemon> {
  const connection = await openNats();
  const tunnelHostname = buildUserTunnelHostname(userId);
  const queue: WorkItem[] = [];
  const waiters = new Set<WorkItemWaiter>();

  const pushWorkItem = (item: WorkItem): void => {
    for (const waiter of waiters) {
      if (!waiter.matcher(item)) continue;
      waiters.delete(waiter);
      waiter.resolve(item);
      return;
    }
    queue.push(item);
  };

  const server = await serve({
    connection,
    hostname: tunnelHostname,
    fetch: async (request) => {
      const url = new URL(request.url);

      // Live presence: the cluster's status probe fetches this over the tunnel.
      // Answering it 200 is what makes the link "online" — there is no claim.
      if (url.pathname === "/api/links/status" && request.method === "GET") {
        return Response.json({
          hostname: tunnelHostname,
          capabilities,
          cliVersion: "test",
        });
      }

      if (url.pathname !== "/api/links/work" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      let body: unknown;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }

      const parsed = workItemSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_work_item" }, { status: 400 });
      }

      pushWorkItem(parsed.data);
      return new Response(null, { status: 202 });
    },
  });
  await connection.flush();
  await waitForPresence(api);

  async function closeServer(server: TunnelServer): Promise<void> {
    await server.close().catch(() => {});
    await server.closed.catch(() => {});
  }

  return {
    tunnelHostname,
    async nextWorkItem(runIdOrMatcher, opts) {
      const matcher = normalizeMatcher(runIdOrMatcher);
      const queued = takeQueued(queue, matcher);
      if (queued) return queued;

      const timeoutMs = opts?.timeoutMs ?? DEFAULT_WORK_ITEM_TIMEOUT_MS;
      const timeout = new AbortController();
      let resolveWorkItem!: (item: WorkItem) => void;
      const workItemPromise = new Promise<WorkItem>((resolve) => {
        resolveWorkItem = resolve;
      });
      const waiter: WorkItemWaiter = { matcher, resolve: resolveWorkItem };
      waiters.add(waiter);

      try {
        return await Promise.race([
          workItemPromise,
          sleep(timeoutMs, { signal: timeout.signal }).then(() => {
            throw new Error(
              `Timed out waiting for tunnel work item after ${timeoutMs}ms`,
            );
          }),
        ]);
      } finally {
        timeout.abort();
        waiters.delete(waiter);
      }
    },
    async close() {
      waiters.clear();
      queue.length = 0;
      await closeServer(server);
      await connection.close();
    },
  };
}

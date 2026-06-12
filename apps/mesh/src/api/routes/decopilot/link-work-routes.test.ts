/**
 * Unit tests for the work long-poll route — focused on the link-protocol
 * version gate (v2 hard break). The NATS consumer is a structural stub that
 * yields nothing (long-poll window "expires" immediately → 204), so the
 * tests exercise the gate + claim path without real JetStream.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../hono-env";
import { createInMemoryLinkClaimRegistry } from "@/links/link-claim-registry";
import { MIN_SUPPORTED_LINK_PROTOCOL } from "@/links/protocol";
import { createLinkWorkRoutes } from "./link-work-routes";
import type { LinkWorkQueue } from "./link-work-queue";

function makeApp(opts: { userId?: string | null } = {}) {
  const userId = opts.userId === undefined ? "user_1" : opts.userId;
  const linkClaimRegistry = createInMemoryLinkClaimRegistry();
  let consumerRequests = 0;
  const workQueue = {
    getOrCreateConsumer: async () => {
      consumerRequests++;
      return {
        fetch: async () => ({
          stop() {},
          async *[Symbol.asyncIterator]() {},
        }),
      };
    },
  } as unknown as LinkWorkQueue;

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("meshContext", {
      auth: userId ? { user: { id: userId } } : {},
    } as unknown as Env["Variables"]["meshContext"]);
    await next();
  });
  app.route("/api", createLinkWorkRoutes({ linkClaimRegistry, workQueue }));

  return {
    app,
    linkClaimRegistry,
    consumerRequests: () => consumerRequests,
  };
}

function poll(app: Hono<Env>, headers: Record<string, string> = {}) {
  return app.request("/api/links/work", { headers });
}

describe("link work route protocol gate", () => {
  test("rejects a poll without x-link-protocol as a v1 daemon with 426", async () => {
    const { app, linkClaimRegistry, consumerRequests } = makeApp();

    const res = await poll(app);

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      error: "protocol_mismatch",
      minSupported: MIN_SUPPORTED_LINK_PROTOCOL,
      message:
        "Link protocol v1 is no longer supported. Re-run: bunx decocms@latest link",
    });
    // The gate fires before any side effect: no presence claim is minted and
    // no JetStream consumer is created for a daemon that can't take work.
    expect(await linkClaimRegistry.get("user_1")).toBeNull();
    expect(consumerRequests()).toBe(0);
  });

  test("treats an unparsable x-link-protocol header as v1", async () => {
    const { app } = makeApp();

    const res = await poll(app, { "x-link-protocol": "banana" });

    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("protocol_mismatch");
    expect(body.message).toContain("v1 is no longer supported");
    expect(body.message).toContain("Re-run: bunx decocms@latest link");
  });

  test("rejects an explicit stale version below the minimum", async () => {
    const { app } = makeApp();

    const res = await poll(app, {
      "x-link-protocol": String(MIN_SUPPORTED_LINK_PROTOCOL - 1),
    });

    expect(res.status).toBe(426);
    const body = (await res.json()) as { minSupported: number };
    expect(body.minSupported).toBe(MIN_SUPPORTED_LINK_PROTOCOL);
  });

  test("serves a v2 poll normally (claim minted, 204 on empty queue)", async () => {
    const { app, linkClaimRegistry, consumerRequests } = makeApp();

    const res = await poll(app, {
      "x-link-protocol": "2",
      "x-link-capabilities": "claude-code",
      "x-link-machine-id": "machine-1",
      "x-link-cli-version": "test",
    });

    expect(res.status).toBe(204);
    expect(consumerRequests()).toBe(1);
    const claim = await linkClaimRegistry.get("user_1");
    expect(claim).toMatchObject({
      machineId: "machine-1",
      cliVersion: "test",
      capabilities: ["claude-code"],
    });
  });

  test("still requires auth when the protocol is acceptable", async () => {
    const { app } = makeApp({ userId: null });

    const res = await poll(app, { "x-link-protocol": "2" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

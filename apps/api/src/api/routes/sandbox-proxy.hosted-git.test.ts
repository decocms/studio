import { describe, expect, it } from "bun:test";
import { BLOCKS_V8_METADATA_KEY } from "@decocms/shared/blocks-major";
import { Hono, type Context } from "hono";
import { hostedV8GitGone } from "./sandbox-proxy";

/** The `/git/*` gate behind a claim like `resolveVmClaim` sets. */
function app(
  runtime: "sandbox" | "cms",
  metadata: Record<string, unknown> | null,
) {
  const reached: string[] = [];
  const hono = new Hono();
  hono.use("/:virtualMcpId/:branch/*", async (c, next) => {
    (c as unknown as Context).set("vmClaim", {
      claimName: "claim",
      callerUserId: "u1",
      runner: null,
      virtualMcpId: c.req.param("virtualMcpId"),
      branch: c.req.param("branch"),
      userId: "u1",
      projectRef: "p1",
      virtualMcpMetadata: metadata,
      connectionIds: [],
      runtime,
    });
    await next();
  });
  hono.use("/:virtualMcpId/:branch/git/*", hostedV8GitGone as never);
  hono.all("/:virtualMcpId/:branch/git/*", (c) => {
    reached.push(c.req.path);
    return c.json({ ok: true });
  });
  return { hono, reached };
}

const V8 = { [BLOCKS_V8_METADATA_KEY]: true };

describe("sandbox-less git routes of a Blocks v8 site", () => {
  it("answer 404 without reaching the GitHub-backed handlers", async () => {
    const { hono, reached } = app("cms", V8);
    for (const route of ["status", "diff", "publish", "discard", "rebase"]) {
      const res = await hono.request(`/vm1/main/git/${route}`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("hosted_cms");
    }
    expect(reached).toEqual([]);
  });

  it("leave a v7 session and a v8 sandbox's own git alone", async () => {
    const v7 = app("cms", null);
    expect((await v7.hono.request("/vm1/main/git/status")).status).toBe(200);
    // A stale `blocksMajor` marker is not the switch: v7, as on main.
    const stale = app("cms", { blocksMajor: 8 });
    expect((await stale.hono.request("/vm1/main/git/status")).status).toBe(200);
    const sandbox = app("sandbox", V8);
    expect((await sandbox.hono.request("/vm1/main/git/status")).status).toBe(
      200,
    );
  });
});

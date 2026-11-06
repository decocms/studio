/**
 * The decofile routes are the v7 git surface. A Blocks v8 site (its
 * `metadata.blocksMajor` marker, with the CMS schema push it came from) keeps its content on the hosted CMS, so a
 * write or a publish here is refused before any repository lookup: no
 * commit of `.deco/blocks` and no merge into main for an R2 site, whichever
 * editor sends it (design: S3, conditions 1 and 2).
 */

import { describe, expect, it } from "bun:test";
import {
  BLOCKS_MAJOR_METADATA_KEY,
  blocksV8Metadata,
} from "@decocms/shared/blocks-major";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import type { Env } from "../hono-env";
import { createDecofileRoutes } from "./decofile";

const ORG = "org";

function setup(metadata: Record<string, unknown>) {
  const opened: string[] = [];
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: { user: { id: "user", role: "owner" } },
    access: { getRole: () => "owner", check: async () => {} },
    storage: {
      virtualMcps: {
        findById: async (id: string) =>
          id === "p1"
            ? { id, organization_id: ORG, metadata, connections: [] }
            : null,
      },
    },
  } as unknown as StudioContext;
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/decofile",
    createDecofileRoutes({
      // Every repository open is recorded, then fails: a v7 request reaches it.
      repoClientFor: async () => {
        opened.push("repo");
        throw new Error("no GitHub in this test");
      },
    }),
  );
  return { app, opened };
}

const PROJECT = {
  previewServerUrl: "https://www.acme.test",
  repository: { owner: "acme", name: "site" },
};

const WRITES = [
  [
    "PATCH",
    "/decofile/p1/main",
    JSON.stringify({ set: { "pages/home": { __resolveType: "x" } } }),
  ],
  ["POST", "/decofile/p1/main/publish", "{}"],
] as const;

describe("decofile routes on a Blocks v8 site", () => {
  it("refuse a write and a publish with 409 hosted_cms, never opening the repository", async () => {
    const { app, opened } = setup({
      ...PROJECT,
      ...blocksV8Metadata({ site: "acme", sha256: "e1" }),
    });
    for (const [method, path, body] of WRITES) {
      const res = await app.request(path, {
        method,
        body,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "hosted_cms" });
    }
    expect(opened).toEqual([]);
  });

  for (const [name, metadata] of [
    ["no marker", PROJECT],
    // A marker 8 with no CMS schema push (an earlier Studio set it from git).
    [
      "a stale marker, no schema push",
      { ...PROJECT, [BLOCKS_MAJOR_METADATA_KEY]: 8 },
    ],
  ] as const) {
    it(`keep serving a v7 project (${name}) from its repository, as today`, async () => {
      const { app, opened } = setup(metadata);
      for (const [method, path, body] of WRITES) {
        const res = await app.request(path, {
          method,
          body,
          headers: { "content-type": "application/json" },
        });
        expect(res.status).not.toBe(409);
      }
      expect(opened.length).toBe(WRITES.length);
    });
  }
});

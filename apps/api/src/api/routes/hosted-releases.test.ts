/**
 * Route tests of the Releases routes (`hosted.ts`): Republish, Publish's
 * "Try again", and the listing with what the site serves. The repository,
 * delivery bucket and telemetry are in-memory fakes.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { CACHE_REVISION, deliveryKeys } from "@/hosted/delivery-store";
import {
  fakeInsights,
  fakeRepo,
  memoryDeliveryStore,
  memoryKv,
  SCHEMA_TEXT,
} from "@/hosted/hosted-test-helpers";
import { readLatest } from "@/hosted/publish";
import { buildRevision } from "@/hosted/release-objects";
import type { ServedLabel } from "@/hosted/serving";
import type { Env } from "../hono-env";
import { createHostedRoutes } from "./hosted";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const ORG = "org";

function context(): StudioContext {
  const project = {
    id: "p1",
    organization_id: ORG,
    metadata: { repository: { owner: "acme", name: "site" }, blocksMajor: 8 },
    connections: [],
  };
  return {
    organization: { id: ORG, slug: ORG },
    auth: {
      user: { id: "user", role: "owner", name: "Ana", email: "ana@acme.com" },
      permissionsOrganizationId: ORG,
    },
    access: { getRole: () => "owner", check: async () => {} },
    storage: {
      kv: memoryKv(),
      virtualMcps: {
        findById: async (id: string) => (id === "p1" ? project : null),
        patchMetadata: async () => true,
      },
      orgSites: {
        getByProject: async (projectId: string) => ({
          slug: "acme",
          organizationId: ORG,
          projectId,
        }),
      },
    },
  } as unknown as StudioContext;
}

function setup() {
  let served: ServedLabel[] | null = null;
  const git = fakeRepo({
    ".deco/schema.gen.json": SCHEMA_TEXT,
    ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v1" }),
  });
  const delivery = memoryDeliveryStore();
  const ctx = context();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/hosted",
    createHostedRoutes({
      repoClientFor: async () => git.client,
      delivery: () => ({ store: delivery.store, purge: delivery.purge }),
      insightsFor: async () => fakeInsights(git.history).client,
      servedLabels: () => async () => served,
    }),
  );
  const release = async () => {
    const sha = git.head();
    await delivery.store.putJson(
      deliveryKeys.revision("acme", sha),
      await buildRevision(git.client, null, sha),
      CACHE_REVISION,
    );
    return sha;
  };
  const post = (path: string, body: unknown = {}) =>
    app.request(`/hosted/p1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const serve = (labels: ServedLabel[] | null) => {
    served = labels;
  };
  return { git, delivery, app, release, post, serve };
}

describe("POST releases/:sha/republish", () => {
  it("publishes a new release with that release's content", async () => {
    const { git, delivery, release, post } = setup();
    const first = await release();
    git.pushDirect(
      { ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }) },
      "Summer sale",
    );
    await release();
    const res = await post(`releases/${first}/republish`);
    expect(res.status).toBe(200);
    const sha = git.head();
    expect(await res.json()).toEqual({
      result: "merged",
      sha,
      release: "current",
    });
    expect(git.history[0]?.message).toStartWith("Republish: initial\n\n");
    expect(git.filesAt(sha)[".deco/blocks/Home.json"]).toBe(
      serializeBlock({ path: "/", title: "v1" }),
    );
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(sha);
  });

  it("is 404 for a commit without a release", async () => {
    const { git, post } = setup();
    const res = await post(`releases/${git.head()}/republish`);
    expect(res.status).toBe(404);
  });

  it("asks again on a schema mismatch (409), then republishes when confirmed", async () => {
    const { git, release, post } = setup();
    const first = await release();
    git.pushDirect({
      ".deco/schema.gen.json": SCHEMA_TEXT.replace("next.7", "next.8"),
      ".deco/blocks/Home.json": serializeBlock({ t: 2 }),
    });
    const refused = await post(`releases/${first}/republish`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "schema-mismatch" });
    const ok = await post(`releases/${first}/republish`, { confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: "merged" });
  });

  it("is 409 main-moved when main moves under the commit", async () => {
    const { git, release, post } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    const commitFiles = git.client.commitFiles;
    git.client.commitFiles = async (params) => {
      git.pushDirect({ ".deco/blocks/X.json": "{}\n" }, "someone else");
      return commitFiles(params);
    };
    const res = await post(`releases/${first}/republish`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "main-moved" });
  });
});

describe("POST releases/current", () => {
  it("only makes main's head current (Publish's Try again): no pointer flip to an older release", async () => {
    const { git, delivery, release, post } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    const flip = await post("releases/current", { sha: first });
    expect(flip.status).toBe(400);
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    const retry = await post("releases/current", { head: true });
    expect(retry.status).toBe(200);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });
});

describe("GET releases", () => {
  it("links a republish to its original, and says what the site serves", async () => {
    const { git, app, release, post, serve } = setup();
    const original = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await release();
    await post(`releases/${original}/republish`);
    const republished = git.head();

    // Nothing reported yet: the screen falls back to the pointer.
    const before = await (await app.request("/hosted/p1/releases")).json();
    expect(before.serving).toEqual({ source: "none" });
    expect(before.current.revision).toBe(republished);
    expect(before.commits[0]).toMatchObject({
      sha: republished,
      hasRelease: true,
      republishOf: { sha: original },
    });

    const lastSeen = new Date().toISOString();
    serve([{ label: republished, lastSeen }]);
    const after = await (await app.request("/hosted/p1/releases")).json();
    expect(after.serving).toEqual({
      source: "site",
      revision: republished,
      lastSeen,
    });
  });
});

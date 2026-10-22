/**
 * Route tests of the Releases routes (`hosted.ts`): Reapply version (and its
 * schema read), Publish's "Try again", and the listing. The repository and
 * delivery bucket are in-memory fakes.
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
    metadata: {
      repository: { owner: "acme", name: "site" },
      blocksMajor: 8,
      previewServerUrl: "https://Preview.Acme.com/",
    },
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

function setup(
  siteDomains: (site: string) => Promise<string[]> = async (site) =>
    site === "acme"
      ? ["acme.deco.site", "www.acme.com", "preview.acme.com"]
      : [],
) {
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
      siteDomains,
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
  const get = async (path: string) => app.request(`/hosted/p1/${path}`);
  return { git, delivery, app, release, post, get };
}

describe("POST releases/:sha/reapply", () => {
  it("publishes a new version with that version's content", async () => {
    const { git, delivery, release, post } = setup();
    const first = await release();
    git.pushDirect(
      { ".deco/blocks/Home.json": serializeBlock({ path: "/", title: "v2" }) },
      "Summer sale",
    );
    await release();
    const res = await post(`releases/${first}/reapply`);
    expect(res.status).toBe(200);
    const sha = git.head();
    expect(await res.json()).toEqual({
      result: "merged",
      sha,
      release: "current",
      schemaChanged: false,
    });
    expect(git.history[0]?.message).toStartWith("Made current: initial\n\n");
    expect(git.filesAt(sha)[".deco/blocks/Home.json"]).toBe(
      serializeBlock({ path: "/", title: "v1" }),
    );
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(sha);
    // Make current carries the site's preview hosts, in latest.json and in
    // the new version's companion release.
    const hosts = ["acme.deco.site", "preview.acme.com", "www.acme.com"];
    expect((await readLatest(delivery.store, "acme"))?.previewHosts).toEqual(
      hosts,
    );
    const companion = delivery.objects.get(deliveryKeys.revision("acme", sha));
    expect(JSON.parse(companion?.text ?? "{}").previewHosts).toEqual(hosts);
  });

  it("is 404 for a commit without a release", async () => {
    const { git, post, get } = setup();
    const res = await post(`releases/${git.head()}/reapply`);
    expect(res.status).toBe(404);
    expect((await get(`releases/${git.head()}/reapply`)).status).toBe(404);
  });

  it("reapplies a version made for another schema without asking again", async () => {
    const { git, release, post, get } = setup();
    const first = await release();
    git.pushDirect({
      ".deco/schema.gen.json": SCHEMA_TEXT.replace("next.7", "next.8"),
      ".deco/blocks/Home.json": serializeBlock({ t: 2 }),
    });
    const head = git.head();
    const check = await get(`releases/${first}/reapply`);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ schemaChanged: true });
    expect(git.head()).toBe(head);
    const ok = await post(`releases/${first}/reapply`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      result: "merged",
      schemaChanged: true,
    });
    expect(git.head()).not.toBe(head);
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
    const res = await post(`releases/${first}/reapply`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "main-moved" });
  });
});

describe("POST releases/retry", () => {
  it("only releases main's head (Publish's Try again); the old pointer route is gone", async () => {
    const { git, delivery, release, post } = setup();
    const first = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    const flip = await post("releases/current", { sha: first });
    expect(flip.status).toBe(404);
    expect(await readLatest(delivery.store, "acme")).toBeNull();
    const retry = await post("releases/retry");
    expect(retry.status).toBe(200);
    expect((await readLatest(delivery.store, "acme"))?.revision).toBe(
      git.head(),
    );
  });

  it("writes the site's addresses Studio knows as previewHosts: sorted, without duplicates", async () => {
    const { delivery, post } = setup();
    const retry = await post("releases/retry");
    expect(retry.status).toBe(200);
    const hosts = ["acme.deco.site", "preview.acme.com", "www.acme.com"];
    expect(((await retry.json()) as { current: unknown }).current).toEqual(
      expect.objectContaining({ previewHosts: hosts }),
    );
    expect((await readLatest(delivery.store, "acme"))?.previewHosts).toEqual(
      hosts,
    );
  });

  it("still releases when the site's domains can't be read: the preview server alone", async () => {
    const { delivery, post } = setup(async () => {
      throw new Error("supabase down");
    });
    expect((await post("releases/retry")).status).toBe(200);
    expect((await readLatest(delivery.store, "acme"))?.previewHosts).toEqual([
      "preview.acme.com",
    ]);
  });
});

describe("GET releases", () => {
  it("links a reapplied version to its original; current is latest.json", async () => {
    const { git, release, post, get } = setup();
    const original = await release();
    git.pushDirect({ ".deco/blocks/Home.json": serializeBlock({ t: 2 }) });
    await release();
    await post(`releases/${original}/reapply`);
    const reapplied = git.head();

    const page = await (await get("releases")).json();
    expect(page.serving).toBeUndefined();
    expect(page.current.revision).toBe(reapplied);
    expect(page.commits[0]).toMatchObject({
      sha: reapplied,
      hasRelease: true,
      reapplyOf: { sha: original },
    });
  });
});

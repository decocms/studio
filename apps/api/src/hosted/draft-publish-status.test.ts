import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import {
  hostedDraftPublishDiff,
  draftGitDiscard,
  hostedDraftPublishStatus,
  loadHostedDraft,
} from "./draft-publish-status";
import { BLOCKS_MAJOR_METADATA_KEY } from "@decocms/shared/blocks-major";
import { createDraftStore, type HostedDraftRef } from "./draft-store";
import {
  fakeRepo,
  memoryDeliveryStore,
  memoryKv,
  SCHEMA_TEXT,
} from "./hosted-test-helpers";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const REF: HostedDraftRef = {
  organizationId: "org",
  virtualMcpId: "vmcp",
  branch: "thread-1",
  site: "acme",
};

describe("hosted draft publish status", () => {
  it("shows, diffs and discards the draft's changes against main", async () => {
    const git = fakeRepo({
      ".deco/schema.gen.json": SCHEMA_TEXT,
      ".deco/blocks/Home.json": serializeBlock({ v: 1 }),
      ".deco/blocks/Old.json": serializeBlock({ o: 1 }),
    });
    const drafts = createDraftStore({
      kv: memoryKv(),
      store: memoryDeliveryStore().store,
    });
    const repo = { client: git.client, packagePath: null, mainBranch: "main" };
    await drafts.update(REF, () => ({
      set: { Home: { v: 2 }, New: { n: 1 } },
      delete: ["Old"],
    }));
    const draft = await drafts.load(REF);

    const status = await hostedDraftPublishStatus(repo, REF.branch, draft);
    expect(status.changedFiles).toEqual([
      { path: ".deco/blocks/Home.json", status: "modified" },
      { path: ".deco/blocks/New.json", status: "added" },
      { path: ".deco/blocks/Old.json", status: "removed" },
    ]);
    expect(status.aheadOfBase).toBe(3);
    expect(status.headSha.startsWith(`${git.head()}~`)).toBe(true);

    const diff = await hostedDraftPublishDiff(repo, draft);
    expect(diff.diffs[".deco/blocks/Home.json"]).toEqual({
      from: serializeBlock({ v: 1 }),
      to: serializeBlock({ v: 2 }),
    });
    expect(diff.diffs[".deco/blocks/Old.json"]?.to).toBeNull();

    await draftGitDiscard(drafts, REF, [
      ".deco/blocks/Home.json",
      ".deco/blocks/Old.json",
    ]);
    expect((await drafts.load(REF))?.body).toEqual({
      set: { New: { n: 1 } },
      delete: [],
    });
  });

  it("has nothing to publish without a draft", async () => {
    const git = fakeRepo({ ".deco/schema.gen.json": SCHEMA_TEXT });
    const status = await hostedDraftPublishStatus(
      { client: git.client, packagePath: null, mainBranch: "main" },
      "thread-1",
      null,
    );
    expect(status.changedFiles).toEqual([]);
    expect(status.aheadOfBase).toBe(0);
  });
});

describe("loadHostedDraft: the v8 marker gate", () => {
  const SITE = "acme";
  const V7_SCHEMA = '{\n  "definitions": {},\n  "root": {}\n}\n';

  function request(params: {
    metadata: Record<string, unknown> | null;
    files: Record<string, string>;
    owned?: boolean;
  }) {
    const git = fakeRepo(params.files);
    const delivery = memoryDeliveryStore();
    const kv = memoryKv();
    const calls = { git: 0, orgSites: 0 };
    const patches: Array<{ set: object; unset: string[] }> = [];
    const req = {
      storage: {
        kv,
        orgSites: {
          getByProject: async () => {
            calls.orgSites++;
            return params.owned === false
              ? null
              : { slug: SITE, organizationId: "org" };
          },
        },
        virtualMcps: {
          patchMetadata: async (p: { set: object; unset: string[] }) => {
            patches.push({ set: p.set, unset: p.unset });
            return true;
          },
        },
      },
      userId: "user",
      organizationId: "org",
      virtualMcpId: "vmcp",
      branch: "thread-1",
      metadata: params.metadata,
      gitClient: async () => {
        calls.git++;
        return git.client;
      },
      drafts: createDraftStore({ kv, store: delivery.store }),
    } as unknown as Parameters<typeof loadHostedDraft>[0];
    return { req, calls, patches };
  }

  it("an unmarked (v7) project reads nothing: no org_sites, no GitHub", async () => {
    const { req, calls, patches } = request({
      metadata: {},
      files: { ".deco/schema.gen.json": SCHEMA_TEXT },
    });
    expect(await loadHostedDraft(req)).toBeNull();
    expect(calls).toEqual({ git: 0, orgSites: 0 });
    expect(patches).toEqual([]);
  });

  it("a marked project whose main is v8 gets its draft", async () => {
    const { req, patches } = request({
      metadata: { blocksMajor: 8 },
      files: { ".deco/schema.gen.json": SCHEMA_TEXT },
    });
    const hosted = await loadHostedDraft(req);
    expect(hosted?.ref).toEqual({ ...REF, site: SITE });
    expect(patches).toEqual([]);
  });

  it("a marked project whose main is back on v7: null, marker cleared", async () => {
    const { req, patches } = request({
      metadata: { blocksMajor: 8 },
      files: { ".deco/schema.gen.json": V7_SCHEMA },
    });
    expect(await loadHostedDraft(req)).toBeNull();
    expect(patches).toEqual([{ set: {}, unset: [BLOCKS_MAJOR_METADATA_KEY] }]);
  });

  it("a marked project that doesn't own its site reads no GitHub", async () => {
    const { req, calls } = request({
      metadata: { blocksMajor: 8 },
      files: { ".deco/schema.gen.json": SCHEMA_TEXT },
      owned: false,
    });
    expect(await loadHostedDraft(req)).toBeNull();
    expect(calls.git).toBe(0);
  });
});

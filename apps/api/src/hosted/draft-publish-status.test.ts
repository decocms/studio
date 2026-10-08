import { beforeAll, describe, expect, it } from "bun:test";
import { serializeBlock } from "@decocms/blocks/protocol";
import {
  hostedDraftPublishDiff,
  draftGitDiscard,
  hostedDraftPublishStatus,
} from "./draft-publish-status";
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

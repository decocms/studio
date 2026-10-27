import { describe, expect, it } from "bun:test";
import type { OrgFsEntry } from "../storage/org-fs";
import {
  blogDir,
  deleteBlogRecords,
  MAX_CAMPAIGN_SEEDS,
  readBlogState,
  recordPath,
  singletonPath,
  writeBlogFiles,
  type ProjectRef,
} from "./blog-state";
import type { OrgFs } from "./org-fs";

const PROJECT: ProjectRef = {
  id: "vmcp_1",
  title: "Acme · Loja BR",
  metadata: { projectFolderName: "acme-loja-br" },
};

function entry(path: string, hash: string | null): OrgFsEntry {
  return {
    organizationId: "org_1",
    volume: "home",
    path,
    parent: path.slice(0, path.lastIndexOf("/")),
    kind: "file",
    contentHash: hash,
    size: 0,
    seq: "1",
    deletedAt: null,
    createdBy: "u",
    createdAt: "",
    updatedBy: "u",
    updatedAt: "",
    threadId: null,
    readPublic: false,
    shareMode: "private",
  };
}

interface FakeOptions {
  /** Paths whose read throws, standing in for a vanished object. */
  unreadable?: Set<string>;
  /** Directories whose listing throws, standing in for a missing folder. */
  unlistable?: Set<string>;
}

/** An in-memory org-fs holding only what these tests put in it. */
function fakeOrgFs(
  files: Map<string, { body: string; hash: string | null }>,
  options: FakeOptions = {},
) {
  const writes: { path: string; body: string; expect?: unknown }[] = [];
  const deletes: string[] = [];
  const fs = {
    async listDir(_volume: string, path: string): Promise<OrgFsEntry[]> {
      if (options.unlistable?.has(path)) throw new Error("no such directory");
      return [...files.keys()]
        .filter((p) => p.slice(0, p.lastIndexOf("/")) === path)
        .map((p) => entry(p, files.get(p)?.hash ?? null));
    },
    async read(_volume: string, path: string): Promise<Uint8Array> {
      if (options.unreadable?.has(path)) throw new Error("gone");
      const file = files.get(path);
      if (!file) throw new Error("not found");
      return new TextEncoder().encode(file.body);
    },
    async write(
      _volume: string,
      path: string,
      body: string,
      opts: { expect?: unknown },
    ): Promise<OrgFsEntry> {
      writes.push({ path, body, expect: opts.expect });
      files.set(path, { body, hash: `hash-${writes.length}` });
      return entry(path, `hash-${writes.length}`);
    },
    async delete(_volume: string, path: string): Promise<void> {
      deletes.push(path);
      if (!files.delete(path)) throw new Error("not found");
    },
  };
  return { fs: fs as unknown as OrgFs, writes, deletes };
}

const BASE = blogDir(PROJECT);

function withFiles(
  entries: Record<string, unknown>,
): Map<string, { body: string; hash: string | null }> {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      {
        body: typeof value === "string" ? value : JSON.stringify(value),
        hash: `hash-of-${path}`,
      },
    ]),
  );
}

describe("blog state paths", () => {
  it("roots everything at the project's pinned folder", () => {
    expect(BASE).toBe("projects/acme-loja-br/Blog");
    expect(singletonPath(PROJECT, "brand")).toBe(`${BASE}/brand.json`);
    expect(recordPath(PROJECT, "campaigns", "abc")).toBe(
      `${BASE}/campaigns/abc.json`,
    );
  });

  it("falls back to the title when the folder was never pinned", () => {
    expect(blogDir({ id: "vmcp_2", title: "Outra Loja" })).toBe(
      "projects/outra-loja/Blog",
    );
  });
});

describe("readBlogState", () => {
  it("reads the singletons and the records, with their versions", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/brand.json`]: { companyName: "Acme" },
        [`${BASE}/context.json`]: { tone: "direct" },
        [`${BASE}/formats.json`]: { formats: [{ name: "Guia", value: "..." }] },
        [`${BASE}/campaigns/c1.json`]: { campaignName: "Black Friday" },
        [`${BASE}/campaign-seeds/s1.json`]: { seedName: "Datas" },
      }),
    );

    const state = await readBlogState(fs, PROJECT);

    expect(state.brand).toEqual({ companyName: "Acme" });
    expect(state.context).toEqual({ tone: "direct" });
    expect(state.campaigns).toEqual([
      { id: "c1", data: { campaignName: "Black Friday" } },
    ]);
    expect(state.campaignSeeds).toEqual([
      { id: "s1", data: { seedName: "Datas" } },
    ]);
    expect(state.versions[`${BASE}/brand.json`]).toBe(
      `hash-of-${BASE}/brand.json`,
    );
    expect(state.versions[`${BASE}/campaigns/c1.json`]).toBe(
      `hash-of-${BASE}/campaigns/c1.json`,
    );
  });

  it("reads as empty when the project has no folder yet", async () => {
    const { fs } = fakeOrgFs(new Map(), { unlistable: new Set([BASE]) });
    const state = await readBlogState(fs, PROJECT);
    expect(state).toEqual({
      brand: null,
      context: null,
      formats: null,
      campaigns: [],
      campaignSeeds: [],
      versions: {},
    });
  });

  it("skips a corrupt record instead of losing the whole board", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/campaigns/good.json`]: { campaignName: "Natal" },
        [`${BASE}/campaigns/broken.json`]: "{ not json",
      }),
    );
    const state = await readBlogState(fs, PROJECT);
    expect(state.campaigns).toEqual([
      { id: "good", data: { campaignName: "Natal" } },
    ]);
  });

  it("skips a record whose file vanished between listing and reading", async () => {
    const path = `${BASE}/campaigns/ghost.json`;
    const { fs } = fakeOrgFs(
      withFiles({
        [path]: { campaignName: "Ghost" },
        [`${BASE}/campaigns/real.json`]: { campaignName: "Real" },
      }),
      { unreadable: new Set([path]) },
    );
    const state = await readBlogState(fs, PROJECT);
    expect(state.campaigns.map((c) => c.id)).toEqual(["real"]);
  });

  it("ignores a singleton that is corrupt, keeping the others", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/brand.json`]: "}{",
        [`${BASE}/context.json`]: { tone: "warm" },
      }),
    );
    const state = await readBlogState(fs, PROJECT);
    expect(state.brand).toBeNull();
    expect(state.context).toEqual({ tone: "warm" });
    expect(state.versions[`${BASE}/brand.json`]).toBeUndefined();
  });

  it("stops at the ceiling rather than reading a folder forever", async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CAMPAIGN_SEEDS + 10; i += 1) {
      many[`${BASE}/campaign-seeds/s${i}.json`] = { seedName: `s${i}` };
    }
    const { fs } = fakeOrgFs(withFiles(many));
    const state = await readBlogState(fs, PROJECT);
    expect(state.campaignSeeds).toHaveLength(MAX_CAMPAIGN_SEEDS);
  });

  it("ignores a file whose name is not an id", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/campaigns/README.md`]: "notes",
        [`${BASE}/campaigns/c1.json`]: { campaignName: "Only this" },
      }),
    );
    const state = await readBlogState(fs, PROJECT);
    expect(state.campaigns.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("writeBlogFiles", () => {
  it("carries the precondition through to storage", async () => {
    const { fs, writes } = fakeOrgFs(new Map());
    await writeBlogFiles(fs, "user_1", [
      {
        path: `${BASE}/brand.json`,
        data: { companyName: "Acme" },
        expect: { contentHash: "abc" },
      },
      { path: `${BASE}/campaigns/c1.json`, data: { campaignName: "X" } },
    ]);
    expect(writes[0]?.expect).toEqual({ contentHash: "abc" });
    expect(writes[1]?.expect).toBeUndefined();
    expect(JSON.parse(writes[0]?.body ?? "")).toEqual({ companyName: "Acme" });
  });

  it("fails the whole call on a refusal, rather than half-applying", async () => {
    const { fs } = fakeOrgFs(new Map());
    const conflict = new Error("precondition failed");
    const refusing = {
      ...fs,
      write: async (_v: string, path: string) => {
        if (path.endsWith("context.json")) throw conflict;
        return entry(path, "h");
      },
    } as unknown as OrgFs;

    await expect(
      writeBlogFiles(refusing, "user_1", [
        { path: `${BASE}/brand.json`, data: {} },
        { path: `${BASE}/context.json`, data: {} },
      ]),
    ).rejects.toThrow("precondition failed");
  });
});

describe("deleteBlogRecords", () => {
  it("treats a record that is already gone as deleted", async () => {
    const { fs, deletes } = fakeOrgFs(
      withFiles({ [`${BASE}/campaigns/here.json`]: {} }),
    );
    await deleteBlogRecords(fs, PROJECT, "user_1", "campaigns", [
      "here",
      "never-existed",
    ]);
    expect(deletes).toEqual([
      `${BASE}/campaigns/here.json`,
      `${BASE}/campaigns/never-existed.json`,
    ]);
  });
});

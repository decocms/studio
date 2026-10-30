import { describe, expect, it } from "bun:test";
import type { OrgFsEntry } from "../storage/org-fs";
import {
  brandPath,
  deleteBlogRecords,
  MAX_CAMPAIGN_SEEDS,
  readBlogState,
  recordPath,
  resolveBrandDir,
  writeBlogFiles,
} from "./blog-state";
import type { OrgFs } from "./org-fs";

const BRAND = "acme";

function entry(
  path: string,
  hash: string | null,
  kind: "file" | "dir" = "file",
): OrgFsEntry {
  return {
    organizationId: "org_1",
    volume: "home",
    path,
    parent: path.slice(0, path.lastIndexOf("/")),
    kind,
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
      const listed = [...files.keys()]
        .filter((p) => p.slice(0, p.lastIndexOf("/")) === path)
        .map((p) => entry(p, files.get(p)?.hash ?? null));
      const dirs = new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(`${path}/`))
          .map((p) => p.slice(path.length + 1).split("/"))
          .filter((parts) => parts.length > 1)
          .map((parts) => `${path}/${parts[0]}`),
      );
      return [...listed, ...[...dirs].map((d) => entry(d, null, "dir"))];
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

const BASE = brandPath(BRAND);

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

const GUIDE = `---
name: Acme
language: pt-BR
site: https://acme.example
---

## Tom de voz

Direto.

## Regras

- Frases curtas.

## Formatos

### Guia

Passo a passo.
`;

describe("blog state paths", () => {
  it("roots everything at the brand folder", () => {
    expect(BASE).toBe("brands/acme");
    expect(recordPath(BRAND, "campaigns", "abc")).toBe(
      "brands/acme/campaigns/abc.json",
    );
  });
});

describe("resolveBrandDir", () => {
  it("takes the org's own brand, else the first, else the org's name", async () => {
    const both = fakeOrgFs(
      withFiles({
        "brands/zeta/brand.md": "",
        "brands/acme/brand.md": "",
      }),
    );
    expect(await resolveBrandDir(both.fs, "acme")).toBe("acme");
    expect(await resolveBrandDir(both.fs, "other")).toBe("acme");
    const none = fakeOrgFs(new Map(), { unlistable: new Set(["brands"]) });
    expect(await resolveBrandDir(none.fs, "acme")).toBe("acme");
  });
});

describe("readBlogState", () => {
  it("reads the guide as brand, writing rules and formats, with its version", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/brand.md`]: GUIDE,
        [`${BASE}/campaigns/c1.json`]: { campaignName: "Black Friday" },
        [`${BASE}/campaign-seeds/s1.json`]: { seedName: "Datas" },
      }),
    );

    const state = await readBlogState(fs, BRAND);

    expect(state.brandPath).toBe(BASE);
    expect(state.brand?.companyName).toBe("Acme");
    expect(state.brand?.language).toBe("pt-BR");
    expect(state.brand?.storeUrl).toBe("https://acme.example");
    expect(state.context?.tone).toBe("Direto.");
    expect(state.context?.dos).toEqual([{ name: "Frases curtas.", value: "" }]);
    expect(state.formats?.formats).toEqual([
      { name: "Guia", value: "Passo a passo." },
    ]);
    expect(state.campaigns).toEqual([
      { id: "c1", data: { campaignName: "Black Friday" } },
    ]);
    expect(state.campaignSeeds).toEqual([
      { id: "s1", data: { seedName: "Datas" } },
    ]);
    expect(state.versions[`${BASE}/brand.md`]).toBe(`hash-of-${BASE}/brand.md`);
    expect(state.versions[`${BASE}/campaigns/c1.json`]).toBe(
      `hash-of-${BASE}/campaigns/c1.json`,
    );
  });

  it("reads as empty when the brand has no folder yet", async () => {
    const { fs } = fakeOrgFs(new Map(), { unlistable: new Set([BASE]) });
    const state = await readBlogState(fs, BRAND);
    expect(state).toEqual({
      brandPath: BASE,
      brand: null,
      context: null,
      formats: null,
      campaigns: [],
      campaignSeeds: [],
      versions: {},
    });
  });

  it("a brand with campaigns but no guide has no brand yet", async () => {
    const { fs } = fakeOrgFs(
      withFiles({ [`${BASE}/campaigns/c1.json`]: { campaignName: "Natal" } }),
    );
    const state = await readBlogState(fs, BRAND);
    expect(state.brand).toBeNull();
    expect(state.campaigns).toHaveLength(1);
  });

  it("an unreadable guide reads as no guide", async () => {
    const path = `${BASE}/brand.md`;
    const { fs } = fakeOrgFs(withFiles({ [path]: GUIDE }), {
      unreadable: new Set([path]),
    });
    const state = await readBlogState(fs, BRAND);
    expect(state.brand).toBeNull();
    expect(state.versions[path]).toBeUndefined();
  });

  it("skips a corrupt record instead of losing the whole board", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/campaigns/good.json`]: { campaignName: "Natal" },
        [`${BASE}/campaigns/broken.json`]: "{ not json",
      }),
    );
    const state = await readBlogState(fs, BRAND);
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
    const state = await readBlogState(fs, BRAND);
    expect(state.campaigns.map((c) => c.id)).toEqual(["real"]);
  });

  it("stops at the ceiling rather than reading a folder forever", async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CAMPAIGN_SEEDS + 10; i += 1) {
      many[`${BASE}/campaign-seeds/s${i}.json`] = { seedName: `s${i}` };
    }
    const { fs } = fakeOrgFs(withFiles(many));
    const state = await readBlogState(fs, BRAND);
    expect(state.campaignSeeds).toHaveLength(MAX_CAMPAIGN_SEEDS);
  });

  it("ignores a file whose name is not an id", async () => {
    const { fs } = fakeOrgFs(
      withFiles({
        [`${BASE}/campaigns/README.md`]: "notes",
        [`${BASE}/campaigns/c1.json`]: { campaignName: "Only this" },
      }),
    );
    const state = await readBlogState(fs, BRAND);
    expect(state.campaigns.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("writeBlogFiles", () => {
  it("carries the precondition through to storage", async () => {
    const { fs, writes } = fakeOrgFs(new Map());
    await writeBlogFiles(fs, "user_1", [
      {
        path: `${BASE}/campaigns/c1.json`,
        data: { campaignName: "Acme" },
        expect: { contentHash: "abc" },
      },
      { path: `${BASE}/campaigns/c2.json`, data: { campaignName: "X" } },
    ]);
    expect(writes[0]?.expect).toEqual({ contentHash: "abc" });
    expect(writes[1]?.expect).toBeUndefined();
    expect(JSON.parse(writes[0]?.body ?? "")).toEqual({ campaignName: "Acme" });
  });

  it("fails the whole call on a refusal, rather than half-applying", async () => {
    const { fs } = fakeOrgFs(new Map());
    const conflict = new Error("precondition failed");
    const refusing = {
      ...fs,
      write: async (_v: string, path: string) => {
        if (path.endsWith("c2.json")) throw conflict;
        return entry(path, "h");
      },
    } as unknown as OrgFs;

    await expect(
      writeBlogFiles(refusing, "user_1", [
        { path: `${BASE}/campaigns/c1.json`, data: {} },
        { path: `${BASE}/campaigns/c2.json`, data: {} },
      ]),
    ).rejects.toThrow("precondition failed");
  });
});

describe("deleteBlogRecords", () => {
  it("treats a record that is already gone as deleted", async () => {
    const { fs, deletes } = fakeOrgFs(
      withFiles({ [`${BASE}/campaigns/here.json`]: {} }),
    );
    await deleteBlogRecords(fs, BRAND, "user_1", "campaigns", [
      "here",
      "never-existed",
    ]);
    expect(deletes).toEqual([
      `${BASE}/campaigns/here.json`,
      `${BASE}/campaigns/never-existed.json`,
    ]);
  });
});

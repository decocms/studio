import { describe, expect, test } from "bun:test";
import { GitProviderError } from "@/git-providers";
import type { FsLister, MediaStore, RepoReader } from "../ports.ts";
import type { DiagnosisEvidence } from "../types.ts";
import {
  CODE_UNAVAILABLE,
  type CodeAccess,
  noRepositoryGap,
} from "./code-source.ts";
import { loadRepoSnapshot } from "./repo.ts";
import { refreshRepoSnapshot, withRepoSnapshot } from "./repo-snapshot.ts";

const evidence = (over: Partial<DiagnosisEvidence> = {}): DiagnosisEvidence =>
  ({
    pdp_behaviour: [
      {
        device: "mobile",
        elements: [],
        sections: [{ section: "Product/PDP" }],
      },
    ],
    gaps: [],
    ...over,
  }) as unknown as DiagnosisEvidence;

function memoryMedia() {
  const objects = new Map<string, Uint8Array>();
  const media: MediaStore = {
    put: async (path, bytes) => {
      objects.set(path, bytes);
      return path;
    },
    get: async (path) => objects.get(path) ?? null,
    url: async (path) => `https://media.example/${path}`,
  };
  return { media, objects };
}

/** A ready access over the given reader (the test's view). */
const ready = (
  read: RepoReader,
  opts: { list?: FsLister; skipped?: string[]; open?: () => never } = {},
): CodeAccess => {
  const list = opts.list ?? (async () => []);
  return {
    kind: "ready",
    repo: "acme/loja-exemplo",
    provider: "github",
    open:
      opts.open ??
      (async () => ({
        repo: "acme/loja-exemplo",
        read,
        list,
        raw: { read, list },
        skipped: () => opts.skipped ?? [],
      })),
  };
};

const pdpOnly: RepoReader = async (path) =>
  path === "sections/Product/PDP.tsx" ? "export default 1" : null;

describe("withRepoSnapshot", () => {
  test("read: stored in the run's media and the evidence points at it", async () => {
    const { media, objects } = memoryMedia();
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: ready(pdpOnly),
      media,
      key: "ux/d1/repo.json",
    });
    expect(out.repo_snapshot_key).toBe("ux/d1/repo.json");
    expect(out.gaps).toEqual([]);
    expect([...objects.keys()]).toEqual(["ux/d1/repo.json"]);
    const saved = await loadRepoSnapshot(media, "ux/d1/repo.json");
    expect(saved?.repo).toBe("acme/loja-exemplo");
    expect(saved?.files.map((f) => f.path)).toEqual([
      "sections/Product/PDP.tsx",
    ]);
  });

  test("with the listing, the PDP's page block enters the snapshot", async () => {
    const { media } = memoryMedia();
    await withRepoSnapshot({
      evidence: evidence(),
      access: ready(
        async (path) =>
          path === "sections/Product/PDP.tsx"
            ? "export default 1"
            : path === ".deco/blocks/pages-productpage-1.json"
              ? '{"path":"/:slug/p","sections":[]}'
              : null,
        {
          list: async () => [
            {
              name: "pages-productpage-1.json",
              path: ".deco/blocks/pages-productpage-1.json",
              type: "file",
              size: 1,
            },
          ],
        },
      ),
      media,
      key: "k",
    });
    expect((await loadRepoSnapshot(media, "k"))?.page_block).toBe(
      ".deco/blocks/pages-productpage-1.json",
    );
  });

  test("a file over the read ceiling: the snapshot is kept and the gap names it", async () => {
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: ready(pdpOnly, {
        skipped: [".deco/blocks/pages-productpage-1.json"],
      }),
      media: memoryMedia().media,
      key: "k",
    });
    expect(out.repo_snapshot_key).toBe("k");
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.error).toContain(
      ".deco/blocks/pages-productpage-1.json",
    );
    expect(out.gaps[0]?.error).toContain("200 KB");
  });

  test("no path to the code: the access's gap, without reading, and not twice", async () => {
    const gap = noRepositoryGap();
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: { kind: "gap", gap },
      media: memoryMedia().media,
      key: "k",
    });
    expect(out.repo_snapshot_key).toBeUndefined();
    expect(out.gaps).toEqual([gap]);
    expect(gap.owner).toBe("customer");
    expect(gap.key).toBe("repository");
    const again = await withRepoSnapshot({
      evidence: out,
      access: { kind: "gap", gap },
      media: memoryMedia().media,
      key: "k",
    });
    expect(again.gaps).toEqual([gap]);
  });

  test("a read failure becomes a gap, with no key", async () => {
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: ready(async () => {
        throw new Error("HTTP 500");
      }),
      media: memoryMedia().media,
      key: "k",
    });
    expect(out.repo_snapshot_key).toBeUndefined();
    expect(out.gaps).toEqual([
      { source: "github", error: "snapshot do repo: HTTP 500" },
    ]);
  });

  test("the provider saying the GitHub credential died: the customer's gap, 'reconecte'", async () => {
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: ready(async () => {
        throw new GitProviderError({
          provider: "github",
          status: 401,
          message: "Bad credentials",
        });
      }),
      media: memoryMedia().media,
      key: "k",
    });
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.owner).toBe("customer");
    expect(out.gaps[0]?.key).toBe("repository");
    expect(out.gaps[0]?.error.startsWith(`${CODE_UNAVAILABLE}:`)).toBe(true);
    expect(out.gaps[0]?.error).toContain("reconecte o GitHub");
  });

  test("no object storage: a gap, without opening the repo", async () => {
    let opened = false;
    const out = await withRepoSnapshot({
      evidence: evidence(),
      access: ready(async () => "x", {
        open: () => {
          opened = true;
          throw new Error("não devia abrir");
        },
      }),
      media: null,
      key: "k",
    });
    expect(opened).toBe(false);
    expect(out.gaps).toEqual([
      {
        source: "github",
        error:
          "snapshot do repo: armazenamento de imagens indisponível nesta instalação",
      },
    ]);
  });
});

describe("refreshRepoSnapshot", () => {
  test("read again under the same key, with the skipped files in the note", async () => {
    const { media } = memoryMedia();
    const out = await refreshRepoSnapshot({
      evidence: evidence({ repo_snapshot_key: "ux/d1/repo.json" }),
      access: ready(pdpOnly, { skipped: ["src/big.tsx"] }),
      media,
      key: "ux/d1/repo.json",
    });
    expect(out.evidence?.repo_snapshot_key).toBe("ux/d1/repo.json");
    expect(out.note).toStartWith(
      "snapshot do repo refeito (acme/loja-exemplo); snapshot do repo: 1 arquivo ficou de fora",
    );
    expect(await loadRepoSnapshot(media, "ux/d1/repo.json")).not.toBeNull();
  });

  test("without access or storage, nothing to write, and the note says what the tests read", async () => {
    const gap = await refreshRepoSnapshot({
      evidence: evidence({ repo_snapshot_key: "k" }),
      access: { kind: "gap", gap: noRepositoryGap() },
      media: memoryMedia().media,
      key: "k",
    });
    expect(gap.evidence).toBeNull();
    expect(gap.note).toBe(
      `${noRepositoryGap().error}: vale o snapshot da rodada`,
    );
    const noMedia = await refreshRepoSnapshot({
      evidence: evidence(),
      access: ready(pdpOnly),
      media: null,
      key: "k",
    });
    expect(noMedia.evidence).toBeNull();
    expect(noMedia.note).toBe(
      "armazenamento de imagens indisponível nesta instalação: os testes de código saem 'não deu pra testar'",
    );
  });

  test("a failure keeps the round's snapshot and names the owned gap", async () => {
    const out = await refreshRepoSnapshot({
      evidence: evidence({ repo_snapshot_key: "k" }),
      access: ready(async () => {
        throw new GitProviderError({
          provider: "github",
          status: 429,
          message: "rate limited",
          retryAfterMs: 10_000,
        });
      }),
      media: memoryMedia().media,
      key: "k",
    });
    expect(out.evidence).toBeNull();
    expect(out.note).toBe(
      `${CODE_UNAVAILABLE}: o GitHub limitou as leituras do repositório acme/loja-exemplo (de novo em 10s): vale o snapshot da rodada`,
    );
  });
});

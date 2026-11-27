import { describe, expect, test } from "bun:test";
import {
  type FsLister,
  type Llm,
  type MediaStore,
  NoAiModelError,
  type RepoReader,
} from "../ports.ts";
import type { DevicePdpBehaviour, UxHypothesis } from "../types.ts";
import {
  compactPageBlock,
  findPageBlock,
  findPdpPageBlock,
  importsOf,
  loadRepoSnapshot,
  MISSING_IMPORTS_MAX,
  missingImports,
  NEED_FILES_MAX_BYTES,
  neededPaths,
  PAGE_BLOCK_MAX_BYTES,
  PAGE_BLOCKS_DIR,
  pageBlockNote,
  parseRepoAnswer,
  pdpSectionsOfPageBlock,
  type RepoSnapshot,
  readNeededFiles,
  repoSnapshotKey,
  runRepoCheck,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_READS,
  saveRepoSnapshot,
  sectionPath,
  snapshotRepo,
  storeRepoSnapshot,
} from "./repo.ts";
import type { VerifyCheck } from "./types.ts";

const FROM = "sections/Product/ProductDetails.tsx";
const ctx = { elementKeys: new Set(["r|2"]) };
const check: VerifyCheck = {
  id: "c2",
  claim: "x",
  stage: "repo",
  device: "mobile",
  steps: [],
  question: "q?",
  confirms_if: "a",
  refutes_if: "b",
};
const snap: RepoSnapshot = {
  repo: "acme/loja-exemplo",
  synced_at: "t",
  files: [{ path: "sections/Product/ProductDetails.tsx", text: "x" }],
};

/** An org-bound object store in memory; `puts` lists the keys written. */
function memoryMedia(seed: Record<string, string> = {}) {
  const objects = new Map<string, Uint8Array>(
    Object.entries(seed).map(([k, v]) => [k, new TextEncoder().encode(v)]),
  );
  const puts: string[] = [];
  const media: MediaStore = {
    async put(path, bytes) {
      puts.push(path);
      objects.set(path, bytes);
      return path;
    },
    get: async (path) => objects.get(path) ?? null,
    url: async (path) => `https://media.example/${path}`,
  };
  return { media, puts };
}

describe("sectionPath / importsOf", () => {
  test("sectionPath", () => {
    expect(sectionPath("Product/ProductDetails")).toBe(
      "sections/Product/ProductDetails.tsx",
    );
  });
  test("relative, alias and package", () => {
    expect(
      importsOf('import X from "../../components/product/Title";', FROM),
    ).toContain("components/product/Title.tsx");
    expect(importsOf('import { a } from "~/sdk/format";', FROM)).toContain(
      "sdk/format.ts",
    );
    expect(importsOf('import React from "react";', FROM)).toEqual([]);
  });
});

describe("parseRepoAnswer", () => {
  const ans = (o: object) => JSON.stringify(o);
  test("a file outside the snapshot does not confirm", () => {
    const r = parseRepoAnswer(
      ans({ outcome: "confirma", observed: "o", source_ref: "src/nada.tsx:3" }),
      snap,
      check,
      ctx,
    );
    expect(r.run.outcome).toBe("nao_decidiu");
  });
  test("a file present confirms and keeps the reference", () => {
    const ref = "src/sections/Product/ProductDetails.tsx:1";
    const r = parseRepoAnswer(
      ans({ outcome: "confirma", observed: "o", source_ref: ref }),
      snap,
      check,
      ctx,
    );
    expect(r.run.outcome).toBe("confirma");
    expect(r.run.source_ref).toBe(ref);
  });
  test("a line the file read does not have does not decide", () => {
    const r = parseRepoAnswer(
      ans({
        outcome: "confirma",
        observed: "o",
        source_ref: "src/sections/Product/ProductDetails.tsx:9999",
      }),
      snap,
      check,
      ctx,
    );
    expect(r.run.outcome).toBe("nao_decidiu");
    expect(r.run.observed).toContain("linha 9999");
  });
  test("a valid followup becomes a live test; an invalid one is dropped", () => {
    const base = { outcome: "nao_decidiu", observed: "o" };
    const ok = parseRepoAnswer(
      ans({
        ...base,
        followup_steps: [
          { op: "inspect", target: { kind: "part", part: "price" } },
        ],
      }),
      snap,
      check,
      ctx,
    );
    expect(ok.followup?.id).toBe("c2-f");
    expect(ok.followup?.stage).toBe("live");
    const bad = parseRepoAnswer(
      ans({ ...base, followup_steps: [{ op: "eval", code: "1" }] }),
      snap,
      check,
      ctx,
    );
    expect(bad.followup).toBeNull();
  });
});

describe("snapshotRepo", () => {
  test("follows chained imports", async () => {
    const fs: Record<string, string> = {
      "sections/A.tsx": 'import b from "../components/B";',
      "components/B.tsx": 'import c from "~/sdk/c";',
      "sdk/c.ts": "export const c = 1;",
    };
    const s = await snapshotRepo({
      read: async (p) => fs[p] ?? null,
      repo: "acme/loja-exemplo",
      sections: ["A"],
    });
    expect(s.files.map((f) => f.path)).toEqual([
      "sections/A.tsx",
      "components/B.tsx",
      "sdk/c.ts",
    ]);
  });
  test("respects SNAPSHOT_MAX_FILES", async () => {
    const read = async (p: string) => {
      const n = Number(/(\d+)\.tsx$/.exec(p)?.[1] ?? 0);
      return `import x from "~/components/f${n + 1}";`;
    };
    const s = await snapshotRepo({ read, repo: "r", sections: ["f0"] });
    expect(s.files.length).toBe(SNAPSHOT_MAX_FILES);
  });
  test("a read error with no file read is raised", async () => {
    await expect(
      snapshotRepo({
        read: async () => {
          throw new Error("HTTP 500");
        },
        repo: "r",
        sections: ["A"],
      }),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("runRepoCheck", () => {
  test("without a snapshot it is nao_testou", async () => {
    const r = await runRepoCheck({
      llm: async () => {
        throw new Error("não devia chamar o modelo");
      },
      snapshot: null,
      check,
      hypothesis: {} as UxHypothesis,
      ctx,
      onUsage: () => {},
    });
    expect(r.run.outcome).toBe("nao_testou");
    expect(r.run.observed).toBe("o repositório não foi lido nesta rodada");
  });
});

describe("snapshotRepo, limits and loops", () => {
  test("MAX_FILES: the chain would go past the ceiling and stops exactly at it", async () => {
    const reads: string[] = [];
    const read = async (p: string) => {
      reads.push(p);
      const n = Number(/(\d+)\.tsx$/.exec(p)?.[1] ?? 0);
      return n < SNAPSHOT_MAX_FILES + 10
        ? `import x from "~/components/f${n + 1}";`
        : "";
    };
    const s = await snapshotRepo({ read, repo: "r", sections: ["f0"] });
    expect(s.files.length).toBe(SNAPSHOT_MAX_FILES);
    expect(reads.some((p) => p.includes(`f${SNAPSHOT_MAX_FILES + 1}`))).toBe(
      false,
    );
  });
  test("MAX_BYTES: a file over the ceiling stays out", async () => {
    const big = "x".repeat(SNAPSHOT_MAX_BYTES - 10);
    const fs: Record<string, string> = {
      "sections/A.tsx": `import b from "~/components/B"; //${big.slice(0, SNAPSHOT_MAX_BYTES - 200)}`,
      "components/B.tsx": "y".repeat(500),
    };
    const s = await snapshotRepo({
      read: async (p) => fs[p] ?? null,
      repo: "r",
      sections: ["A"],
    });
    expect(s.files.map((f) => f.path)).toEqual(["sections/A.tsx"]);
  });
  test("an import cycle terminates", async () => {
    const fs: Record<string, string> = {
      "sections/A.tsx": 'import b from "~/components/B";',
      "components/B.tsx": 'import a from "~/sections/A";',
    };
    const s = await snapshotRepo({
      read: async (p) => fs[p] ?? null,
      repo: "r",
      sections: ["A"],
    });
    expect(s.files.length).toBe(2);
  });
  test("a missing file mid-chain is skipped", async () => {
    const fs: Record<string, string> = {
      "sections/A.tsx":
        'import m from "~/components/Missing"; import c from "~/sdk/c";',
      "sdk/c.ts": "export {}",
    };
    const s = await snapshotRepo({
      read: async (p) => fs[p] ?? null,
      repo: "r",
      sections: ["A"],
    });
    expect(s.files.map((f) => f.path)).toEqual(["sections/A.tsx", "sdk/c.ts"]);
  });
  test("x.tsx resolves: x.ts and x/index.tsx are not requested", async () => {
    const reads: string[] = [];
    const fs: Record<string, string> = {
      "sections/A.tsx": 'import x from "~/components/x";',
      "components/x.tsx": "export {}",
    };
    await snapshotRepo({
      read: async (p) => {
        reads.push(p);
        return fs[p] ?? null;
      },
      repo: "r",
      sections: ["A"],
    });
    expect(reads).toEqual(["sections/A.tsx", "components/x.tsx"]);
  });
  test("the read ceiling counts 404s", async () => {
    let n = 0;
    const imports = Array.from(
      { length: 400 },
      (_, i) => `import a${i} from "~/m/m${i}";`,
    ).join("\n");
    const read = async (p: string) => {
      n++;
      return p === "sections/A.tsx" ? imports : null;
    };
    const s = await snapshotRepo({ read, repo: "r", sections: ["A"] });
    expect(n).toBe(SNAPSHOT_MAX_READS);
    expect(s.files.length).toBe(1);
  });
  test("a seed with no file returns an empty snapshot (the caller decides)", async () => {
    const s = await snapshotRepo({
      read: async () => null,
      repo: "r",
      sections: ["A"],
    });
    expect(s.files).toEqual([]);
  });
});

describe("parseRepoAnswer, desmente", () => {
  test("desmente without source_ref becomes nao_decidiu", () => {
    const r = parseRepoAnswer(
      JSON.stringify({ outcome: "desmente", observed: "o" }),
      snap,
      check,
      ctx,
    );
    expect(r.run.outcome).toBe("nao_decidiu");
    expect(r.run.source_ref).toBeNull();
  });
});

describe("loadRepoSnapshot", () => {
  test("the key is the diagnosis's (the storage is already the org's)", () => {
    expect(repoSnapshotKey("d1")).toBe("ux/d1/repo.json");
  });
  test("missing, invalid and valid", async () => {
    const { media } = memoryMedia({
      bad: JSON.stringify({ repo: "r", files: [] }),
      notjson: "{",
      good: JSON.stringify(snap),
    });
    expect(await loadRepoSnapshot(media, "nope")).toBeNull();
    expect(await loadRepoSnapshot(media, "bad")).toBeNull();
    expect(await loadRepoSnapshot(media, "notjson")).toBeNull();
    expect(await loadRepoSnapshot(media, "good")).toEqual(snap);
  });
  test("what saveRepoSnapshot writes comes back the same", async () => {
    const { media } = memoryMedia();
    await saveRepoSnapshot(media, "k", { ...snap, page_block: "a.json" });
    expect(await loadRepoSnapshot(media, "k")).toEqual({
      ...snap,
      page_block: "a.json",
    });
  });
  test("failing storage is null, not an exception", async () => {
    const media: MediaStore = {
      put: async (p) => p,
      get: async () => {
        throw new Error("storage down");
      },
      url: async (p) => p,
    };
    expect(await loadRepoSnapshot(media, "k")).toBeNull();
  });
});

describe("storeRepoSnapshot", () => {
  const pdp = [
    {
      elements: [{ section: "Product/A" }],
      sections: [{ section: "Product/B" }],
    },
  ] as unknown as DevicePdpBehaviour[];
  test("seeds from elements and sections and writes", async () => {
    const { media, puts } = memoryMedia();
    const reads: string[] = [];
    const key = await storeRepoSnapshot({
      media,
      key: "ux/d/repo.json",
      read: async (p) => {
        reads.push(p);
        return "export {}";
      },
      repo: "r",
      pdp,
    });
    expect(key).toBe("ux/d/repo.json");
    expect(puts).toEqual(["ux/d/repo.json"]);
    expect(reads).toEqual(["sections/Product/A.tsx", "sections/Product/B.tsx"]);
    expect((await loadRepoSnapshot(media, key))?.files).toHaveLength(2);
  });
  test("with no file it throws and writes nothing", async () => {
    const { media, puts } = memoryMedia();
    await expect(
      storeRepoSnapshot({
        media,
        key: "k",
        read: async () => null,
        repo: "r",
        pdp,
      }),
    ).rejects.toThrow("nenhuma seção da página encontrada no repo");
    expect(puts).toEqual([]);
  });
});

// ── runRepoCheck with files requested on demand───────────────────────────────

type Prompts = Array<{ system: string; user: string }>;

/** The model answers `answers` in order and fails after; keeps what each call sent. */
async function withLlm<T>(
  answers: object[],
  fn: (prompts: Prompts, llm: Llm) => Promise<T>,
): Promise<T> {
  const prompts: Prompts = [];
  const llm: Llm = async (request) => {
    prompts.push({ system: request.systemPrompt, user: request.userPrompt });
    const next = answers[prompts.length - 1];
    if (!next) throw new Error("sem resposta");
    return JSON.stringify(next);
  };
  return fn(prompts, llm);
}

const repoCheckWith = (llm: Llm, read?: RepoReader, timeLeft?: () => number) =>
  runRepoCheck({
    llm,
    snapshot: snap,
    check,
    hypothesis: { title: "t", why: "w" } as UxHypothesis,
    ctx,
    onUsage: () => {},
    read,
    timeLeft,
  });

describe("runRepoCheck, ceilings and second-round failures", () => {
  test("the combined requests have their own ceiling (NEED_FILES_MAX_BYTES)", async () => {
    const big = "x".repeat(Math.floor(NEED_FILES_MAX_BYTES * 0.6));
    await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: ["components/A.tsx", "components/B.tsx"],
        },
        { outcome: "nao_decidiu", observed: "ok" },
      ],
      async (prompts, llm) => {
        await repoCheckWith(llm, async () => big);
        expect(prompts[1]?.user).toContain("### components/A.tsx");
        expect(prompts[1]?.user).not.toContain("### components/B.tsx");
        expect(prompts[1]?.user).toContain("components/B.tsx (grande demais)");
      },
    );
    expect(NEED_FILES_MAX_BYTES).toBe(120_000);
  });

  test("under 180 s to the deadline: the first answer stands", async () => {
    const reads: string[] = [];
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: ["hooks/useCart.ts"],
        },
        {
          outcome: "confirma",
          observed: "x",
          source_ref: "hooks/useCart.ts:1",
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(
          llm,
          async (p) => {
            reads.push(p);
            return "x";
          },
          () => 179_000,
        );
        expect(prompts.length).toBe(1);
        return out;
      },
    );
    expect(reads).toEqual([]);
    expect(r.run.outcome).toBe("nao_decidiu");
    expect(r.run.observed).toContain("sem tempo pra ler hooks/useCart.ts");
  });

  test("a failing second round: the first answer stands, not nao_testou", async () => {
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta o hook",
          need_files: ["hooks/useCart.ts"],
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(llm, async () => "export {}");
        expect(prompts.length).toBe(2);
        return out;
      },
    );
    expect(r.run.outcome).toBe("nao_decidiu");
    expect(r.run.observed).toContain("falta o hook");
    expect(r.run.observed).toContain("a segunda volta falhou");
  });

  test("no model on either round: the error propagates instead of becoming a test outcome", async () => {
    const noModel: Llm = async () => {
      throw new NoAiModelError();
    };
    await expect(repoCheckWith(noModel)).rejects.toBeInstanceOf(NoAiModelError);
    let calls = 0;
    const secondFails: Llm = async () => {
      calls += 1;
      if (calls > 1) throw new NoAiModelError();
      return JSON.stringify({
        outcome: "nao_decidiu",
        observed: "falta",
        need_files: ["hooks/useCart.ts"],
      });
    };
    await expect(
      repoCheckWith(secondFails, async () => "export {}"),
    ).rejects.toBeInstanceOf(NoAiModelError);
  });
});

describe("runRepoCheck, files requested on demand", () => {
  test("a served and cited request becomes confirma", async () => {
    const reads: string[] = [];
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: ["src/components/ClosedPopup.tsx"],
        },
        {
          outcome: "confirma",
          observed: "o popup fecha sozinho",
          source_ref: "components/ClosedPopup.tsx:1",
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(llm, async (p) => {
          reads.push(p);
          return p === "components/ClosedPopup.tsx"
            ? "export const X = 1;"
            : null;
        });
        expect(prompts.length).toBe(2);
        expect(prompts[0]?.system).toContain("need_files");
        expect(prompts[1]?.user).toContain("### components/ClosedPopup.tsx");
        expect(prompts[1]?.system).not.toContain('"need_files"');
        return out;
      },
    );
    expect(reads).toEqual(["components/ClosedPopup.tsx"]);
    expect(r.run.outcome).toBe("confirma");
    expect(r.run.source_ref).toBe("components/ClosedPopup.tsx:1");
  });

  test("a request with .., an absolute path or an unlisted extension is ignored", async () => {
    const reads: string[] = [];
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: [
            "../segredo.ts",
            "/etc/passwd.json",
            "a/../../b.ts",
            "img/logo.png",
          ],
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(llm, async (p) => {
          reads.push(p);
          return "x";
        });
        expect(prompts.length).toBe(1);
        return out;
      },
    );
    expect(reads).toEqual([]);
    expect(r.run.outcome).toBe("nao_decidiu");
  });

  test("at most 6 per request, without rereading what the snapshot has", async () => {
    const reads: string[] = [];
    const asked = [
      "sections/Product/ProductDetails.tsx",
      ...Array.from({ length: 8 }, (_, i) => `components/f${i}.tsx`),
    ];
    await withLlm(
      [
        { outcome: "nao_decidiu", observed: "falta", need_files: asked },
        { outcome: "nao_decidiu", observed: "ainda não" },
      ],
      (_, llm) =>
        repoCheckWith(llm, async (p) => {
          reads.push(p);
          return "x";
        }),
    );
    expect(reads).toEqual(
      Array.from({ length: 6 }, (_, i) => `components/f${i}.tsx`),
    );
  });

  test("the second round cannot request more", async () => {
    const reads: string[] = [];
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: ["hooks/useCart.ts"],
        },
        {
          outcome: "nao_decidiu",
          observed: "falta mais",
          need_files: ["hooks/useOther.ts"],
        },
        {
          outcome: "confirma",
          observed: "não devia chegar aqui",
          source_ref: "hooks/useOther.ts:1",
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(llm, async (p) => {
          reads.push(p);
          return "export {}";
        });
        expect(prompts.length).toBe(2);
        return out;
      },
    );
    expect(reads).toEqual(["hooks/useCart.ts"]);
    expect(r.run.outcome).toBe("nao_decidiu");
  });

  test("a missing (or failing) file does not break and the model is told", async () => {
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: ["components/Header.tsx", "components/Boom.tsx"],
        },
        { outcome: "nao_decidiu", observed: "sem o arquivo não dá" },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(llm, async (p) => {
          if (p === "components/Boom.tsx") throw new Error("HTTP 500");
          return null;
        });
        expect(prompts.length).toBe(2);
        expect(prompts[1]?.user).toContain(
          "components/Header.tsx (não existe)",
        );
        expect(prompts[1]?.user).toContain("components/Boom.tsx (não abriu");
        return out;
      },
    );
    expect(r.run.outcome).toBe("nao_decidiu");
  });

  test("without a reader: one call, and the usual prompt (no need_files)", async () => {
    await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "o",
          need_files: ["hooks/useCart.ts"],
        },
      ],
      async (prompts, llm) => {
        const r = await repoCheckWith(llm, undefined);
        expect(prompts.length).toBe(1);
        expect(prompts[0]?.system).not.toContain("need_files");
        expect(r.run.outcome).toBe("nao_decidiu");
      },
    );
  });

  test("the model gets the verification tier and onUsage", async () => {
    const seen: Array<{ tier: string; onUsage: boolean }> = [];
    const onUsage = () => {};
    await runRepoCheck({
      llm: async (request, usage) => {
        seen.push({ tier: request.tier, onUsage: usage === onUsage });
        return JSON.stringify({ outcome: "nao_decidiu", observed: "o" });
      },
      snapshot: snap,
      check,
      hypothesis: { title: "t", why: "w" } as UxHypothesis,
      ctx,
      onUsage,
    });
    expect(seen).toEqual([{ tier: "smart", onUsage: true }]);
  });
});

describe("snapshotRepo, slots", () => {
  test("a file imported by two sections takes one slot", async () => {
    const reads: string[] = [];
    const fs: Record<string, string> = {
      "sections/A.tsx": 'import c from "~/components/C";',
      "sections/B.tsx": 'import c from "../components/C.tsx";',
      "components/C.tsx": "export {}",
    };
    const s = await snapshotRepo({
      read: async (p) => {
        reads.push(p);
        return fs[p] ?? null;
      },
      repo: "r",
      sections: ["A", "B", "/A.tsx"],
    });
    expect(s.files.map((f) => f.path)).toEqual([
      "sections/A.tsx",
      "sections/B.tsx",
      "components/C.tsx",
    ]);
    expect(reads.filter((p) => p === "components/C.tsx").length).toBe(1);
  });
});

// ── The PDP page block (section order) ──────────────────────────────────────

const PDP_BLOCK = JSON.stringify({
  name: "Product Page",
  path: "/:slug/p",
  sections: [
    { __resolveType: "Header - 01" },
    { __resolveType: "site/sections/Product/ProductDetails.tsx" },
    { __resolveType: "site/sections/Product/ProductShelf.tsx" },
  ],
});

const blockEntry = (name: string) => ({
  name,
  path: `${PAGE_BLOCKS_DIR}/${name}`,
  type: "file",
  size: 1,
});

describe("findPageBlock (outside the PDP)", () => {
  const files: Record<string, string> = {
    ".deco/blocks/pages-home-1.json": JSON.stringify({
      path: "/",
      sections: [],
    }),
    ".deco/blocks/pages-Categoria-2.json": JSON.stringify({
      path: "/produtos/*",
      sections: [],
    }),
    ".deco/blocks/pages-Vestidos-3.json": JSON.stringify({
      path: "/produtos/vestido",
      sections: [],
    }),
    ".deco/blocks/pages-productpage-ce48.json": PDP_BLOCK,
  };
  const list: FsLister = async () =>
    Object.keys(files).map((p) => blockEntry(p.split("/").pop() as string));
  const read: RepoReader = async (path) => files[path] ?? null;

  test("home: the block with path /", async () => {
    const block = await findPageBlock(list, read, { type: "home", route: "/" });
    expect(block?.path).toBe(".deco/blocks/pages-home-1.json");
  });

  test("category: the exact route beats the generic one", async () => {
    const exact = await findPageBlock(list, read, {
      type: "categoria",
      route: "/produtos/vestido",
    });
    expect(exact?.path).toBe(".deco/blocks/pages-Vestidos-3.json");
    const generic = await findPageBlock(list, read, {
      type: "categoria",
      route: "/produtos/blusa",
    });
    expect(generic?.path).toBe(".deco/blocks/pages-Categoria-2.json");
  });

  test("checkout has no block; without a page it is the PDP", async () => {
    expect(
      await findPageBlock(list, read, {
        type: "carrinho_checkout",
        route: null,
      }),
    ).toBeNull();
    expect((await findPageBlock(list, read))?.path).toBe(
      ".deco/blocks/pages-productpage-ce48.json",
    );
  });
});

describe("findPdpPageBlock", () => {
  test("pages-productpage* comes first", async () => {
    const reads: string[] = [];
    const block = await findPdpPageBlock(
      async (dir) =>
        dir === PAGE_BLOCKS_DIR
          ? [
              blockEntry("pages-Natal%2520Produtos-1.json"),
              blockEntry("pages-productpage-ce48.json"),
              blockEntry("Header.json"),
            ]
          : [],
      async (path) => {
        reads.push(path);
        return path.endsWith("productpage-ce48.json") ? PDP_BLOCK : null;
      },
    );
    expect(block?.path).toBe(".deco/blocks/pages-productpage-ce48.json");
    expect(reads).toEqual([".deco/blocks/pages-productpage-ce48.json"]);
  });

  test("no productpage: the pages-* with product in the name and a /p path", async () => {
    const files: Record<string, string> = {
      ".deco/blocks/pages-Bazar%2520Produtos-4.json": JSON.stringify({
        path: "/sale/validacao",
      }),
      ".deco/blocks/pages-pdp-nova-9.json": PDP_BLOCK,
    };
    const block = await findPdpPageBlock(
      async () => [
        blockEntry("pages-Bazar%2520Produtos-4.json"),
        blockEntry("pages-pdp-nova-9.json"),
        blockEntry("pages-home-1.json"),
      ],
      async (path) => files[path] ?? null,
    );
    expect(block?.path).toBe(".deco/blocks/pages-pdp-nova-9.json");
    expect(block?.reads).toBe(2);
  });

  test("reads at most 3 candidates", async () => {
    let reads = 0;
    const block = await findPdpPageBlock(
      async () =>
        ["a", "b", "c", "d"].map((x) => blockEntry(`pages-produto-${x}.json`)),
      async () => {
        reads++;
        return JSON.stringify({ path: "/colecao" });
      },
    );
    expect(block).toBeNull();
    expect(reads).toBe(3);
  });

  test("broken JSON does not break it; no folder is null", async () => {
    expect(
      await findPdpPageBlock(
        async () => [blockEntry("pages-productpage-1.json")],
        async () => "{ não é json",
      ),
    ).toBeNull();
    expect(
      await findPdpPageBlock(
        async () => [],
        async () => PDP_BLOCK,
      ),
    ).toBeNull();
  });
});

describe("snapshotRepo with the page block", () => {
  const files: Record<string, string> = {
    ".deco/blocks/pages-productpage-1.json": PDP_BLOCK,
    "sections/Product/ProductDetails.tsx": "export default 1",
  };
  const read: RepoReader = async (p) => files[p] ?? null;

  test("goes first and sets page_block", async () => {
    const s = await snapshotRepo({
      read,
      list: async () => [blockEntry("pages-productpage-1.json")],
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.files.map((f) => f.path)).toEqual([
      ".deco/blocks/pages-productpage-1.json",
      "sections/Product/ProductDetails.tsx",
    ]);
    expect(s.page_block).toBe(".deco/blocks/pages-productpage-1.json");
  });

  test("counts toward the byte ceiling", async () => {
    const compact = compactPageBlock(JSON.parse(PDP_BLOCK));
    const big = "x".repeat(SNAPSHOT_MAX_BYTES - compact.length + 1);
    const s = await snapshotRepo({
      read: async (p) =>
        p.endsWith(".json") ? PDP_BLOCK : p.endsWith(".tsx") ? big : null,
      list: async () => [blockEntry("pages-productpage-1.json")],
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.page_block).toBeDefined();
    expect(s.files.map((f) => f.path)).toEqual([
      ".deco/blocks/pages-productpage-1.json",
    ]);
  });

  test("a failing listing does not drop the sections", async () => {
    const s = await snapshotRepo({
      read,
      list: async () => {
        throw new Error("HTTP 500");
      },
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.files.map((f) => f.path)).toEqual([
      "sections/Product/ProductDetails.tsx",
    ]);
    expect(s.page_block).toBeUndefined();
  });

  test("a failing listing does not become the snapshot's error", async () => {
    // Without sections the snapshot comes back empty (storeRepoSnapshot decides): a failed listing does not throw.
    const s = await snapshotRepo({
      read: async () => null,
      list: async () => {
        throw new Error("HTTP 500");
      },
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.files).toEqual([]);
  });

  test("a 1 MB raw block goes in compacted", async () => {
    const huge = JSON.stringify({
      path: "/:slug/p",
      sections: [
        {
          __resolveType: "site/sections/Product/BannerPDP.tsx",
          banners: [{ alt: "x".repeat(1_000_000) }],
        },
        {
          __resolveType: "website/sections/Rendering/Lazy.tsx",
          section: { __resolveType: "Complete Seu Look" },
        },
      ],
    });
    const s = await snapshotRepo({
      read: async (p) =>
        p.endsWith(".json")
          ? huge
          : p.endsWith(".tsx")
            ? "export default 1"
            : null,
      list: async () => [blockEntry("pages-productpage-1.json")],
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.page_block).toBe(".deco/blocks/pages-productpage-1.json");
    expect(s.files[0]?.text.length).toBeLessThan(2_000);
    expect(s.files[0]?.text).toContain("Complete Seu Look");
    // The clicked section, plus the product section the block lists (BannerPDP).
    expect(s.files.map((f) => f.path)).toEqual([
      ".deco/blocks/pages-productpage-1.json",
      "sections/Product/ProductDetails.tsx",
      "sections/Product/BannerPDP.tsx",
    ]);
  });

  test("without a lister: unchanged", async () => {
    const s = await snapshotRepo({
      read,
      repo: "acme/loja-exemplo",
      sections: ["Product/ProductDetails"],
    });
    expect(s.page_block).toBeUndefined();
    expect(s.files).toHaveLength(1);
  });
});

describe("code test prompt with the page block", () => {
  test("names the block file and says the order is in it", async () => {
    const withBlock: RepoSnapshot = {
      ...snap,
      files: [
        { path: ".deco/blocks/pages-productpage-1.json", text: PDP_BLOCK },
        ...snap.files,
      ],
      page_block: ".deco/blocks/pages-productpage-1.json",
    };
    await withLlm(
      [{ outcome: "nao_decidiu", observed: "x" }],
      async (prompts, llm) => {
        await runRepoCheck({
          llm,
          snapshot: withBlock,
          check,
          hypothesis: { title: "t", why: "w" } as UxHypothesis,
          ctx,
          onUsage: () => {},
        });
        expect(prompts[0]?.user).toContain(
          "O arquivo .deco/blocks/pages-productpage-1.json é o bloco da página analisada",
        );
        expect(prompts[0]?.user).toContain("COMPACTADO");
        expect(prompts[0]?.user).toContain("ordem dessa lista");
        expect(prompts[0]?.user).toContain(
          "### .deco/blocks/pages-productpage-1.json\n```json",
        );
      },
    );
  });

  test("without a block, no note", () => {
    expect(pageBlockNote(snap)).toBe("");
  });

  test("the cited block decides (it is in the snapshot)", () => {
    const withBlock: RepoSnapshot = {
      ...snap,
      files: [{ path: ".deco/blocks/pages-productpage-1.json", text: "{}" }],
      page_block: ".deco/blocks/pages-productpage-1.json",
    };
    const { run } = parseRepoAnswer(
      JSON.stringify({
        outcome: "confirma",
        observed: "a vitrine é a 5ª seção",
        source_ref: ".deco/blocks/pages-productpage-1.json:1",
      }),
      withBlock,
      check,
      ctx,
    );
    expect(run.outcome).toBe("confirma");
  });

  test("loadRepoSnapshot accepts page_block and rejects a wrong type", async () => {
    const { media } = memoryMedia({
      ok: JSON.stringify({ ...snap, page_block: "a.json" }),
      wrong: JSON.stringify({ ...snap, page_block: 3 }),
    });
    const ok = await loadRepoSnapshot(media, "ok");
    expect(ok?.page_block).toBe("a.json");
    expect(await loadRepoSnapshot(media, "wrong")).toBeNull();
  });
});

describe("compactPageBlock", () => {
  test("order, multivariate flags and Lazy, without the props", () => {
    const out = JSON.parse(
      compactPageBlock({
        path: "/:slug/p",
        sections: [
          { __resolveType: "Header - 01" },
          {
            __resolveType: "website/flags/multivariate/section.ts",
            variants: [
              {
                rule: { __resolveType: "Buy Now Button V2 0,5" },
                value: {
                  __resolveType: "site/sections/Product/ProductDetails.tsx",
                  page: { __resolveType: "PDP Loader" },
                  extraInformations: { bonus: "x".repeat(5000) },
                },
              },
            ],
          },
          {
            __resolveType: "website/sections/Rendering/Lazy.tsx",
            section: {
              __resolveType: "site/sections/Product/ProductShelf.tsx",
              title: "Quem comprou também curtiu",
            },
          },
        ],
      }),
    );
    expect(out).toEqual({
      path: "/:slug/p",
      sections: [
        { section: "Header - 01" },
        {
          section: "website/flags/multivariate/section.ts",
          variants: [
            {
              rule: "Buy Now Button V2 0,5",
              sections: [
                { section: "site/sections/Product/ProductDetails.tsx" },
              ],
            },
          ],
        },
        {
          section: "website/sections/Rendering/Lazy.tsx",
          sections: [
            {
              section: "site/sections/Product/ProductShelf.tsx",
              title: "Quem comprou também curtiu",
            },
          ],
        },
      ],
    });
  });

  test("over the ceiling: cuts the last sections and marks truncated", () => {
    const sections = Array.from({ length: 2000 }, (_, i) => ({
      __resolveType: `site/sections/Bloco${i}-${"x".repeat(40)}.tsx`,
    }));
    const text = compactPageBlock({ path: "/:slug/p", sections });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      PAGE_BLOCK_MAX_BYTES,
    );
    const out = JSON.parse(text);
    expect(out.truncated).toBe(true);
    expect(out.sections[0].section).toContain("Bloco0-");
  });
});

describe("compactPageBlock, sections as an object (loose multivariate flag)", () => {
  // The whole page is ONE multivariate flag, and the PDP lives in a wrapper's `children`.
  const LOOSE_FLAG_SHAPE = {
    path: "/:slug/p",
    sections: {
      __resolveType: "website/flags/multivariate.ts",
      SEO: { __resolveType: "SEO PDP" },
      variants: [
        {
          rule: { __resolveType: "Mobile" },
          value: [
            {
              __resolveType: "site/sections/Product/NotFoundChallenge.tsx",
              page: { __resolveType: "PDP Loader" },
              children: [
                {
                  __resolveType: "site/sections/Product/ProductDetails.tsx",
                  page: { __resolveType: "PDP Loader" },
                },
                {
                  __resolveType: "website/sections/Rendering/Lazy.tsx",
                  section: {
                    __resolveType: "site/sections/Product/ProductShelf.tsx",
                    title: "Você também pode gostar",
                    products: { __resolveType: "Loader" },
                  },
                },
              ],
            },
          ],
        },
        {
          rule: { __resolveType: "website/matchers/always.ts" },
          value: [
            {
              __resolveType: "site/sections/Product/BrandWrapper.tsx",
              brandSections: [{ __resolveType: "Header Global " }],
            },
          ],
        },
      ],
    },
  };

  test("the flag becomes the only section, with its variants and what they wrap", () => {
    const out = JSON.parse(compactPageBlock(LOOSE_FLAG_SHAPE));
    expect(out.sections).toHaveLength(1);
    const flag = out.sections[0];
    expect(flag.section).toBe("website/flags/multivariate.ts");
    expect(flag.variants.map((v: { rule: string }) => v.rule)).toEqual([
      "Mobile",
      "website/matchers/always.ts",
    ]);
    expect(flag.variants[0].sections[0].slots.children).toEqual([
      { section: "site/sections/Product/ProductDetails.tsx" },
      {
        section: "website/sections/Rendering/Lazy.tsx",
        sections: [
          {
            section: "site/sections/Product/ProductShelf.tsx",
            title: "Você também pode gostar",
          },
        ],
      },
    ]);
    expect(flag.variants[1].sections[0].slots.brandSections).toEqual([
      { section: "Header Global " },
    ]);
    // A loader (loose object) is not a section list.
    expect(JSON.stringify(out)).not.toContain("PDP Loader");
  });

  test("a variant value as an object also becomes a list", () => {
    const out = JSON.parse(
      compactPageBlock({
        path: "/:slug/p",
        sections: {
          __resolveType: "website/flags/multivariate.ts",
          variants: [
            {
              rule: { __resolveType: "website/matchers/always.ts" },
              value: { __resolveType: "site/sections/Product/PDP.tsx" },
            },
          ],
        },
      }),
    );
    expect(out.sections[0].variants[0].sections).toEqual([
      { section: "site/sections/Product/PDP.tsx" },
    ]);
  });

  test("one giant flag: cuts inside, keeps the flag", () => {
    const lazy = (i: number) => ({
      __resolveType: "website/sections/Rendering/Lazy.tsx",
      section: {
        __resolveType: `site/sections/Shelf${i}-${"x".repeat(60)}.tsx`,
      },
    });
    const variant = (rule: string) => ({
      rule: { __resolveType: rule },
      value: Array.from({ length: 600 }, (_, i) => lazy(i)),
    });
    const text = compactPageBlock({
      path: "/:slug/p",
      sections: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [variant("Mobile"), variant("website/matchers/always.ts")],
      },
    });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      PAGE_BLOCK_MAX_BYTES,
    );
    const out = JSON.parse(text);
    expect(out.truncated).toBe(true);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].section).toBe("website/flags/multivariate.ts");
    expect(out.sections[0].variants).toHaveLength(2);
    // The deepest goes first: what the Lazy wraps, last to first.
    const first = out.sections[0].variants[0].sections;
    expect(first.length).toBeGreaterThan(0);
    expect(first[0].section).toBe("website/sections/Rendering/Lazy.tsx");
    // Cuts no more than needed: it ends near the ceiling.
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(
      PAGE_BLOCK_MAX_BYTES * 0.8,
    );
  });
});

// The model copies extensionless imports ("components/x/Y"); those requests must still resolve.
describe("need_files without an extension", () => {
  const reader =
    (exists: Record<string, string>, reads: string[] = []): RepoReader =>
    async (p) => {
      reads.push(p);
      return exists[p] ?? null;
    };

  test("neededPaths accepts no extension and still rejects assets", () => {
    expect(
      neededPaths(
        [
          "components/product/ProductVariantSelector",
          "~/components/newsletter-popup/ButtonClosePopup",
          "src/hooks/useCart",
          "img/logo.png",
          "../../components/x/Y",
        ],
        new Set(),
      ),
    ).toEqual([
      "components/product/ProductVariantSelector",
      "components/newsletter-popup/ButtonClosePopup",
      "hooks/useCart",
    ]);
  });

  test("no extension, already in the snapshot as .tsx: takes no slot", () => {
    expect(
      neededPaths(["components/A"], new Set(["components/A.tsx"])),
    ).toEqual([]);
  });

  test("resolves .tsx", async () => {
    const reads: string[] = [];
    const r = await readNeededFiles(
      reader({ "components/A.tsx": "a" }, reads),
      ["components/A"],
    );
    expect(r.files).toEqual([{ path: "components/A.tsx", text: "a" }]);
    expect(r.missed).toEqual([]);
  });

  test("resolves /index.tsx, and .ts comes before /index", async () => {
    const r = await readNeededFiles(
      reader({ "components/B/index.tsx": "b", "hooks/c.ts": "c" }),
      ["components/B", "hooks/c"],
    );
    expect(r.files.map((f) => f.path)).toEqual([
      "components/B/index.tsx",
      "hooks/c.ts",
    ]);
  });

  test("with an extension: the path as given first, alone", async () => {
    const reads: string[] = [];
    const r = await readNeededFiles(
      reader({ "components/A.tsx": "a" }, reads),
      ["components/A.tsx"],
    );
    expect(reads).toEqual(["components/A.tsx"]);
    expect(r.files.map((f) => f.path)).toEqual(["components/A.tsx"]);
  });

  test("wrong extension (.ts requested, .tsx in the repo) still resolves", async () => {
    const r = await readNeededFiles(reader({ "components/A.tsx": "a" }), [
      "components/A.ts",
    ]);
    expect(r.files.map((f) => f.path)).toEqual(["components/A.tsx"]);
  });

  test("no candidate opens: missing, and the error beats the 404", async () => {
    const r = await readNeededFiles(
      async (p) => {
        if (p === "components/Boom.tsx") throw new Error("HTTP 500");
        return null;
      },
      ["components/Nada", "components/Boom"],
    );
    expect(r.files).toEqual([]);
    expect(r.missed).toEqual([
      "components/Nada (não existe)",
      "components/Boom (não abriu: HTTP 500)",
    ]);
    expect(r.missedPaths).toEqual(["components/Nada", "components/Boom"]);
  });

  test("X and X.tsx in one request go in once", async () => {
    const r = await readNeededFiles(reader({ "components/A.tsx": "a" }), [
      "components/A",
      "components/A.tsx",
    ]);
    expect(r.files.length).toBe(1);
  });

  test("requests with ~/ and src/ without an extension, end to end", async () => {
    const reads: string[] = [];
    const r = await withLlm(
      [
        {
          outcome: "nao_decidiu",
          observed: "falta",
          need_files: [
            "~/components/newsletter-popup/ButtonClosePopup",
            "src/components/product/ProductVariantSelector",
            "components/Sumido",
          ],
        },
        {
          outcome: "confirma",
          observed: "abre no primeiro gesto",
          source_ref: "components/newsletter-popup/ButtonClosePopup.tsx:1",
        },
      ],
      async (prompts, llm) => {
        const out = await repoCheckWith(
          llm,
          reader(
            {
              "components/newsletter-popup/ButtonClosePopup.tsx": "x",
              "components/product/ProductVariantSelector/index.tsx": "y",
            },
            reads,
          ),
        );
        expect(prompts.length).toBe(2);
        expect(prompts[1]?.user).toContain(
          "### components/newsletter-popup/ButtonClosePopup.tsx",
        );
        expect(prompts[1]?.user).toContain(
          "### components/product/ProductVariantSelector/index.tsx",
        );
        return out;
      },
    );
    expect(r.run.outcome).toBe("confirma");
    expect(r.run.observed).toContain(
      "(li também: components/newsletter-popup/ButtonClosePopup.tsx, components/product/ProductVariantSelector/index.tsx)",
    );
    expect(r.run.observed).toContain("(não abriu: components/Sumido)");
  });

  test("without a request, observed is unchanged", async () => {
    const r = await withLlm(
      [{ outcome: "nao_decidiu", observed: "nada a pedir" }],
      (_, llm) => repoCheckWith(llm, async () => null),
    );
    expect(r.run.observed).toBe("nada a pedir");
  });
});

describe("imports outside the snapshot", () => {
  const snapWith = (files: RepoSnapshot["files"]): RepoSnapshot => ({
    repo: "acme/loja-exemplo",
    synced_at: "t",
    files,
  });

  test("resolves relative and ~/, drops what is present, no duplicate extension", () => {
    const list = missingImports(
      snapWith([
        {
          path: "sections/Product/ProductDetails.tsx",
          text: `import A from "../../components/product/ProductVariantSelector";
import B from "~/components/newsletter-popup/ButtonClosePopup";
import C from "~/components/ui/Here.tsx";
import D from "../../components/ui/Present";
import "preact";
import s from "./x.css";`,
        },
        { path: "components/ui/Present.tsx", text: "export {}" },
        {
          path: ".deco/blocks/pages-productpage.json",
          text: '{"from": "./x"}',
        },
      ]),
    );
    expect(list).toEqual([
      "components/product/ProductVariantSelector",
      "components/newsletter-popup/ButtonClosePopup",
      "components/ui/Here.tsx",
    ]);
  });

  test("respects the ceiling", () => {
    const text = Array.from(
      { length: MISSING_IMPORTS_MAX + 10 },
      (_, i) => `import X${i} from "~/components/c${i}";`,
    ).join("\n");
    const list = missingImports(snapWith([{ path: "sections/S.tsx", text }]));
    expect(list.length).toBe(MISSING_IMPORTS_MAX);
    expect(MISSING_IMPORTS_MAX).toBe(40);
  });

  test("only in the first-round prompt, and only with the repo at hand", async () => {
    const withImport: RepoSnapshot = {
      ...snap,
      files: [
        {
          path: "sections/Product/ProductDetails.tsx",
          text: 'import A from "~/components/A";',
        },
      ],
    };
    const run = (llm: Llm, read?: RepoReader) =>
      runRepoCheck({
        llm,
        snapshot: withImport,
        check,
        hypothesis: { title: "t", why: "w" } as UxHypothesis,
        ctx,
        onUsage: () => {},
        read,
      });
    await withLlm(
      [
        { outcome: "nao_decidiu", observed: "o", need_files: ["components/A"] },
        { outcome: "nao_decidiu", observed: "o" },
      ],
      async (prompts, llm) => {
        await run(llm, async () => "x");
        expect(prompts[0]?.user).toContain(
          "## Importados pelos arquivos acima que não estão aqui",
        );
        expect(prompts[0]?.user).toContain("- components/A");
        expect(prompts[1]?.user).not.toContain("## Importados pelos");
      },
    );
    await withLlm(
      [{ outcome: "nao_decidiu", observed: "o" }],
      async (prompts, llm) => {
        await run(llm, undefined);
        expect(prompts[0]?.user).not.toContain("## Importados pelos");
      },
    );
  });
});

describe("need_files and imports, review", () => {
  test("candidates one at a time: never more than 6 concurrent reads", async () => {
    let inFlight = 0;
    let peak = 0;
    const reads: string[] = [];
    await readNeededFiles(
      async (p) => {
        reads.push(p);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return null;
      },
      Array.from({ length: 6 }, (_, i) => `components/C${i}`),
    );
    expect(reads.length).toBe(24);
    expect(peak).toBeLessThanOrEqual(6);
  });

  test("stops at the first that opens", async () => {
    const reads: string[] = [];
    await readNeededFiles(
      async (p) => {
        reads.push(p);
        return p === "components/A.ts" ? "a" : null;
      },
      ["components/A"],
    );
    expect(reads).toEqual(["components/A.tsx", "components/A.ts"]);
  });

  test("a dotted name (Product.Gallery) is a component, not an extension", () => {
    expect(
      neededPaths(
        ["components/product/Product.Gallery", "components/x/logo.svg"],
        new Set(),
      ),
    ).toEqual(["components/product/Product.Gallery"]);
    const list = missingImports({
      repo: "acme/loja-exemplo",
      synced_at: "t",
      files: [
        {
          path: "sections/S.tsx",
          text: 'import G from "~/components/product/Product.Gallery";\nimport "./s.css";',
        },
      ],
    });
    expect(list).toEqual(["components/product/Product.Gallery"]);
  });

  test("X/index.ts in the snapshot counts as present", () => {
    const list = missingImports({
      repo: "acme/loja-exemplo",
      synced_at: "t",
      files: [
        { path: "sections/S.tsx", text: 'import U from "~/sdk/useCart";' },
        { path: "sdk/useCart/index.ts", text: "export {}" },
      ],
    });
    expect(list).toEqual([]);
  });

  test("an import with spaces or a huge path stays off the list", () => {
    const long = `components/${"a".repeat(220)}`;
    const list = missingImports({
      repo: "acme/loja-exemplo",
      synced_at: "t",
      files: [
        {
          path: "sections/S.tsx",
          text: `import A from "~/components/com espaço";\nimport B from "~/${long}";\nimport C from "~/components/Ok";`,
        },
      ],
    });
    expect(list).toEqual(["components/Ok"]);
  });
});

// The clicked section may be a wrapper; the product section comes from the CMS.
describe("pdpSectionsOfPageBlock", () => {
  test("takes the compacted block's product sections, in order, without repeats", () => {
    const block = JSON.stringify({
      path: "/:slug/p",
      sections: [
        { section: "site/sections/Header/Header.tsx" },
        {
          section: "website/flags/multivariate.ts",
          variants: [
            {
              rule: "Mobile",
              sections: [
                {
                  section: "site/sections/Product/NotFoundChallenge.tsx",
                  slots: {
                    children: [
                      { section: "site/sections/Product/ProductDetails.tsx" },
                      { section: "site/sections/Product/ProductShelf.tsx" },
                    ],
                  },
                },
              ],
            },
            {
              rule: "always",
              sections: [
                { section: "site/sections/Product/ProductDetails.tsx" },
              ],
            },
          ],
        },
        { section: "Footer - 04" },
      ],
    });
    expect(pdpSectionsOfPageBlock(block)).toEqual([
      "sections/Product/NotFoundChallenge.tsx",
      "sections/Product/ProductDetails.tsx",
      "sections/Product/ProductShelf.tsx",
    ]);
  });
});

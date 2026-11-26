import { describe, expect, test } from "bun:test";
import {
  chooseThemeBlock,
  cssVariablesOf,
  extractCodeTokens,
  pickThemePaths,
  themePropsOf,
} from "./code-tokens.ts";
import {
  type Llm,
  type LlmRequest,
  NoAiModelError,
  type RepoEntry,
} from "./ports.ts";

const entry = (path: string, size = 1000, type = "file"): RepoEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type,
  size,
});

describe("pickThemePaths (loja deco com Tailwind 3 na raiz)", () => {
  const root = [
    entry("tailwind.config.ts", 5435),
    entry("tailwind.css", 85_334),
    entry("deno.json"),
    entry(".deco", 0, "dir"),
    entry("sections", 0, "dir"),
    entry("static", 0, "dir"),
  ];
  const dirs = new Set([".deco", "sections", "static"]);

  test("lê config, CSS de entrada, site.json e a section de Theme", () => {
    expect(pickThemePaths(root, dirs)).toEqual([
      "tailwind.config.ts",
      "tailwind.css",
      ".deco/blocks/site.json",
      "sections/Theme/Theme.tsx",
    ]);
  });

  test("deixa de fora o CSS gerado em static/ e arquivo grande demais", () => {
    const paths = pickThemePaths(
      [
        ...root,
        entry("static/tailwind.css", 428_321),
        entry("huge.css", 400_000),
      ],
      dirs,
    );
    expect(paths).not.toContain("static/tailwind.css");
    expect(paths).not.toContain("huge.css");
  });

  test("tanstack: CSS em src/styles e Theme em src/sections", () => {
    expect(
      pickThemePaths(
        [entry("src", 0, "dir"), entry("src/styles/app.css", 123_704)],
        new Set(["src"]),
      ),
    ).toEqual(["src/styles/app.css", "src/sections/Theme/Theme.tsx"]);
  });
});

describe("pickThemePaths (TanStack com o código na raiz)", () => {
  const root = [
    entry("router.tsx", 3835),
    entry(".deco", 0, "dir"),
    entry("sections", 0, "dir"),
    entry("styles", 0, "dir"),
    entry("components", 0, "dir"),
  ];
  const dirs = new Set([".deco", "sections", "styles", "components"]);

  test("CSS em styles/, o bloco de tema e a section de Theme", () => {
    expect(
      pickThemePaths(
        [
          ...root,
          entry("styles/app.css", 23_051),
          entry(".deco/blocks/Banner Global.json", 81),
          entry(".deco/blocks/Fashion theme.json", 1390),
          entry(".deco/blocks/Preview site", 0, "dir"),
        ],
        dirs,
      ),
    ).toEqual([
      "styles/app.css",
      ".deco/blocks/Fashion theme.json",
      "sections/Theme/Theme.tsx",
    ]);
  });

  test("o tema da loja vem antes do Fashion theme do template", () => {
    expect(
      pickThemePaths(
        [
          ...root,
          entry("styles/app.css", 123_704),
          entry(".deco/blocks/Fashion theme.json", 1195),
          entry(".deco/blocks/Loja Theme.json", 1015),
          entry(".deco/blocks/Header.json", 900),
        ],
        dirs,
      ),
    ).toEqual([
      "styles/app.css",
      ".deco/blocks/Loja Theme.json",
      ".deco/blocks/Fashion theme.json",
      "sections/Theme/Theme.tsx",
    ]);
  });

  test("site.json listado entra", () => {
    const paths = pickThemePaths(
      [...root, entry(".deco/blocks/site.json", 5000)],
      dirs,
    );
    expect(paths).toContain(".deco/blocks/site.json");
  });
});

describe("cssVariablesOf", () => {
  test("pega as declarações, sem comentário e sem repetir", () => {
    expect(
      cssVariablesOf(`:root {
  /* --ignorada: 1px; */
  --header-mobile-height: 80px;
  --alert-height: 40px;
  --header-desktop-height-alert: calc(
    var(--header-desktop-height) + var(--alert-height)
  );
}
.x { --alert-height: 99px; }`),
    ).toEqual({
      "--header-mobile-height": "80px",
      "--alert-height": "40px",
      "--header-desktop-height-alert":
        "calc( var(--header-desktop-height) + var(--alert-height) )",
    });
  });
});

describe("themePropsOf", () => {
  test("achata as props da section de Theme do site.json", () => {
    const site = JSON.stringify({
      global: [
        {
          __resolveType: "site/sections/Theme/Theme.tsx",
          mainColors: { primary: "#333333", "base-100": "#ffffff" },
          buttonStyle: { "--rounded-btn": "2rem" },
          mode: "dark",
        },
        { __resolveType: "site/sections/Theme/Fonts.tsx" },
      ],
    });
    expect(themePropsOf(site)).toEqual({
      "mainColors.primary": "#333333",
      "mainColors.base-100": "#ffffff",
      "buttonStyle.--rounded-btn": "2rem",
    });
  });

  test("JSON quebrado não lança", () => {
    expect(themePropsOf("{")).toEqual({});
  });
});

describe("chooseThemeBlock", () => {
  const theme = (primary: string) =>
    JSON.stringify({
      __resolveType: "site/sections/Theme/Theme.tsx",
      mainColors: { primary },
    });
  const own = { path: ".deco/blocks/Loja Theme.json", text: theme("#333333") };
  const fashion = {
    path: ".deco/blocks/Fashion theme.json",
    text: theme("#384c53"),
  };

  test("o bloco que outro bloco referencia pelo nome vence", () => {
    const site = {
      path: ".deco/blocks/site.json",
      text: JSON.stringify({ theme: { __resolveType: "Fashion theme" } }),
    };
    expect(chooseThemeBlock([own, fashion, site])).toBe(fashion.path);
  });

  test("site.json com o tema inline: nenhum bloco solto vale", () => {
    const site = {
      path: ".deco/blocks/site.json",
      text: JSON.stringify({ theme: JSON.parse(theme("#333333")) }),
    };
    expect(chooseThemeBlock([site, own, fashion])).toBeNull();
  });

  test("sem referência: o que não é o Fashion theme do template", () => {
    expect(chooseThemeBlock([fashion, own])).toBe(own.path);
  });

  test("só o Fashion theme: ele mesmo", () => {
    expect(chooseThemeBlock([fashion])).toBe(fashion.path);
  });

  test("sem bloco de tema solto (site.json não conta): null", () => {
    expect(
      chooseThemeBlock([{ path: ".deco/blocks/site.json", text: "{}" }]),
    ).toBeNull();
  });
});

describe("extractCodeTokens", () => {
  const listing: Record<string, RepoEntry[]> = {
    "": [
      entry(".deco", 0, "dir"),
      entry("sections", 0, "dir"),
      entry("styles", 0, "dir"),
    ],
    styles: [entry("styles/app.css", 200)],
    ".deco/blocks": [
      entry(".deco/blocks/Fashion theme.json", 100),
      entry(".deco/blocks/Loja Theme.json", 100),
    ],
  };
  const files: Record<string, string> = {
    "styles/app.css": ":root { --alert-height: 40px; }",
    ".deco/blocks/Loja Theme.json": JSON.stringify({
      __resolveType: "site/sections/Theme/Theme.tsx",
      mainColors: { primary: "#333333" },
    }),
    ".deco/blocks/Fashion theme.json": JSON.stringify({
      __resolveType: "site/sections/Theme/Theme.tsx",
      mainColors: { primary: "#384c53", tertiary: "#ffeaaf" },
    }),
  };
  const code = (listed: string[] = []) => ({
    repo: "acme/loja-exemplo",
    list: async (dir: string) => {
      listed.push(dir);
      return listing[dir] ?? [];
    },
    read: async (path: string) => files[path] ?? null,
  });

  test("lista o repo, lê o tema e o commit é a hora da leitura", async () => {
    const listed: string[] = [];
    const down: Llm = async () => {
      throw new Error("modelo fora do ar");
    };
    const tokens = await extractCodeTokens({
      code: code(listed),
      llm: down,
      now: "2026-11-20T12:00:00.000Z",
      onUsage: () => {},
    });
    expect(listed.sort()).toEqual(["", ".deco/blocks", "styles"]);
    expect(tokens.repo).toBe("acme/loja-exemplo");
    expect(tokens.commit).toBe("2026-11-20T12:00:00.000Z");
    // Um tema só: o do template não completa o da loja.
    expect(tokens.files).toEqual([
      "styles/app.css",
      ".deco/blocks/Loja Theme.json",
    ]);
    expect(tokens.css_variables).toEqual({ "--alert-height": "40px" });
    expect(tokens.theme).toEqual({ "mainColors.primary": "#333333" });
    expect(JSON.stringify(tokens)).not.toContain("#ffeaaf");
    // O modelo fora do ar: a parte sem modelo sai mesmo assim.
    expect(tokens.model_error).toBe("modelo fora do ar");
  });

  test("no model: the error propagates instead of becoming model_error", async () => {
    const noModel: Llm = async () => {
      throw new NoAiModelError();
    };
    await expect(
      extractCodeTokens({
        code: code(),
        llm: noModel,
        now: "2026-11-20T12:00:00.000Z",
        onUsage: () => {},
      }),
    ).rejects.toBeInstanceOf(NoAiModelError);
  });

  test("o modelo nomeia: tetos, itens sem nome fora, valores em texto", async () => {
    const calls: LlmRequest[] = [];
    const llm: Llm = async (request) => {
      calls.push(request);
      return `Aqui está:\n\`\`\`json\n${JSON.stringify({
        colors: [
          { name: "primary", value: "#333333", usage: "botão" },
          { value: "#fff" },
          "bg-primary",
          ...Array.from({ length: 25 }, (_, i) => ({ name: `c${i}` })),
        ],
        fonts: [{ name: "font-sans", family: null }],
        radii: [{ name: "--rounded-btn", value: 2 }],
        conventions: "  Tailwind 3 + daisyUI  ",
      })}\n\`\`\``;
    };
    const tokens = await extractCodeTokens({
      code: code(),
      llm,
      now: "t",
      onUsage: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tier).toBe("smart");
    expect(calls[0]?.userPrompt).toContain("acme/loja-exemplo");
    expect(calls[0]?.userPrompt).toContain("### .deco/blocks/Loja Theme.json");
    // Os 20 primeiros, depois os sem nome saem.
    expect(tokens.colors).toHaveLength(18);
    expect(tokens.colors[0]).toEqual({
      name: "primary",
      value: "#333333",
      usage: "botão",
    });
    expect(tokens.colors[1]).toEqual({ name: "c0", value: "", usage: "" });
    expect(tokens.fonts).toEqual([{ name: "font-sans", family: "" }]);
    expect(tokens.radii).toEqual([{ name: "--rounded-btn", value: "2" }]);
    expect(tokens.conventions).toBe("Tailwind 3 + daisyUI");
    expect(tokens.model_error).toBeUndefined();
  });

  test("resposta sem JSON: só a parte sem modelo, sem erro", async () => {
    const tokens = await extractCodeTokens({
      code: code(),
      llm: async () => "não sei",
      now: "t",
      onUsage: () => {},
    });
    expect(tokens.colors).toEqual([]);
    expect(tokens.conventions).toBeNull();
    expect(tokens.model_error).toBeUndefined();
  });

  test("raiz vazia é erro", async () => {
    await expect(
      extractCodeTokens({
        code: {
          repo: "acme/loja-exemplo",
          list: async () => [],
          read: async () => null,
        },
        llm: async () => "{}",
        now: "t",
        onUsage: () => {},
      }),
    ).rejects.toThrow("a raiz do repositório veio vazia");
  });
});

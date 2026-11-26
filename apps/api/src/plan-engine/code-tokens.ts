/**
 * O design system pelo código da loja: o repositório do site ligado à org,
 * lido pelos provedores de git do Studio (verify/code-source.ts).
 *
 * O render (capture.ts) diz o que aparece na tela; o código diz como a loja
 * CHAMA cada coisa — `bg-primary`, `--rounded-btn`, `etc-t2-pure`. É isso que
 * faz o mockup reusar a classe da loja em vez de colar um hex.
 *
 * ## O que se lê (teto fixo de arquivos e bytes)
 *
 *   tailwind.config.*                  cores, fontes e raios nomeados
 *   CSS de entrada (tailwind.css, src/styles/*.css, …)
 *                                      só as declarações `--var: valor`
 *   .deco/blocks/site.json             as props das sections de Theme (cores
 *                                      do daisyUI, raio de botão), sem modelo
 *   .deco/blocks/*theme*.json          o mesmo, no bloco de tema solto
 *   sections/Theme/Theme.tsx           como as props viram variável CSS
 *
 * Os caminhos são os do repo como estão: `src/styles/...` numa loja TanStack,
 * `styles/...` quando o código mora na raiz; as listas abaixo cobrem os dois.
 * As lojas TanStack (Tailwind v4) não têm tailwind.config: o tema vem do CSS e
 * do bloco de tema. A leitura não fixa o commit, então o `commit` vira a hora
 * da leitura.
 */

import { z } from "zod";
import { extractJsonObject } from "./json.ts";
import type {
  FsLister,
  Llm,
  LlmUsage,
  RepoEntry,
  RepoReader,
} from "./ports.ts";
import type { CodeTokens } from "./types.ts";

const MAX_FILE_BYTES = 150_000;
const MAX_PROMPT_CHARS_PER_FILE = 12_000;
const MAX_CSS_VARIABLES = 120;

const TAILWIND_CONFIG = /^tailwind\.config\.(ts|js|mjs|cjs)$/;
const CSS_DIRS = ["styles", "src/styles", "src", "app", "src/app"];
const THEME_SECTIONS = [
  "sections/Theme/Theme.tsx",
  "src/sections/Theme/Theme.tsx",
];
const SITE_BLOCK = ".deco/blocks/site.json";
const BLOCKS_DIR = ".deco/blocks";
/** O nome que o template da deco dá ao tema; o da loja, se houver, vem antes. */
const TEMPLATE_THEME = /^fashion theme\.json$/i;
/** Blocos de tema soltos lidos; um só vale (chooseThemeBlock). */
const MAX_THEME_CANDIDATES = 4;

/** `site.json` ou um bloco de tema solto: os dois viram props de Theme. */
const isThemeBlock = (path: string) =>
  path === SITE_BLOCK || path.startsWith(`${BLOCKS_DIR}/`);

// ── Leitura do repo ──────────────────────────────────────────────────────────

interface RepoFile {
  path: string;
  text: string;
}

/** De onde o tema é lido: o repo do site. */
interface ThemeSource {
  /** Filhos diretos de `dir` ("" = raiz). A raiz falhar é erro. */
  list(dir: string): Promise<RepoEntry[]>;
  /** null = não veio. */
  read(path: string): Promise<string | null>;
  /** Pastas além das de CSS que vale listar, se a primeira parte existir na raiz. */
  extraDirs: string[];
  /** O commit lido; a leitura não o fixa, então é a hora da leitura. */
  commit(): string | null;
}

/** O repo do site; sem commit, vale a hora da leitura. */
function repoThemeSource(
  list: FsLister,
  read: RepoReader,
  readAt: string,
): ThemeSource {
  return {
    extraDirs: [BLOCKS_DIR],
    commit: () => readAt,
    list,
    read,
  };
}

/**
 * Lê do repo o conjunto fixo de arquivos de tema. Um arquivo que não volta só
 * fica de fora; a listagem da raiz falhar (ou vir vazia) é que é erro.
 */
async function readThemeFiles(
  source: ThemeSource,
): Promise<{ commit: string | null; files: RepoFile[]; missed: string[] }> {
  const root = await source.list("");
  if (root.length === 0) throw new Error("a raiz do repositório veio vazia");
  const dirs = new Set(root.filter((e) => e.type === "dir").map((e) => e.path));

  const listed = await Promise.all(
    [...CSS_DIRS, ...source.extraDirs]
      .filter((d) => dirs.has(d.split("/")[0] ?? d))
      .map(async (dir) => {
        try {
          return await source.list(dir);
        } catch {
          return [];
        }
      }),
  );
  const paths = pickThemePaths([...root, ...listed.flat()], dirs);

  const files: RepoFile[] = [];
  const missed: string[] = [];
  await Promise.all(
    paths.map(async (path) => {
      try {
        const text = await source.read(path);
        if (text) files.push({ path, text });
        else missed.push(path);
      } catch {
        missed.push(path);
      }
    }),
  );
  files.sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path));
  // Um tema só: os outros blocos soltos foram lidos pra achar referência.
  const theme = chooseThemeBlock(files);
  return {
    commit: source.commit(),
    files: files.filter((f) => !isLooseThemeBlock(f.path) || f.path === theme),
    missed,
  };
}

/**
 * Quais arquivos ler, dado o que a listagem achou. Fica de fora o CSS gerado
 * (um `static/tailwind.css` de centenas de KB é saída do build, não fonte).
 */
export function pickThemePaths(
  entries: readonly RepoEntry[],
  rootDirs: ReadonlySet<string>,
): string[] {
  const files = entries.filter(
    (e) => e.type === "file" && e.size <= MAX_FILE_BYTES,
  );
  const out: string[] = [];
  const config = files.find(
    (e) => !e.path.includes("/") && TAILWIND_CONFIG.test(e.name),
  );
  if (config) out.push(config.path);
  const css = files
    .filter((e) => e.name.endsWith(".css"))
    .filter((e) => {
      const dir = e.path.includes("/")
        ? e.path.slice(0, e.path.lastIndexOf("/"))
        : "";
      return dir === "" || CSS_DIRS.includes(dir);
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 2);
  out.push(...css.map((e) => e.path));
  if (rootDirs.has(".deco")) {
    // Listado, o site.json só entra se existir; sem listagem de blocos, é pedido às cegas.
    const blocks = files.filter((e) => e.path.startsWith(`${BLOCKS_DIR}/`));
    if (blocks.length === 0 || blocks.some((e) => e.path === SITE_BLOCK)) {
      out.push(SITE_BLOCK);
    }
    // Blocos de tema soltos (TanStack): todos lidos, o do template por último, e no máximo um vale.
    out.push(
      ...blocks
        .filter((e) => e.path !== SITE_BLOCK)
        .filter((e) => e.name.endsWith(".json") && /theme/i.test(e.name))
        .sort(
          (a, b) =>
            Number(TEMPLATE_THEME.test(a.name)) -
              Number(TEMPLATE_THEME.test(b.name)) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, MAX_THEME_CANDIDATES)
        .map((e) => e.path),
    );
  }
  for (const theme of THEME_SECTIONS) {
    if (rootDirs.has(theme.split("/")[0] ?? "")) {
      out.push(theme);
      break;
    }
  }
  return out;
}

/** Bloco de tema solto em .deco/blocks (o site.json não é um). */
const isLooseThemeBlock = (path: string) => {
  const name = path.split("/").pop() ?? "";
  return (
    path.startsWith(`${BLOCKS_DIR}/`) &&
    path !== SITE_BLOCK &&
    name.endsWith(".json") &&
    /theme/i.test(name)
  );
};

/** "Loja Theme.json" → "Loja Theme" (o nome que um bloco usa pra referenciar). */
function blockName(path: string): string {
  const file = (path.split("/").pop() ?? "").replace(/\.json$/, "");
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

/**
 * Qual bloco de tema solto vale (null = nenhum). Um só: misturar o "Fashion
 * theme" do template com o da loja dava à loja uma cor que ela não usa. Ordem:
 *   1. o que outro bloco lido referencia (`"__resolveType": "<nome>"`) — um
 *      site.json que aponta `theme` pro "Fashion theme";
 *   2. nenhum, se o site.json já traz o tema inline, e os blocos soltos ficam
 *      sobrando;
 *   3. o que não é o do template; o do template só se for o único.
 *
 * Só conta referência nos blocos que já foram lidos (site.json e os próprios
 * temas): varrer os milhares de blocos de uma loja grande não cabe na leitura.
 */
export function chooseThemeBlock(files: readonly RepoFile[]): string | null {
  const themes = files.filter((f) => isLooseThemeBlock(f.path));
  if (themes.length === 0) return null;
  const referenced = themes.find((t) => {
    const name = blockName(t.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ref = new RegExp(`"__resolveType"\\s*:\\s*"${name}"`);
    return files.some(
      (f) =>
        f.path !== t.path &&
        f.path.startsWith(`${BLOCKS_DIR}/`) &&
        ref.test(f.text),
    );
  });
  if (referenced) return referenced.path;
  const site = files.find((f) => f.path === SITE_BLOCK);
  if (site && Object.keys(themePropsOf(site.text)).length > 0) return null;
  const isTemplate = (t: RepoFile) =>
    TEMPLATE_THEME.test(t.path.split("/").pop() ?? "");
  return (themes.find((t) => !isTemplate(t)) ?? themes[0])?.path ?? null;
}

// ── O que sai sem modelo ─────────────────────────────────────────────────────

/** Declarações `--nome: valor;` de um CSS, na ordem, sem repetir nome. */
export function cssVariablesOf(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const [, name, value] = m;
    if (!name || !value || name in out) continue;
    out[name] = value.trim().replace(/\s+/g, " ");
    if (Object.keys(out).length >= MAX_CSS_VARIABLES) break;
  }
  return out;
}

/**
 * As props das sections de Theme no `site.json` (cores do daisyUI, raio de
 * botão…), achatadas em `grupo.chave → valor`. É o tema que o CMS publica.
 */
export function themePropsOf(siteJson: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(siteJson);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = obj.__resolveType;
    if (typeof type === "string" && /\/Theme\/Theme\.tsx$/.test(type)) {
      for (const [group, value] of Object.entries(obj)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        for (const [key, v] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (typeof v === "string" || typeof v === "number") {
            out[`${group}.${key}`] = String(v);
          }
        }
      }
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(parsed);
  return out;
}

// ── O modelo ─────────────────────────────────────────────────────────────────

function forPrompt(file: RepoFile): string {
  if (file.path.endsWith(".css")) {
    const vars = Object.entries(cssVariablesOf(file.text))
      .map(([k, v]) => `${k}: ${v};`)
      .join("\n");
    // As variáveis inteiras + o começo do arquivo (é onde mora o @theme/@layer base).
    return `${vars}\n\n/* começo do arquivo */\n${file.text.slice(0, 4_000)}`.slice(
      0,
      MAX_PROMPT_CHARS_PER_FILE,
    );
  }
  if (isThemeBlock(file.path)) {
    return JSON.stringify(themePropsOf(file.text), null, 1);
  }
  return file.text.slice(0, MAX_PROMPT_CHARS_PER_FILE);
}

const asText = (v: unknown) => String(v ?? "");

/** Os `n` primeiros itens de uma lista; os que não têm `name` em texto saem. */
const listOf = <T>(item: z.ZodType<T>, n: number) =>
  z.unknown().transform((v): T[] =>
    Array.isArray(v)
      ? v.slice(0, n).flatMap((x) => {
          const r = item.safeParse(x);
          return r.success ? [r.data] : [];
        })
      : [],
  );

const ModelTokensSchema = z.object({
  colors: listOf(
    z
      .object({ name: z.string(), value: z.unknown(), usage: z.unknown() })
      .transform((c) => ({
        name: c.name,
        value: asText(c.value),
        usage: asText(c.usage),
      })),
    20,
  ),
  fonts: listOf(
    z
      .object({ name: z.string(), family: z.unknown() })
      .transform((f) => ({ name: f.name, family: asText(f.family) })),
    6,
  ),
  radii: listOf(
    z
      .object({ name: z.string(), value: z.unknown() })
      .transform((r) => ({ name: r.name, value: asText(r.value) })),
    8,
  ),
  conventions: z
    .unknown()
    .transform((v) => (typeof v === "string" ? v.trim() : null)),
});

/**
 * Lê o repo e devolve os tokens. A parte determinística (variáveis do CSS e
 * props do Theme) sai mesmo se o modelo falhar; o modelo só nomeia cores,
 * fontes, raios e diz as convenções de classe.
 */
export async function extractCodeTokens(opts: {
  /** O repo, com os caminhos como estão; `repo` = como ele aparece nos relatos. */
  code: { list: FsLister; read: RepoReader; repo: string };
  llm: Llm;
  now: string;
  onUsage: (u: LlmUsage) => void;
}): Promise<CodeTokens> {
  const source = repoThemeSource(opts.code.list, opts.code.read, opts.now);
  const repoName = opts.code.repo;
  const { commit, files, missed } = await readThemeFiles(source);
  if (files.length === 0) {
    throw new Error(
      `nenhum arquivo de tema no repo${missed.length ? ` (falharam: ${missed.join(", ")})` : ""}`,
    );
  }
  const cssVariables: Record<string, string> = {};
  for (const f of files) {
    if (f.path.endsWith(".css"))
      Object.assign(cssVariables, cssVariablesOf(f.text));
  }
  // site.json e no máximo um bloco solto (chooseThemeBlock); o primeiro vence.
  const theme: Record<string, string> = {};
  for (const f of files) {
    if (!isThemeBlock(f.path)) continue;
    for (const [k, v] of Object.entries(themePropsOf(f.text))) {
      if (!(k in theme)) theme[k] = v;
    }
  }
  const tokens: CodeTokens = {
    repo: repoName,
    commit,
    read_at: opts.now,
    files: files.map((f) => f.path),
    css_variables: Object.fromEntries(
      Object.entries(cssVariables).slice(0, MAX_CSS_VARIABLES),
    ),
    theme,
    colors: [],
    fonts: [],
    radii: [],
    conventions: null,
  };

  try {
    const raw = await opts.llm(
      {
        tier: "smart",
        maxTokens: 2_500,
        temperature: 0,
        systemPrompt:
          "Você lê o código de tema de uma loja e devolve os tokens de design como a loja os nomeia. Responda só JSON.",
        userPrompt: `Arquivos de tema do repositório ${tokens.repo}:

${files.map((f) => `### ${f.path}\n${forPrompt(f)}`).join("\n\n")}

Devolva os tokens COMO O CÓDIGO OS CHAMA (nome de classe Tailwind/daisyUI ou variável CSS), com o valor resolvido quando der:
{
  "colors": [{"name": "primary", "value": "#333333", "usage": "botão principal, texto forte"}],
  "fonts": [{"name": "font-montserrat", "family": "Montserrat, sans-serif"}],
  "radii": [{"name": "--rounded-btn", "value": "2rem"}],
  "conventions": "1-3 frases: stack (Tailwind 3 + daisyUI…), e como se escreve um botão principal, um chip e um texto de preço com as classes da loja"
}
No máximo 20 cores, 6 fontes, 8 raios. Não invente o que não está nos arquivos.`,
      },
      opts.onUsage,
    );
    const json = extractJsonObject(raw);
    if (json) {
      const parsed = ModelTokensSchema.parse(JSON.parse(json));
      tokens.colors = parsed.colors;
      tokens.fonts = parsed.fonts;
      tokens.radii = parsed.radii;
      tokens.conventions = parsed.conventions;
    }
  } catch (err) {
    tokens.model_error = err instanceof Error ? err.message : String(err);
  }
  return tokens;
}

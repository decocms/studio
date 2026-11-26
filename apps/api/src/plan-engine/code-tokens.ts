/**
 * The store's design system from its linked repository: how the code NAMES each thing (`bg-primary`,
 * `--rounded-btn`), so a mockup reuses the store's classes instead of pasting hex values.
 */

import { z } from "zod";
import { extractJsonObject } from "./json.ts";
import {
  type FsLister,
  type Llm,
  type LlmUsage,
  type RepoEntry,
  type RepoReader,
  rethrowNoAiModel,
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
/** The theme name deco's template uses; the store's own theme, if any, wins. */
const TEMPLATE_THEME = /^fashion theme\.json$/i;
/** Loose theme blocks read; only one counts (chooseThemeBlock). */
const MAX_THEME_CANDIDATES = 4;

/** `site.json` or a loose theme block: both become Theme props. */
const isThemeBlock = (path: string) =>
  path === SITE_BLOCK || path.startsWith(`${BLOCKS_DIR}/`);

// ── Reading the repo ─────────────────────────────────────────────────────────

interface RepoFile {
  path: string;
  text: string;
}

/** Where the theme is read from: the site's repo. */
interface ThemeSource {
  /** Direct children of `dir` ("" = root). A failing root is an error. */
  list(dir: string): Promise<RepoEntry[]>;
  /** null = not returned. */
  read(path: string): Promise<string | null>;
  /** Folders besides the CSS ones worth listing, when their first segment exists at the root. */
  extraDirs: string[];
  /** The commit read; the read does not pin one, so it is the read time. */
  commit(): string | null;
}

/** The site's repo; without a commit, the read time stands in. */
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

/** Reads the fixed set of theme files; a missing file is skipped, only a failed or empty root is an error. */
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
  // One theme only: the other loose blocks were read to find references.
  const theme = chooseThemeBlock(files);
  return {
    commit: source.commit(),
    files: files.filter((f) => !isLooseThemeBlock(f.path) || f.path === theme),
    missed,
  };
}

/** Which files to read from the listing; generated CSS (a large `static/tailwind.css`) is build output and stays out. */
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
    // With a blocks listing, site.json is read only if listed; without one, it is requested blind.
    const blocks = files.filter((e) => e.path.startsWith(`${BLOCKS_DIR}/`));
    if (blocks.length === 0 || blocks.some((e) => e.path === SITE_BLOCK)) {
      out.push(SITE_BLOCK);
    }
    // Loose theme blocks (TanStack): all read, the template's last, and at most one counts.
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

/** A loose theme block in .deco/blocks (site.json is not one). */
const isLooseThemeBlock = (path: string) => {
  const name = path.split("/").pop() ?? "";
  return (
    path.startsWith(`${BLOCKS_DIR}/`) &&
    path !== SITE_BLOCK &&
    name.endsWith(".json") &&
    /theme/i.test(name)
  );
};

/** "Store Theme.json" → "Store Theme" (the name another block references it by). */
function blockName(path: string): string {
  const file = (path.split("/").pop() ?? "").replace(/\.json$/, "");
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

/**
 * The loose theme block that counts (null = none), so the template's theme never mixes into the store's:
 * one a read block references, else none when site.json inlines the theme, else the non-template one.
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

// ── Without the model ─────────────────────────────────────────────────────────

/** A CSS file's `--name: value;` declarations, in order, without repeating a name. */
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

/** The Theme sections' props in `site.json` (daisyUI colors, button radius…) flattened to `group.key → value`. */
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

// ── The model ────────────────────────────────────────────────────────────────

function forPrompt(file: RepoFile): string {
  if (file.path.endsWith(".css")) {
    const vars = Object.entries(cssVariablesOf(file.text))
      .map(([k, v]) => `${k}: ${v};`)
      .join("\n");
    // All variables plus the file's start (where @theme/@layer base lives).
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

/** The first `n` items of a list; items without a text `name` are dropped. */
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
 * Reads the repo and returns the tokens. CSS variables and Theme props come out even when the model fails;
 * the model only names colors, fonts and radii and states the class conventions.
 */
export async function extractCodeTokens(opts: {
  /** The repo with its paths as they are; `repo` = how reports name it. */
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
  // site.json and at most one loose block (chooseThemeBlock); the first wins.
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
    rethrowNoAiModel(err);
    tokens.model_error = err instanceof Error ? err.message : String(err);
  }
  return tokens;
}

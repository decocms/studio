/**
 * The verifier's repository stage: a snapshot of the store's code (the page's sections and what they import)
 * and one question to the model about it. Paths are the mirror's (`src/` stripped); only files read can decide.
 */

import { z } from "zod";
import { parseJson, text } from "../opportunities.ts";
import {
  type FsLister,
  type Llm,
  type LlmUsage,
  type MediaStore,
  type RepoReader,
  rethrowNoAiModel,
} from "../ports.ts";
import type { DevicePdpBehaviour, UxHypothesis, UxPageType } from "../types.ts";
import { type PlanContext, VERIFY_MODEL, validateSteps } from "./plan.ts";
import type { CheckOutcome, CheckRun, VerifyCheck } from "./types.ts";

export interface RepoSnapshot {
  /** The repo read (`owner/name`). */
  repo: string;
  /** When the snapshot was read (the read does not expose the commit). */
  synced_at: string;
  files: Array<{ path: string; text: string }>;
  /** The file in `files` that is the page's CMS block, whose `sections` hold the order. Absent = not found. */
  page_block?: string;
}

export const SNAPSHOT_MAX_FILES = 25;
export const SNAPSHOT_MAX_BYTES = 400_000;
/** Read ceiling (404s and oversized files count). */
export const SNAPSHOT_MAX_READS = SNAPSHOT_MAX_FILES * 8;

/** "Product/ProductDetails" → "sections/Product/ProductDetails.tsx". */
export function sectionPath(section: string): string {
  const clean = section.replace(/^\/+/, "").replace(/\.tsx?$/, "");
  return `sections/${clean}.tsx`;
}

const CODE_EXT = /\.(tsx?|jsx?)$/;
/** Non-code file extensions. A closed list: "Product.Gallery" is an extensionless component, not a ".Gallery" file. */
const ASSET_EXT =
  /\.(css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|txt|md|html?|ya?ml)$/i;
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)["']([^"']+)["']/g;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * The file's local imports as candidate paths from the repo root (relative and `~/`; no third-party packages).
 * Without an extension it returns `.tsx`, `.ts`, `/index.tsx` and `/index.ts`; the reader keeps the first that exists.
 */
export function importsOf(source: string, fromPath: string): string[] {
  const dir = fromPath.split("/").slice(0, -1).join("/");
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec) continue;
    let base: string;
    if (spec.startsWith("~/")) base = normalize(spec.slice(2));
    else if (spec.startsWith(".")) base = normalize(`${dir}/${spec}`);
    else continue;
    if (!base) continue;
    if (CODE_EXT.test(base)) out.push(base);
    else if (ASSET_EXT.test(base)) continue;
    else
      out.push(
        `${base}.tsx`,
        `${base}.ts`,
        `${base}/index.tsx`,
        `${base}/index.ts`,
      );
  }
  return [...new Set(out)];
}

/** The same candidates as `importsOf`, grouped by import (extensionless base). */
function importGroups(source: string, fromPath: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const candidate of importsOf(source, fromPath)) {
    const base = candidate.replace(/(\/index)?\.tsx?$/, "");
    groups.set(base, [...(groups.get(base) ?? []), candidate]);
  }
  return groups;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Where deco's CMS keeps blocks (pages included). */
export const PAGE_BLOCKS_DIR = ".deco/blocks";
/** How many candidate page blocks to read, at most, to find the PDP's. */
const PAGE_BLOCK_MAX_READS = 3;
/** Ceiling of the compacted block: a raw block can pass 1 MB and would eat the snapshot's 400 KB ceiling. */
export const PAGE_BLOCK_MAX_BYTES = 40_000;
const COMPACT_MAX_DEPTH = 8;

/** A section of the compacted block: its type and what it wraps. */
interface CompactSection {
  section: string;
  title?: string;
  /** Multivariate flag: each variant's rule and its sections. */
  variants?: Array<{ rule: string | null; sections: CompactSection[] }>;
  /** Lazy/Deferred and similar: the sections inside. */
  sections?: CompactSection[];
  /** Other section lists in the props (a wrapper's `children`): the PDP may live there. */
  slots?: Record<string, CompactSection[]>;
}

/** `sections` (page, Deferred, variant `value`) comes as a list OR a single object (a loose multivariate flag). */
const asList = (raw: unknown): unknown[] =>
  Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];

const isSectionList = (v: unknown): v is unknown[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x) =>
      x &&
      typeof x === "object" &&
      typeof (x as { __resolveType?: unknown }).__resolveType === "string",
  );

function compactSection(raw: unknown, depth: number): CompactSection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  const type = x.__resolveType;
  const out: CompactSection = {
    section: typeof type === "string" ? type : "(sem __resolveType)",
  };
  if (typeof x.title === "string" && x.title.trim()) {
    out.title = x.title.trim().slice(0, 80);
  }
  if (depth >= COMPACT_MAX_DEPTH) return out;
  const many = (v: unknown): CompactSection[] =>
    asList(v)
      .map((s) => compactSection(s, depth + 1))
      .filter((s): s is CompactSection => s !== null);
  if (Array.isArray(x.variants)) {
    out.variants = x.variants.map((v) => {
      const variant = (v ?? {}) as { rule?: unknown; value?: unknown };
      const rule = (variant.rule ?? null) as { __resolveType?: unknown } | null;
      return {
        rule:
          typeof rule?.__resolveType === "string" ? rule.__resolveType : null,
        sections: many(variant.value),
      };
    });
  }
  const inner = [...many(x.section), ...many(x.sections)];
  if (inner.length > 0) out.sections = inner;
  for (const [key, value] of Object.entries(x)) {
    if (key === "section" || key === "sections" || key === "variants") continue;
    if (!isSectionList(value)) continue;
    out.slots ??= {};
    out.slots[key] = many(value);
  }
  return out;
}

/** The compacted block's section lists, with each one's depth. */
function listsOf(
  sections: CompactSection[],
  depth: number,
  acc: Array<{ list: unknown[]; depth: number; order: number }>,
): typeof acc {
  acc.push({ list: sections, depth, order: acc.length });
  for (const s of sections) {
    for (const v of s.variants ?? []) listsOf(v.sections, depth + 1, acc);
    if (s.sections) listsOf(s.sections, depth + 1, acc);
    for (const list of Object.values(s.slots ?? {})) {
      listsOf(list, depth + 1, acc);
    }
  }
  return acc;
}

/**
 * The page block reduced to what decides order: `path` and its sections with type, title, flag variants and wrapped lists.
 * Over PAGE_BLOCK_MAX_BYTES it cuts from the inside out (deepest list, last first), keeps the top flag and marks `truncated`.
 */
export function compactPageBlock(parsed: {
  path?: unknown;
  sections?: unknown;
}): string {
  const sections = asList(parsed.sections)
    .map((s) => compactSection(s, 0))
    .filter((s): s is CompactSection => s !== null);
  const path = typeof parsed.path === "string" ? parsed.path : null;
  const render = (truncated: boolean) =>
    JSON.stringify(
      truncated ? { path, sections, truncated } : { path, sections },
      null,
      1,
    );
  let text = render(false);
  if (byteLength(text) <= PAGE_BLOCK_MAX_BYTES) return text;
  // Deepest first; on a tie, the later one (its inner lists are already empty by then).
  const queue = listsOf(sections, 0, []).sort(
    (a, b) => b.depth - a.depth || b.order - a.order,
  );
  let size = byteLength(text);
  /** Cheap estimate of each cut: unindented size times the indentation share; exact once under the ceiling. */
  const ratio = size / byteLength(JSON.stringify({ path, sections }));
  for (const { list } of queue) {
    while (list.length > 0 && size > PAGE_BLOCK_MAX_BYTES) {
      const dropped = list.pop();
      size -= (byteLength(JSON.stringify(dropped)) + 1) * ratio;
      if (size <= PAGE_BLOCK_MAX_BYTES) {
        text = render(true);
        size = byteLength(text);
      }
    }
    if (size <= PAGE_BLOCK_MAX_BYTES) break;
  }
  return render(true);
}

/**
 * The PDP's CMS page block, which holds the section order (`pages-productpage-*.json`, `path` = `/:slug/p`).
 * Tries `pages-productpage*` first, then up to 3 product-named `pages-*` with a `/p` path; null when none.
 * `reads` counts the reads spent; the text returned is the COMPACTED block.
 */
export async function findPdpPageBlock(
  list: FsLister,
  read: RepoReader,
): Promise<{ path: string; text: string; reads: number } | null> {
  const entries = (await list(PAGE_BLOCKS_DIR))
    .filter((e) => e.type === "file" && /^pages-.*\.json$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const named = entries.filter((e) => /^pages-productpage/i.test(e.name));
  const others = entries.filter(
    (e) =>
      !/^pages-productpage/i.test(e.name) &&
      /(product|produto|pdp)/i.test(e.name),
  );
  let fallback: { path: string; text: string } | null = null;
  let reads = 0;
  for (const e of [...named, ...others].slice(0, PAGE_BLOCK_MAX_READS)) {
    reads++;
    const text = await read(e.path);
    if (text === null) continue;
    let parsed: { path?: unknown; sections?: unknown } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const path = typeof parsed.path === "string" ? parsed.path : "";
    const compact = compactPageBlock(parsed);
    if (/\/p\/?$/.test(path)) return { path: e.path, text: compact, reads };
    // pages-productpage* counts even without the expected path (it comes first in the rule).
    if (!fallback && named.includes(e)) {
      fallback = { path: e.path, text: compact };
    }
  }
  return fallback ? { ...fallback, reads } : null;
}

/** Block file names typical of each page type. */
const PAGE_BLOCK_NAME: Record<
  Exclude<UxPageType, "pdp" | "carrinho_checkout">,
  RegExp
> = {
  home: /(home|index|inicio|homepage)/i,
  busca: /(search|busca|pesquisa)/i,
  categoria: /(category|categoria|plp|departament|collection|listing|search)/i,
};

/**
 * The analyzed page type's block. PDP: `findPdpPageBlock`; otherwise the block whose `path` is the analyzed route,
 * plus the generic route (`/*`, `/:slug`) for a category. The file name only orders the reads.
 */
export async function findPageBlock(
  list: FsLister,
  read: RepoReader,
  page?: { type: UxPageType; route: string | null } | null,
): Promise<{ path: string; text: string; reads: number } | null> {
  if (!page || page.type === "pdp") return findPdpPageBlock(list, read);
  if (page.type === "carrinho_checkout") return null;
  const nameRe = PAGE_BLOCK_NAME[page.type];
  const entries = (await list(PAGE_BLOCKS_DIR))
    .filter((e) => e.type === "file" && /^pages-.*\.json$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ordered = [
    ...entries.filter((e) => nameRe.test(e.name)),
    ...entries.filter((e) => !nameRe.test(e.name)),
  ];
  const route = page.route ?? (page.type === "home" ? "/" : null);
  let fallback: { path: string; text: string } | null = null;
  let reads = 0;
  for (const e of ordered.slice(0, PAGE_BLOCK_MAX_READS + 2)) {
    reads++;
    const text = await read(e.path);
    if (text === null) continue;
    let parsed: { path?: unknown } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const path = typeof parsed.path === "string" ? parsed.path : "";
    const compact = compactPageBlock(parsed);
    if (route && path === route) return { path: e.path, text: compact, reads };
    if (
      !fallback &&
      nameRe.test(e.name) &&
      (page.type !== "categoria" || /[*:]/.test(path))
    ) {
      fallback = { path: e.path, text: compact };
    }
  }
  return fallback ? { ...fallback, reads } : null;
}

/** The product sections (`site/sections/Product/...tsx`) the compacted PDP block lists, in order, as mirror paths. */
export function pdpSectionsOfPageBlock(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /"section":\s*"site\/sections\/([^"]+?)\.tsx"/g,
  )) {
    const name = m[1];
    if (!name || !/(^|\/)product\//i.test(name)) continue;
    const path = sectionPath(name);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Starts at the page's sections and follows imports breadth-first up to the file or byte ceiling; missing files are skipped.
 * If NOTHING was read and a read failed (credential, provider), the error is raised so a 401 never looks like an empty repo.
 */
export async function snapshotRepo(opts: {
  read: RepoReader;
  repo: string;
  sections: string[];
  /** To find the page block (`findPageBlock`). Absent = without it. */
  list?: FsLister;
  /** The analyzed page (its block). Absent = PDP. */
  page?: { type: UxPageType; route: string | null } | null;
}): Promise<RepoSnapshot> {
  const queue = [...new Set(opts.sections.map(sectionPath))];
  const seen = new Set(queue);
  const files: RepoSnapshot["files"] = [];
  let bytes = 0;
  let firstError: unknown = null;
  let pageBlock: string | undefined;
  let blockReads = 0;
  // The page block goes first (the only place with the section order) and counts toward the ceilings.
  if (opts.list) {
    try {
      const block = await findPageBlock(opts.list, opts.read, opts.page);
      blockReads = block?.reads ?? 0;
      const size = block ? byteLength(block.text) : 0;
      if (block && size <= SNAPSHOT_MAX_BYTES) {
        files.push({ path: block.path, text: block.text });
        bytes += size;
        pageBlock = block.path;
        // The clicked section may be a wrapper with the PDP coming from the CMS: the block's product sections join the queue.
        const isPdp = !opts.page || opts.page.type === "pdp";
        for (const path of isPdp ? pdpSectionsOfPageBlock(block.text) : []) {
          if (seen.has(path)) continue;
          seen.add(path);
          queue.push(path);
        }
      }
    } catch (err) {
      // Only a warning: the block is extra, and its failure must not make the snapshot throw.
      console.warn(
        `[plan-engine] bloco de página: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // Candidates of one extensionless import form a group: the first that opens resolves it.
  const groupOf = new Map<string, string>();
  const resolved = new Set<string>();
  let reads = blockReads;
  while (
    queue.length > 0 &&
    files.length < SNAPSHOT_MAX_FILES &&
    reads < SNAPSHOT_MAX_READS
  ) {
    const path = queue.shift() as string;
    const group = groupOf.get(path);
    if (group && resolved.has(group)) continue;
    reads++;
    let body: string | null;
    try {
      body = await opts.read(path);
    } catch (err) {
      firstError ??= err;
      continue;
    }
    if (body === null) continue;
    const size = byteLength(body);
    if (bytes + size > SNAPSHOT_MAX_BYTES) continue;
    bytes += size;
    if (group) resolved.add(group);
    files.push({ path, text: body });
    for (const [group, candidates] of importGroups(body, path)) {
      for (const next of candidates) {
        if (seen.has(next)) continue;
        seen.add(next);
        groupOf.set(next, group);
        queue.push(next);
      }
    }
  }
  if (files.length === 0 && firstError) throw firstError;
  return {
    repo: opts.repo,
    synced_at: new Date().toISOString(),
    files,
    ...(pageBlock ? { page_block: pageBlock } : {}),
  };
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** The round's MediaStore is already the org's: the key only carries the diagnosis. */
export const repoSnapshotKey = (diagnosisId: string) =>
  `ux/${diagnosisId}/repo.json`;

const RepoSnapshotSchema = z.object({
  repo: z.string(),
  synced_at: z.string(),
  files: z.array(z.object({ path: z.string(), text: z.string() })),
  page_block: z.string().optional(),
});

export async function saveRepoSnapshot(
  media: MediaStore,
  key: string,
  snapshot: RepoSnapshot,
): Promise<void> {
  await media.put(
    key,
    new TextEncoder().encode(JSON.stringify(snapshot)),
    "application/json",
  );
}

/** null when missing or not shaped like a snapshot. */
export async function loadRepoSnapshot(
  media: MediaStore,
  key: string,
): Promise<RepoSnapshot | null> {
  try {
    const bytes = await media.get(key);
    if (!bytes) return null;
    const parsed = RepoSnapshotSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!parsed.success) return null;
    const { page_block, ...rest } = parsed.data;
    return page_block === undefined ? rest : { ...rest, page_block };
  } catch {
    return null;
  }
}

/** Reads the repo from the page's sections and stores it. An empty snapshot throws, so the repo test is nao_testou without a model call. */
export async function storeRepoSnapshot(opts: {
  media: MediaStore;
  key: string;
  read: RepoReader;
  /** To include the page block (the section order). */
  list?: FsLister;
  repo: string;
  pdp: DevicePdpBehaviour[];
  /** The analyzed page. Absent = PDP. */
  page?: { type: UxPageType; route: string | null } | null;
}): Promise<string> {
  const sections = [
    ...new Set(
      opts.pdp.flatMap((b) => [
        ...(b.elements ?? []).map((e) => e.section),
        ...(b.sections ?? []).map((x) => x.section),
      ]),
    ),
  ].filter(Boolean);
  const snapshot = await snapshotRepo({
    read: opts.read,
    list: opts.list,
    repo: opts.repo,
    sections,
    page: opts.page,
  });
  if (snapshot.files.length === 0) {
    throw new Error("nenhuma seção da página encontrada no repo");
  }
  await saveRepoSnapshot(opts.media, opts.key, snapshot);
  return opts.key;
}

// ── Asking the model ────────────────────────────────────────────────────────

const OUTCOMES: readonly string[] = ["confirma", "desmente", "nao_decidiu"];

function refPath(ref: string): string {
  return ref
    .trim()
    .replace(/:\d+(?:[-:]\d+)*$/, "")
    .replace(/^\.\//, "")
    .replace(/^src\//, "");
}

export function parseRepoAnswer(
  raw: string,
  snapshot: RepoSnapshot,
  check: VerifyCheck,
  ctx: PlanContext,
): { run: CheckRun; followup: VerifyCheck | null } {
  const parsed = parseJson(raw, "verificação no código");
  const asked = text(parsed.outcome);
  let outcome: CheckOutcome = OUTCOMES.includes(asked)
    ? (asked as CheckOutcome)
    : "nao_decidiu";
  let observed = text(parsed.observed) || "(sem observação)";
  const ref = text(parsed.source_ref);
  const inSnapshot =
    ref !== "" && snapshot.files.some((f) => f.path === refPath(ref));
  if ((outcome === "confirma" || outcome === "desmente") && !inSnapshot) {
    observed = `${observed} (sem decidir: ${ref ? `o arquivo ${ref} não está no snapshot` : "sem arquivo citado"})`;
    outcome = "nao_decidiu";
  }
  let followup: VerifyCheck | null = null;
  if (parsed.followup_steps !== undefined && !check.id.endsWith("-f")) {
    const v = validateSteps(parsed.followup_steps, ctx);
    if ("steps" in v) {
      followup = {
        id: `${check.id}-f`,
        claim: check.claim,
        stage: "live",
        device: check.device,
        steps: v.steps,
        question: null,
        confirms_if: check.confirms_if,
        refutes_if: check.refutes_if,
      };
    }
  }
  return {
    run: {
      check,
      outcome,
      observed,
      screenshot_url: null,
      source_ref: inSnapshot ? ref : null,
    },
    followup,
  };
}

/** How many files the model may request at once. */
const NEED_FILES_MAX = 6;
/** Ceiling on the requests combined: the second round resends the whole snapshot, so they must not double the prompt. */
export const NEED_FILES_MAX_BYTES = 120_000;
/** Slack needed to start the second round: reads (one candidate at a time, over 30 s) plus the model (120 s). */
const SECOND_ROUND_MIN_MS = 180_000;
const NEED_FILES_EXT = /\.(tsx?|jsx?|css|json)$/;
const NEED_FILES_CODE_EXT = /\.(tsx?|jsx?)$/;
/** How many imports outside the snapshot the prompt lists, at most. */
export const MISSING_IMPORTS_MAX = 40;

const REPO_RULES = `Você responde UMA pergunta sobre o código de uma loja, pra decidir uma hipótese de CRO. Só vale o que está nos arquivos abaixo; não suponha o que não está lá.

Responda SÓ este JSON:
{ "outcome": "confirma" | "desmente" | "nao_decidiu", "observed": "o que o código mostra, em português, frases curtas", "source_ref": "caminho/do/arquivo.tsx:linha", "followup_steps": [ ...opcional... ] }

- "confirma"/"desmente" exigem "source_ref" com o caminho EXATO de um arquivo dos blocos abaixo. Sem isso, use "nao_decidiu".
- Aplique "confirms_if" e "refutes_if" como foram escritos; se o código não decide, "nao_decidiu".
- "followup_steps" (opcional, só se um passo no navegador decide o que o código não decide): lista de passos { "op": "open"|"click"|"choose_size"|"choose_variant"|"reload"|"scroll_to"|"wait"|"gesture"|"inspect"|"observe_click"|"screenshot", ... }; "open" e "reload" aceitam "keep_overlays": true pra testar pop-up/modal/banner (sem isso a página abre com eles fechados); click, scroll_to, inspect, observe_click e screenshot levam alvo { "kind": "element", "key": "..." } ou { "kind": "part", "part": "price|size_selector|buy_button|shipping|first_recommendation" }. Nunca comprar nem mexer em formulário.
- Pop-up/banner pode só abrir no primeiro gesto da pessoa (mexer o mouse ou o dedo), e o navegador do teste não mexe sozinho. Se o código mostra isso, teste com { "op": "open", "keep_overlays": true }, { "op": "gesture" } (mexe o mouse no meio da tela, sem clicar) e { "op": "wait", "ms": 8000 } antes de olhar o pop-up.`;

/** Without the repo at hand to read more files: the usual prompt. */
const REPO_SYSTEM = REPO_RULES;

const REPO_SYSTEM_ASK = `${REPO_RULES}
- "need_files" (opcional, só nesta primeira resposta): se a resposta depende de um arquivo do repo que NÃO está nos blocos abaixo (um componente ou hook que eles importam, por exemplo), peça até ${NEED_FILES_MAX} caminhos relativos à RAIZ do repo, no formato dos blocos ("components/x/Y.tsx", sem "src/"); sem extensão também vale ("components/x/Y"). Nada de caminho relativo do import ("../../components/x/Y" não abre): quando o arquivo estiver na lista "Importados pelos arquivos acima que não estão aqui", copie dali. Nesse caso use "outcome": "nao_decidiu"; você recebe os arquivos e responde de novo, e a segunda resposta não pode pedir mais.`;

const REPO_SYSTEM_FINAL = `${REPO_RULES}
- Esta é a segunda volta: os arquivos que você pediu estão abaixo (os que abriram). Decida com eles; não peça mais arquivos.`;

/**
 * Where to look for a request, in order: the path as given (with an extension), then the base's `.tsx`, `.ts`,
 * `/index.tsx`, `/index.ts`, since the model copies extensionless imports. `.css`/`.json` only as given.
 */
function needCandidates(path: string): string[] {
  if (NEED_FILES_EXT.test(path) && !NEED_FILES_CODE_EXT.test(path)) {
    return [path];
  }
  const base = path.replace(NEED_FILES_CODE_EXT, "");
  const tries = [
    `${base}.tsx`,
    `${base}.ts`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ];
  return [...new Set(base === path ? tries : [path, ...tries])];
}

/**
 * The readable `need_files` paths: repo-root relative, no `..` or absolute path, code/style/JSON or no extension,
 * and not already read. Leading `src/`, `./` and `~/` are stripped to match the mirror's paths.
 */
export function neededPaths(raw: unknown, have: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || t.startsWith("/") || /^[a-z]+:/i.test(t) || t.includes("\\"))
      continue;
    if (t.split("/").includes("..")) continue;
    const path = t
      .replace(/^\.\//, "")
      .replace(/^~\//, "")
      .replace(/^src\//, "")
      .replace(/\/+$/, "");
    if (!path || path.startsWith("/")) continue;
    const hasExt = NEED_FILES_EXT.test(path);
    if (!hasExt && ASSET_EXT.test(path)) continue;
    // Without an extension, any candidate already read counts as read.
    const known = hasExt
      ? have.has(path)
      : needCandidates(path).some((c) => have.has(c));
    if (known || out.includes(path)) continue;
    out.push(path);
  }
  return out.slice(0, NEED_FILES_MAX);
}

type ReadAttempt = { body: string | null; error: string | null };

const attempt = (read: RepoReader, path: string): Promise<ReadAttempt> =>
  read(path).then(
    (body) => ({ body, error: null }),
    (err: unknown) => ({
      body: null,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

/**
 * The first candidate that opens, one at a time in order, so 6 parallel requests never pass 6 concurrent reads.
 * A non-404 error stops there; attempts count against time, not the file ceiling.
 */
async function resolveNeeded(
  read: RepoReader,
  requested: string,
): Promise<{ path: string; body: string } | { error: string | null }> {
  for (const path of needCandidates(requested)) {
    const t = await attempt(read, path);
    if (t.error !== null) return { error: t.error };
    if (t.body !== null) return { path, body: t.body };
  }
  return { error: null };
}

/**
 * Reads the requested files up to NEED_FILES_MAX_BYTES combined. A file that does not open is left out with the reason
 * for the second-round prompt; `files` carries the path that opened (with extension), which is what the model cites.
 */
export async function readNeededFiles(
  read: RepoReader,
  paths: string[],
): Promise<{
  files: RepoSnapshot["files"];
  /** With the reason, for the prompt. */
  missed: string[];
  /** Only the requested path, for the report. */
  missedPaths: string[];
}> {
  const files: RepoSnapshot["files"] = [];
  const missed: string[] = [];
  const missedPaths: string[] = [];
  let bytes = 0;
  // In parallel, with the ceiling applied in request order.
  const results = await Promise.all(paths.map((p) => resolveNeeded(read, p)));
  for (const [i, path] of paths.entries()) {
    const r = results[i];
    if (!r) continue;
    const miss = (why: string) => {
      missed.push(`${path} (${why})`);
      missedPaths.push(path);
    };
    if ("error" in r) {
      miss(r.error !== null ? `não abriu: ${r.error}` : "não existe");
      continue;
    }
    // "X" and "X.tsx" in the same request: the file goes in once.
    if (files.some((f) => f.path === r.path)) continue;
    const size = byteLength(r.body);
    if (bytes + size > NEED_FILES_MAX_BYTES) {
      miss("grande demais");
      continue;
    }
    bytes += size;
    files.push({ path: r.path, text: r.body });
  }
  return { files, missed, missedPaths };
}

/**
 * Local imports of snapshot files that are not in it, as repo-root paths (extensionless when the import is), up to
 * MISSING_IMPORTS_MAX, so the model picks a path that opens instead of the relative import.
 */
export function missingImports(snapshot: RepoSnapshot): string[] {
  const have = new Set(snapshot.files.map((f) => f.path));
  const out: string[] = [];
  for (const f of snapshot.files) {
    if (!CODE_EXT.test(f.path)) continue;
    for (const [base, candidates] of importGroups(f.text, f.path)) {
      if (candidates.some((c) => have.has(c))) continue;
      const shown = candidates.length === 1 ? (candidates[0] ?? base) : base;
      // An odd import (spaces, huge path) does not become a prompt line.
      if (/\s/.test(shown) || shown.length > 200) continue;
      if (out.includes(shown)) continue;
      out.push(shown);
      if (out.length >= MISSING_IMPORTS_MAX) return out;
    }
  }
  return out;
}

function missingImportsNote(snapshot: RepoSnapshot): string {
  const list = missingImports(snapshot);
  if (list.length === 0) return "";
  return `\n\n## Importados pelos arquivos acima que não estão aqui
Caminhos na raiz do repo; pode pedir qualquer um em "need_files" do jeito que está.
${list.map((p) => `- ${p}`).join("\n")}`;
}

function filesForPrompt(snapshot: RepoSnapshot): string {
  let budget = SNAPSHOT_MAX_BYTES;
  const blocks: string[] = [];
  for (const f of snapshot.files) {
    if (budget <= 0) break;
    const body = f.text.length > budget ? f.text.slice(0, budget) : f.text;
    budget -= body.length;
    const lang = f.path.endsWith(".json") ? "json" : "tsx";
    blocks.push(`### ${f.path}\n\`\`\`${lang}\n${body}\n\`\`\``);
  }
  return blocks.join("\n\n");
}

/** Prompt note on the page block: the section order comes from the CMS, not the TSX. */
export function pageBlockNote(snapshot: RepoSnapshot): string {
  if (!snapshot.page_block) return "";
  return `## Ordem das seções da página
O arquivo ${snapshot.page_block} é o bloco da página analisada no CMS da loja, COMPACTADO: só o "path" e a lista "sections" em ordem, cada item com "section" (o __resolveType: caminho da seção ou nome de um bloco salvo), "title" quando tem, "variants" (flag multivariada: a regra e as seções de cada variante), "sections" (o que um Lazy/Deferred embrulha) e "slots" (outras listas de seções nas props, como "children"). Com "truncated", listas internas foram cortadas pra caber. A ordem das seções na página é a ordem dessa lista; uma flag ou Lazy ocupa a posição dela. Pra perguntas sobre o que vem antes ou depois na página, cite esse arquivo.

`;
}

export async function runRepoCheck(opts: {
  llm: Llm;
  snapshot: RepoSnapshot | null;
  check: VerifyCheck;
  hypothesis: UxHypothesis;
  ctx: PlanContext;
  onUsage: (u: LlmUsage) => void;
  /** The repo, for a file the snapshot lacks. Absent = one round only. */
  read?: RepoReader;
  /** Time left until the hypothesis deadline (ms); without enough, no second round. */
  timeLeft?: () => number;
}): Promise<{ run: CheckRun; followup: VerifyCheck | null }> {
  const { check, snapshot, hypothesis: h, read } = opts;
  const notRun = (observed: string) => ({
    run: {
      check,
      outcome: "nao_testou" as const,
      observed,
      screenshot_url: null,
      source_ref: null,
    },
    followup: null,
  });
  if (!snapshot) return notRun("o repositório não foi lido nesta rodada");
  const question = `## Hipótese
- título: ${h.title}
- causa: ${h.why}

## Teste
- o que verifica: ${check.claim}
- pergunta: ${check.question ?? check.claim}
- confirms_if: ${check.confirms_if}
- refutes_if: ${check.refutes_if}

${pageBlockNote(snapshot)}## Arquivos (${snapshot.repo})
${filesForPrompt(snapshot)}`;
  const ask = (systemPrompt: string, userPrompt: string) =>
    opts.llm(
      {
        tier: VERIFY_MODEL,
        maxTokens: 2_000,
        temperature: 0,
        timeoutMs: 120_000,
        systemPrompt,
        userPrompt,
      },
      opts.onUsage,
    );
  try {
    // The import list only serves to request files: first round only, and only with the repo at hand.
    const first = await ask(
      read ? REPO_SYSTEM_ASK : REPO_SYSTEM,
      read ? `${question}${missingImportsNote(snapshot)}` : question,
    );
    if (!read) return parseRepoAnswer(first, snapshot, check, opts.ctx);
    const wanted = neededPaths(
      parseJson(first, "verificação no código").need_files,
      new Set(snapshot.files.map((f) => f.path)),
    );
    if (wanted.length === 0) {
      return parseRepoAnswer(first, snapshot, check, opts.ctx);
    }
    if (opts.timeLeft && opts.timeLeft() < SECOND_ROUND_MIN_MS) {
      const r = parseRepoAnswer(first, snapshot, check, opts.ctx);
      r.run.observed = `${r.run.observed} (sem tempo pra ler ${wanted.join(", ")})`;
      return r;
    }
    const extra = await readNeededFiles(read, wanted);
    const merged: RepoSnapshot = {
      ...snapshot,
      files: [...snapshot.files, ...extra.files],
    };
    const asked = [
      extra.files.length > 0
        ? `## Arquivos que você pediu\n${filesForPrompt({ ...snapshot, files: extra.files })}`
        : "",
      extra.missed.length > 0
        ? `## Pedidos que não abriram\n${extra.missed.map((m) => `- ${m}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const second = await ask(REPO_SYSTEM_FINAL, `${question}\n\n${asked}`);
      const r = parseRepoAnswer(second, merged, check, opts.ctx);
      // The report says what else was read and what did not open.
      const notes = [
        extra.files.length > 0
          ? `(li também: ${extra.files.map((f) => f.path).join(", ")})`
          : "",
        extra.missedPaths.length > 0
          ? `(não abriu: ${extra.missedPaths.join(", ")})`
          : "",
      ].filter(Boolean);
      if (notes.length > 0)
        r.run.observed = `${r.run.observed} ${notes.join(" ")}`;
      return r;
    } catch (err) {
      rethrowNoAiModel(err);
      // The first answer already counts: a broken second round does not erase it.
      const r = parseRepoAnswer(first, snapshot, check, opts.ctx);
      r.run.observed = `${r.run.observed} (a segunda volta falhou: ${err instanceof Error ? err.message : err})`;
      return r;
    }
  } catch (err) {
    rethrowNoAiModel(err);
    return notRun(
      `falhou ao perguntar ao código: ${err instanceof Error ? err.message : err}`,
    );
  }
}

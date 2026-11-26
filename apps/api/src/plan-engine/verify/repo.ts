/**
 * Etapa de repositório do verificador: um snapshot do código da loja (as
 * seções da página e o que elas importam) e uma pergunta ao modelo sobre ele.
 *
 * Os caminhos são os do espelho (`src/` tirado: `src/sections/X.tsx` mora em
 * `sections/X.tsx`); quem lê o repositório resolve `X` e `src/X`.
 *
 * Citação de arquivo fora do que foi lido nunca confirma nem desmente: o
 * modelo pode inventar um caminho com cara de verdade, e só o que foi lido vale.
 *
 * O snapshot tem teto (25 arquivos), e os testes de repo saíam "os arquivos
 * fornecidos não incluem ClosedPopup / useCart / Header". Com o repo à mão, o
 * modelo pode pedir até 6 arquivos numa primeira volta (`need_files`); a
 * segunda responde e não pede mais.
 */

import { z } from "zod";
import { parseJson, text } from "../opportunities.ts";
import type {
  FsLister,
  Llm,
  LlmUsage,
  MediaStore,
  RepoReader,
} from "../ports.ts";
import type { DevicePdpBehaviour, UxHypothesis, UxPageType } from "../types.ts";
import { type PlanContext, VERIFY_MODEL, validateSteps } from "./plan.ts";
import type { CheckOutcome, CheckRun, VerifyCheck } from "./types.ts";

export interface RepoSnapshot {
  /** O repo lido (`owner/nome`). */
  repo: string;
  /** Quando o snapshot foi lido (a leitura não expõe o commit). */
  synced_at: string;
  files: Array<{ path: string; text: string }>;
  /**
   * O arquivo (dentro de `files`) que é o bloco de página da PDP no CMS: a
   * ordem das seções da página está no `sections` dele. Ausente = não achado.
   */
  page_block?: string;
}

export const SNAPSHOT_MAX_FILES = 25;
export const SNAPSHOT_MAX_BYTES = 400_000;
/** Teto de leituras (404 e arquivo grande demais contam). */
export const SNAPSHOT_MAX_READS = SNAPSHOT_MAX_FILES * 8;

/** "Product/ProductDetails" → "sections/Product/ProductDetails.tsx". */
export function sectionPath(section: string): string {
  const clean = section.replace(/^\/+/, "").replace(/\.tsx?$/, "");
  return `sections/${clean}.tsx`;
}

const CODE_EXT = /\.(tsx?|jsx?)$/;
/**
 * Extensão de arquivo que não é código. Lista fechada: "Product.Gallery" é um
 * componente sem extensão, não um arquivo ".Gallery".
 */
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
 * Imports locais do arquivo, como caminhos candidatos na raiz do repo.
 * Relativos e `~/` entram; pacote de terceiros não. Sem extensão, a resolução
 * é uma suposição: devolve `.tsx`, `.ts`, `/index.tsx` e `/index.ts`, e quem lê
 * fica com o primeiro que existir.
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

/** Os mesmos candidatos de `importsOf`, agrupados por import (base sem extensão). */
function importGroups(source: string, fromPath: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const candidate of importsOf(source, fromPath)) {
    const base = candidate.replace(/(\/index)?\.tsx?$/, "");
    groups.set(base, [...(groups.get(base) ?? []), candidate]);
  }
  return groups;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Onde o CMS da deco guarda os blocos (páginas inclusive). */
export const PAGE_BLOCKS_DIR = ".deco/blocks";
/** Quantos blocos de página candidatos ler, no máximo, pra achar o da PDP. */
const PAGE_BLOCK_MAX_READS = 3;
/**
 * Teto do bloco compactado. O bloco cru passa de 1 MB em algumas lojas (props
 * de banner, textos) e comeria o teto de 400 KB do snapshot.
 */
export const PAGE_BLOCK_MAX_BYTES = 40_000;
const COMPACT_MAX_DEPTH = 8;

/** Uma seção do bloco compactado: o tipo e o que ela embrulha. */
interface CompactSection {
  section: string;
  title?: string;
  /** Flag multivariada: a regra de cada variante e as seções dela. */
  variants?: Array<{ rule: string | null; sections: CompactSection[] }>;
  /** Lazy/Deferred e afins: as seções de dentro. */
  sections?: CompactSection[];
  /** Outras listas de seções nas props (`children` de um embrulho): é ali que a PDP pode morar. */
  slots?: Record<string, CompactSection[]>;
}

/**
 * `sections` (de página, de Deferred, `value` de variante) vem em lista OU como
 * um objeto só: a página inteira de algumas lojas é uma flag multivariada solta.
 */
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

/** As listas de seções do bloco compactado, com a profundidade de cada uma. */
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
 * O bloco de página reduzido ao que decide a ordem: `path` e `sections` em
 * ordem, cada uma com o `__resolveType`, o `title` (quando tem), as variantes
 * de flag multivariada, o que Lazy/Deferred embrulham e as outras listas de
 * seções das props. Até PAGE_BLOCK_MAX_BYTES: passando, corta de dentro pra
 * fora (a lista mais funda, do fim pro começo), mantendo a flag de cima, e
 * marca `truncated`.
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
  // Mais funda primeiro; no empate, a que vem depois (as de dentro dela já estão vazias quando chega a vez).
  const queue = listsOf(sections, 0, []).sort(
    (a, b) => b.depth - a.depth || b.order - a.order,
  );
  let size = byteLength(text);
  /**
   * Estimativa barata do que sai a cada corte: o tamanho sem indentação vezes
   * a proporção da indentação no todo. A conta exata vem quando a estimativa
   * passa abaixo do teto; se ainda sobra, continua cortando.
   */
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
 * O bloco de página da PDP no CMS. A ordem das seções não está no código: está
 * no `sections` de `.deco/blocks/pages-productpage-*.json` (`path` =
 * `/:slug/p`). Sem ele, o teste de código da hipótese "vitrine no fundo da
 * página" não tinha como decidir.
 *
 * `pages-productpage*` primeiro; senão até 3 `pages-*` com product/produto/pdp
 * no nome, e vale o que tem `path` terminando em `/p`. Pasta que não existe ou
 * nada que case: null. `reads` = quantas leituras gastou. O texto devolvido é o
 * bloco COMPACTADO (`compactPageBlock`), não o arquivo cru.
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
    // pages-productpage* vale mesmo sem o path esperado (vem primeiro na regra).
    if (!fallback && named.includes(e)) {
      fallback = { path: e.path, text: compact };
    }
  }
  return fallback ? { ...fallback, reads } : null;
}

/** Nome de arquivo de bloco que costuma ser de cada tipo de página. */
const PAGE_BLOCK_NAME: Record<
  Exclude<UxPageType, "pdp" | "carrinho_checkout">,
  RegExp
> = {
  home: /(home|index|inicio|homepage)/i,
  busca: /(search|busca|pesquisa)/i,
  categoria: /(category|categoria|plp|departament|collection|listing|search)/i,
};

/**
 * O bloco de página do tipo analisado. PDP: `findPdpPageBlock`. Home, busca e
 * categoria: o bloco cujo `path` é a rota analisada (`/`, `/buscar`,
 * `/produtos/vestido`); na categoria vale também a rota genérica (`/*`,
 * `/:slug`) que a renderiza. Nome do arquivo só escolhe a ordem de leitura.
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

/**
 * As seções de produto (`site/sections/Product/...tsx`) que o bloco de página
 * compactado da PDP lista, na ordem, como caminhos do espelho.
 */
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
 * Começa nas seções da página e segue os imports em largura até o teto de
 * arquivos ou de bytes. Arquivo que não existe é pulado; se NADA foi lido e
 * houve erro de leitura (credencial, provedor), o erro sobe: um snapshot vazio
 * por 401 não pode parecer "repo sem as seções".
 */
export async function snapshotRepo(opts: {
  read: RepoReader;
  repo: string;
  sections: string[];
  /** Pra achar o bloco de página (`findPageBlock`). Ausente = sem ele. */
  list?: FsLister;
  /** A página analisada (o bloco dela). Ausente = PDP. */
  page?: { type: UxPageType; route: string | null } | null;
}): Promise<RepoSnapshot> {
  const queue = [...new Set(opts.sections.map(sectionPath))];
  const seen = new Set(queue);
  const files: RepoSnapshot["files"] = [];
  let bytes = 0;
  let firstError: unknown = null;
  let pageBlock: string | undefined;
  let blockReads = 0;
  // O bloco de página entra primeiro (é o único lugar com a ordem das seções) e conta nos tetos.
  if (opts.list) {
    try {
      const block = await findPageBlock(opts.list, opts.read, opts.page);
      blockReads = block?.reads ?? 0;
      const size = block ? byteLength(block.text) : 0;
      if (block && size <= SNAPSHOT_MAX_BYTES) {
        files.push({ path: block.path, text: block.text });
        bytes += size;
        pageBlock = block.path;
        // A seção clicada pode ser um embrulho e a PDP entrar pelo CMS, não por import: as seções de produto do bloco entram na fila.
        const isPdp = !opts.page || opts.page.type === "pdp";
        for (const path of isPdp ? pdpSectionsOfPageBlock(block.text) : []) {
          if (seen.has(path)) continue;
          seen.add(path);
          queue.push(path);
        }
      }
    } catch (err) {
      // Só aviso: o bloco é extra, e a falha dele não pode fazer o snapshot lançar.
      console.warn(
        `[plan-engine] bloco de página: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // Candidatos de um mesmo import sem extensão formam um grupo: o primeiro que abrir resolve.
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

// ── Armazenamento ───────────────────────────────────────────────────────────

/** O MediaStore da rodada já é da org: a chave só leva o diagnóstico. */
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

/** null se não existe ou não tem o formato de snapshot. */
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

/**
 * Lê o repo a partir das seções que a página usa e grava. Snapshot vazio não
 * se grava (lança): sem chave, o teste de repo sai nao_testou sem gastar uma
 * chamada ao modelo.
 */
export async function storeRepoSnapshot(opts: {
  media: MediaStore;
  key: string;
  read: RepoReader;
  /** Pra incluir o bloco de página (a ordem das seções). */
  list?: FsLister;
  repo: string;
  pdp: DevicePdpBehaviour[];
  /** A página analisada. Ausente = PDP. */
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

// ── Pergunta ao modelo ──────────────────────────────────────────────────────

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

/** Quantos arquivos o modelo pode pedir de uma vez. */
const NEED_FILES_MAX = 6;
/**
 * Teto dos pedidos somados. A segunda volta reenvia o snapshot inteiro (até
 * SNAPSHOT_MAX_BYTES); os pedidos por cima disso não podem dobrar o prompt.
 */
export const NEED_FILES_MAX_BYTES = 120_000;
/**
 * A segunda volta só começa com isto de folga: leituras + modelo (120 s). Os
 * candidatos de um pedido são lidos um por um, então as leituras passam de
 * 30 s: 180 s e não 150 s.
 */
const SECOND_ROUND_MIN_MS = 180_000;
const NEED_FILES_EXT = /\.(tsx?|jsx?|css|json)$/;
const NEED_FILES_CODE_EXT = /\.(tsx?|jsx?)$/;
/** Quantos importados fora do snapshot o prompt lista, no máximo. */
export const MISSING_IMPORTS_MAX = 40;

const REPO_RULES = `Você responde UMA pergunta sobre o código de uma loja, pra decidir uma hipótese de CRO. Só vale o que está nos arquivos abaixo; não suponha o que não está lá.

Responda SÓ este JSON:
{ "outcome": "confirma" | "desmente" | "nao_decidiu", "observed": "o que o código mostra, em português, frases curtas", "source_ref": "caminho/do/arquivo.tsx:linha", "followup_steps": [ ...opcional... ] }

- "confirma"/"desmente" exigem "source_ref" com o caminho EXATO de um arquivo dos blocos abaixo. Sem isso, use "nao_decidiu".
- Aplique "confirms_if" e "refutes_if" como foram escritos; se o código não decide, "nao_decidiu".
- "followup_steps" (opcional, só se um passo no navegador decide o que o código não decide): lista de passos { "op": "open"|"click"|"choose_size"|"choose_variant"|"reload"|"scroll_to"|"wait"|"gesture"|"inspect"|"observe_click"|"screenshot", ... }; "open" e "reload" aceitam "keep_overlays": true pra testar pop-up/modal/banner (sem isso a página abre com eles fechados); click, scroll_to, inspect, observe_click e screenshot levam alvo { "kind": "element", "key": "..." } ou { "kind": "part", "part": "price|size_selector|buy_button|shipping|first_recommendation" }. Nunca comprar nem mexer em formulário.
- Pop-up/banner pode só abrir no primeiro gesto da pessoa (mexer o mouse ou o dedo), e o navegador do teste não mexe sozinho. Se o código mostra isso, teste com { "op": "open", "keep_overlays": true }, { "op": "gesture" } (mexe o mouse no meio da tela, sem clicar) e { "op": "wait", "ms": 8000 } antes de olhar o pop-up.`;

/** Sem o repo à mão pra ler mais arquivos: o prompt de sempre. */
const REPO_SYSTEM = REPO_RULES;

const REPO_SYSTEM_ASK = `${REPO_RULES}
- "need_files" (opcional, só nesta primeira resposta): se a resposta depende de um arquivo do repo que NÃO está nos blocos abaixo (um componente ou hook que eles importam, por exemplo), peça até ${NEED_FILES_MAX} caminhos relativos à RAIZ do repo, no formato dos blocos ("components/x/Y.tsx", sem "src/"); sem extensão também vale ("components/x/Y"). Nada de caminho relativo do import ("../../components/x/Y" não abre): quando o arquivo estiver na lista "Importados pelos arquivos acima que não estão aqui", copie dali. Nesse caso use "outcome": "nao_decidiu"; você recebe os arquivos e responde de novo, e a segunda resposta não pode pedir mais.`;

const REPO_SYSTEM_FINAL = `${REPO_RULES}
- Esta é a segunda volta: os arquivos que você pediu estão abaixo (os que abriram). Decida com eles; não peça mais arquivos.`;

/**
 * Onde procurar um pedido, em ordem: o caminho como veio (se tem extensão),
 * depois `.tsx`, `.ts`, `/index.tsx`, `/index.ts` da base. O modelo copia o
 * import, que vem sem extensão, e o pedido sumia em silêncio. `.css`/`.json`
 * só como vieram.
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
 * Os caminhos do `need_files` que dá pra ler: relativos à raiz do repo, sem
 * `..`, sem caminho absoluto, sem extensão ou com extensão de código/estilo/
 * JSON, e fora do que já foi lido (não gasta vaga). Os `src/`, `./` e `~/` do
 * começo saem: os caminhos são os do espelho, e o modelo copia o do import.
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
    // Sem extensão, qualquer candidato já lido conta como lido.
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
 * O primeiro candidato que abre, um por um e na ordem: com até 6 pedidos em
 * paralelo, nunca passa de 6 leituras ao mesmo tempo. Erro que não é 404 para
 * ali (mais tentativas só gastam tempo). As tentativas contam no tempo, não
 * no teto de arquivos.
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
 * Lê os arquivos pedidos. Arquivo que não abre (não existe, erro, grande
 * demais) fica de fora com o motivo, que vai pro prompt da segunda volta. O
 * teto é NEED_FILES_MAX_BYTES, somando os pedidos. `files` sai com o caminho
 * que abriu (com extensão), que é o que o modelo cita.
 */
export async function readNeededFiles(
  read: RepoReader,
  paths: string[],
): Promise<{
  files: RepoSnapshot["files"];
  /** Com o motivo, pro prompt. */
  missed: string[];
  /** Só o caminho pedido, pro relato. */
  missedPaths: string[];
}> {
  const files: RepoSnapshot["files"] = [];
  const missed: string[] = [];
  const missedPaths: string[] = [];
  let bytes = 0;
  // Em paralelo, e o teto aplicado na ordem do pedido.
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
    // "X" e "X.tsx" no mesmo pedido: o arquivo entra uma vez só.
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
 * Imports locais dos arquivos do snapshot que não estão nele, como caminhos na
 * raiz do repo (sem extensão quando o import não tem), até
 * MISSING_IMPORTS_MAX. O modelo não sabia os caminhos e pedia o do import
 * (`../../components/...`), que não abre: agora escolhe desta lista.
 */
export function missingImports(snapshot: RepoSnapshot): string[] {
  const have = new Set(snapshot.files.map((f) => f.path));
  const out: string[] = [];
  for (const f of snapshot.files) {
    if (!CODE_EXT.test(f.path)) continue;
    for (const [base, candidates] of importGroups(f.text, f.path)) {
      if (candidates.some((c) => have.has(c))) continue;
      const shown = candidates.length === 1 ? (candidates[0] ?? base) : base;
      // Import estranho (espaço, caminho enorme) não vira linha do prompt.
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

/**
 * Aviso do prompt sobre o bloco de página: a ordem das seções vem do CMS, não
 * do TSX, e o modelo procurava no TSX.
 */
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
  /** O repo, pro arquivo que o snapshot não trouxe. Ausente = uma volta só. */
  read?: RepoReader;
  /** Quanto falta pro prazo da hipótese (ms); sem tempo, não há segunda volta. */
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
    // A lista de importados só serve pra pedir arquivo: só na primeira volta e só com o repo à mão.
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
      // O relato diz o que foi lido a mais e o que não abriu.
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
      // A primeira resposta já valia: a segunda volta quebrar não apaga ela.
      const r = parseRepoAnswer(first, snapshot, check, opts.ctx);
      r.run.observed = `${r.run.observed} (a segunda volta falhou: ${err instanceof Error ? err.message : err})`;
      return r;
    }
  } catch (err) {
    return notRun(
      `falhou ao perguntar ao código: ${err instanceof Error ? err.message : err}`,
    );
  }
}

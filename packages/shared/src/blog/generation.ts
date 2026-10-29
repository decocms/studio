/**
 * A drafted post, turned into the blocks this site renders.
 *
 * The far end of the pipeline: a model wrote sections naming blocks by their
 * component name, and this maps each one onto the `__resolveType` that site
 * actually uses, fills the product slot in whichever of four shapes that site
 * stores, clears unresolved image sentinels and picks a slug nothing has
 * taken. Everything a post needs to render and nothing a model can be trusted
 * to get right.
 */
import { clearSentinels } from "../blog-image-sentinel";
import { asRecord, randomHex, toArray } from "./fields";
import { listBlogPayloads } from "./decofile-scan";
import {
  type AuthorRef,
  type CategoryRef,
  type PlanningMeta,
  setPostStatus,
} from "./post-meta";
import {
  blockComponentName,
  discoverBlogBlockTypes,
  type BlogBlockDiscoveryOptions,
} from "./block-discovery";
import { rawBlockSchema, reconciledSchema } from "./block-schema";
import { citedSections, mentionableSections } from "./formats";
import type { LiveMeta } from "./live-meta";
import { writeProductListIds } from "./product-loader";

/**
 * One correctly-filled example per block the CMS draws its own editor for.
 *
 * Where Studio ships a bespoke editor (`block-registry.tsx`), Studio knows the
 * shape — that editor is the contract, and several of these shapes are ones no
 * schema states plainly: a `List` keeps its items as one newline-joined string,
 * and `Table`, `Checklist`, `Steps`, `StatGroup`, `CardGroup` and `Comparison`
 * all keep theirs as JSON encoded inside a string. A writer handed only a
 * schema gets those wrong every time.
 *
 * Taken from blocks real sites already render, not invented. The floor only:
 * {@link blockExample} overrides any of these with one from the site's own
 * published post, because two sites legitimately store the same block
 * differently and the one that renders there wins.
 *
 * A product slot is deliberately absent — {@link writeProductListIds} fills it
 * in whatever shape the site already uses, so there is nothing here to copy.
 */
export const KNOWN_BLOG_BLOCK_EXAMPLES: Record<
  string,
  Record<string, unknown>
> = {
  Paragraph: {
    html: "<p>A dúvida entre 9000 ou 12000 BTUs é a mais comum na hora de escolher.</p>",
  },
  Heading: { text: "Antes de escolher: o resumo", level: "h2" },
  Quote: {
    quote: "Levei só a mala de bordo e não senti falta de nada.",
    attribution: "Ana, leitora",
  },
  List: {
    items:
      "<strong>Tecnologia Inverter:</strong> temperatura mais estável;\n<strong>Gaveta HortiNatura:</strong> frescor por duas vezes mais tempo;",
    style: "unordered",
  },
  BlockImage: {
    url: "https://cdn.exemplo.com/2026/10/mochila.webp",
    alt: "Mochila escolar azul apoiada em uma cadeira de sala de aula",
    size: "full",
  },
  Video: {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    caption: "Como medir a capacidade da mala",
  },
  Divider: {},
  Cta: { text: "Ver toda a linha Escolar", href: "/escolar" },
  Callout: {
    title: "VOCÊ SABIA?",
    body: "Pediatras recomendam que a mochila carregada não passe de 10% do peso da criança.",
    variant: "tip",
  },
  Code: { code: "const total = itens.length;", language: "ts" },
  Stat: {
    value: "30%",
    label: "menos desperdício",
    description: "Comparado ao modelo anterior da mesma linha.",
  },
  StatGroup: {
    stats:
      '[{"value":"30%","label":"menos desperdício"},{"value":"2x","label":"mais frescor"}]',
  },
  CardGroup: {
    cards:
      '[{"title":"Pré-escola","body":"Pouco material, mochila pequena."},{"title":"Fundamental","body":"Cadernos e livros pesam; considere rodinhas."}]',
  },
  Checklist: {
    title: "Antes de comprar, confira",
    items:
      '["Capacidade em litros","Alças acolchoadas","Compartimento para notebook"]',
  },
  Steps: {
    title: "Como medir",
    steps:
      '[{"title":"Meça a altura","description":"Da base ao topo, sem as alças."},{"title":"Some a profundidade"}]',
  },
  Comparison: {
    left: '{"title":"Com rodinhas","items":["Poupa a coluna","Mais pesada vazia"]}',
    right:
      '{"title":"De costas","items":["Mais leve","Exige ajuste das alças"]}',
  },
  Table: {
    headers: '["Modelo","Capacidade","Preço"]',
    rows: '[["Bordo","38L","R$ 399"],["Média","68L","R$ 599"]]',
  },
};

/** One block the writer may build a section from, with its own typing. */
export interface GenerationBlock {
  name: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  /** How this site already stores the block, when it has one to show. */
  example?: Record<string, unknown>;
}

/** How long an example may be before it costs more prompt than it teaches. */
const MAX_EXAMPLE_CHARS = 600;

/**
 * One of this block as the site already stores it.
 *
 * The derived schema is not always the truth. A prop whose `$ref` did not
 * resolve comes out of `resolveSchema` typed `object` with no properties —
 * a guess, and one a writer acts on: a `List` that stores its items as one
 * newline-joined string was handed a schema saying "object" and dutifully
 * wrote a map. An existing post is what actually renders, so it settles the
 * shape where the schema only describes it.
 *
 * Live posts first: a planning post may itself have been generated wrong, and
 * copying our own mistake back in would make it permanent.
 */
export function blockExample(
  resolveType: string,
  decofile: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const { payload } of listBlogPayloads(decofile, "posts")) {
    for (const raw of toArray(payload.sections)) {
      const section = asRecord(raw);
      if (!section || section.__resolveType !== resolveType) continue;
      const { __resolveType: _type, ...props } = section;
      if (Object.keys(props).length === 0) continue;
      if (JSON.stringify(props).length > MAX_EXAMPLE_CHARS) continue;
      return props;
    }
  }
  return undefined;
}

/** The text every post needs, whatever its format cites. */
const BASIC_TEXT_BLOCKS: ReadonlySet<string> = new Set([
  "Heading",
  "Paragraph",
]);

/**
 * The blocks a format admits, each carrying the schema its props must match.
 *
 * Cited blocks first, then the basic text and the product blocks the site fills; a brief citing nothing admits all.
 *
 * Several blocks can share a component name (a site's override of an app
 * block). The writer only ever sees the name, so the first wins here the same
 * way it does in {@link sectionResolveTypes} — the two must agree, or a section
 * would be written against one schema and saved as another.
 */
export function blocksForFormat(
  format: { value: string },
  meta: LiveMeta,
  decofile: Record<string, unknown>,
  options?: BlogBlockDiscoveryOptions,
): GenerationBlock[] {
  const available = mentionableSections(meta, options);
  const byName = sectionResolveTypes(meta, options);
  const cited = new Set(citedSections(format.value, byName));
  const wanted = available.filter((section) => cited.has(section.resolveType));
  const chosen =
    wanted.length > 0
      ? [
          ...wanted,
          ...available.filter(
            (section) =>
              !cited.has(section.resolveType) &&
              (BASIC_TEXT_BLOCKS.has(section.name) ||
                productSlotOf(blockExample(section.resolveType, decofile)) !==
                  null),
          ),
        ]
      : available;

  const seen = new Set<string>();
  const blocks: GenerationBlock[] = [];
  for (const section of chosen) {
    if (seen.has(section.name)) continue;
    if (byName[section.name] !== section.resolveType) continue;
    seen.add(section.name);
    const example =
      blockExample(section.resolveType, decofile) ??
      KNOWN_BLOG_BLOCK_EXAMPLES[section.name];
    blocks.push({
      name: section.name,
      title: section.title,
      description: section.description ?? "",
      schema: reconciledSchema(
        rawBlockSchema(section.resolveType, meta),
        example,
      ),
      example,
    });
  }
  return blocks;
}

/**
 * Component name → the resolveType this site actually exposes for it.
 *
 * A generated section names its kind (`Heading`); only the site knows whether
 * that is `blog/sections/blocks/Heading.tsx` or its own
 * `site/sections/Blog/Post/Heading.tsx`. Keeping the mapping here means the
 * model never sees a resolveType and so can never invent one.
 */
export function sectionResolveTypes(
  meta: LiveMeta,
  options?: BlogBlockDiscoveryOptions,
): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const block of discoverBlogBlockTypes(meta, options)) {
    const name = blockComponentName(block.resolveType);
    if (!(name in byName)) byName[name] = block.resolveType;
  }
  return byName;
}

/** One section as the drafting tool hands it over, before it becomes a block. */
export interface DraftSection {
  /** The block's name; {@link sectionResolveTypes} maps it to a resolveType. */
  type: string;
  props: Record<string, unknown>;
  /** Campaign product ids, written into the slot in this site's own shape. */
  productIds?: string[];
}

/**
 * A drafted post as {@link buildGeneratedPostPayload} needs it.
 *
 * Declared structurally rather than read off `StudioToolIO`: the generated
 * contract is derived from the tool that imports this module, and a type that
 * points back at its own consumer resolves to whatever the generator was
 * midway through believing.
 */
export interface GeneratedDraft {
  title: string;
  excerpt: string;
  seo: { title: string; description: string };
  cover: { url: string; alt: string };
  categorySlugs: string[];
  authorEmails: string[];
  sections: DraftSection[];
}

/**
 * Turn generated sections into decofile blocks.
 *
 * The props arrive already checked against the block's own JSON Schema, which
 * is what lets this be a spread. It used to be a switch with one case per kind,
 * encoding each block's storage convention by hand — a `List` keeps its items
 * as one newline-joined string — and that was only ever right for the blocks
 * the blog app ships. A site with its own section got the app's assumptions,
 * and a block that saves fine and renders empty is the worst way to be wrong.
 *
 * A kind this site doesn't expose is dropped: better a shorter post than a
 * block the editor can't render.
 */
export function buildPostSections(
  sections: DraftSection[],
  resolveTypes: Record<string, string>,
  /** How each block already stores its product slot, by component name. */
  productShapes: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    const __resolveType = resolveTypes[section.type];
    if (!__resolveType) continue;
    const props = withProducts(
      section.props,
      section.productIds ?? [],
      productShapes[section.type],
    );
    blocks.push({ __resolveType, ...props });
  }
  return blocks;
}

/** The prop a product block points at, by the name its editor already assumes. */
const PRODUCT_SLOTS = ["product", "products"] as const;

/** Which of a block's props is its product slot, if any. */
export function productSlotOf(shape: unknown): string | null {
  const record = asRecord(shape);
  if (!record) return null;
  return PRODUCT_SLOTS.find((slot) => slot in record) ?? null;
}

/**
 * The chosen products, written into the block the way this site stores them.
 *
 * Not left to the writer: every shape but one carries a `__resolveType`, and a
 * writer that never sees one cannot compose one. `writeProductListIds` already
 * preserves whichever of the four forms the site uses, so the shape comes from
 * a block the site already renders and only the ids come from the campaign.
 *
 * With no such block to copy the shape from, the slot is left alone. Guessing
 * a loader ref for a site that stores plain ids hands it something its own
 * section cannot read.
 */
function withProducts(
  props: Record<string, unknown>,
  ids: string[],
  shape: unknown,
): Record<string, unknown> {
  const filled = ids.filter(Boolean);
  const slot = productSlotOf(shape);
  if (filled.length === 0 || !slot) return props;
  const stored = (shape as Record<string, unknown>)[slot];
  return { ...props, [slot]: writeProductListIds(stored, filled) };
}

/** Longest slug a post may carry, suffix included. */
const SLUG_MAX_LENGTH = 80;

/** URL-safe slug from a title: accents folded, punctuation dropped. */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/** Slugify as the author types: keeps the trailing "-" `slugifyTitle` trims, or typing "meu-post" would eat the separator. */
export function maskSlugInput(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/** `base-suffix`, shortening the base so the whole slug still fits the cap. */
function suffixSlug(base: string, suffix: string): string {
  const room = SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, "")}-${suffix}`;
}

/**
 * `slugifyTitle(source)`, suffixed until it stops colliding with `taken`.
 * `fallbackPrefix` names the random slug minted when `source` slugifies to
 * nothing at all (`"!!!"`), so each collection gets its own readable shape.
 */
export function uniqueSlug(
  source: string,
  taken: string[],
  fallbackPrefix: string,
): string {
  const base = slugifyTitle(source) || `${fallbackPrefix}-${randomHex(6)}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = suffixSlug(base, String(n));
    if (!used.has(candidate)) return candidate;
  }
  return suffixSlug(base, randomHex(4));
}

/** {@link uniqueSlug} for a post title. */
export function uniquePostSlug(title: string, taken: string[]): string {
  return uniqueSlug(title, taken, "post");
}

/** {@link uniqueSlug} for a category name. */
export function uniqueCategorySlug(source: string, taken: string[]): string {
  return uniqueSlug(source, taken, "category");
}

/** A freshly generated post: lands in Awaiting review, cover and all. */
export function buildGeneratedPostPayload({
  draft,
  resolveTypes,
  productShapes,
  categories,
  authors,
  planning,
  takenSlugs,
  now,
}: {
  /**
   * The drafted post. `cover.url` is filled by whoever drew it — the drafting
   * tool when it was given a bucket, BLOG_POST_ILLUSTRATE otherwise — so the
   * brief that produced it is not this function's business.
   */
  draft: GeneratedDraft;
  resolveTypes: Record<string, string>;
  /** How each block already stores its product slot, by component name. */
  productShapes?: Record<string, unknown>;
  /** The site's categories, to resolve the chosen slugs into stored refs. */
  categories: CategoryRef[];
  /** The site's authors, to resolve the chosen emails into stored refs. */
  authors: AuthorRef[];
  /** The briefing the card was generated from, kept for the board card. */
  planning?: PlanningMeta;
  takenSlugs: string[];
  now: Date;
}): Record<string, unknown> {
  const chosenCategories = new Set(draft.categorySlugs);
  const chosenAuthors = new Set(draft.authorEmails);
  const payload: Record<string, unknown> = {
    title: draft.title,
    slug: uniquePostSlug(draft.title, takenSlugs),
    date: now.toISOString().slice(0, 10),
    excerpt: draft.excerpt,
    image: draft.cover.url,
    alt: draft.cover.alt,
    authors: authors.filter((author) => chosenAuthors.has(author.email)),
    categories: categories.filter((c) => chosenCategories.has(c.slug)),
    seo: {
      title: draft.seo.title,
      description: draft.seo.description,
      image: draft.cover.url,
    },
    /**
     * Cleared here because this is where the browser persists. A sentinel is
     * the drafting model's note to the illustrator; whoever skipped it, or ran
     * it without a bucket, an unresolved one saved as an image address renders
     * broken on the published page.
     */
    sections: clearSentinels(
      buildPostSections(draft.sections, resolveTypes, productShapes),
    ),
    planning: (planning ?? {}) as Record<string, unknown>,
  };
  return setPostStatus(payload, "awaiting_review", now);
}

/**
 * Which blocks this site can actually render a post out of.
 *
 * A site exposes its sections through `/live/_meta`; the blog app ships a
 * handful of its own. Both are offered to a writer, and a block the editor
 * cannot render is worse than a shorter post — so discovery is the same list
 * on both sides of the wall.
 */
import { type LiveMeta, resolveBlockSchemaMetadata } from "./live-meta";

export type BlogBlockSource = "app" | "site";

export interface BlogBlockType {
  resolveType: string;
  title: string;
  description?: string;
  /** @untitledui/icons component name; resolved via getIconComponent. */
  iconName: string;
  /** URL when the section declares `@icon` as an image (http(s)/data/absolute). */
  iconUrl?: string;
  /** "app" = deco-cms/blog built-ins; "site" = section defined by this site. */
  source: BlogBlockSource;
}

/** How a caller narrows the blocks a post may be written with. */
export interface BlogBlockDiscoveryOptions {
  /** Drop the `deco-cms/blog` built-ins — the `hide_default_blog_blocks` flag. */
  hideDefaults?: boolean;
}

/**
 * Defaults for the well-known blog block component names. Used to give
 * the inserter pretty labels, descriptions and icons.
 *
 * For **app blocks** (`blog/sections/blocks/*`) the catalog overrides the
 * schema metadata — built-in schemas typically just echo the class name
 * (e.g. "BlockImage"), and we want the friendly label ("Image") instead.
 *
 * For **site blocks** (`site/sections/Blog/Post/*`) the schema's `@title`
 * / `@description` / `@icon` win — site authors should be in control of
 * their own block presentation. The catalog only fills in when the schema
 * omits a field.
 */
const KNOWN_BLOG_BLOCK_CATALOG: Record<
  string,
  { title: string; description: string; iconName: string }
> = {
  Paragraph: {
    title: "Paragraph",
    description: "Rich text content",
    iconName: "Pilcrow01",
  },
  Heading: {
    title: "Heading",
    description: "Section title (H1–H6)",
    iconName: "HeadingSquare",
  },
  Quote: {
    title: "Quote",
    description: "Pull quote",
    iconName: "MessageTextSquare02",
  },
  Code: {
    title: "Code",
    description: "Code block with syntax highlighting",
    iconName: "Code02",
  },
  List: {
    title: "List",
    description: "Bulleted or numbered list",
    iconName: "List",
  },
  BlockImage: {
    title: "Image",
    description: "Image with optional caption",
    iconName: "Image01",
  },
  Video: {
    title: "Video",
    description: "Embedded video",
    iconName: "PlayCircle",
  },
  Divider: {
    title: "Divider",
    description: "Horizontal divider",
    iconName: "Divider",
  },
  Cta: {
    title: "Call to action",
    description: "Button linking to a URL",
    iconName: "CursorClick01",
  },
  Callout: {
    title: "Callout",
    description: "Highlighted note, tip or warning",
    iconName: "Lightbulb02",
  },
  Stat: {
    title: "Stat",
    description: "Single key metric",
    iconName: "BarChartSquareUp",
  },
  StatGroup: {
    title: "Stat group",
    description: "Row of metrics",
    iconName: "BarChartSquare02",
  },
  CardGroup: {
    title: "Card group",
    description: "Grid of cards",
    iconName: "LayoutGrid01",
  },
  Checklist: {
    title: "Checklist",
    description: "List of check items",
    iconName: "CheckSquare",
  },
  Steps: {
    title: "Steps",
    description: "Step-by-step guide",
    iconName: "LayersThree01",
  },
  Comparison: {
    title: "Comparison",
    description: "Side-by-side comparison",
    iconName: "Columns03",
  },
  Table: {
    title: "Table",
    description: "Rows and columns of structured data",
    iconName: "Table",
  },
  ProductCard: {
    title: "Product card",
    description: "Single product",
    iconName: "Tag01",
  },
  ProductShelf: {
    title: "Product shelf",
    description: "Row of products",
    iconName: "ShoppingBag01",
  },
};

const FALLBACK_BLOG_BLOCK_ICON = "Box";

function blogBlockSource(resolveType: string): BlogBlockSource {
  return resolveType.startsWith("site/") ? "site" : "app";
}

/**
 * Schema `icon` strings can be either an @untitledui/icons component name
 * (e.g. "Pilcrow01") or an image URL declared via `@icon`. URLs start
 * with a protocol, `data:`, or an absolute path.
 */
function isImageUrl(icon: string): boolean {
  return (
    icon.startsWith("http://") ||
    icon.startsWith("https://") ||
    icon.startsWith("data:") ||
    icon.startsWith("/")
  );
}

/**
 * Pick the first defined value among the candidates. Used to express
 * precedence chains compactly without `??` ladders that obscure intent.
 */
function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined) return c;
  }
  return undefined;
}

/**
 * Some site schemas leave `@title`/`@description` as the raw resolveType (e.g.
 * "site/sections/Blog/Post/BlockImage.tsx"). That is a path, not a label — drop
 * it so the friendly catalog name shows instead.
 */
function humanLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("/") || /\.(tsx?|jsx?)$/.test(value)) return undefined;
  return value;
}

/** "BlockImage" -> "Block image", "ProductShelf" -> "Product shelf". */
function humanizeComponentName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Title, description and icon for one blog block, with the precedence
 * described in KNOWN_BLOG_BLOCK_CATALOG. Callers that only hold a stored
 * block's `__resolveType` (the generic block editor) use this to name what is
 * being edited; the inserter builds its whole list from it.
 */
export function blogBlockTypeFor(
  resolveType: string,
  meta: LiveMeta,
): BlogBlockType {
  const md = resolveBlockSchemaMetadata(resolveType, meta);
  const name = blockComponentName(resolveType);
  const catalog = KNOWN_BLOG_BLOCK_CATALOG[name];
  const source = blogBlockSource(resolveType);

  // Site schema label wins, but only a real one — never a path-like default.
  const mdTitle = humanLabel(md.title);
  const mdDescription = humanLabel(md.description);
  const title =
    (source === "site"
      ? pick(mdTitle, catalog?.title)
      : pick(catalog?.title, mdTitle)) ?? humanizeComponentName(name);
  const description =
    source === "site"
      ? pick(mdDescription, catalog?.description)
      : pick(catalog?.description, mdDescription);

  // Only a site block's `@icon` is trusted: built-in schemas carry no icon hint.
  const rawIcon = source === "site" ? md.icon : undefined;
  const iconUrl = rawIcon && isImageUrl(rawIcon) ? rawIcon : undefined;
  const iconName =
    iconUrl !== undefined
      ? (catalog?.iconName ?? FALLBACK_BLOG_BLOCK_ICON)
      : (pick(rawIcon, catalog?.iconName) ?? FALLBACK_BLOG_BLOCK_ICON);

  return { resolveType, title, description, iconName, iconUrl, source };
}

/**
 * Discover the content block types a post can contain from the live
 * manifest, with title/icon metadata for the inserter UI. Recognizes both
 * the `deco-cms/blog` app blocks (`blog/sections/blocks/*`) and
 * site-defined blog blocks (`site/sections/Blog/Post/*`), matching the
 * same set that `isBlogPostBlockResolveType` accepts everywhere else.
 */
export function discoverBlogBlockTypes(
  meta: LiveMeta,
  { hideDefaults = false }: BlogBlockDiscoveryOptions = {},
): BlogBlockType[] {
  const seen = new Set<string>();
  const out: BlogBlockType[] = [];
  const groups = meta.manifest?.blocks ?? {};
  for (const group of Object.values(groups)) {
    for (const resolveType of Object.keys(group)) {
      if (!isBlogPostBlockResolveType(resolveType) || seen.has(resolveType)) {
        continue;
      }
      if (hideDefaults && blogBlockSource(resolveType) === "app") continue;
      seen.add(resolveType);
      out.push(blogBlockTypeFor(resolveType, meta));
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** "site/sections/Blog/Post/Paragraph.tsx" -> "Paragraph" */
export function blockComponentName(resolveType: string): string {
  const base = resolveType.split("/").pop() ?? resolveType;
  return base.replace(/\.(tsx?|jsx?)$/, "");
}

const BLOG_POST_BLOCK_PREFIXES = [
  "blog/sections/blocks/",
  "site/sections/Blog/Post/",
] as const;

/** True when resolveType points at a blog post content block editor. */
export function isBlogPostBlockResolveType(resolveType: string): boolean {
  return BLOG_POST_BLOCK_PREFIXES.some((prefix) =>
    resolveType.startsWith(prefix),
  );
}

// ------------------ Brand rules (dos / guardrails / values / competitors) ----

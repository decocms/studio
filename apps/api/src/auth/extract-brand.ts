/**
 * Firecrawl brand extraction — shared logic used by both the
 * BRAND_CONTEXT_EXTRACT MCP tool and the domain-setup endpoint.
 */

export interface ExtractedBrand {
  name: string;
  domain: string;
  overview: string;
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
  fonts: {
    heading?: string;
    body?: string;
    code?: string;
  } | null;
  colors: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    foreground?: string;
  } | null;
  images: null;
  metadata: Record<string, unknown> | null;
}

/**
 * Scrape a website via Firecrawl and extract branding data.
 * Returns null if the API call fails or returns no branding.
 * Throws on missing API key.
 */
export async function extractBrandFromDomain(
  domain: string,
  firecrawlApiKey: string,
  fallbackName?: string,
): Promise<ExtractedBrand | null> {
  let url = domain.trim();
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${firecrawlApiKey}`,
    },
    body: JSON.stringify({ url, formats: ["branding"] }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Firecrawl API error: ${response.status} ${text.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as {
    success?: boolean;
    data?: {
      branding?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  };

  if (!result.success || !result.data?.branding) {
    return null;
  }

  const branding = result.data.branding;
  const metadata = result.data.metadata ?? {};
  const mapped = mapFirecrawlBranding(branding, metadata);

  // Derive name — prefer the shortest segment after a separator in the
  // title (e.g. "Visual CMS for Your Storefront | Deco" → "Deco"),
  // then ogSiteName, then the fallback.
  const titleParts = (metadata.title as string)
    ?.split(/[|–—]|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const shortestPart = titleParts
    ?.slice()
    .sort((a, b) => a.length - b.length)[0];
  const name =
    shortestPart ?? (metadata.ogSiteName as string) ?? fallbackName ?? domain;

  return {
    name,
    domain,
    overview: (metadata.description as string) ?? "",
    logo: mapped.logo,
    favicon: mapped.favicon,
    ogImage: mapped.ogImage,
    fonts: mapped.fonts,
    colors: mapped.colors,
    images: null,
    metadata: Object.keys(mapped.metadata).length > 0 ? mapped.metadata : null,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

const COLOR_ROLES = new Set([
  "primary",
  "secondary",
  "accent",
  "background",
  "foreground",
]);

const FONT_ROLE_MAP: Record<string, string> = {
  heading: "heading",
  headings: "heading",
  head: "heading",
  title: "heading",
  body: "body",
  primary: "body",
  text: "body",
  code: "code",
  monospace: "code",
  mono: "code",
};

function mapFirecrawlBranding(
  branding: Record<string, unknown>,
  metadata: Record<string, unknown>,
): {
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
  fonts: ExtractedBrand["fonts"];
  colors: ExtractedBrand["colors"];
  metadata: Record<string, unknown>;
} {
  const images = (branding.images ?? {}) as Record<string, unknown>;

  // Colors: pick known semantic roles from branding.colors
  const rawColors = (branding.colors ?? {}) as Record<string, unknown>;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawColors)) {
    if (typeof value === "string" && value && COLOR_ROLES.has(key)) {
      colors[key] = value;
    }
  }

  // Fonts: map fontFamilies roles to semantic roles
  const fonts: Record<string, string> = {};
  const typography = (branding.typography ?? {}) as Record<string, unknown>;
  const fontFamilies = (typography.fontFamilies ?? {}) as Record<
    string,
    unknown
  >;

  for (const [role, family] of Object.entries(fontFamilies)) {
    if (typeof family === "string" && family) {
      const mapped = FONT_ROLE_MAP[role.toLowerCase()];
      if (mapped && !fonts[mapped]) {
        fonts[mapped] = family;
      }
    }
  }

  // Fallback: additional fonts from the fonts array
  const rawFonts = branding.fonts;
  if (Array.isArray(rawFonts)) {
    for (const f of rawFonts) {
      const family = (f as Record<string, unknown>).family;
      if (typeof family === "string" && family && !fonts.body) {
        fonts.body = family;
      }
    }
  }

  const richMetadata: Record<string, unknown> = {};
  for (const key of [
    "typography",
    "components",
    "spacing",
    "layout",
    "animations",
    "icons",
    "tone",
    "personality",
    "colorScheme",
  ]) {
    if (branding[key] !== undefined) {
      richMetadata[key] = branding[key];
    }
  }

  return {
    logo: (images.logo as string) ?? null,
    favicon: (images.favicon as string) ?? null,
    ogImage: (images.ogImage as string) ?? (metadata.ogImage as string) ?? null,
    fonts:
      Object.keys(fonts).length > 0 ? (fonts as ExtractedBrand["fonts"]) : null,
    colors:
      Object.keys(colors).length > 0
        ? (colors as ExtractedBrand["colors"])
        : null,
    metadata: richMetadata,
  };
}

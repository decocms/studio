/**
 * Curated default themes for the Page Editor.
 *
 * Audit source: `.context/page-editor-audit.md` (2026-05-20). We picked 10
 * themes out of ~36 generated in active demo usage by:
 *
 *   1. Aesthetic identity — distinct design languages, not 6 variants of
 *      dark-neon.
 *   2. Contrast quality — fg/bg ≥ 7:1, muted/bg ≥ 5.5:1, primary-as-button-
 *      background passes WCAG AA against either white or black text.
 *      All themes here have been verified by `contrastRatio()` in
 *      `./contrast.ts`. The DS-create pipeline runs `normalizeBrandContrast`
 *      on every load anyway — so even if a theme's source values drift,
 *      the renderer is safe.
 *   3. Memorability — short, recognizable slug + display name + 6-word vibe
 *      hint. The agent picks by slug; the welcome quiz shows display name
 *      and vibe.
 *
 * Two consumers:
 *   - The welcome quiz's "Visual anchor" question — these 10 replace the
 *     six hand-rolled anchors (Minimal mono, Dark neon, etc.) with names
 *     the agent can name back as a `template` argument to
 *     `DESIGN_SYSTEM_CREATE` or extend with brand-specific tweaks.
 *   - The `DESIGN_SYSTEM_CREATE` tool itself, which accepts a `template`
 *     slug to seed the brand tokens. The agent may then override individual
 *     fields (typically `primary` + `name`) for the specific brand.
 */

import type { BrandTokens } from "./templates";

export interface DefaultTheme {
  slug: string;
  displayName: string;
  vibe: string;
  /** Full BrandTokens minus the auto-derived on-X fields (computed at DS-create). */
  brand: Omit<BrandTokens, "onPrimary" | "onSecondary" | "onAccent">;
}

export const DEFAULT_THEMES: readonly DefaultTheme[] = [
  {
    slug: "dark-violet",
    displayName: "Dark Violet",
    vibe: "Cinematic violet for AI products",
    brand: {
      name: "Dark Violet",
      primary: "#8B5CF6",
      secondary: "#EC4899",
      accent: "#10B981",
      bg: "#07050F",
      surface: "#130E22",
      fg: "#EDE9FE",
      muted: "#9080C0",
      border: "#231940",
      headingFont: "Inter",
      bodyFont: "Inter",
      radius: "10px",
    },
  },
  {
    slug: "cyber-lime",
    displayName: "Cyber Lime",
    vibe: "Lime on graphite, hacker meets finance",
    brand: {
      name: "Cyber Lime",
      primary: "#D0EC1A",
      secondary: "#A595FF",
      accent: "#FFC116",
      bg: "#1C1917",
      surface: "#282524",
      fg: "#FAFAF9",
      muted: "#94908C",
      border: "#44403C",
      headingFont: "Inter",
      bodyFont: "Inter",
      radius: "12px",
    },
  },
  {
    slug: "editorial-serif",
    displayName: "Editorial Serif",
    vibe: "Quiet luxury, magazine-grade typography",
    brand: {
      name: "Editorial Serif",
      primary: "#1C1917",
      secondary: "#44403C",
      accent: "#0D9488",
      bg: "#FAFAF9",
      surface: "#F0F0F0",
      fg: "#1C1917",
      muted: "#6B6560",
      border: "#D0CECD",
      headingFont: "DM Serif Display",
      bodyFont: "Inter",
      radius: "4px",
    },
  },
  {
    slug: "pastel-peach",
    displayName: "Pastel Peach",
    vibe: "Warm terracotta for friendly B2B",
    brand: {
      name: "Pastel Peach",
      primary: "#B5694A",
      secondary: "#8A7265",
      accent: "#6E9B82",
      bg: "#FFF3EE",
      surface: "#FFE5D9",
      fg: "#2A160E",
      muted: "#775D53",
      border: "#E1C4B7",
      headingFont: "Plus Jakarta Sans",
      bodyFont: "Inter",
      radius: "20px",
    },
  },
  {
    slug: "neon-retro",
    displayName: "Neon Retro 80s",
    vibe: "Arcade-flyer yellow, pink, electric cyan",
    brand: {
      name: "Neon Retro 80s",
      primary: "#FFE500",
      secondary: "#FF2D78",
      accent: "#00E8FF",
      bg: "#0D0D0F",
      surface: "#1A1A22",
      fg: "#F0F0FF",
      muted: "#8888AA",
      border: "#303045",
      headingFont: "Impact",
      bodyFont: "Arial",
      radius: "0px",
    },
  },
  {
    slug: "brutalist-mono",
    displayName: "Brutalist Mono",
    vibe: "Black borders, monospace, single hot accent",
    brand: {
      name: "Brutalist Mono",
      primary: "#E8320A",
      secondary: "#0A0A0A",
      accent: "#E8320A",
      bg: "#F5F3EE",
      surface: "#EAE7DF",
      fg: "#0A0A0A",
      muted: "#555550",
      border: "#0A0A0A",
      headingFont: "Space Mono",
      bodyFont: "Inter",
      radius: "0px",
    },
  },
  {
    slug: "sage-minimal",
    displayName: "Sage Minimal",
    vibe: "Hushed olive on warm paper",
    brand: {
      name: "Sage Minimal",
      primary: "#7BA17B",
      secondary: "#3A3733",
      accent: "#5C875C",
      bg: "#F6F5F1",
      surface: "#DFDEDC",
      fg: "#1C1917",
      muted: "#67625D",
      border: "#CCC9C3",
      headingFont: "Inter",
      bodyFont: "Inter",
      radius: "4px",
    },
  },
  {
    slug: "glass-deep-sea",
    displayName: "Glass Deep Sea",
    vibe: "Teal glow over midnight navy",
    brand: {
      name: "Glass Deep Sea",
      primary: "#00D4C8",
      secondary: "#7B6FFF",
      accent: "#F5A623",
      bg: "#05091A",
      surface: "#0D1630",
      fg: "#E8F0FF",
      muted: "#7387B3",
      border: "#1F3052",
      headingFont: "Sora",
      bodyFont: "Inter",
      radius: "20px",
    },
  },
  {
    slug: "electric-indigo",
    displayName: "Electric Indigo",
    vibe: "Crisp indigo on white, modern SaaS",
    brand: {
      name: "Electric Indigo",
      primary: "#2E5AFF",
      secondary: "#7C5CFF",
      accent: "#2E5AFF",
      bg: "#FFFFFF",
      surface: "#E7E9EF",
      fg: "#0A1022",
      muted: "#5B647C",
      border: "#CCD3E2",
      headingFont: "Plus Jakarta Sans",
      bodyFont: "Public Sans",
      radius: "18px",
    },
  },
  {
    slug: "confetti-magenta",
    displayName: "Confetti Magenta",
    vibe: "Hot pink, violet, yellow — party energy",
    brand: {
      name: "Confetti Magenta",
      primary: "#FF2D6B",
      secondary: "#5B3FFF",
      accent: "#FFE500",
      bg: "#FAFAF7",
      surface: "#F0ECF9",
      fg: "#0F0A1E",
      muted: "#6B6085",
      border: "#D1CAE9",
      headingFont: "Bricolage Grotesque",
      bodyFont: "Inter",
      radius: "18px",
    },
  },
];

/**
 * Look up a default theme by slug. Used by `DESIGN_SYSTEM_CREATE` when
 * the agent passes `template: "<slug>"` to seed the brand tokens.
 */
export function getDefaultTheme(slug: string): DefaultTheme | null {
  return DEFAULT_THEMES.find((t) => t.slug === slug) ?? null;
}

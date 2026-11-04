/**
 * Mock data for reviewing the skills UI. The catalog doesn't send `category`
 * or `bundles` yet and projects can't store picks, so this fills both in:
 * the taxonomy and each skill's place in it, plus picks kept in the browser.
 * Replace with the catalog's frontmatter and the project's metadata once
 * those land.
 */

import { useLocalStorage } from "@/hooks/use-local-storage";
import type { OrgFsSkillCatalogEntry } from "@/hooks/use-org-fs";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export const SKILL_CATEGORY_IDS = [
  "storefront",
  "performance",
  "seo",
  "analytics",
  "migration",
  "quality",
  "delivery",
  "content",
  "platform",
] as const;

export type SkillCategoryId = (typeof SKILL_CATEGORY_IDS)[number];

export function isSkillCategory(
  value: string | undefined | null,
): value is SkillCategoryId {
  return SKILL_CATEGORY_IDS.some((id) => id === value);
}

export const SKILL_BUNDLES = [
  { id: "pr-qa", category: "quality" },
  { id: "pr-review", category: "delivery" },
  { id: "storefront-building", category: "storefront" },
  { id: "storefront-performance", category: "performance" },
  { id: "caching", category: "performance" },
  { id: "seo-audit", category: "seo" },
  { id: "store-diagnostic", category: "analytics" },
  { id: "conversion-analysis", category: "analytics" },
  { id: "migration-tanstack", category: "migration" },
  { id: "migration-faststore", category: "migration" },
  { id: "go-live", category: "quality" },
  { id: "jira-workflow", category: "delivery" },
  { id: "office-documents", category: "content" },
  { id: "presentations", category: "content" },
  { id: "writing", category: "content" },
  { id: "security-audit", category: "quality" },
  { id: "mcp-apps", category: "platform" },
] as const satisfies ReadonlyArray<{ id: string; category: SkillCategoryId }>;

export type SkillBundleId = (typeof SKILL_BUNDLES)[number]["id"];

const BUNDLE_REF_PREFIX = "bundle:";

/** What a project stores for a whole bundle: `bundle:<id>`. */
export function bundleRef(id: SkillBundleId): string {
  return `${BUNDLE_REF_PREFIX}${id}`;
}

/** The bundle id a reference names, or null for a plain skill id. */
export function bundleIdOfRef(ref: string): string | null {
  return ref.startsWith(BUNDLE_REF_PREFIX)
    ? ref.slice(BUNDLE_REF_PREFIX.length)
    : null;
}

interface MockPlacement {
  category: SkillCategoryId;
  bundles?: SkillBundleId[];
}

/** Keyed by the skill's folder name, the last segment of its catalog id. */
const MOCK_PLACEMENT: Record<string, MockPlacement> = {
  "asset-hash-busting": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  "bump-dependencies": { category: "storefront" },
  brand: { category: "content", bundles: ["presentations"] },
  cache: { category: "performance", bundles: ["caching"] },
  "cacheable-matchers": { category: "performance", bundles: ["caching"] },
  canonical: { category: "seo", bundles: ["seo-audit"] },
  "client-js-budget": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  "cms-friendly-props": {
    category: "storefront",
    bundles: ["storefront-building"],
  },
  "deco-bot-rendering": {
    category: "seo",
    bundles: ["storefront-performance", "seo-audit"],
  },
  "deduplicate-loaders": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  docx: { category: "content", bundles: ["office-documents"] },
  "ecommerce-qa": { category: "quality", bundles: ["pr-qa"] },
  "figma-to-deco": { category: "storefront", bundles: ["storefront-building"] },
  "file-reading": { category: "content", bundles: ["office-documents"] },
  "fix-bug": { category: "storefront", bundles: ["pr-review"] },
  "flutter-app": { category: "platform" },
  "hardcoded-to-blocks": {
    category: "storefront",
    bundles: ["storefront-building"],
  },
  "html-size-optimizer": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  "image-optimizer": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  images: { category: "performance", bundles: ["storefront-performance"] },
  "jira-execute": { category: "delivery", bundles: ["jira-workflow"] },
  "jira-merge": { category: "delivery", bundles: ["jira-workflow"] },
  "jira-qa-gate": { category: "delivery", bundles: ["jira-workflow"] },
  "jira-release": { category: "delivery", bundles: ["jira-workflow"] },
  "jira-review": { category: "delivery", bundles: ["jira-workflow"] },
  "jira-validate-production": {
    category: "delivery",
    bundles: ["jira-workflow"],
  },
  "monitor-summary": { category: "analytics", bundles: ["store-diagnostic"] },
  "new-page": { category: "storefront", bundles: ["storefront-building"] },
  "new-section": { category: "storefront", bundles: ["storefront-building"] },
  "pagespeed-score-model": {
    category: "performance",
    bundles: ["storefront-performance"],
  },
  pdf: { category: "content", bundles: ["office-documents"] },
  pptx: { category: "content", bundles: ["office-documents"] },
  "qa-screenshot": { category: "quality", bundles: ["pr-qa"] },
  review: { category: "delivery", bundles: ["pr-review"] },
  robots: { category: "seo", bundles: ["seo-audit"] },
  "seo-sections": { category: "seo", bundles: ["seo-audit"] },
  "setup-blog": { category: "storefront", bundles: ["storefront-building"] },
  slides: { category: "content", bundles: ["presentations"] },
  "tanstack-go-live-check": { category: "quality", bundles: ["go-live"] },
  "task-board-setup": { category: "delivery" },
  templating: { category: "content", bundles: ["presentations"] },
  "tool-scripting": { category: "platform", bundles: ["mcp-apps"] },
  troubleshooting: { category: "storefront" },
  variants: { category: "storefront", bundles: ["storefront-building"] },
  video: { category: "storefront", bundles: ["storefront-building"] },
  "vtex-login-headless": {
    category: "storefront",
    bundles: ["storefront-building"],
  },
  xlsx: { category: "content", bundles: ["office-documents"] },
};

/** The catalog with a mock category and bundles wherever the frontmatter has none. */
export function withMockPlacement(
  entries: OrgFsSkillCatalogEntry[],
): OrgFsSkillCatalogEntry[] {
  return entries.map((entry) => {
    const mock = MOCK_PLACEMENT[entry.id.split("/").pop() ?? ""];
    if (!mock) return entry;
    return {
      ...entry,
      category: entry.category ?? mock.category,
      bundles: entry.bundles ?? mock.bundles,
    };
  });
}

/** A project's picks, kept in this browser until projects can store them. */
export function useMockProjectSkills(projectId: string) {
  return useLocalStorage<string[]>(
    LOCALSTORAGE_KEYS.mockProjectSkills(projectId),
    [],
  );
}

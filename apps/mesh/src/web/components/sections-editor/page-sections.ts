import type { RawSection } from "./section-types";
import type { PageVariant } from "./page-variants";

export type { PageVariant };

export function buildPageDataWithSections(
  decofile: Record<string, unknown>,
  pageKey: string,
  updatedSections: RawSection[],
  variantIndex: number,
  pageVariants: PageVariant[],
): Record<string, unknown> {
  const fullPageData = {
    ...(decofile[pageKey] as Record<string, unknown>),
  };

  if (pageVariants.length > 1) {
    const currentSections = fullPageData.sections as Record<string, unknown>;
    const variants = [
      ...((currentSections?.variants as Array<Record<string, unknown>>) ?? []),
    ];
    if (variants[variantIndex]) {
      variants[variantIndex] = {
        ...variants[variantIndex],
        value: updatedSections,
      };
    }
    fullPageData.sections = { ...currentSections, variants };
  } else {
    fullPageData.sections = updatedSections;
  }

  return fullPageData;
}

export function cloneSection(section: RawSection): RawSection {
  return structuredClone(section);
}

export function canMakeSectionReusable(section: {
  isSavedBlock?: boolean;
  isMultivariate?: boolean;
}): boolean {
  return !section.isSavedBlock && !section.isMultivariate;
}

export function suggestBlockId(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_-]/g, "");
  if (/^[A-Za-z]/.test(cleaned)) return cleaned;
  if (cleaned) return `Block${cleaned}`;
  return "";
}

export function validateBlockId(
  blockId: string,
  decofile: Record<string, unknown>,
): string | null {
  const trimmed = blockId.trim();
  if (!trimmed) return "Block name is required.";
  if (trimmed.includes("/")) {
    return "Block name cannot contain slashes.";
  }
  if (Object.hasOwn(decofile, trimmed)) {
    return "A block with this name already exists.";
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) {
    return "Use letters, numbers, hyphens, or underscores. Must start with a letter.";
  }
  return null;
}

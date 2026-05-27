import { isLazyResolveType } from "./section-lazy";
import { labelFromResolveType, type RawSection } from "./section-types";

export interface ParsedSection {
  index: number;
  resolveType: string;
  label: string;
  isLazy?: boolean;
  isHidden?: boolean;
  isSavedBlock?: boolean;
  isMultivariate?: boolean;
}

/**
 * Parse raw decofile sections into display-ready entries with
 * isLazy / isHidden / isSavedBlock / isMultivariate flags.
 * Mirrors admin-mcp's `parseSectionsFromArray()`.
 */
export function parseSections(
  rawSections: RawSection[],
  decofile: Record<string, unknown>,
): ParsedSection[] {
  return rawSections.map((s, idx) => {
    const rt = s.__resolveType ?? "";
    const isLazy = isLazyResolveType(rt);

    if (!isLazy && rt !== "" && !rt.includes("/") && rt in decofile) {
      const resolvedBlock = decofile[rt] as Record<string, unknown> | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        rt.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: false,
        isSavedBlock: true,
      };
    }

    const innerSection = isLazy
      ? (s.section as RawSection | undefined)
      : undefined;
    const mvRt = isLazy ? (innerSection?.__resolveType ?? "") : rt;

    if (mvRt.includes("flags/multivariate")) {
      const mvObj = (isLazy ? innerSection : s) as RawSection;
      const rawVariants = Array.isArray(mvObj?.variants) ? mvObj.variants : [];

      const NEVER_TYPES = ["website/matchers/never.ts"];
      if (
        rawVariants.length === 1 &&
        NEVER_TYPES.includes(
          (rawVariants[0]?.rule?.__resolveType as string) ?? "",
        )
      ) {
        const innerValue = (rawVariants[0]?.value ?? {}) as Record<
          string,
          unknown
        >;
        let innerRt = (innerValue.__resolveType as string) ?? "";
        const innerIsLazy = isLazyResolveType(innerRt);
        if (innerIsLazy) {
          const nested = innerValue.section as
            | Record<string, unknown>
            | undefined;
          innerRt = (nested?.__resolveType as string) ?? innerRt;
        }
        return {
          index: idx,
          resolveType: rt,
          label: labelFromResolveType(innerRt) || `Section ${idx + 1}`,
          isHidden: true,
          isLazy: innerIsLazy,
        };
      }

      const firstValueRt = (
        rawVariants[0]?.value as Record<string, unknown> | undefined
      )?.__resolveType as string | undefined;
      const sectionLabel = firstValueRt
        ? labelFromResolveType(firstValueRt)
        : "Section";
      return {
        index: idx,
        resolveType: rt,
        label: `Variants of ${sectionLabel}`,
        isMultivariate: true,
        isLazy,
      };
    }

    const effectiveRt = isLazy ? (s.section?.__resolveType ?? rt) : rt;
    if (
      isLazy &&
      effectiveRt !== "" &&
      !effectiveRt.includes("/") &&
      effectiveRt in decofile
    ) {
      const resolvedBlock = decofile[effectiveRt] as
        | Record<string, unknown>
        | undefined;
      const label =
        (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
        effectiveRt
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()) ||
        `Section ${idx + 1}`;
      return {
        index: idx,
        resolveType: rt,
        label,
        isLazy: true,
        isSavedBlock: true,
      };
    }

    return {
      index: idx,
      resolveType: rt,
      label: labelFromResolveType(effectiveRt) || `Section ${idx + 1}`,
      isLazy,
    };
  });
}

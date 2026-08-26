import { isSavedBlockResolveType } from "./block-type-utils";
import { isLazyResolveType } from "./section-lazy";
import {
  labelFromResolveType,
  NEVER_MATCHER_RESOLVE_TYPE,
  PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE,
  SECTION_MULTIVARIATE_RESOLVE_TYPE,
  type RawSection,
} from "./section-types";

export interface ParsedSection {
  index: number;
  resolveType: string;
  label: string;
  isLazy?: boolean;
  isHidden?: boolean;
  isSavedBlock?: boolean;
  isMultivariate?: boolean;
}

/** A saved block's own `name`, or its resolveType humanized, or a positional fallback. */
function resolvedBlockLabel(
  blockKey: string,
  idx: number,
  decofile: Record<string, unknown>,
): string {
  const resolvedBlock = decofile[blockKey] as
    | Record<string, unknown>
    | undefined;
  return (
    (typeof resolvedBlock?.name === "string" && resolvedBlock.name) ||
    blockKey.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ||
    `Section ${idx + 1}`
  );
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

    if (!isLazy && rt !== "" && isSavedBlockResolveType(rt) && rt in decofile) {
      return {
        index: idx,
        resolveType: rt,
        label: resolvedBlockLabel(rt, idx, decofile),
        isLazy: false,
        isSavedBlock: true,
      };
    }

    const innerSection = isLazy
      ? (s.section as RawSection | undefined)
      : undefined;
    const mvRt = isLazy ? (innerSection?.__resolveType ?? "") : rt;

    if (
      mvRt === PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE ||
      mvRt === SECTION_MULTIVARIATE_RESOLVE_TYPE
    ) {
      const mvObj = (isLazy ? innerSection : s) as RawSection;
      const rawVariants = Array.isArray(mvObj?.variants) ? mvObj.variants : [];

      if (
        rawVariants.length === 1 &&
        ((rawVariants[0]?.rule?.__resolveType as string) ?? "") ===
          NEVER_MATCHER_RESOLVE_TYPE
      ) {
        const innerValue = (rawVariants[0]?.value ?? {}) as Record<
          string,
          unknown
        >;
        let innerRt = (innerValue.__resolveType as string) ?? "";
        const innerIsLazy = isLazyResolveType(innerRt);
        let mvInner: Record<string, unknown> = innerValue;
        if (innerIsLazy) {
          const nested = innerValue.section as
            | Record<string, unknown>
            | undefined;
          innerRt = (nested?.__resolveType as string) ?? innerRt;
          if (nested) mvInner = nested;
        }

        // Hidden variant section: keep the "Variants of X" label from the wrapped multivariate block.
        if (
          innerRt === PAGE_MULTIVARIATE_FLAG_RESOLVE_TYPE ||
          innerRt === SECTION_MULTIVARIATE_RESOLVE_TYPE
        ) {
          const innerVariants = Array.isArray(mvInner.variants)
            ? (mvInner.variants as Array<Record<string, unknown>>)
            : [];
          const firstValueRt = (
            innerVariants[0]?.value as Record<string, unknown> | undefined
          )?.__resolveType as string | undefined;
          const sectionLabel = firstValueRt
            ? labelFromResolveType(firstValueRt)
            : "Section";
          return {
            index: idx,
            resolveType: rt,
            label: `Variants of ${sectionLabel}`,
            isHidden: true,
            isLazy: innerIsLazy,
          };
        }

        if (
          innerRt !== "" &&
          isSavedBlockResolveType(innerRt) &&
          innerRt in decofile
        ) {
          return {
            index: idx,
            resolveType: rt,
            label: resolvedBlockLabel(innerRt, idx, decofile),
            isHidden: true,
            isLazy: innerIsLazy,
            isSavedBlock: true,
          };
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
      isSavedBlockResolveType(effectiveRt) &&
      effectiveRt in decofile
    ) {
      return {
        index: idx,
        resolveType: rt,
        label: resolvedBlockLabel(effectiveRt, idx, decofile),
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

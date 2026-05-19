import { useState, useRef } from "react";
import { ArrowLeft, Loading01 } from "@untitledui/icons";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { toast } from "sonner";
import { useDecofile } from "./use-decofile";
import { useLiveMeta } from "./use-live-meta";
import { useSaveBlock } from "./use-save-block";
import { extractPages } from "./page-list";
import { SectionList, parseSections, isLazyResolveType } from "./section-list";
import { arrayMove } from "@dnd-kit/sortable";
import type { ParsedSection } from "./section-list";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";
import { MatcherPicker, extractMatchers } from "./matcher-picker";

interface RawSection {
  __resolveType: string;
  section?: { __resolveType?: string; [key: string]: unknown };
  variants?: Array<{
    value?: Record<string, unknown>;
    rule?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

const AUTOSAVE_DELAY = 700;

interface PageVariant {
  label: string;
  sections: RawSection[];
  rule?: Record<string, unknown>;
}

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function labelFromResolveType(rt: string): string {
  const segments = rt.split("/");
  const filename = segments[segments.length - 1] ?? rt;
  return (
    filename
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) || rt
  );
}

function formatMatcher(rule: Record<string, unknown> | undefined): string {
  if (!rule) return "Default";
  const rt = (rule.__resolveType as string) ?? "";

  const alwaysTypes = [
    "website/matchers/always.ts",
    "$live/matchers/MatchAlways.ts",
  ];
  if (alwaysTypes.includes(rt) || rt === "") return "Default";

  switch (rt) {
    case "website/matchers/never.ts":
      return "Hidden";

    case "website/matchers/device.ts":
    case "$live/matchers/MatchDevice.ts": {
      const {
        mobile,
        tablet,
        desktop,
        devices: devList = [],
      } = rule as {
        mobile?: boolean;
        tablet?: boolean;
        desktop?: boolean;
        devices?: string[];
      };
      const devices = [...(devList as string[])];
      if (mobile) devices.push("Mobile");
      if (tablet) devices.push("Tablet");
      if (desktop) devices.push("Desktop");
      return devices.length > 0
        ? devices.map(capitalize).join(" & ")
        : labelFromResolveType(rt);
    }

    case "website/matchers/date.ts":
    case "$live/matchers/MatchDate.ts": {
      const { start, end } = rule as { start?: string; end?: string };
      if (!start && !end) return labelFromResolveType(rt);
      const fmt = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      });
      if (start && end) {
        try {
          return `${fmt.format(new Date(start))} \u2192 ${fmt.format(new Date(end))}`;
        } catch {
          return labelFromResolveType(rt);
        }
      }
      if (start) {
        try {
          return `From ${fmt.format(new Date(start))}`;
        } catch {
          return labelFromResolveType(rt);
        }
      }
      if (end) {
        try {
          return `Until ${fmt.format(new Date(end))}`;
        } catch {
          return labelFromResolveType(rt);
        }
      }
      return labelFromResolveType(rt);
    }

    case "website/matchers/random.ts":
    case "$live/matchers/MatchRandom.ts": {
      const { traffic } = rule as { traffic?: number };
      if (typeof traffic === "number") {
        return `${Math.ceil(traffic * 100)}% of sessions`;
      }
      return labelFromResolveType(rt);
    }

    case "website/matchers/host.ts":
    case "$live/matchers/MatchHost.ts": {
      const { includes, match } = rule as {
        includes?: string;
        match?: string;
      };
      const parts: string[] = [];
      if (includes) parts.push(includes);
      if (match) parts.push(match);
      return parts.length > 0 ? parts.join(" - ") : labelFromResolveType(rt);
    }

    case "website/matchers/pathname.ts": {
      const caseObj = rule.case as
        | { type?: string; pathname?: string }
        | undefined;
      const { type, pathname } = caseObj ?? {};
      if (type && pathname) return `Pathname ${type} ${pathname}`;
      return labelFromResolveType(rt);
    }

    case "website/matchers/location.ts":
    case "$live/matchers/MatchLocation.ts": {
      const { includeLocations, excludeLocations } = rule as {
        includeLocations?: Array<{
          city?: string;
          regionCode?: string;
          country?: string;
        }>;
        excludeLocations?: Array<{
          city?: string;
          regionCode?: string;
          country?: string;
        }>;
      };
      const fmtLoc = (loc: {
        city?: string;
        regionCode?: string;
        country?: string;
      }) => [loc.city, loc.regionCode, loc.country].filter(Boolean).join(" - ");
      const first = includeLocations?.[0];
      if (first) {
        const rest = (includeLocations?.length ?? 0) - 1;
        return `${fmtLoc(first)}${rest > 0 ? ` +${rest}` : ""}`;
      }
      const firstEx = excludeLocations?.[0];
      if (firstEx) {
        const rest = (excludeLocations?.length ?? 0) - 1;
        return `Except ${fmtLoc(firstEx)}${rest > 0 ? ` +${rest}` : ""}`;
      }
      return "Any location";
    }

    case "website/matchers/multi.ts":
    case "$live/matchers/MatchMulti.ts": {
      const { matchers, op = "AND" } = rule as {
        matchers?: Array<Record<string, unknown>>;
        op?: string;
      };
      if (matchers && matchers.length > 0) {
        return matchers.map(formatMatcher).join(` ${op} `);
      }
      return labelFromResolveType(rt);
    }

    default:
      return labelFromResolveType(rt) || "Default";
  }
}

/**
 * Parse page-level `sections` into an array of variants.
 * - Plain array → single variant labelled "Default"
 * - Multivariate flag object → one variant per entry in `variants`
 */
function parsePageVariants(sections: unknown): PageVariant[] {
  if (Array.isArray(sections)) {
    return [{ label: "Default", sections }];
  }
  if (sections && typeof sections === "object") {
    const obj = sections as Record<string, unknown>;
    if (Array.isArray(obj.variants)) {
      const raw = obj.variants as Array<{
        rule?: Record<string, unknown>;
        value?: unknown;
      }>;
      return raw.map((v, i) => ({
        label: formatMatcher(v.rule) || `Variant ${i + 1}`,
        sections: Array.isArray(v.value) ? (v.value as RawSection[]) : [],
        rule: v.rule,
      }));
    }
  }
  return [];
}

/**
 * Editable page name + path inputs that hold local state to prevent
 * focus loss when the parent re-renders after decofile invalidation.
 */
function PageHeaderInputs({
  pageKey,
  initialName,
  initialPath,
  onFieldChange,
}: {
  pageKey: string;
  initialName: string;
  initialPath: string;
  onFieldChange: (field: "name" | "path", value: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [path, setPath] = useState(initialPath);
  const [prevKey, setPrevKey] = useState(pageKey);

  // Reset local state when navigating to a different page
  if (prevKey !== pageKey) {
    setPrevKey(pageKey);
    setName(initialName);
    setPath(initialPath);
  }

  return (
    <div className="space-y-1">
      <input
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          onFieldChange("name", e.target.value);
        }}
        className="w-full bg-transparent text-sm font-semibold truncate outline-none border-none p-0 focus:ring-0 placeholder:text-muted-foreground"
        placeholder="Page name"
      />
      <input
        type="text"
        value={path}
        onChange={(e) => {
          setPath(e.target.value);
          onFieldChange("path", e.target.value);
        }}
        className="w-full bg-transparent text-xs text-muted-foreground truncate outline-none border-none p-0 focus:ring-0 placeholder:text-muted-foreground"
        placeholder="/path"
      />
    </div>
  );
}

/**
 * Unwrap a raw section to get the actual editable data and its resolveType.
 * Handles lazy wrappers, hidden (multivariate+never), saved blocks, and
 * multivariate sections — mirrors admin-mcp's handleCmsSelectSection.
 */
function unwrapSection(
  raw: RawSection,
  parsed: ParsedSection,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  // Multivariate: don't load form data (would need variant selector)
  if (parsed.isMultivariate) {
    return null;
  }

  // Saved block: load from decofile entry
  // May be direct (rt = "Header") or lazy-wrapped (rt = "Lazy.tsx", section.rt = "Header")
  if (parsed.isSavedBlock) {
    const blockKey = parsed.isLazy
      ? ((raw.section?.__resolveType as string) ?? raw.__resolveType)
      : raw.__resolveType;
    const blockData = (decofile[blockKey] as Record<string, unknown>) ?? {};
    const rt = (blockData.__resolveType as string) ?? blockKey;
    return { data: { ...blockData }, resolveType: rt };
  }

  // Hidden section: unwrap multivariate → variants[0].value → possibly lazy
  if (parsed.isHidden) {
    const isLazy = isLazyResolveType(raw.__resolveType);
    const mvObj = isLazy ? (raw.section as RawSection | undefined) : raw;
    const innerValue =
      (mvObj?.variants?.[0]?.value as Record<string, unknown>) ??
      (raw as Record<string, unknown>);
    const innerRt = (innerValue.__resolveType as string) ?? "";
    // Inner value might itself be lazy-wrapped
    if (isLazyResolveType(innerRt)) {
      const nested = (innerValue.section as Record<string, unknown>) ?? {};
      return {
        data: { ...nested },
        resolveType: (nested.__resolveType as string) ?? innerRt,
      };
    }
    return { data: { ...innerValue }, resolveType: innerRt };
  }

  // Lazy section: unwrap .section
  if (parsed.isLazy) {
    const inner =
      (raw.section as Record<string, unknown>) ??
      (raw as Record<string, unknown>);
    return {
      data: { ...inner },
      resolveType: (inner.__resolveType as string) ?? raw.__resolveType,
    };
  }

  // Normal section
  return {
    data: { ...(raw as Record<string, unknown>) },
    resolveType: raw.__resolveType,
  };
}

/**
 * Side panel for editing deco.cx page sections.
 * Renders sections for the currently active page and a schema-driven form.
 * The active page is determined by `currentPath` (from the iframe URL).
 * Changes auto-save after a debounce.
 */
export function SectionsEditor({
  previewUrl,
  orgSlug,
  virtualMcpId,
  branch,
  currentPath,
  onSaved,
}: {
  previewUrl: string;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  currentPath: string;
  /** Called after a successful auto-save so the parent can reload the preview. */
  onSaved?: () => void;
}) {
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(previewUrl);
  const { data: meta, isLoading: metaLoading } = useLiveMeta(previewUrl);

  const [selectedSectionIndex, setSelectedSectionIndex] = useState<
    number | null
  >(null);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [activeResolveType, setActiveResolveType] = useState<string | null>(
    null,
  );
  const [activeVariantIndex, setActiveVariantIndex] = useState(0);
  const [ruleFormValue, setRuleFormValue] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ruleResolveType, setRuleResolveType] = useState<string | null>(null);

  // Reset form state when the active page changes
  const [prevPath, setPrevPath] = useState(currentPath);
  if (prevPath !== currentPath) {
    setPrevPath(currentPath);
    setSelectedSectionIndex(null);
    setFormValue(null);
    setActiveResolveType(null);
    setActiveVariantIndex(0);
    setRuleFormValue(null);
    setRuleResolveType(null);
  }

  const saveBlock = useSaveBlock({ previewUrl, orgSlug, virtualMcpId, branch });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ruleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Accumulates pending page header field changes to avoid losing edits
  const pendingPageFieldsRef = useRef<Record<string, string>>({});

  // Keep a ref to the latest render-scope values so debounced callbacks
  // always read fresh data instead of a stale closure.
  const latestRef = useRef<{
    rawSections: RawSection[];
    parsedSections: ParsedSection[];
    decofile: Record<string, unknown>;
    activePageKey: string | null;
    pageVariants: PageVariant[];
    variantIndex: number;
  }>({
    rawSections: [],
    parsedSections: [],
    decofile: {},
    activePageKey: null,
    pageVariants: [],
    variantIndex: 0,
  });

  if (decofileLoading || metaLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!decofile || !meta) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        Could not load site data.
      </div>
    );
  }

  const pages = extractPages(decofile);
  const norm = (s: string) => s.replace(/\/+$/, "") || "/";
  const activePage = pages.find((p) => norm(p.path) === norm(currentPath));
  const activePageKey = activePage?.key ?? null;

  const pageData =
    activePageKey && decofile[activePageKey]
      ? (decofile[activePageKey] as Record<string, unknown>)
      : null;
  const pageVariants = parsePageVariants(pageData?.sections);
  const hasMultipleVariants = pageVariants.length > 1;
  const safeVariantIndex = Math.min(
    activeVariantIndex,
    pageVariants.length - 1,
  );
  const activeVariant = pageVariants[safeVariantIndex];
  const rawSections: RawSection[] = activeVariant?.sections ?? [];
  const parsedSections = parseSections(rawSections, decofile);

  // Sync ref so debounced callbacks always see the latest values.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- ref is only read in setTimeout callbacks, not during render
  latestRef.current = {
    rawSections,
    parsedSections,
    decofile,
    activePageKey,
    pageVariants,
    variantIndex: safeVariantIndex,
  };

  const activeSchema =
    activeResolveType && meta ? resolveSchema(activeResolveType, meta) : null;

  const scheduleAutoSave = (
    nextValue: Record<string, unknown>,
    sectionIndex: number,
  ) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const {
        rawSections: latestRawSections,
        parsedSections: latestParsedSections,
        decofile: latestDecofile,
        activePageKey: latestPageKey,
        pageVariants: latestVariants,
        variantIndex: latestVariantIndex,
      } = latestRef.current;
      const rawSection = latestRawSections[sectionIndex];
      if (!rawSection) return;
      const parsed = latestParsedSections[sectionIndex];
      if (!parsed) return;

      // Saved block: write the block entry directly
      if (parsed.isSavedBlock) {
        const blockKey = parsed.isLazy
          ? ((rawSection.section?.__resolveType as string) ??
            rawSection.__resolveType)
          : rawSection.__resolveType;
        saveBlock.mutate(
          { blockKey, data: nextValue },
          {
            onSuccess: () => onSaved?.(),
            onError: (err) => toast.error(`Save failed: ${err.message}`),
          },
        );
        return;
      }

      // Inline section (possibly wrapped): rebuild the full wrapper structure
      if (!latestPageKey) return;
      const fullPageData = {
        ...(latestDecofile[latestPageKey] as Record<string, unknown>),
      };
      const updatedSections = [...latestRawSections];

      if (parsed.isHidden) {
        // Re-wrap into multivariate+never structure
        const isLazy = isLazyResolveType(rawSection.__resolveType);
        const mvObj = isLazy
          ? { ...(rawSection.section as Record<string, unknown>) }
          : { ...rawSection };
        const variants = Array.isArray(mvObj.variants)
          ? [...(mvObj.variants as Array<Record<string, unknown>>)]
          : [];
        if (variants[0]) {
          variants[0] = { ...variants[0], value: nextValue };
        }
        mvObj.variants = variants;
        if (isLazy) {
          updatedSections[sectionIndex] = {
            ...rawSection,
            section: mvObj,
          } as RawSection;
        } else {
          updatedSections[sectionIndex] = mvObj as RawSection;
        }
      } else if (parsed.isLazy) {
        // Re-wrap into lazy structure
        updatedSections[sectionIndex] = {
          ...rawSection,
          section: nextValue,
        } as RawSection;
      } else {
        updatedSections[sectionIndex] = nextValue as RawSection;
      }

      // Write back into the correct variant or directly
      if (latestVariants.length > 1) {
        // Multivariate page: update the specific variant's value
        const currentSections = fullPageData.sections as Record<
          string,
          unknown
        >;
        const variants = [
          ...((currentSections?.variants as Array<Record<string, unknown>>) ??
            []),
        ];
        if (variants[latestVariantIndex]) {
          variants[latestVariantIndex] = {
            ...variants[latestVariantIndex],
            value: updatedSections,
          };
        }
        fullPageData.sections = { ...currentSections, variants };
      } else {
        fullPageData.sections = updatedSections;
      }
      saveBlock.mutate(
        { blockKey: latestPageKey, data: fullPageData },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleSelectSection = (index: number) => {
    setSelectedSectionIndex(index);
    const rawSection = rawSections[index];
    const parsed = parsedSections[index];
    if (!rawSection || !parsed) return;

    const unwrapped = unwrapSection(rawSection, parsed, decofile);
    if (!unwrapped) {
      // Multivariate — no form editing for now
      setFormValue(null);
      setActiveResolveType(null);
      return;
    }

    setFormValue(unwrapped.data);
    setActiveResolveType(unwrapped.resolveType);
  };

  const handleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    setFormValue(next);
    if (selectedSectionIndex !== null) {
      scheduleAutoSave(next, selectedSectionIndex);
    }
  };

  const savePageField = (field: "name" | "path", value: string) => {
    if (!activePageKey) return;
    // Accumulate all pending field changes so rapid edits to name+path
    // are merged into a single save instead of overwriting each other.
    pendingPageFieldsRef.current[field] = value;
    if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
    pageDebounceRef.current = setTimeout(() => {
      const pending = pendingPageFieldsRef.current;
      pendingPageFieldsRef.current = {};
      const fullPageData = {
        ...(decofile[activePageKey] as Record<string, unknown>),
        ...pending,
      };
      // No onSaved/iframe reload — name/path don't affect the visual preview
      saveBlock.mutate(
        { blockKey: activePageKey, data: fullPageData },
        {
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleReorder = (fromIndex: number, toIndex: number) => {
    if (!activePageKey) return;
    const reordered = arrayMove([...rawSections], fromIndex, toIndex);
    const fullPageData = {
      ...(decofile[activePageKey] as Record<string, unknown>),
    };
    if (hasMultipleVariants) {
      const currentSections = fullPageData.sections as Record<string, unknown>;
      const variants = [
        ...((currentSections?.variants as Array<Record<string, unknown>>) ??
          []),
      ];
      if (variants[safeVariantIndex]) {
        variants[safeVariantIndex] = {
          ...variants[safeVariantIndex],
          value: reordered,
        };
      }
      fullPageData.sections = { ...currentSections, variants };
    } else {
      fullPageData.sections = reordered;
    }
    saveBlock.mutate(
      { blockKey: activePageKey, data: fullPageData },
      {
        onSuccess: () => onSaved?.(),
        onError: (err) => toast.error(`Reorder failed: ${err.message}`),
      },
    );
  };

  // Sync rule form state when variant changes
  const activeRule = activeVariant?.rule;
  const activeRuleRt = (activeRule?.__resolveType as string) ?? "";
  // Initialize rule form state when switching variants
  if (
    hasMultipleVariants &&
    selectedSectionIndex === null &&
    ruleResolveType === null &&
    activeRule
  ) {
    setRuleResolveType(activeRuleRt);
    const { __resolveType: _, ...ruleData } = activeRule;
    setRuleFormValue(ruleData);
  }

  const availableMatchers = meta ? extractMatchers(meta) : [];

  const ruleSchema =
    ruleResolveType && meta ? resolveSchema(ruleResolveType, meta) : null;

  const scheduleRuleSave = (newRule: Record<string, unknown>) => {
    if (ruleDebounceRef.current) clearTimeout(ruleDebounceRef.current);
    ruleDebounceRef.current = setTimeout(() => {
      const {
        activePageKey: latestPageKey,
        decofile: latestDecofile,
        variantIndex: latestVariantIndex,
      } = latestRef.current;
      if (!latestPageKey) return;

      const fullPageData = {
        ...(latestDecofile[latestPageKey] as Record<string, unknown>),
      };
      const mv = {
        ...(fullPageData.sections as Record<string, unknown>),
      };
      const variants = [
        ...((mv.variants as Array<Record<string, unknown>>) ?? []),
      ];
      if (variants[latestVariantIndex]) {
        variants[latestVariantIndex] = {
          ...variants[latestVariantIndex],
          rule: newRule,
        };
      }
      fullPageData.sections = { ...mv, variants };

      saveBlock.mutate(
        { blockKey: latestPageKey, data: fullPageData },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleMatcherTypeChange = (newRt: string) => {
    setRuleResolveType(newRt);
    const newRule: Record<string, unknown> = newRt
      ? { __resolveType: newRt }
      : {};
    setRuleFormValue({});
    scheduleRuleSave(newRule);
  };

  const handleRuleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    setRuleFormValue(next);
    const newRule: Record<string, unknown> = ruleResolveType
      ? { __resolveType: ruleResolveType, ...next }
      : { ...next };
    scheduleRuleSave(newRule);
  };

  if (!activePage) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        No page found for {currentPath}
      </div>
    );
  }

  const selectedParsed =
    selectedSectionIndex !== null
      ? (parsedSections[selectedSectionIndex] ?? null)
      : null;

  const isEditing = activeSchema && formValue && selectedParsed;

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-3 py-2.5 border-b shrink-0">
        {isEditing ? (
          <button
            type="button"
            onClick={() => {
              setSelectedSectionIndex(null);
              setFormValue(null);
              setActiveResolveType(null);
            }}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{activePage.name}</span>
          </button>
        ) : (
          <PageHeaderInputs
            pageKey={activePageKey!}
            initialName={activePage.name}
            initialPath={activePage.path}
            onFieldChange={savePageField}
          />
        )}
      </div>

      {/* Variant selector (when page sections are multivariate) */}
      {hasMultipleVariants && !isEditing && (
        <div className="flex gap-1 px-3 py-1.5 border-b shrink-0 overflow-x-auto">
          {pageVariants.map((variant, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setActiveVariantIndex(i);
                setSelectedSectionIndex(null);
                setFormValue(null);
                setActiveResolveType(null);
                const variantRule = pageVariants[i]?.rule;
                const variantRuleRt =
                  (variantRule?.__resolveType as string) ?? "";
                setRuleResolveType(variantRuleRt);
                if (variantRule) {
                  const { __resolveType: _, ...ruleData } = variantRule;
                  setRuleFormValue(ruleData);
                } else {
                  setRuleFormValue(null);
                }
              }}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                i === safeVariantIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {variant.label}
            </button>
          ))}
        </div>
      )}

      {/* Drill-down: section list OR section form */}
      {isEditing ? (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4">
            <h2 className="text-sm font-semibold mb-4">
              {selectedParsed.label}
            </h2>
            <SchemaForm
              schema={activeSchema}
              value={formValue}
              onChange={handleFormChange}
              basePath=""
            />
          </div>
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          {/* Variant rule editor */}
          {hasMultipleVariants && ruleResolveType !== null && (
            <div className="px-3 py-3 border-b space-y-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Rule
              </span>
              <MatcherPicker
                currentRt={ruleResolveType}
                currentLabel={formatMatcher(activeVariant?.rule)}
                matchers={availableMatchers}
                onSelect={handleMatcherTypeChange}
              />
              {ruleSchema && ruleFormValue && (
                <div className="pt-1">
                  <SchemaForm
                    schema={ruleSchema}
                    value={ruleFormValue}
                    onChange={handleRuleFormChange}
                    basePath=""
                  />
                </div>
              )}
            </div>
          )}
          <div className="p-2">
            <SectionList
              sections={parsedSections}
              selectedIndex={selectedSectionIndex}
              onSelect={handleSelectSection}
              onReorder={handleReorder}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

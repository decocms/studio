import { useState, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  DotsHorizontal,
  Edit01,
  Flag01,
  Loading01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { VariantRenameDialog } from "./variant-rename-dialog";
import { toast } from "sonner";
import { useDecofile } from "./use-decofile";
import { useLiveMeta } from "./use-live-meta";
import { useDeleteBlock } from "./use-delete-block";
import { useSaveBlock } from "./use-save-block";
import { extractPages, globalSectionLabel } from "./page-list";
import { normalizePagePath } from "./page-path-utils";
import { SectionList, parseSections } from "./section-list";
import { isLazyResolveType } from "./section-lazy";
import { arrayMove } from "@dnd-kit/sortable";
import type { ParsedSection } from "./section-list";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";
import { MatcherPicker, extractMatchers } from "./matcher-picker";
import { resolveMatcherIconName } from "./matcher-icons";
import { getIconComponent } from "../agent-icon";
import { MakeReusableModal } from "./make-reusable-modal";
import { AddSectionModal } from "./add-section-modal";
import type { SectionCatalogEntry } from "./section-catalog";
import { SectionVariantList } from "./section-variant-list";
import { ALWAYS_MATCHER_RESOLVE_TYPE, type RawSection } from "./section-types";
import {
  buildMatcherBlockData,
  buildMatcherBlockReference,
  inlineMatcherRule,
  isSavedMatcherBlockReference,
  readMatcherRuleFormState,
  resolveEffectiveMatcherRule,
  resolveVariantRuleLabel,
  unwrapMatcherRule,
} from "./matcher-rules";
import {
  buildPageDataWithSections,
  cloneSection,
  suggestBlockId,
  validateBlockId,
} from "./page-sections";
import {
  deleteMultivariateSectionVariant,
  duplicateMultivariateSectionVariant,
  flattenMultivariateSection,
  getMultivariateSectionObject,
  parseSectionFlagVariants,
  rebuildSectionWithMultivariate,
  unwrapVariantSectionValue,
  updateMultivariateSectionVariantRule,
  updateMultivariateSectionVariantValue,
} from "./section-variants";

const AUTOSAVE_DELAY = 700;

const VARIANT_GREEN_TEXT = "oklch(0.65 0.15 160)";
const VARIANT_TAB_ACTIVE_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.22)]";

function VariantTabIcon({
  rule,
  matchers,
}: {
  rule: Record<string, unknown> | undefined;
  matchers: Array<{ resolveType: string; iconName: string }>;
}) {
  const rt = (rule?.__resolveType as string) ?? "";
  // Prefer the schema-defined icon (resolved by extractMatchers) so custom
  // matchers like "Birthday" pick up the Calendar icon set in their schema
  // metadata, instead of falling back to FilterLines via regex matching.
  const fromSchema = matchers.find((m) => m.resolveType === rt)?.iconName;
  const iconName = fromSchema ?? resolveMatcherIconName(rt);
  const Icon = getIconComponent(iconName);
  if (!Icon) return null;
  return <Icon size={14} className="shrink-0" />;
}

interface PageVariant {
  /** Display label (global block name if saved, otherwise derived from the rule). */
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

/**
 * Render a `start`/`end` ISO-date pair as a compact range — used by deco's
 * built-in date matcher AND by any custom matcher whose rule happens to
 * carry the same field names (e.g. project-defined `Date` / `Birthday`
 * matchers that don't share resolveType with the website package). Returns
 * null when the rule has no readable date fields so callers can fall back.
 */
function formatDateRange(rule: Record<string, unknown>): string | null {
  const { start, end } = rule as { start?: unknown; end?: unknown };
  const startStr = typeof start === "string" ? start : "";
  const endStr = typeof end === "string" ? end : "";
  if (!startStr && !endStr) return null;
  const fmt = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const tryFormat = (iso: string): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return fmt.format(d);
  };
  const startFmt = tryFormat(startStr);
  const endFmt = tryFormat(endStr);
  if (startFmt && endFmt) return `${startFmt} → ${endFmt}`;
  if (startFmt) return `From ${startFmt}`;
  if (endFmt) return `Until ${endFmt}`;
  return null;
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
    case "$live/matchers/MatchDate.ts":
      return formatDateRange(rule) ?? labelFromResolveType(rt);

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

    default: {
      // Project-defined matchers (e.g. "Date", "Birthday") don't share
      // resolveType with the website package, so generic field inspection
      // is the only way to surface their actual configuration on the tab.
      const range = formatDateRange(rule);
      if (range) return range;
      return labelFromResolveType(rt) || "Default";
    }
  }
}

/**
 * Parse page-level `sections` into an array of variants.
 * - Plain array → single variant labelled "Default"
 * - Multivariate flag object → one variant per entry in `variants`
 */
function parsePageVariants(
  sections: unknown,
  decofile: Record<string, unknown>,
): PageVariant[] {
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
      const labels = raw.map((v) =>
        resolveVariantRuleLabel(v.rule, decofile, formatMatcher),
      );
      const labelCounts = labels.reduce<Record<string, number>>((acc, l) => {
        acc[l] = (acc[l] ?? 0) + 1;
        return acc;
      }, {});
      const seen: Record<string, number> = {};
      return raw.map((v, i) => {
        const baseLabel = labels[i] ?? `Variant ${i + 1}`;
        const total = labelCounts[baseLabel] ?? 1;
        let label = baseLabel;
        if (total > 1) {
          seen[baseLabel] = (seen[baseLabel] ?? 0) + 1;
          label = `${baseLabel} ${seen[baseLabel]}`;
        }
        return {
          label: label || `Variant ${i + 1}`,
          sections: Array.isArray(v.value) ? (v.value as RawSection[]) : [],
          rule: v.rule,
        };
      });
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
  orgSlug,
  virtualMcpId,
  branch,
  previewReady = true,
  previewUrl,
  currentPath,
  activePageBlockKey = null,
  activeGlobalBlockKey = null,
  externalSelectedIndex,
  onSaved,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** When false, waits for the sandbox dev server before preview-fetch. */
  previewReady?: boolean;
  /** Sandbox preview base URL used for section gallery previews. */
  previewUrl?: string;
  currentPath: string;
  /** When set, identifies the page by its unique decofile block key. Takes
   * precedence over `currentPath` for selection — required when multiple
   * pages share the same `path`. */
  activePageBlockKey?: string | null;
  /** When set, edits a saved global block instead of a page. */
  activeGlobalBlockKey?: string | null;
  /** Section index selected via click-through from the preview iframe. */
  externalSelectedIndex?: number | null;
  /** Called after a successful auto-save so the parent can reload the preview. */
  onSaved?: () => void;
}) {
  const previewFetchParams = previewReady
    ? { orgSlug, virtualMcpId, branch }
    : null;
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(previewFetchParams);
  const { data: meta, isLoading: metaLoading } =
    useLiveMeta(previewFetchParams);

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
  const [prevExternalIdx, setPrevExternalIdx] = useState<
    number | null | undefined
  >(undefined);
  const [ruleFormValue, setRuleFormValue] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ruleResolveType, setRuleResolveType] = useState<string | null>(null);
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<string[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
  const [makeReusableIndex, setMakeReusableIndex] = useState<number | null>(
    null,
  );
  const [renameVariantIndex, setRenameVariantIndex] = useState<number | null>(
    null,
  );
  const [isVariantRuleOpen, setIsVariantRuleOpen] = useState(true);
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [activeSectionVariantIndex, setActiveSectionVariantIndex] = useState(0);
  const [sectionRuleFormValue, setSectionRuleFormValue] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [sectionRuleResolveType, setSectionRuleResolveType] = useState<
    string | null
  >(null);
  const [prevAutoGlobalKey, setPrevAutoGlobalKey] = useState<string | null>(
    null,
  );

  // Reset form state when the active page or global block changes
  const [prevPath, setPrevPath] = useState(currentPath);
  const [prevGlobalBlockKey, setPrevGlobalBlockKey] =
    useState(activeGlobalBlockKey);
  if (prevPath !== currentPath || prevGlobalBlockKey !== activeGlobalBlockKey) {
    setPrevPath(currentPath);
    setPrevGlobalBlockKey(activeGlobalBlockKey);
    setSelectedSectionIndex(null);
    setFormValue(null);
    setActiveResolveType(null);
    setActiveVariantIndex(0);
    setRuleFormValue(null);
    setRuleResolveType(null);
    setActiveSectionVariantIndex(0);
    setSectionRuleFormValue(null);
    setSectionRuleResolveType(null);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  const [renameVariantPending, setRenameVariantPending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ruleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRuleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
    sectionVariantIndex: number;
    selectedSectionIndex: number | null;
  }>({
    rawSections: [],
    parsedSections: [],
    decofile: {},
    activePageKey: null,
    pageVariants: [],
    variantIndex: 0,
    sectionVariantIndex: 0,
    selectedSectionIndex: null,
  });

  if (!previewReady || decofileLoading || metaLoading) {
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
  const norm = normalizePagePath;
  const isGlobalBlockMode = !!activeGlobalBlockKey;
  const activePage = isGlobalBlockMode
    ? null
    : activePageBlockKey
      ? (pages.find((p) => p.key === activePageBlockKey) ?? null)
      : (pages.find((p) => norm(p.path) === norm(currentPath)) ?? null);
  const activePageKey = isGlobalBlockMode
    ? activeGlobalBlockKey
    : (activePage?.key ?? null);
  const globalBlockData =
    isGlobalBlockMode && activeGlobalBlockKey
      ? (decofile[activeGlobalBlockKey] as Record<string, unknown> | undefined)
      : undefined;
  const globalBlockName =
    isGlobalBlockMode && activeGlobalBlockKey && globalBlockData
      ? globalSectionLabel(activeGlobalBlockKey, globalBlockData)
      : isGlobalBlockMode && activeGlobalBlockKey
        ? activeGlobalBlockKey
        : "";

  const pageData =
    !isGlobalBlockMode && activePageKey && decofile[activePageKey]
      ? (decofile[activePageKey] as Record<string, unknown>)
      : null;
  const pageVariants = isGlobalBlockMode
    ? [
        {
          label: "Default",
          sections: [{ __resolveType: activeGlobalBlockKey! } as RawSection],
        },
      ]
    : parsePageVariants(pageData?.sections, decofile ?? {});
  const hasMultipleVariants = pageVariants.length > 1;
  const safeVariantIndex = Math.min(
    activeVariantIndex,
    pageVariants.length - 1,
  );
  const activeVariant = pageVariants[safeVariantIndex];
  const rawSections: RawSection[] = activeVariant?.sections ?? [];
  const parsedSections = parseSections(rawSections, decofile);

  // Global blocks open directly into the section form (single saved block).
  if (
    isGlobalBlockMode &&
    activeGlobalBlockKey &&
    prevAutoGlobalKey !== activeGlobalBlockKey
  ) {
    setPrevAutoGlobalKey(activeGlobalBlockKey);
    const rawSection = rawSections[0];
    const parsed = parsedSections[0];
    if (rawSection && parsed) {
      setSelectedSectionIndex(0);
      setActiveSectionVariantIndex(0);
      setFieldBreadcrumbs([]);
      const unwrapped = unwrapSection(rawSection, parsed, decofile);
      if (unwrapped) {
        setFormValue(unwrapped.data);
        setActiveResolveType(unwrapped.resolveType);
        setSectionRuleResolveType(null);
        setSectionRuleFormValue(null);
      }
    }
  }
  if (!isGlobalBlockMode && prevAutoGlobalKey !== null) {
    setPrevAutoGlobalKey(null);
  }

  // Sync ref so debounced callbacks always see the latest values.
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- ref is only read in setTimeout callbacks, not during render
  latestRef.current = {
    rawSections,
    parsedSections,
    decofile,
    activePageKey,
    pageVariants,
    variantIndex: safeVariantIndex,
    sectionVariantIndex: activeSectionVariantIndex,
    selectedSectionIndex,
  };

  const applySectionVariant = (
    rawSection: RawSection,
    parsed: ParsedSection,
    variantIndex: number,
  ) => {
    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      return;
    }

    const variants = parseSectionFlagVariants(mvObj, formatMatcher);
    const variant = variants[variantIndex];
    if (!variant) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      return;
    }

    const unwrapped = unwrapVariantSectionValue(variant.value, decofile);
    setFormValue(unwrapped?.data ?? null);
    setActiveResolveType(unwrapped?.resolveType ?? null);

    const ruleRt = (variant.rule?.__resolveType as string) ?? "";
    setSectionRuleResolveType(ruleRt);
    if (variant.rule) {
      const { __resolveType: _, ...ruleData } = variant.rule;
      setSectionRuleFormValue(ruleData);
    } else {
      setSectionRuleFormValue(null);
    }
  };

  // Auto-select section when parent signals a click-through from the preview.
  if (
    externalSelectedIndex !== undefined &&
    externalSelectedIndex !== prevExternalIdx
  ) {
    setPrevExternalIdx(externalSelectedIndex ?? null);
    if (typeof externalSelectedIndex === "number") {
      const rawSection = rawSections[externalSelectedIndex];
      const parsed = parsedSections[externalSelectedIndex];
      if (rawSection && parsed) {
        setSelectedSectionIndex(externalSelectedIndex);
        setActiveSectionVariantIndex(0);
        setFieldBreadcrumbs([]);
        setFormResetKey((key) => key + 1);
        if (parsed.isMultivariate) {
          applySectionVariant(rawSection, parsed, 0);
        } else {
          const unwrapped = unwrapSection(rawSection, parsed, decofile);
          if (!unwrapped) {
            setFormValue(null);
            setActiveResolveType(null);
          } else {
            setFormValue(unwrapped.data);
            setActiveResolveType(unwrapped.resolveType);
          }
          setSectionRuleResolveType(null);
          setSectionRuleFormValue(null);
        }
      }
    }
  }

  const activeSchema =
    activeResolveType && meta ? resolveSchema(activeResolveType, meta) : null;

  const savePageSections = (
    updatedSections: RawSection[],
    options?: { onSuccess?: () => void },
  ) => {
    if (!activePageKey) return;
    const fullPageData = buildPageDataWithSections(
      decofile,
      activePageKey,
      updatedSections,
      safeVariantIndex,
      pageVariants,
    );
    saveBlock.mutate(
      { blockKey: activePageKey, data: fullPageData },
      {
        onSuccess: () => options?.onSuccess?.() ?? onSaved?.(),
        onError: (err) => toast.error(`Save failed: ${err.message}`),
      },
    );
  };

  const clearSectionEditing = () => {
    setSelectedSectionIndex(null);
    setFormValue(null);
    setActiveResolveType(null);
    setActiveSectionVariantIndex(0);
    setSectionRuleFormValue(null);
    setSectionRuleResolveType(null);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
  };

  const scheduleAutoSave = (
    nextValue: Record<string, unknown>,
    sectionIndex: number,
  ) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const targetSectionVariantIndex = latestRef.current.sectionVariantIndex;

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

      if (parsed.isMultivariate) {
        const mvObj = getMultivariateSectionObject(rawSection, parsed);
        if (!mvObj || !latestPageKey) return;

        const updatedMvObj = updateMultivariateSectionVariantValue(
          mvObj,
          targetSectionVariantIndex,
          nextValue,
        );
        updatedSections[sectionIndex] = rebuildSectionWithMultivariate(
          rawSection,
          parsed,
          updatedMvObj,
        );
      } else if (parsed.isHidden) {
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
    setActiveSectionVariantIndex(0);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    const rawSection = rawSections[index];
    const parsed = parsedSections[index];
    if (!rawSection || !parsed) return;

    if (parsed.isMultivariate) {
      applySectionVariant(rawSection, parsed, 0);
      return;
    }

    const unwrapped = unwrapSection(rawSection, parsed, decofile);
    if (!unwrapped) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      return;
    }

    setFormValue(unwrapped.data);
    setActiveResolveType(unwrapped.resolveType);
    setSectionRuleResolveType(null);
    setSectionRuleFormValue(null);
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

    if (selectedSectionIndex !== null) {
      if (selectedSectionIndex === fromIndex) {
        setSelectedSectionIndex(toIndex);
      } else if (
        fromIndex < selectedSectionIndex &&
        toIndex >= selectedSectionIndex
      ) {
        setSelectedSectionIndex(selectedSectionIndex - 1);
      } else if (
        fromIndex > selectedSectionIndex &&
        toIndex <= selectedSectionIndex
      ) {
        setSelectedSectionIndex(selectedSectionIndex + 1);
      }
    }

    savePageSections(reordered);
  };

  const handleDeleteSection = (index: number) => {
    if (!activePageKey) return;
    const updatedSections = rawSections.filter((_, i) => i !== index);
    if (selectedSectionIndex === index) {
      clearSectionEditing();
    } else if (selectedSectionIndex !== null && selectedSectionIndex > index) {
      setSelectedSectionIndex(selectedSectionIndex - 1);
    }
    savePageSections(updatedSections);
  };

  const handleDuplicateSection = (index: number) => {
    if (!activePageKey) return;
    const section = rawSections[index];
    if (!section) return;
    const updatedSections = [...rawSections];
    updatedSections.splice(index + 1, 0, cloneSection(section));
    if (selectedSectionIndex !== null && selectedSectionIndex > index) {
      setSelectedSectionIndex(selectedSectionIndex + 1);
    }
    savePageSections(updatedSections);
  };

  const handleAddSection = (entry: SectionCatalogEntry) => {
    if (!activePageKey) return;

    const updatedSections = [
      ...rawSections,
      { __resolveType: entry.resolveType } as RawSection,
    ];
    const newIndex = updatedSections.length - 1;

    savePageSections(updatedSections, {
      onSuccess: () => {
        setAddSectionOpen(false);
        setSelectedSectionIndex(newIndex);
        setActiveSectionVariantIndex(0);
        setFieldBreadcrumbs([]);
        setFormResetKey((key) => key + 1);

        const rawSection = updatedSections[newIndex];
        const parsed = parseSections(updatedSections, decofile)[newIndex];
        if (!rawSection || !parsed) return;

        if (parsed.isMultivariate) {
          applySectionVariant(rawSection, parsed, 0);
          return;
        }

        const unwrapped = unwrapSection(rawSection, parsed, decofile);
        if (!unwrapped) {
          setFormValue(null);
          setActiveResolveType(null);
          setSectionRuleResolveType(null);
          setSectionRuleFormValue(null);
          return;
        }

        setFormValue(unwrapped.data);
        setActiveResolveType(unwrapped.resolveType);
        setSectionRuleResolveType(null);
        setSectionRuleFormValue(null);
      },
    });
  };

  const handleSelectSectionVariant = (variantIndex: number) => {
    if (selectedSectionIndex === null) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    setActiveSectionVariantIndex(variantIndex);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    applySectionVariant(rawSection, parsed, variantIndex);
  };

  const handleDeleteSectionVariant = (variantIndex: number) => {
    if (selectedSectionIndex === null || !activePageKey) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const updatedMvObj = deleteMultivariateSectionVariant(mvObj, variantIndex);
    if (!updatedMvObj) {
      toast.error("Cannot delete the only variant.");
      return;
    }

    const updatedSections = [...rawSections];
    updatedSections[selectedSectionIndex] = rebuildSectionWithMultivariate(
      rawSection,
      parsed,
      updatedMvObj,
    );

    const variants = updatedMvObj.variants as unknown[];
    let nextIndex = activeSectionVariantIndex;
    if (variantIndex === activeSectionVariantIndex) {
      nextIndex = Math.min(variantIndex, variants.length - 1);
    } else if (variantIndex < activeSectionVariantIndex) {
      nextIndex = activeSectionVariantIndex - 1;
    }

    setActiveSectionVariantIndex(nextIndex);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    applySectionVariant(
      updatedSections[selectedSectionIndex],
      parsed,
      nextIndex,
    );
    savePageSections(updatedSections);
  };

  const handleDuplicateSectionVariant = (variantIndex: number) => {
    if (selectedSectionIndex === null || !activePageKey) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const updatedMvObj = duplicateMultivariateSectionVariant(
      mvObj,
      variantIndex,
    );
    const updatedSections = [...rawSections];
    updatedSections[selectedSectionIndex] = rebuildSectionWithMultivariate(
      rawSection,
      parsed,
      updatedMvObj,
    );

    const nextIndex = variantIndex + 1;
    setActiveSectionVariantIndex(nextIndex);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    applySectionVariant(
      updatedSections[selectedSectionIndex],
      parsed,
      nextIndex,
    );
    savePageSections(updatedSections);
  };

  const handleRemoveAllSectionVariants = () => {
    if (selectedSectionIndex === null || !activePageKey) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const flattened = flattenMultivariateSection(rawSection, parsed, mvObj);
    if (!flattened) {
      toast.error("Could not remove variants.");
      return;
    }

    const updatedSections = [...rawSections];
    updatedSections[selectedSectionIndex] = flattened;

    const nextParsed = parseSections(updatedSections, decofile)[
      selectedSectionIndex
    ];
    if (!nextParsed) return;

    setActiveSectionVariantIndex(0);
    setSectionRuleResolveType(null);
    setSectionRuleFormValue(null);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);

    const unwrapped = unwrapSection(flattened, nextParsed, decofile);
    if (!unwrapped) {
      setFormValue(null);
      setActiveResolveType(null);
    } else {
      setFormValue(unwrapped.data);
      setActiveResolveType(unwrapped.resolveType);
    }

    savePageSections(updatedSections);
  };

  const handleMakeReusableSubmit = async (blockId: string) => {
    if (makeReusableIndex === null || !activePageKey) return;

    const validationError = validateBlockId(blockId, decofile);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const rawSection = rawSections[makeReusableIndex];
    const parsed = parsedSections[makeReusableIndex];
    if (!rawSection || !parsed) return;

    const unwrapped = unwrapSection(rawSection, parsed, decofile);
    if (!unwrapped) {
      toast.error("This section cannot be saved as global.");
      return;
    }

    const blockData = {
      ...unwrapped.data,
      name: blockId,
    };

    try {
      await saveBlock.mutateAsync({ blockKey: blockId, data: blockData });

      const updatedSections = [...rawSections];
      updatedSections[makeReusableIndex] = { __resolveType: blockId };

      await saveBlock.mutateAsync({
        blockKey: activePageKey,
        data: buildPageDataWithSections(
          decofile,
          activePageKey,
          updatedSections,
          safeVariantIndex,
          pageVariants,
        ),
      });

      if (selectedSectionIndex === makeReusableIndex) {
        clearSectionEditing();
      }

      setMakeReusableIndex(null);
      toast.success(`Saved global block "${blockId}"`);
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save global block",
      );
    }
  };

  // Sync rule form state when variant changes
  const activeRule = activeVariant?.rule;
  // Initialize rule form state when switching variants
  if (
    hasMultipleVariants &&
    selectedSectionIndex === null &&
    ruleResolveType === null &&
    activeRule
  ) {
    const { resolveType, formValue } = readMatcherRuleFormState(
      activeRule,
      decofile ?? {},
    );
    setRuleResolveType(resolveType);
    setRuleFormValue(formValue);
  }

  const availableMatchers = meta ? extractMatchers(meta) : [];
  const canAddSection =
    !isGlobalBlockMode && !!(previewUrl && meta && decofile);

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
      const currentVariant = variants[latestVariantIndex];
      const currentRule = currentVariant?.rule as
        | Record<string, unknown>
        | undefined;

      if (isSavedMatcherBlockReference(currentRule, latestDecofile)) {
        const blockKey = (currentRule?.__resolveType as string) ?? "";
        const existingBlock = latestDecofile[blockKey] as
          | Record<string, unknown>
          | undefined;
        const displayName =
          typeof existingBlock?.name === "string"
            ? existingBlock.name
            : blockKey;
        const { __resolveType: matcherRt, ...matcherData } = newRule;
        saveBlock.mutate(
          {
            blockKey,
            data: buildMatcherBlockData(
              (matcherRt as string) ?? "",
              matcherData,
              displayName,
            ),
          },
          {
            onSuccess: () => onSaved?.(),
            onError: (err) => toast.error(`Save failed: ${err.message}`),
          },
        );
        return;
      }

      if (currentVariant) {
        variants[latestVariantIndex] = {
          ...currentVariant,
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
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
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

  const scheduleSectionRuleSave = (newRule: Record<string, unknown>) => {
    if (sectionRuleDebounceRef.current) {
      clearTimeout(sectionRuleDebounceRef.current);
    }
    const {
      selectedSectionIndex: targetSectionIndex,
      sectionVariantIndex: targetSectionVariantIndex,
    } = latestRef.current;
    if (targetSectionIndex === null) return;

    sectionRuleDebounceRef.current = setTimeout(() => {
      const {
        rawSections: latestRawSections,
        parsedSections: latestParsedSections,
        decofile: latestDecofile,
        activePageKey: latestPageKey,
        pageVariants: latestVariants,
        variantIndex: latestVariantIndex,
      } = latestRef.current;
      if (!latestPageKey) return;

      const rawSection = latestRawSections[targetSectionIndex];
      const parsed = latestParsedSections[targetSectionIndex];
      if (!rawSection || !parsed?.isMultivariate) return;

      const mvObj = getMultivariateSectionObject(rawSection, parsed);
      if (!mvObj) return;

      const updatedMvObj = updateMultivariateSectionVariantRule(
        mvObj,
        targetSectionVariantIndex,
        newRule,
      );
      const updatedSections = [...latestRawSections];
      updatedSections[targetSectionIndex] = rebuildSectionWithMultivariate(
        rawSection,
        parsed,
        updatedMvObj,
      );

      const fullPageData = buildPageDataWithSections(
        latestDecofile,
        latestPageKey,
        updatedSections,
        latestVariantIndex,
        latestVariants,
      );

      saveBlock.mutate(
        { blockKey: latestPageKey, data: fullPageData },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleSectionMatcherTypeChange = (newRt: string) => {
    setSectionRuleResolveType(newRt);
    setSectionRuleFormValue({});
    scheduleSectionRuleSave(
      newRt
        ? { __resolveType: newRt }
        : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE },
    );
  };

  const handleSectionRuleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    setSectionRuleFormValue(next);
    const newRule: Record<string, unknown> = sectionRuleResolveType
      ? { __resolveType: sectionRuleResolveType, ...next }
      : { ...next };
    scheduleSectionRuleSave(newRule);
  };

  if (!isGlobalBlockMode && !activePage) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        No page found for {currentPath}
      </div>
    );
  }

  if (isGlobalBlockMode && !globalBlockData) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        Global block not found
      </div>
    );
  }

  const selectedParsed =
    selectedSectionIndex !== null
      ? (parsedSections[selectedSectionIndex] ?? null)
      : null;
  const selectedRawSection =
    selectedSectionIndex !== null ? rawSections[selectedSectionIndex] : null;
  const sectionMvObj =
    selectedRawSection && selectedParsed?.isMultivariate
      ? getMultivariateSectionObject(selectedRawSection, selectedParsed)
      : null;
  const sectionFlagVariants = sectionMvObj
    ? parseSectionFlagVariants(sectionMvObj, formatMatcher)
    : [];
  const safeSectionVariantIndex = Math.min(
    activeSectionVariantIndex,
    Math.max(sectionFlagVariants.length - 1, 0),
  );
  const activeSectionFlagVariant =
    sectionFlagVariants[safeSectionVariantIndex] ?? null;
  const isEditingMultivariateSection = selectedParsed?.isMultivariate === true;
  const isEditingSection =
    selectedSectionIndex !== null && selectedParsed !== null;
  const isEditing =
    isEditingSection &&
    (isEditingMultivariateSection || !!(activeSchema && formValue));
  const sectionRuleSchema =
    sectionRuleResolveType && meta
      ? resolveSchema(sectionRuleResolveType, meta)
      : null;
  const editingBreadcrumbs =
    isEditing && (!isGlobalBlockMode || fieldBreadcrumbs.length > 0)
      ? isGlobalBlockMode
        ? [globalBlockName, ...fieldBreadcrumbs]
        : [
            activePage!.name,
            selectedParsed!.label,
            ...(isEditingMultivariateSection && activeSectionFlagVariant
              ? [activeSectionFlagVariant.label]
              : []),
            ...fieldBreadcrumbs,
          ]
      : [];
  const handleAddPageVariant = () => {
    if (!activePageKey) return;
    const fullPageData = decofile[activePageKey] as Record<string, unknown>;
    const current = fullPageData.sections;
    // Seed the new variant with a clone of the currently active variant's
    // sections — gives the user a working baseline to modify (matches the
    // A/B-test mental model: fork-then-tweak).
    const seedSections = structuredClone(rawSections);
    let updatedSections: Record<string, unknown>;
    if (Array.isArray(current)) {
      updatedSections = {
        variants: [{ value: current }, { value: seedSections }],
      };
    } else if (current && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (Array.isArray(obj.variants)) {
        updatedSections = {
          ...obj,
          variants: [...(obj.variants as unknown[]), { value: seedSections }],
        };
      } else {
        return;
      }
    } else {
      updatedSections = {
        variants: [{ value: [] }, { value: seedSections }],
      };
    }
    const newVariantIndex = Array.isArray(updatedSections.variants as unknown[])
      ? (updatedSections.variants as unknown[]).length - 1
      : 1;
    saveBlock.mutate(
      {
        blockKey: activePageKey,
        data: { ...fullPageData, sections: updatedSections },
      },
      {
        onSuccess: () => {
          setActiveVariantIndex(newVariantIndex);
          setSelectedSectionIndex(null);
          setFormValue(null);
          setActiveResolveType(null);
          setFieldBreadcrumbs([]);
          setRuleFormValue(null);
          setRuleResolveType(null);
        },
        onError: (err) => toast.error(`Save failed: ${err.message}`),
      },
    );
  };

  /**
   * Read the page's variants array, apply a transform, then either persist
   * the modified `{ variants: [...] }` shape or collapse back to a flat
   * sections array when only one variant remains. Shared by delete + rename.
   */
  const mutatePageVariants = (
    transform: (
      variants: Array<Record<string, unknown>>,
    ) => Array<Record<string, unknown>> | null,
    onSaved?: () => void,
  ) => {
    if (!activePageKey) return;
    const fullPageData = decofile[activePageKey] as Record<string, unknown>;
    const current = fullPageData.sections;
    if (!current || typeof current !== "object" || Array.isArray(current))
      return;
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj.variants)) return;
    const next = transform([
      ...(obj.variants as Array<Record<string, unknown>>),
    ]);
    if (!next) return;
    const updatedSections: unknown =
      next.length === 1 && Array.isArray(next[0]?.value)
        ? (next[0].value as unknown[])
        : { ...obj, variants: next };
    saveBlock.mutate(
      {
        blockKey: activePageKey,
        data: { ...fullPageData, sections: updatedSections },
      },
      {
        onSuccess: () => onSaved?.(),
        onError: (err) => toast.error(`Save failed: ${err.message}`),
      },
    );
  };

  const handleDeletePageVariant = (variantIndex: number) => {
    mutatePageVariants(
      (variants) => {
        if (variants.length <= 1) return null;
        variants.splice(variantIndex, 1);
        return variants;
      },
      () => {
        // After delete, keep the user on a valid neighboring variant.
        const collapsing = pageVariants.length - 1 === 1;
        if (collapsing) {
          setActiveVariantIndex(0);
        } else if (variantIndex < safeVariantIndex) {
          setActiveVariantIndex(safeVariantIndex - 1);
        } else if (variantIndex === safeVariantIndex) {
          setActiveVariantIndex(Math.max(0, variantIndex - 1));
        }
        setSelectedSectionIndex(null);
        setFormValue(null);
        setActiveResolveType(null);
        setFieldBreadcrumbs([]);
        setRuleFormValue(null);
        setRuleResolveType(null);
      },
    );
  };

  const handleRenamePageVariant = async (
    variantIndex: number,
    nextName: string,
  ) => {
    if (!activePageKey) return;

    const fullPageData = decofile[activePageKey] as Record<string, unknown>;
    const current = fullPageData.sections;
    if (!current || typeof current !== "object" || Array.isArray(current))
      return;
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj.variants)) return;

    const variants = [...(obj.variants as Array<Record<string, unknown>>)];
    const target = variants[variantIndex];
    if (!target?.rule) return;

    const trimmed = nextName.trim();
    setRenameVariantPending(true);

    try {
      if (!trimmed) {
        if (!isSavedMatcherBlockReference(target.rule, decofile)) {
          setRenameVariantIndex(null);
          return;
        }

        const blockKey = (target.rule as Record<string, unknown>)
          .__resolveType as string;
        variants[variantIndex] = {
          ...target,
          rule: inlineMatcherRule(target.rule, decofile),
        };

        await saveBlock.mutateAsync({
          blockKey: activePageKey,
          data: { ...fullPageData, sections: { ...obj, variants } },
        });
        await deleteBlock.mutateAsync({ blockKey });
        setRenameVariantIndex(null);
        onSaved?.();
        return;
      }

      const unwrapped = unwrapMatcherRule(target.rule, decofile);
      if (!unwrapped) return;

      if (unwrapped.blockKey) {
        await saveBlock.mutateAsync({
          blockKey: unwrapped.blockKey,
          data: buildMatcherBlockData(
            unwrapped.resolveType,
            unwrapped.data,
            trimmed,
          ),
        });
        setRenameVariantIndex(null);
        onSaved?.();
        return;
      }

      const blockId = suggestBlockId(trimmed);
      const validationError = validateBlockId(blockId, decofile);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      await saveBlock.mutateAsync({
        blockKey: blockId,
        data: buildMatcherBlockData(
          unwrapped.resolveType,
          unwrapped.data,
          trimmed,
        ),
      });

      variants[variantIndex] = {
        ...target,
        rule: buildMatcherBlockReference(blockId),
      };

      await saveBlock.mutateAsync({
        blockKey: activePageKey,
        data: { ...fullPageData, sections: { ...obj, variants } },
      });

      setRenameVariantIndex(null);
      toast.success(`Saved matcher as global block "${trimmed}"`);
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to rename variant",
      );
    } finally {
      setRenameVariantPending(false);
    }
  };

  const exitSectionEditing = () => {
    clearSectionEditing();
  };
  const handleBreadcrumbClick = (index: number) => {
    if (isGlobalBlockMode) {
      setFieldBreadcrumbs(fieldBreadcrumbs.slice(0, index));
      setFormResetKey((key) => key + 1);
      return;
    }

    if (index === 0) {
      exitSectionEditing();
      return;
    }

    if (index === 1) {
      setFieldBreadcrumbs([]);
      setFormResetKey((key) => key + 1);
      return;
    }

    if (isEditingMultivariateSection && index === 2) {
      setFieldBreadcrumbs([]);
      setFormResetKey((key) => key + 1);
      return;
    }

    const fieldBase = isEditingMultivariateSection ? 2 : 1;
    setFieldBreadcrumbs(fieldBreadcrumbs.slice(0, index - fieldBase));
  };

  return (
    <div className="flex h-full min-w-0 w-full flex-col">
      {/* Page header */}
      <div className="px-3 py-2.5 border-b shrink-0">
        {isEditing && (!isGlobalBlockMode || fieldBreadcrumbs.length > 0) ? (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {!isGlobalBlockMode && hasMultipleVariants && activeVariant && (
              <button
                type="button"
                onClick={exitSectionEditing}
                title={`Editing in variant: ${activeVariant.label}`}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1 rounded-md h-6 px-1.5 text-xs font-medium cursor-pointer transition-opacity hover:opacity-80",
                  VARIANT_TAB_ACTIVE_CLASS,
                )}
              >
                <VariantTabIcon
                  rule={resolveEffectiveMatcherRule(
                    activeVariant.rule,
                    decofile ?? {},
                  )}
                  matchers={availableMatchers}
                />
                <span className="max-w-[160px] truncate">
                  {activeVariant.label}
                </span>
              </button>
            )}
            <nav
              aria-label="Editing breadcrumb"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
            >
              {editingBreadcrumbs.map((crumb, index) => {
                const isLast = index === editingBreadcrumbs.length - 1;

                return (
                  <span
                    key={`${crumb}-${index}`}
                    className="flex min-w-0 items-center gap-1 overflow-hidden"
                  >
                    {index > 0 && (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
                    )}
                    <button
                      type="button"
                      onClick={() => handleBreadcrumbClick(index)}
                      title={crumb}
                      className={cn(
                        "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                        isLast
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {crumb}
                    </button>
                  </span>
                );
              })}
            </nav>
          </div>
        ) : isGlobalBlockMode ? (
          <div className="space-y-0.5">
            <div className="text-sm font-medium truncate">
              {globalBlockName}
            </div>
            <div className="text-xs text-muted-foreground">
              Global component
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <PageHeaderInputs
                pageKey={activePageKey!}
                initialName={activePage!.name}
                initialPath={activePage!.path}
                onFieldChange={savePageField}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Add variant"
                  className="size-7 shrink-0"
                  style={{ color: "oklch(0.65 0.15 160)" }}
                  onClick={handleAddPageVariant}
                >
                  <Flag01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add variant</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Variant selector (when page sections are multivariate) */}
      {hasMultipleVariants && !isEditing && (
        <div className="flex items-center border-b shrink-0">
          <div className="flex flex-1 min-w-0 items-center gap-1.5 pl-3 pr-2 py-2 overflow-x-auto">
            {pageVariants.map((variant, i) => {
              const isActive = i === safeVariantIndex;
              const canDelete = pageVariants.length > 1;
              return (
                <div
                  key={i}
                  className={cn(
                    "group shrink-0 inline-flex items-center rounded-md transition-colors",
                    isActive
                      ? VARIANT_TAB_ACTIVE_CLASS
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveVariantIndex(i);
                      setSelectedSectionIndex(null);
                      setFormValue(null);
                      setActiveResolveType(null);
                      setFieldBreadcrumbs([]);
                      const variantRule = pageVariants[i]?.rule;
                      const { resolveType, formValue } =
                        readMatcherRuleFormState(variantRule, decofile ?? {});
                      setRuleResolveType(resolveType);
                      setRuleFormValue(formValue);
                    }}
                    className="inline-flex items-center gap-1.5 h-8 pl-3 pr-1.5 text-sm font-medium cursor-pointer"
                  >
                    <VariantTabIcon
                      rule={resolveEffectiveMatcherRule(
                        variant.rule,
                        decofile ?? {},
                      )}
                      matchers={availableMatchers}
                    />
                    <span className="truncate">{variant.label}</span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Actions for ${variant.label}`}
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "inline-flex h-8 w-6 items-center justify-center pr-1 cursor-pointer transition-opacity",
                          "opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100",
                          isActive && "opacity-100",
                        )}
                      >
                        <DotsHorizontal size={12} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-36">
                      <DropdownMenuItem
                        onClick={() => setRenameVariantIndex(i)}
                      >
                        <Edit01 size={14} />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={!canDelete}
                        onClick={() => handleDeletePageVariant(i)}
                      >
                        <Trash01 size={14} />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
          {/* Pinned "+" — stays visible regardless of horizontal scroll. */}
          <div className="shrink-0 pr-3 pl-1 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Add variant"
                  className="size-8 shrink-0 cursor-pointer"
                  style={{ color: VARIANT_GREEN_TEXT }}
                  onClick={handleAddPageVariant}
                >
                  <Plus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add variant</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Drill-down: section list OR section form */}
      {isEditing ? (
        <ScrollArea className="flex-1 min-h-0">
          {isEditingMultivariateSection && sectionFlagVariants.length > 0 && (
            <>
              <SectionVariantList
                variants={sectionFlagVariants.map((variant, index) => ({
                  index,
                  label: variant.label,
                }))}
                selectedIndex={safeSectionVariantIndex}
                onSelect={handleSelectSectionVariant}
                onDuplicate={handleDuplicateSectionVariant}
                onDelete={handleDeleteSectionVariant}
                onRemoveAll={handleRemoveAllSectionVariants}
              />
              {isEditingMultivariateSection && (
                <div className="px-3 py-3 border-b space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Variant rule
                  </span>
                  <MatcherPicker
                    currentRt={sectionRuleResolveType ?? ""}
                    currentLabel={formatMatcher(activeSectionFlagVariant?.rule)}
                    matchers={availableMatchers}
                    onSelect={handleSectionMatcherTypeChange}
                  />
                  {sectionRuleSchema && sectionRuleFormValue && (
                    <div className="pt-1">
                      <SchemaForm
                        schema={sectionRuleSchema}
                        value={sectionRuleFormValue}
                        onChange={handleSectionRuleFormChange}
                        basePath=""
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="min-w-0 max-w-full overflow-x-hidden p-4">
            {activeSchema && formValue ? (
              <SchemaForm
                key={formResetKey}
                schema={activeSchema}
                value={formValue}
                onChange={handleFormChange}
                basePath=""
                breadcrumbPath={[]}
                onBreadcrumbChange={setFieldBreadcrumbs}
              />
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No editable fields for this variant.
              </div>
            )}
          </div>
        </ScrollArea>
      ) : isGlobalBlockMode ? (
        <ScrollArea className="flex-1 min-h-0">
          <div className="min-w-0 max-w-full overflow-x-hidden p-4">
            {activeSchema && formValue ? (
              <SchemaForm
                key={formResetKey}
                schema={activeSchema}
                value={formValue}
                onChange={handleFormChange}
                basePath=""
                breadcrumbPath={[]}
                onBreadcrumbChange={setFieldBreadcrumbs}
              />
            ) : (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No editable fields for this global block.
              </div>
            )}
          </div>
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          {/* Variant rule editor (collapsible so users can reclaim space) */}
          {hasMultipleVariants && ruleResolveType !== null && (
            <div
              className={cn(
                "px-3 border-b",
                isVariantRuleOpen ? "pt-3 pb-5 space-y-3" : "py-2",
              )}
            >
              <button
                type="button"
                onClick={() => setIsVariantRuleOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left cursor-pointer rounded-sm py-0.5 hover:bg-muted/40"
                aria-expanded={isVariantRuleOpen}
              >
                <span className="text-xs font-medium text-muted-foreground">
                  Variant rule
                </span>
                {isVariantRuleOpen ? (
                  <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
              {isVariantRuleOpen && (
                <>
                  <MatcherPicker
                    currentRt={ruleResolveType}
                    currentLabel={resolveVariantRuleLabel(
                      activeVariant?.rule,
                      decofile ?? {},
                      formatMatcher,
                    )}
                    matchers={availableMatchers}
                    onSelect={handleMatcherTypeChange}
                  />
                  {ruleSchema && ruleFormValue && (
                    <div className="space-y-3">
                      <SchemaForm
                        schema={ruleSchema}
                        value={ruleFormValue}
                        onChange={handleRuleFormChange}
                        basePath=""
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <div className="p-2 pt-3">
            <SectionList
              listKey={`${activePageKey ?? ""}-${safeVariantIndex}`}
              sections={parsedSections}
              selectedIndex={selectedSectionIndex}
              onSelect={handleSelectSection}
              onReorder={handleReorder}
              onDelete={handleDeleteSection}
              onDuplicate={handleDuplicateSection}
              onMakeReusable={setMakeReusableIndex}
              onAddSection={() => setAddSectionOpen(true)}
              canAddSection={canAddSection}
            />
          </div>
        </ScrollArea>
      )}

      <MakeReusableModal
        open={makeReusableIndex !== null}
        onOpenChange={(open) => {
          if (!open) setMakeReusableIndex(null);
        }}
        defaultBlockId={
          makeReusableIndex !== null
            ? suggestBlockId(parsedSections[makeReusableIndex]?.label ?? "")
            : ""
        }
        isPending={saveBlock.isPending}
        onSubmit={handleMakeReusableSubmit}
      />

      {previewUrl && (
        <AddSectionModal
          open={addSectionOpen}
          onOpenChange={setAddSectionOpen}
          meta={meta}
          decofile={decofile}
          previewBaseUrl={previewUrl}
          onSelect={handleAddSection}
        />
      )}

      {renameVariantIndex !== null && (
        <VariantRenameDialog
          open
          initialName={
            isSavedMatcherBlockReference(
              pageVariants[renameVariantIndex]?.rule,
              decofile ?? {},
            )
              ? resolveVariantRuleLabel(
                  pageVariants[renameVariantIndex]?.rule,
                  decofile ?? {},
                  formatMatcher,
                )
              : ""
          }
          autoLabel={formatMatcher(
            resolveEffectiveMatcherRule(
              pageVariants[renameVariantIndex]?.rule,
              decofile ?? {},
            ),
          )}
          isPending={renameVariantPending}
          onSubmit={async (name) => {
            await handleRenamePageVariant(renameVariantIndex, name);
          }}
          onOpenChange={(open) => {
            if (!open && !renameVariantPending) setRenameVariantIndex(null);
          }}
        />
      )}
    </div>
  );
}

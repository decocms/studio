import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/i18n/use-t";
import { KEYS } from "@/lib/query-keys";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code01,
  Globe01,
  Loading01,
  CreditCardSearch,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { VariantRenameDialog } from "./variant-rename-dialog";
import { toast } from "sonner";
import { useDecofile } from "./use-decofile";
import { useLiveMeta } from "./use-live-meta";
import { useDeleteBlock } from "./use-delete-block";
import {
  AUTOSAVE_DELAY,
  useDebouncedSaveBlock,
  useSaveBlock,
} from "./use-save-block";
import { extractPages, findPageForPath, globalSectionLabel } from "./page-list";
import { SectionList, parseSections } from "./section-list";
import { isLazyResolveType } from "./section-lazy";
import { unwrapSection } from "./unwrap-section";
import { arrayMove } from "@dnd-kit/sortable";
import type { ParsedSection } from "./section-list";
import { resolveSchema } from "./resolve-schema";
import { findSiteSeoEntry, resolveSeoTarget } from "./seo-block";
import { defaultPageSeoResolveType } from "./seo-schema";
import { activeSeoResolveType, buildSeoSavePayload } from "./seo-save";
import { isSeoEnabled, unwrapSeoConfig } from "./seo-lazy-render";
import { PageSeoForm } from "./page-seo-form";
import { extractMatcherGlobals, extractMatchers } from "./matcher-picker";
import { PageVariantTabs, VariantTabIcon } from "./page-variant-tabs";
import { MakeReusableModal } from "./make-reusable-modal";
import { AddSectionModal } from "./add-section-modal";
import { useSectionPreviewBase } from "./use-section-preview-base";
import type { SectionCatalogEntry } from "./section-catalog";
import { SectionVariantList } from "./section-variant-list";
import {
  type Crumb,
  crumbLabel,
  headerBackTargetIndex,
} from "./schema-form-breadcrumb";
import { ALWAYS_MATCHER_RESOLVE_TYPE, type RawSection } from "./section-types";
import {
  buildMatcherBlockData,
  buildMatcherBlockReference,
  getSavedMatcherBlockKey,
  inlineMatcherRule,
  isSavedMatcherBlockReference,
  readMatcherRuleFormState,
  resolveEffectiveMatcherRule,
  resolveVariantRuleLabel,
  seedMatcherRule,
  unwrapMatcherRule,
} from "./matcher-rules";
import {
  appendPageVariantSections,
  buildPageSectionsFromVariants,
  countSavedMatcherBlockReferences,
  duplicatePageVariantEntry,
  getLastVariantIndex,
  isMultivariateArrayWrapper,
  type PageVariant,
} from "./page-variants";
import {
  buildPageDataWithSections,
  cloneSection,
  suggestBlockId,
  validateBlockId,
} from "./page-sections";
import {
  appendSectionVariant,
  deleteMultivariateSectionVariant,
  duplicateMultivariateSectionVariant,
  flattenMultivariateSection,
  getMultivariateSectionObject,
  hideSection,
  parseSectionFlagVariants,
  rebuildSectionWithMultivariate,
  reorderMultivariateSectionVariant,
  showSection,
  toggleSectionLazyRender,
  unwrapVariantSectionValue,
  updateMultivariateSectionVariantRule,
  updateMultivariateSectionVariantValue,
} from "./section-variants";
import {
  buildPageVariantOverrideParams,
  buildSectionVariantOverrideParams,
  type PageVariantInfo,
} from "./variant-matcher-override";
import { PageJsonDialog } from "./page-json-dialog";
import { createReferencedBlockSaver } from "./save-referenced-block";
import { formatMatcher } from "./format-matcher";
import {
  AddVariantButton,
  PageHeaderInputs,
  parsePageVariantsForEditor,
  SchemaFormPanel,
  VARIANT_TAB_ACTIVE_CLASS,
} from "./sections-editor-panels";
import { VariantRuleEditor } from "./variant-rule-editor";

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
  externalSelection,
  onSaved,
  initialEditSeo = false,
  onExitSeo,
  onViewJsonFile,
  onVariantPreviewOverride,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** When false, waits for the sandbox dev server before fetching metadata. */
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
  /** Click-through from the preview iframe; `seq` distinguishes repeat clicks. */
  externalSelection?: { index: number; seq: number } | null;
  /** Called after a successful auto-save so the parent can reload the preview. */
  onSaved?: () => void;
  /** Open the inline page SEO form on mount (e.g. after "Edit SEO" from a host menu). */
  initialEditSeo?: boolean;
  /** Called when the user leaves inline SEO via the breadcrumb bar. */
  onExitSeo?: () => void;
  /**
   * When provided, "View JSON" opens the page's block file in the host's file
   * view (passing the decofile block key) instead of the built-in JSON modal.
   * Hosts without a file surface (Content tab) omit this and get the modal.
   */
  onViewJsonFile?: (pageKey: string) => void;
  /**
   * Called when the selected section variant changes so the host can force the
   * preview iframe to render that variant via `x-deco-matchers-override`.
   * Passes `null` when no variant override should be applied (non-multivariate
   * section, or nothing selected).
   */
  onVariantPreviewOverride?: (params: string[] | null) => void;
}) {
  const t = useT();
  const previewFetchParams = previewReady
    ? { orgSlug, virtualMcpId, branch, previewUrl }
    : null;
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(previewFetchParams);
  const { data: meta, isLoading: metaLoading } =
    useLiveMeta(previewFetchParams);
  const inset = useInsetContext();
  const agentSiteSlug =
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.siteSlug ?? null)
      : null;
  // Section-gallery previews render against the sandbox dev server, falling
  // back to the Fast Preview production deployment while the sandbox boots.
  const sectionPreviewBase = useSectionPreviewBase({
    virtualMcpId,
    sandboxUrl: previewUrl,
  });

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
  const [prevExternalSeq, setPrevExternalSeq] = useState<
    number | null | undefined
  >(undefined);
  const [ruleFormValue, setRuleFormValue] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ruleResolveType, setRuleResolveType] = useState<string | null>(null);
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<Crumb[]>([]);
  // Reset the form panel's scroll to the top whenever the drill-down DEPTH
  // changes (entering/leaving an item), so a drilled-in item form always starts
  // at the top instead of inheriting the previous view's scroll offset. Keyed on
  // depth, not the full trail, so editing a field that syncs its own crumb label
  // (ArrayField.updateItem) doesn't yank the scroll mid-typing.
  const fieldScrollRef = useRef<HTMLDivElement>(null);
  const [prevFieldDepth, setPrevFieldDepth] = useState(fieldBreadcrumbs.length);
  if (prevFieldDepth !== fieldBreadcrumbs.length) {
    setPrevFieldDepth(fieldBreadcrumbs.length);
    requestAnimationFrame(() => {
      if (fieldScrollRef.current) fieldScrollRef.current.scrollTop = 0;
    });
  }
  const [formResetKey, setFormResetKey] = useState(0);
  const [makeReusableIndex, setMakeReusableIndex] = useState<number | null>(
    null,
  );
  const [renameVariantIndex, setRenameVariantIndex] = useState<number | null>(
    null,
  );
  const [renameSectionVariantIndex, setRenameSectionVariantIndex] = useState<
    number | null
  >(null);
  const [isVariantRuleOpen, setIsVariantRuleOpen] = useState(true);
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  // When the section picker is opened from an array-of-sections field (rather
  // than the page's section list), the field hands us an `append` callback here.
  // A non-null ref routes the modal selection to that field instead of the page.
  const pendingAppendRef = useRef<((item: unknown) => void) | null>(null);

  // Inline SEO editing mode — same breadcrumb UX as editing a section
  const [editingSeo, setEditingSeo] = useState(initialEditSeo);
  const [prevInitialEditSeo, setPrevInitialEditSeo] = useState(initialEditSeo);
  if (initialEditSeo && !prevInitialEditSeo) {
    setPrevInitialEditSeo(true);
    setEditingSeo(true);
    setSelectedSectionIndex(null);
    setFormValue(null);
    setActiveResolveType(null);
    setFieldBreadcrumbs([]);
  }
  if (!initialEditSeo && prevInitialEditSeo) {
    setPrevInitialEditSeo(false);
  }
  const [seoFormValue, setSeoFormValue] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [seoRawOverride, setSeoRawOverride] = useState<
    Record<string, unknown> | null | undefined
  >(undefined);
  const [seoFieldBreadcrumbs, setSeoFieldBreadcrumbs] = useState<Crumb[]>([]);
  const [seoFormResetKey, setSeoFormResetKey] = useState(0);
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

  const queryClient = useQueryClient();
  const decofileCacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
  const pageBlockSave = useDebouncedSaveBlock({
    orgSlug,
    virtualMcpId,
    branch,
  });

  // Reset form state when the active page or global block changes
  const [prevPath, setPrevPath] = useState(currentPath);
  const [prevPageBlockKey, setPrevPageBlockKey] = useState(activePageBlockKey);
  const [prevGlobalBlockKey, setPrevGlobalBlockKey] =
    useState(activeGlobalBlockKey);
  if (
    prevPath !== currentPath ||
    prevPageBlockKey !== activePageBlockKey ||
    prevGlobalBlockKey !== activeGlobalBlockKey
  ) {
    queueMicrotask(() => pageBlockSave.flush());
    setPrevPath(currentPath);
    setPrevPageBlockKey(activePageBlockKey);
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
    setEditingSeo(false);
    setSeoFormValue(null);
    setSeoRawOverride(undefined);
    setSeoFieldBreadcrumbs([]);
    setSeoFormResetKey((key) => key + 1);
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const saveReferencedBlock = createReferencedBlockSaver((refKey, data) => {
    saveBlock.mutate(
      { blockKey: refKey, data },
      {
        onSuccess: () => onSaved?.(),
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
      },
    );
  });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  const [renameVariantPending, setRenameVariantPending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    decofile: {} as Record<string, unknown>,
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
        {t("sectionsEditor.sectionsEditor.couldNotLoadSiteData")}
      </div>
    );
  }

  const pages = extractPages(decofile);
  const isGlobalBlockMode = !!activeGlobalBlockKey;
  const activePage = isGlobalBlockMode
    ? null
    : findPageForPath(pages, currentPath, activePageBlockKey);
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

  // SEO computed values — only while inline SEO is open
  const inlineSeoResolved =
    editingSeo && decofile && meta && activePageKey && activePage
      ? resolveSeoTarget(
          decofile,
          {
            kind: "page",
            pageKey: activePageKey,
            pageName: String(activePage.name ?? ""),
            path: String(activePage.path ?? ""),
          },
          meta,
        )
      : null;
  const savedRawSeo = editingSeo ? pageData?.seo : undefined;
  const displayRawSeo =
    seoRawOverride !== undefined ? seoRawOverride : savedRawSeo;
  const innerFromSaved = editingSeo
    ? unwrapSeoConfig(displayRawSeo)
    : undefined;
  const seoTypeOptions = inlineSeoResolved?.seoTypeOptions ?? [];
  const defaultResolveType =
    editingSeo && meta ? defaultPageSeoResolveType(meta) : "";
  const effectiveInner = (seoFormValue ?? innerFromSaved ?? {}) as Record<
    string,
    unknown
  >;
  const activeSeoType =
    editingSeo && inlineSeoResolved
      ? activeSeoResolveType(effectiveInner, inlineSeoResolved)
      : null;
  const seoSchema =
    editingSeo && activeSeoType && isSeoEnabled(displayRawSeo)
      ? resolveSchema(activeSeoType, meta)
      : null;
  const siteDefaultSeo = editingSeo
    ? findSiteSeoEntry(decofile, meta)?.seoData
    : undefined;

  const pageVariants = isGlobalBlockMode
    ? [
        {
          label: "Default",
          sections: [{ __resolveType: activeGlobalBlockKey! } as RawSection],
        },
      ]
    : parsePageVariantsForEditor(pageData?.sections, decofile ?? {});
  const hasMultipleVariants = pageVariants.length > 1;
  const safeVariantIndex = Math.min(
    activeVariantIndex,
    pageVariants.length - 1,
  );
  const activeVariant = pageVariants[safeVariantIndex];
  const rawSections: RawSection[] = activeVariant?.sections ?? [];
  const parsedSections = parseSections(rawSections, decofile);
  // Page is page-level multivariate when `sections` is a multivariate wrapper.
  const pageIsMultivariate =
    !isGlobalBlockMode && isMultivariateArrayWrapper(pageData?.sections);

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
    decofile: decofile ?? ({} as Record<string, unknown>),
    activePageKey,
    pageVariants,
    variantIndex: safeVariantIndex,
    sectionVariantIndex: activeSectionVariantIndex,
    selectedSectionIndex,
  };

  // Force the preview iframe to render the selected variant via the deco
  // runtime's `x-deco-matchers-override`. `null` clears any prior override.
  const currentPageVariantInfo = (): PageVariantInfo => ({
    multivariate: pageIsMultivariate,
    index: safeVariantIndex,
    variants: pageVariants.map((v) => ({ rule: v.rule })),
  });

  // Force the preview to render a specific *page* variant. Pass the target
  // index/variants explicitly so callers can drive the override before the
  // render-scope `safeVariantIndex` reflects a pending state change.
  const emitPageVariantOverride = (
    variants: Array<{ rule?: Record<string, unknown> }>,
    index: number,
  ) => {
    if (!onVariantPreviewOverride) return;
    if (!activePageKey || !pageIsMultivariate || variants.length <= 1) {
      onVariantPreviewOverride(null);
      return;
    }
    const params = buildPageVariantOverrideParams(
      activePageKey,
      { multivariate: true, index, variants },
      decofile,
      meta,
    );
    onVariantPreviewOverride(params.length > 0 ? params : null);
  };

  const syncVariantPreviewOverride = (
    mvObj: Record<string, unknown> | null,
    sectionIndex: number,
    variantIndex: number,
  ) => {
    if (!onVariantPreviewOverride) return;
    if (!activePageKey) {
      onVariantPreviewOverride(null);
      return;
    }
    const pageInfo = currentPageVariantInfo();
    const pageParams = buildPageVariantOverrideParams(
      activePageKey,
      pageInfo,
      decofile,
      meta,
    );
    if (!mvObj || sectionIndex < 0) {
      onVariantPreviewOverride(pageParams.length > 0 ? pageParams : null);
      return;
    }
    const sectionParams = buildSectionVariantOverrideParams({
      pageKey: activePageKey,
      page: pageInfo,
      sectionIndex,
      sectionLazy: parsedSections[sectionIndex]?.isLazy ?? false,
      mvObj,
      selectedVariantIndex: variantIndex,
      decofile,
      meta,
    });
    const params = [...pageParams, ...sectionParams];
    onVariantPreviewOverride(params.length > 0 ? params : null);
  };

  const applySectionVariant = (
    rawSection: RawSection,
    parsed: ParsedSection,
    variantIndex: number,
    sectionIndex: number = selectedSectionIndex ?? -1,
    // Only force the preview to this variant on an explicit variant-row click.
    // Merely entering/auto-selecting a section must not re-navigate the iframe.
    syncPreview = false,
  ) => {
    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      if (syncPreview)
        syncVariantPreviewOverride(null, sectionIndex, variantIndex);
      return;
    }

    const variants = parseSectionFlagVariants(mvObj, formatMatcher);
    const variant = variants[variantIndex];
    if (!variant) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      if (syncPreview)
        syncVariantPreviewOverride(null, sectionIndex, variantIndex);
      return;
    }

    const unwrapped = unwrapVariantSectionValue(variant.value, decofile);
    setFormValue(unwrapped?.data ?? null);
    setActiveResolveType(unwrapped?.resolveType ?? null);

    const { resolveType, formValue } = readMatcherRuleFormState(
      variant.rule,
      decofile,
      meta ?? undefined,
    );
    setSectionRuleResolveType(resolveType);
    setSectionRuleFormValue(formValue);
    if (syncPreview)
      syncVariantPreviewOverride(mvObj, sectionIndex, variantIndex);
  };

  // Auto-select on preview click-through, keyed on `seq` so repeat clicks count.
  const externalSelectedIndex = externalSelection?.index;
  if (
    externalSelection !== undefined &&
    (externalSelection?.seq ?? null) !== prevExternalSeq
  ) {
    setPrevExternalSeq(externalSelection?.seq ?? null);
    if (typeof externalSelectedIndex === "number") {
      const rawSection = rawSections[externalSelectedIndex];
      const parsed = parsedSections[externalSelectedIndex];
      if (rawSection && parsed) {
        setSelectedSectionIndex(externalSelectedIndex);
        setActiveSectionVariantIndex(0);
        setFieldBreadcrumbs([]);
        setFormResetKey((key) => key + 1);
        if (parsed.isMultivariate) {
          applySectionVariant(rawSection, parsed, 0, externalSelectedIndex);
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

  const sandbox = {
    orgSlug,
    virtualMcpId,
    branch,
    previewUrl: previewUrl ?? undefined,
    siteSlug: agentSiteSlug,
  };

  const activeSchema =
    activeResolveType && meta ? resolveSchema(activeResolveType, meta) : null;

  const savePageSections = (
    updatedSections: RawSection[],
    options?: { onSuccess?: () => void },
  ) => {
    if (!activePageKey) return;
    // Cancel pending field/rule autosave timers — they capture a section index
    // at schedule time and write into `rawSections[index]` (read fresh via
    // latestRef) when they fire. Restructuring the array here (delete,
    // duplicate, reorder, hide/show, ...) shifts what's at that index, so a
    // still-pending timer would land its stale write on the wrong section.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (sectionRuleDebounceRef.current) {
      clearTimeout(sectionRuleDebounceRef.current);
      sectionRuleDebounceRef.current = null;
    }
    // Cancel a pending page-variant rule autosave too — it rebuilds the whole
    // page's `sections` from a `decofile` snapshot read at fire time, which
    // may still predate this save's result, so a stale timer would revert
    // the restructuring committed here.
    if (ruleDebounceRef.current) {
      clearTimeout(ruleDebounceRef.current);
      ruleDebounceRef.current = null;
    }
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
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
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
            onError: (err) =>
              toast.error(
                t("sectionsEditor.sectionsEditor.saveFailed", {
                  error: err.message,
                }),
              ),
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
          onError: (err) =>
            toast.error(
              t("sectionsEditor.sectionsEditor.saveFailed", {
                error: err.message,
              }),
            ),
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
      applySectionVariant(rawSection, parsed, 0, index);
      return;
    }

    const unwrapped = unwrapSection(rawSection, parsed, decofile);
    if (!unwrapped) {
      setFormValue(null);
      setActiveResolveType(null);
      setSectionRuleResolveType(null);
      setSectionRuleFormValue(null);
      syncVariantPreviewOverride(null, index, 0);
      return;
    }

    setFormValue(unwrapped.data);
    setActiveResolveType(unwrapped.resolveType);
    setSectionRuleResolveType(null);
    setSectionRuleFormValue(null);
    syncVariantPreviewOverride(null, index, 0);
  };

  const handleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    setFormValue(next);
    if (selectedSectionIndex !== null) {
      scheduleAutoSave(next, selectedSectionIndex);
    }
  };

  const schedulePageBlockWrite = (seoPatch?: {
    inner?: Record<string, unknown>;
    raw?: Record<string, unknown> | null;
  }) => {
    if (!activePageKey || !decofile || !meta || !activePage) return;
    const target = {
      kind: "page" as const,
      pageKey: activePageKey,
      pageName: String(activePage.name ?? ""),
      path: String(activePage.path ?? ""),
    };
    const resolved = resolveSeoTarget(decofile, target, meta);
    if (!resolved) return;

    pageBlockSave.save(activePageKey, () => {
      const latest = queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(decofileCacheKey),
      )?.[activePageKey];
      if (
        !latest ||
        typeof latest !== "object" ||
        latest === null ||
        Array.isArray(latest)
      ) {
        return null;
      }
      const block = {
        ...(latest as Record<string, unknown>),
        ...pendingPageFieldsRef.current,
      };
      pendingPageFieldsRef.current = {};

      if (seoPatch?.raw !== undefined) {
        return { ...block, seo: seoPatch.raw };
      }
      if (seoPatch?.inner !== undefined) {
        return buildSeoSavePayload(target, resolved, block, seoPatch.inner);
      }
      return block;
    });
  };

  const savePageField = (field: "name" | "path", value: string) => {
    if (!activePageKey) return;
    pendingPageFieldsRef.current[field] = value;
    schedulePageBlockWrite();
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

  // Hide/show a section via the multivariate+never wrapper (see hideSection /
  // showSection). Round-trips normal, lazy, and saved-block sections.
  // Multivariate sections (real variants) are managed through the variant UI.
  const handleToggleHidden = (index: number) => {
    if (!activePageKey) return;
    const rawSection = rawSections[index];
    const parsed = parsedSections[index];
    if (!rawSection || !parsed || parsed.isMultivariate) return;

    const next = parsed.isHidden
      ? showSection(rawSection)
      : hideSection(rawSection);
    if (!next) return;

    const updatedSections = [...rawSections];
    updatedSections[index] = next;
    if (selectedSectionIndex === index) clearSectionEditing();
    savePageSections(updatedSections);
  };

  const handleToggleLazy = (index: number) => {
    if (!activePageKey) return;
    const rawSection = rawSections[index];
    const parsed = parsedSections[index];
    if (!rawSection || !parsed || parsed.isMultivariate) return;

    const next = toggleSectionLazyRender(rawSection);
    if (!next) return;

    const updatedSections = [...rawSections];
    updatedSections[index] = next;
    if (selectedSectionIndex === index) clearSectionEditing();
    savePageSections(updatedSections);
  };

  const handleDetachSection = (index: number) => {
    if (!activePageKey) return;
    const rawSection = rawSections[index];
    const parsed = parsedSections[index];
    if (!rawSection || !parsed?.isSavedBlock) return;

    const unwrapped = unwrapSection(rawSection, parsed, decofile);
    if (!unwrapped?.data) return;

    // Remove the `name` field — it belongs to the saved block, not the inline copy
    const { name: _name, ...inlineData } = unwrapped.data;

    const updatedSections = [...rawSections];
    if (parsed.isLazy) {
      // Preserve the lazy wrapper, replace the inner saved-block reference
      updatedSections[index] = {
        ...rawSection,
        section: inlineData,
      } as RawSection;
    } else {
      updatedSections[index] = inlineData as RawSection;
    }

    if (selectedSectionIndex === index) clearSectionEditing();
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

  // An array-of-sections field asks to open the picker; stash its `append`
  // callback so the shared AddSectionModal routes the selection back to it.
  const handleRequestAddSection = (context: {
    append: (item: unknown) => void;
  }) => {
    pendingAppendRef.current = context.append;
    setAddSectionOpen(true);
  };

  // Dispatches an AddSectionModal selection: when an array-of-sections field
  // requested the picker, append an inline section reference to it (the same
  // `{ __resolveType }` shape `handleAddSection` uses for the page list, and
  // that `ArrayField.addItem` uses for block-ref items). Otherwise fall back to
  // adding a section to the page's section list.
  const handleSelectSectionFromModal = (entry: SectionCatalogEntry) => {
    const append = pendingAppendRef.current;
    if (!append) {
      handleAddSection(entry);
      return;
    }
    append({ __resolveType: entry.resolveType });
    setAddSectionOpen(false);
    pendingAppendRef.current = null;
  };

  const handleSelectSectionVariant = (variantIndex: number) => {
    if (selectedSectionIndex === null) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    setActiveSectionVariantIndex(variantIndex);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    applySectionVariant(
      rawSection,
      parsed,
      variantIndex,
      selectedSectionIndex,
      true,
    );
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
      toast.error(t("sectionsEditor.sectionsEditor.cannotDeleteOnlyVariant"));
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

  const handleReorderSectionVariant = (fromIndex: number, toIndex: number) => {
    if (selectedSectionIndex === null || !activePageKey) return;
    if (fromIndex === toIndex) return;
    const rawSection = rawSections[selectedSectionIndex];
    const parsed = parsedSections[selectedSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const updatedMvObj = reorderMultivariateSectionVariant(
      mvObj,
      fromIndex,
      toIndex,
    );

    const updatedSections = [...rawSections];
    updatedSections[selectedSectionIndex] = rebuildSectionWithMultivariate(
      rawSection,
      parsed,
      updatedMvObj,
    );

    // Keep the selected variant pointing at the same variant after the move.
    let nextIndex = activeSectionVariantIndex;
    if (activeSectionVariantIndex === fromIndex) {
      nextIndex = toIndex;
    } else if (
      fromIndex < activeSectionVariantIndex &&
      toIndex >= activeSectionVariantIndex
    ) {
      nextIndex = activeSectionVariantIndex - 1;
    } else if (
      fromIndex > activeSectionVariantIndex &&
      toIndex <= activeSectionVariantIndex
    ) {
      nextIndex = activeSectionVariantIndex + 1;
    }

    setActiveSectionVariantIndex(nextIndex);
    applySectionVariant(
      updatedSections[selectedSectionIndex],
      parsed,
      nextIndex,
    );
    savePageSections(updatedSections);
  };

  const handleAddSectionVariant = (index?: number) => {
    const sectionIndex = index ?? selectedSectionIndex;
    if (sectionIndex === null || !activePageKey) return;

    const rawSection = rawSections[sectionIndex];
    const parsed = parsedSections[sectionIndex];
    if (!rawSection || !parsed) return;

    const result = appendSectionVariant(rawSection, parsed);
    if (!result) {
      toast.error(t("sectionsEditor.sectionsEditor.sectionCannotHaveVariants"));
      return;
    }

    const updatedSections = [...rawSections];
    updatedSections[sectionIndex] = result.section;
    const nextParsed = parseSections(updatedSections, decofile)[sectionIndex];
    if (!nextParsed?.isMultivariate) {
      toast.error(t("sectionsEditor.sectionsEditor.couldNotAddVariant"));
      return;
    }

    setSelectedSectionIndex(sectionIndex);
    setActiveSectionVariantIndex(result.newVariantIndex);
    setFieldBreadcrumbs([]);
    setFormResetKey((key) => key + 1);
    applySectionVariant(
      result.section,
      nextParsed,
      result.newVariantIndex,
      sectionIndex,
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
      toast.error(t("sectionsEditor.sectionsEditor.couldNotRemoveVariants"));
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

    syncVariantPreviewOverride(null, selectedSectionIndex, 0);
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
      toast.error(
        t("sectionsEditor.sectionsEditor.sectionCannotBeSavedAsGlobal"),
      );
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
      toast.success(
        t("sectionsEditor.sectionsEditor.savedGlobalBlock", { blockId }),
      );
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.failedToSaveGlobalBlock"),
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
      meta ?? undefined,
    );
    setRuleResolveType(resolveType);
    setRuleFormValue(formValue);
  }

  const availableMatchers = meta ? extractMatchers(meta) : [];
  const availableMatcherGlobals =
    meta && decofile ? extractMatcherGlobals(meta, decofile) : [];
  const canAddSection =
    !isGlobalBlockMode && !!(sectionPreviewBase && meta && decofile);

  const ruleSchema =
    ruleResolveType && meta ? resolveSchema(ruleResolveType, meta) : null;

  const cancelPendingRuleSaves = () => {
    if (ruleDebounceRef.current) {
      clearTimeout(ruleDebounceRef.current);
      ruleDebounceRef.current = null;
    }
    if (sectionRuleDebounceRef.current) {
      clearTimeout(sectionRuleDebounceRef.current);
      sectionRuleDebounceRef.current = null;
    }
  };

  const cleanupOrphanMatcherBlock = async (
    blockKey: string,
    projectedDecofile: Record<string, unknown>,
  ) => {
    if (
      countSavedMatcherBlockReferences(projectedDecofile, blockKey, meta) > 0
    ) {
      return;
    }
    try {
      await deleteBlock.mutateAsync({ blockKey });
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.couldNotDeleteMatcherBlock"),
      );
    }
  };

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

      if (isSavedMatcherBlockReference(currentRule, latestDecofile, meta)) {
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
            onError: (err) =>
              toast.error(
                t("sectionsEditor.sectionsEditor.saveFailed", {
                  error: err.message,
                }),
              ),
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
          onError: (err) =>
            toast.error(
              t("sectionsEditor.sectionsEditor.saveFailed", {
                error: err.message,
              }),
            ),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleMatcherTypeChange = (newRt: string) => {
    setRuleResolveType(newRt);
    // Seed union-matcher discriminants so accepting the default branch still
    // persists a valid rule (see seedMatcherRule).
    const newRule: Record<string, unknown> = newRt
      ? seedMatcherRule(newRt, meta)
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
    setRuleFormValue(newRt ? newRule : {});
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

  /**
   * Point the active page variant at an existing saved matcher block (global
   * rule). Writes the page with a reference (`{ __resolveType: blockKey }`) and
   * cleans up the previously-referenced block if it becomes orphaned.
   */
  const handlePageVariantSelectGlobal = async (blockKey: string) => {
    cancelPendingRuleSaves();
    const {
      activePageKey: pageKey,
      decofile: latestDecofile,
      variantIndex,
    } = latestRef.current;
    if (!pageKey) return;

    const fullPageData = latestDecofile[pageKey] as Record<string, unknown>;
    const current = fullPageData?.sections;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return;
    }
    const mv = current as Record<string, unknown>;
    if (!Array.isArray(mv.variants)) return;

    const variants = [...(mv.variants as Array<Record<string, unknown>>)];
    const target = variants[variantIndex];
    if (!target) return;

    const prevBlockKey = getSavedMatcherBlockKey(
      target.rule as Record<string, unknown> | undefined,
      latestDecofile,
      meta,
    );
    const rule = buildMatcherBlockReference(blockKey);
    variants[variantIndex] = { ...target, rule };

    const projectedDecofile = {
      ...latestDecofile,
      [pageKey]: { ...fullPageData, sections: { ...mv, variants } },
    };

    const { resolveType, formValue } = readMatcherRuleFormState(
      rule,
      projectedDecofile,
      meta ?? undefined,
    );
    setRuleResolveType(resolveType);
    setRuleFormValue(formValue);

    try {
      await saveBlock.mutateAsync({
        blockKey: pageKey,
        data: projectedDecofile[pageKey] as Record<string, unknown>,
      });
      if (prevBlockKey && prevBlockKey !== blockKey) {
        await cleanupOrphanMatcherBlock(prevBlockKey, projectedDecofile);
      }
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.couldNotApplySavedRule"),
      );
    }
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

      // When the variant references a saved matcher block (global rule), edits
      // to the rule form update the shared block, not the inline section rule —
      // mirrors the page-variant path in scheduleRuleSave.
      const currentSectionVariants =
        (mvObj.variants as Array<Record<string, unknown>>) ?? [];
      const currentSectionRule = currentSectionVariants[
        targetSectionVariantIndex
      ]?.rule as Record<string, unknown> | undefined;
      if (
        isSavedMatcherBlockReference(currentSectionRule, latestDecofile, meta)
      ) {
        const blockKey = (currentSectionRule?.__resolveType as string) ?? "";
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
            onError: (err) =>
              toast.error(
                t("sectionsEditor.sectionsEditor.saveFailed", {
                  error: err.message,
                }),
              ),
          },
        );
        return;
      }

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
          onError: (err) =>
            toast.error(
              t("sectionsEditor.sectionsEditor.saveFailed", {
                error: err.message,
              }),
            ),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const handleSectionMatcherTypeChange = (newRt: string) => {
    setSectionRuleResolveType(newRt);
    const newRule: Record<string, unknown> = newRt
      ? seedMatcherRule(newRt, meta)
      : { __resolveType: ALWAYS_MATCHER_RESOLVE_TYPE };
    setSectionRuleFormValue(newRt ? newRule : {});
    scheduleSectionRuleSave(newRule);
  };

  const handleSectionRuleFormChange = (val: unknown) => {
    const next = val as Record<string, unknown>;
    setSectionRuleFormValue(next);
    const newRule: Record<string, unknown> = sectionRuleResolveType
      ? { __resolveType: sectionRuleResolveType, ...next }
      : { ...next };
    scheduleSectionRuleSave(newRule);
  };

  /**
   * Point the active section variant at an existing saved matcher block (global
   * rule). Writes the page with a reference and cleans up the previously-
   * referenced block if it becomes orphaned.
   */
  const handleSectionVariantSelectGlobal = async (blockKey: string) => {
    cancelPendingRuleSaves();
    const {
      selectedSectionIndex: targetSectionIndex,
      sectionVariantIndex: targetSectionVariantIndex,
      rawSections: latestRawSections,
      parsedSections: latestParsedSections,
      decofile: latestDecofile,
      activePageKey: pageKey,
      pageVariants: latestVariants,
      variantIndex: latestVariantIndex,
    } = latestRef.current;
    if (targetSectionIndex === null || !pageKey) return;

    const rawSection = latestRawSections[targetSectionIndex];
    const parsed = latestParsedSections[targetSectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const variants = (mvObj.variants as Array<Record<string, unknown>>) ?? [];
    const prevBlockKey = getSavedMatcherBlockKey(
      variants[targetSectionVariantIndex]?.rule as
        | Record<string, unknown>
        | undefined,
      latestDecofile,
      meta,
    );
    const rule = buildMatcherBlockReference(blockKey);
    const updatedMvObj = updateMultivariateSectionVariantRule(
      mvObj,
      targetSectionVariantIndex,
      rule,
    );
    const updatedSections = [...latestRawSections];
    updatedSections[targetSectionIndex] = rebuildSectionWithMultivariate(
      rawSection,
      parsed,
      updatedMvObj,
    );

    const fullPageData = buildPageDataWithSections(
      latestDecofile,
      pageKey,
      updatedSections,
      latestVariantIndex,
      latestVariants,
    );
    const projectedDecofile = { ...latestDecofile, [pageKey]: fullPageData };

    const { resolveType, formValue } = readMatcherRuleFormState(
      rule,
      projectedDecofile,
      meta ?? undefined,
    );
    setSectionRuleResolveType(resolveType);
    setSectionRuleFormValue(formValue);

    try {
      await saveBlock.mutateAsync({ blockKey: pageKey, data: fullPageData });
      if (prevBlockKey && prevBlockKey !== blockKey) {
        await cleanupOrphanMatcherBlock(prevBlockKey, projectedDecofile);
      }
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.couldNotApplySavedRule"),
      );
    }
  };

  if (!isGlobalBlockMode && !activePage) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        {t("sectionsEditor.sectionsEditor.noPageFound", { currentPath })}
      </div>
    );
  }

  if (isGlobalBlockMode && !globalBlockData) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        {t("sectionsEditor.sectionsEditor.globalBlockNotFound")}
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
  // A reusable/global section reached from inside a page (purple in the list).
  // Editing it writes back to the shared block definition, so changes apply
  // everywhere it's used — surface the same global banner as the dedicated
  // global-section route.
  const isEditingSavedBlock =
    isEditing && !isGlobalBlockMode && selectedParsed?.isSavedBlock === true;
  const showGlobalBanner = isGlobalBlockMode || isEditingSavedBlock;
  const globalBannerName = isGlobalBlockMode
    ? globalBlockName
    : (selectedParsed?.label ?? "");
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
  // The global header still needs a crumb at the top level of a directly-opened
  // global block, where editingBreadcrumbs is empty — fall back to its name.
  const seoBreadcrumbs =
    editingSeo && activePage
      ? [activePage.name, "SEO", ...seoFieldBreadcrumbs]
      : [];
  const headerCrumbs = editingSeo
    ? seoBreadcrumbs
    : showGlobalBanner
      ? editingBreadcrumbs.length > 0
        ? editingBreadcrumbs
        : [globalBannerName]
      : editingBreadcrumbs;
  // A multivariate section shows its variant list and the selected variant's
  // form as one combined view, so the section-label and variant-label crumbs
  // collapse to the same level. At that top level the back button must exit the
  // section (not clear an already-empty field trail) — see headerBackTargetIndex.
  const isMultivariateSectionTop =
    !editingSeo &&
    !isGlobalBlockMode &&
    isEditingMultivariateSection &&
    fieldBreadcrumbs.length === 0;
  const handleAddPageVariant = () => {
    if (!activePageKey) return;
    // Cancel a pending rule-autosave timer — it writes into
    // `variants[latestVariantIndex]` (read fresh via latestRef) when it fires,
    // and appending a variant here doesn't change that index, but a stale save
    // firing after this mutation would clobber the newly-saved data with an
    // outdated variants array.
    cancelPendingRuleSaves();
    // Also cancel a pending section-field autosave — it rebuilds
    // `variants[latestVariantIndex]` from a `decofile` snapshot read at fire
    // time, which may still predate this save's result, so a stale timer would
    // clobber the newly-appended variant with an outdated variants array.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const fullPageData = decofile[activePageKey] as Record<string, unknown>;
    const updatedSections = appendPageVariantSections(
      fullPageData.sections,
      rawSections,
    );
    if (!updatedSections) return;

    const newVariantIndex = getLastVariantIndex(updatedSections);
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
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
      },
    );
  };

  /**
   * Read the page's variants array, apply a transform, then persist the
   * modified shape. Shared by delete variant flows.
   */
  const mutatePageVariants = (
    transform: (
      variants: Array<Record<string, unknown>>,
    ) => Array<Record<string, unknown>> | null,
    onSaved?: () => void,
    orphanMatcherBlockKey?: string | null,
  ) => {
    if (!activePageKey) return;
    // Cancel a pending rule-autosave timer — it writes into
    // `variants[latestVariantIndex]` (read fresh via latestRef) when it fires,
    // so reordering/deleting/duplicating variants here would land that stale
    // write on the wrong (or now-missing) variant.
    cancelPendingRuleSaves();
    // Also cancel a pending section-field autosave — it captures a section
    // index at schedule time and writes into the *current* variant's
    // `rawSections[index]` (read fresh via latestRef) when it fires.
    // Reordering/deleting/duplicating a page variant here can shift which
    // variant is active, so a still-pending timer would land its stale write
    // on the wrong variant's section.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
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
    const updatedSections = buildPageSectionsFromVariants(obj, next);
    const projectedDecofile = {
      ...decofile,
      [activePageKey]: { ...fullPageData, sections: updatedSections },
    };
    saveBlock.mutate(
      {
        blockKey: activePageKey,
        data: projectedDecofile[activePageKey] as Record<string, unknown>,
      },
      {
        onSuccess: () => {
          onSaved?.();
          if (orphanMatcherBlockKey) {
            void cleanupOrphanMatcherBlock(
              orphanMatcherBlockKey,
              projectedDecofile,
            );
          }
        },
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
      },
    );
  };

  const selectPageVariant = (index: number) => {
    setRenameVariantIndex(null);
    setActiveVariantIndex(index);
    setSelectedSectionIndex(null);
    setFormValue(null);
    setActiveResolveType(null);
    setFieldBreadcrumbs([]);
    const variantRule = pageVariants[index]?.rule;
    const { resolveType, formValue } = readMatcherRuleFormState(
      variantRule,
      decofile ?? {},
      meta ?? undefined,
    );
    setRuleResolveType(resolveType);
    setRuleFormValue(formValue);
    emitPageVariantOverride(
      pageVariants.map((v) => ({ rule: v.rule })),
      index,
    );
  };

  const handleReorderPageVariants = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;

    let nextIndex = safeVariantIndex;
    if (safeVariantIndex === fromIndex) {
      nextIndex = toIndex;
    } else if (fromIndex < safeVariantIndex && toIndex >= safeVariantIndex) {
      nextIndex = safeVariantIndex - 1;
    } else if (fromIndex > safeVariantIndex && toIndex <= safeVariantIndex) {
      nextIndex = safeVariantIndex + 1;
    }
    setActiveVariantIndex(nextIndex);

    // Keep the preview override pointing at the same variant after the move.
    const reorderedRules = arrayMove(
      pageVariants.map((v) => ({ rule: v.rule })),
      fromIndex,
      toIndex,
    );
    emitPageVariantOverride(reorderedRules, nextIndex);

    mutatePageVariants((variants) => arrayMove(variants, fromIndex, toIndex));
  };

  const handleDeletePageVariant = (variantIndex: number) => {
    const deletedRule = pageVariants[variantIndex]?.rule;
    const orphanMatcherBlockKey = getSavedMatcherBlockKey(
      deletedRule,
      decofile ?? {},
      meta ?? undefined,
    );

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
      orphanMatcherBlockKey,
    );
  };

  const handleDuplicatePageVariant = (variantIndex: number) => {
    mutatePageVariants(
      (variants) => duplicatePageVariantEntry(variants, variantIndex),
      () => {
        // Land the user on the freshly-created clone (inserted right after).
        setActiveVariantIndex(variantIndex + 1);
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
    cancelPendingRuleSaves();
    // Also cancel a pending section-field autosave — it reads the current
    // variant's sections fresh via latestRef when it fires and writes the
    // whole page block. This function itself persists a `sections` snapshot
    // taken now, so a still-pending timer firing during the awaits below
    // would have its write clobbered by this stale snapshot.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const pageKey = latestRef.current.activePageKey;
    const latestDecofile: Record<string, unknown> = latestRef.current.decofile;
    if (!pageKey) return;

    const fullPageData = latestDecofile[pageKey] as Record<string, unknown>;
    const current = fullPageData.sections;
    if (!current || typeof current !== "object" || Array.isArray(current))
      return;
    const obj = current as Record<string, unknown>;
    if (!Array.isArray(obj.variants)) return;

    const variants = [...(obj.variants as Array<Record<string, unknown>>)];
    const target = variants[variantIndex];
    if (!target?.rule || typeof target.rule !== "object") {
      toast.error(t("sectionsEditor.sectionsEditor.variantHasNoMatcherRule"));
      return;
    }
    const targetRule = target.rule as Record<string, unknown>;

    const trimmed = nextName.trim();
    setRenameVariantPending(true);

    try {
      if (!trimmed) {
        if (!isSavedMatcherBlockReference(targetRule, latestDecofile, meta)) {
          setRenameVariantIndex(null);
          return;
        }

        const blockKey = (targetRule.__resolveType as string) ?? "";
        variants[variantIndex] = {
          ...target,
          rule: inlineMatcherRule(targetRule, latestDecofile, meta),
        };

        const projectedDecofile = {
          ...latestDecofile,
          [pageKey]: { ...fullPageData, sections: { ...obj, variants } },
        };

        await saveBlock.mutateAsync({
          blockKey: pageKey,
          data: projectedDecofile[pageKey] as Record<string, unknown>,
        });
        await cleanupOrphanMatcherBlock(blockKey, projectedDecofile);
        setRenameVariantIndex(null);
        onSaved?.();
        return;
      }

      const unwrapped = unwrapMatcherRule(targetRule, latestDecofile, meta);
      if (!unwrapped) {
        toast.error(
          t("sectionsEditor.sectionsEditor.couldNotReadVariantMatcherRule"),
        );
        return;
      }

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
      const validationError = validateBlockId(blockId, latestDecofile);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const blockData = buildMatcherBlockData(
        unwrapped.resolveType,
        unwrapped.data,
        trimmed,
      );

      let createdBlockId: string | null = null;
      try {
        await saveBlock.mutateAsync({ blockKey: blockId, data: blockData });
        createdBlockId = blockId;
        variants[variantIndex] = {
          ...target,
          rule: buildMatcherBlockReference(blockId),
        };
        await saveBlock.mutateAsync({
          blockKey: pageKey,
          data: {
            ...fullPageData,
            sections: { ...obj, variants },
          },
        });
        createdBlockId = null;
      } catch (err) {
        if (createdBlockId) {
          await deleteBlock
            .mutateAsync({ blockKey: createdBlockId })
            .catch(() => {});
        }
        throw err;
      }

      setRenameVariantIndex(null);
      toast.success(
        t("sectionsEditor.sectionsEditor.savedMatcherAsGlobalBlock", {
          trimmed,
        }),
      );
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.failedToRenameVariant"),
      );
    } finally {
      setRenameVariantPending(false);
    }
  };

  /**
   * Section-variant analogue of handleRenamePageVariant: naming a section
   * variant promotes its inline matcher to a global block and points the rule
   * at it; clearing the name inlines the matcher again.
   */
  const handleRenameSectionVariant = async (
    variantIndex: number,
    nextName: string,
  ) => {
    cancelPendingRuleSaves();
    // Also cancel a pending section-field autosave — it targets the same
    // section's `rawSections[index]` and this function persists a
    // `latestRawSections` snapshot taken now, so a still-pending timer firing
    // during the awaits below would have its write clobbered by this stale
    // snapshot.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const {
      selectedSectionIndex: sectionIndex,
      rawSections: latestRawSections,
      parsedSections: latestParsedSections,
      decofile: latestDecofile,
      activePageKey: pageKey,
      pageVariants: latestVariants,
      variantIndex: latestVariantIndex,
    } = latestRef.current;
    if (sectionIndex === null || !pageKey) return;

    const rawSection = latestRawSections[sectionIndex];
    const parsed = latestParsedSections[sectionIndex];
    if (!rawSection || !parsed?.isMultivariate) return;

    const mvObj = getMultivariateSectionObject(rawSection, parsed);
    if (!mvObj) return;

    const variants = (mvObj.variants as Array<Record<string, unknown>>) ?? [];
    const target = variants[variantIndex];
    if (!target?.rule || typeof target.rule !== "object") {
      toast.error(t("sectionsEditor.sectionsEditor.variantHasNoMatcherRule"));
      return;
    }
    const targetRule = target.rule as Record<string, unknown>;

    const trimmed = nextName.trim();
    setRenameVariantPending(true);

    const persistSectionVariants = async (
      nextVariants: Array<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const updatedMvObj = { ...mvObj, variants: nextVariants };
      const updatedSections = [...latestRawSections];
      updatedSections[sectionIndex] = rebuildSectionWithMultivariate(
        rawSection,
        parsed,
        updatedMvObj,
      );
      const fullPageData = buildPageDataWithSections(
        latestDecofile,
        pageKey,
        updatedSections,
        latestVariantIndex,
        latestVariants,
      );
      await saveBlock.mutateAsync({ blockKey: pageKey, data: fullPageData });
      return { ...latestDecofile, [pageKey]: fullPageData };
    };

    try {
      if (!trimmed) {
        if (!isSavedMatcherBlockReference(targetRule, latestDecofile, meta)) {
          setRenameSectionVariantIndex(null);
          return;
        }
        const blockKey = (targetRule.__resolveType as string) ?? "";
        const nextVariants = [...variants];
        nextVariants[variantIndex] = {
          ...target,
          rule: inlineMatcherRule(targetRule, latestDecofile, meta),
        };
        const projectedDecofile = await persistSectionVariants(nextVariants);
        await cleanupOrphanMatcherBlock(blockKey, projectedDecofile);
        setRenameSectionVariantIndex(null);
        onSaved?.();
        return;
      }

      const unwrapped = unwrapMatcherRule(targetRule, latestDecofile, meta);
      if (!unwrapped) {
        toast.error(
          t("sectionsEditor.sectionsEditor.couldNotReadVariantMatcherRule"),
        );
        return;
      }

      if (unwrapped.blockKey) {
        await saveBlock.mutateAsync({
          blockKey: unwrapped.blockKey,
          data: buildMatcherBlockData(
            unwrapped.resolveType,
            unwrapped.data,
            trimmed,
          ),
        });
        setRenameSectionVariantIndex(null);
        onSaved?.();
        return;
      }

      const blockId = suggestBlockId(trimmed);
      const validationError = validateBlockId(blockId, latestDecofile);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      const blockData = buildMatcherBlockData(
        unwrapped.resolveType,
        unwrapped.data,
        trimmed,
      );

      let createdBlockId: string | null = null;
      try {
        await saveBlock.mutateAsync({ blockKey: blockId, data: blockData });
        createdBlockId = blockId;
        const nextVariants = [...variants];
        nextVariants[variantIndex] = {
          ...target,
          rule: buildMatcherBlockReference(blockId),
        };
        await persistSectionVariants(nextVariants);
        createdBlockId = null;
      } catch (err) {
        if (createdBlockId) {
          await deleteBlock
            .mutateAsync({ blockKey: createdBlockId })
            .catch(() => {});
        }
        throw err;
      }

      setRenameSectionVariantIndex(null);
      toast.success(
        t("sectionsEditor.sectionsEditor.savedMatcherAsGlobalBlock", {
          trimmed,
        }),
      );
      onSaved?.();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sectionsEditor.sectionsEditor.failedToRenameVariant"),
      );
    } finally {
      setRenameVariantPending(false);
    }
  };

  const exitSectionEditing = () => {
    clearSectionEditing();
  };

  const handleSeoInnerChange = (nextRecord: Record<string, unknown>) => {
    setSeoFormValue(nextRecord);
    schedulePageBlockWrite({ inner: nextRecord });
  };

  const handlePersistRawSeo = (raw: Record<string, unknown> | null) => {
    setSeoRawOverride(raw);
    schedulePageBlockWrite({ raw });
  };

  const clearSeoForm = () => {
    setSeoFormValue(null);
    setSeoFieldBreadcrumbs([]);
  };
  const bumpSeoFormKey = () => setSeoFormResetKey((key) => key + 1);

  const handleBreadcrumbClick = (index: number) => {
    if (editingSeo) {
      if (index === 0) {
        pageBlockSave.flush();
        setEditingSeo(false);
        setSeoFormValue(null);
        setSeoRawOverride(undefined);
        setSeoFieldBreadcrumbs([]);
        setSeoFormResetKey((key) => key + 1);
        onExitSeo?.();
        return;
      }
      if (index === 1) {
        setSeoFieldBreadcrumbs([]);
        setSeoFormResetKey((key) => key + 1);
        return;
      }
      setSeoFieldBreadcrumbs(seoFieldBreadcrumbs.slice(0, index - 1));
      setSeoFormResetKey((key) => key + 1);
      return;
    }

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
      <div className="shrink-0">
        {/* When editing a reusable/global block (opened directly or from inside
            a page), the breadcrumb bar goes purple with a globe and a note that
            changes apply everywhere — so it never reads as a local edit. */}
        {showGlobalBanner || isEditing || editingSeo ? (
          <div
            className={cn(
              "border-b px-3 py-2.5",
              showGlobalBanner &&
                "border-global-section/22 bg-global-section/12 dark:bg-global-section/16",
            )}
          >
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              {headerCrumbs.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    handleBreadcrumbClick(
                      headerBackTargetIndex(headerCrumbs.length, {
                        isMultivariateSectionTop,
                      }),
                    )
                  }
                  title={t("sectionsEditor.sectionsEditor.back")}
                  aria-label={t("sectionsEditor.sectionsEditor.back")}
                  className={cn(
                    "shrink-0 inline-flex size-6 items-center justify-center rounded-md transition-colors",
                    showGlobalBanner
                      ? "text-foreground/80 hover:bg-global-section/15"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <ChevronLeft className="size-4" />
                </button>
              )}
              {!isGlobalBlockMode && hasMultipleVariants && activeVariant && (
                <button
                  type="button"
                  onClick={exitSectionEditing}
                  title={t("sectionsEditor.sectionsEditor.editingInVariant", {
                    variant: activeVariant.label,
                  })}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1 rounded-md h-6 px-1.5 text-xs font-medium cursor-pointer transition-opacity hover:opacity-80",
                    VARIANT_TAB_ACTIVE_CLASS,
                  )}
                >
                  <VariantTabIcon
                    rule={resolveEffectiveMatcherRule(
                      activeVariant.rule,
                      decofile ?? {},
                      meta ?? undefined,
                    )}
                    matchers={availableMatchers}
                  />
                  <span className="max-w-[160px] truncate">
                    {activeVariant.label}
                  </span>
                </button>
              )}
              <nav
                aria-label={t(
                  "sectionsEditor.sectionsEditor.editingBreadcrumb",
                )}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
              >
                {headerCrumbs.map((crumb, index) => {
                  const isLast = index === headerCrumbs.length - 1;
                  const crumbText = crumbLabel(crumb);

                  return (
                    <span
                      key={`${crumbText}-${index}`}
                      className="flex min-w-0 items-center gap-1 overflow-hidden"
                    >
                      {index > 0 && (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
                      )}
                      <button
                        type="button"
                        onClick={() => handleBreadcrumbClick(index)}
                        title={crumbText}
                        className={cn(
                          "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors",
                          isLast
                            ? showGlobalBanner
                              ? "font-semibold text-global-section-fg dark:text-global-section-fg-dark"
                              : "font-medium text-foreground"
                            : showGlobalBanner
                              ? "text-foreground/80"
                              : "text-muted-foreground",
                          showGlobalBanner
                            ? "hover:bg-global-section/15"
                            : "hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        {crumbText}
                      </button>
                    </span>
                  );
                })}
              </nav>
              {showGlobalBanner && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 cursor-help">
                      <Globe01 className="size-4 text-global-section-fg dark:text-global-section-fg-dark" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[260px]">
                    {t("sectionsEditor.sectionsEditor.globalSectionTooltip")}
                  </TooltipContent>
                </Tooltip>
              )}
              {isEditingSection &&
                !isEditingMultivariateSection &&
                !selectedParsed?.isHidden &&
                activePageKey && (
                  <AddVariantButton onClick={() => handleAddSectionVariant()} />
                )}
            </div>
            {showGlobalBanner && (
              <p className="mt-1.5 py-1.5 pl-1 text-sm leading-snug text-foreground">
                {t("sectionsEditor.sectionsEditor.globalSectionBanner")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
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
                  aria-label={t("sectionsEditor.sectionsEditor.editSeo")}
                  className="size-7 shrink-0"
                  onClick={() => setEditingSeo(true)}
                >
                  <CreditCardSearch size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("sectionsEditor.sectionsEditor.editSeo")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("sectionsEditor.sectionsEditor.viewJson")}
                  className="size-7 shrink-0"
                  onClick={() =>
                    onViewJsonFile && activePageKey
                      ? onViewJsonFile(activePageKey)
                      : setJsonOpen(true)
                  }
                >
                  <Code01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("sectionsEditor.sectionsEditor.viewJson")}
              </TooltipContent>
            </Tooltip>
            <AddVariantButton onClick={handleAddPageVariant} />
          </div>
        )}
      </div>

      {/* Drill-down: SEO form, section form, or section list */}
      {editingSeo ? (
        <ScrollArea
          key="editor-seo"
          className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          <div className="min-w-0 max-w-full overflow-x-hidden px-6 py-4">
            <div className="mx-auto max-w-2xl">
              {pageData && activePageKey ? (
                <PageSeoForm
                  rawSeo={displayRawSeo}
                  innerSeo={effectiveInner}
                  defaultResolveType={defaultResolveType}
                  seoSchema={seoSchema}
                  activeResolveType={activeSeoType}
                  seoTypeOptions={seoTypeOptions}
                  formResetKey={seoFormResetKey}
                  siteDefaultSeo={siteDefaultSeo}
                  onBreadcrumbChange={setSeoFieldBreadcrumbs}
                  onPersistRaw={handlePersistRawSeo}
                  onInnerChange={handleSeoInnerChange}
                  onClearForm={clearSeoForm}
                  onBumpFormKey={bumpSeoFormKey}
                />
              ) : (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("sectionsEditor.sectionsEditor.seoSchemaNotFound")}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      ) : isEditing ? (
        <ScrollArea
          key="editor-section-form"
          viewportRef={fieldScrollRef}
          className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          {/* Variant switcher + rule stay at the variant's top level only; drilling into a nested field hides them so the focused form owns the panel. */}
          {isEditingMultivariateSection &&
            sectionFlagVariants.length > 0 &&
            fieldBreadcrumbs.length === 0 && (
              <>
                <SectionVariantList
                  listKey={`${activePageKey ?? ""}:${selectedSectionIndex ?? ""}`}
                  variants={sectionFlagVariants.map((variant, index) => ({
                    index,
                    label: variant.label,
                  }))}
                  selectedIndex={safeSectionVariantIndex}
                  onSelect={handleSelectSectionVariant}
                  onRename={setRenameSectionVariantIndex}
                  onDuplicate={handleDuplicateSectionVariant}
                  onDelete={handleDeleteSectionVariant}
                  onRemoveAll={handleRemoveAllSectionVariants}
                  onReorder={handleReorderSectionVariant}
                  onAdd={() => handleAddSectionVariant()}
                />
                {isEditingMultivariateSection && (
                  <div className="px-3 py-3 border-b space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("sectionsEditor.sectionsEditor.variantRule")}
                    </span>
                    <VariantRuleEditor
                      currentRt={sectionRuleResolveType ?? ""}
                      currentLabel={resolveVariantRuleLabel(
                        activeSectionFlagVariant?.rule,
                        decofile ?? {},
                        formatMatcher,
                        meta ?? undefined,
                      )}
                      currentGlobalKey={
                        getSavedMatcherBlockKey(
                          activeSectionFlagVariant?.rule,
                          decofile ?? {},
                          meta ?? undefined,
                        ) ?? undefined
                      }
                      matchers={availableMatchers}
                      globals={availableMatcherGlobals}
                      onSelect={handleSectionMatcherTypeChange}
                      onSelectGlobal={handleSectionVariantSelectGlobal}
                      schema={sectionRuleSchema}
                      formValue={sectionRuleFormValue}
                      onChange={handleSectionRuleFormChange}
                      formKey={`${selectedSectionIndex ?? "none"}:${safeSectionVariantIndex}:${sectionRuleResolveType ?? ""}`}
                      formWrapperClassName="pt-1"
                      meta={meta ?? undefined}
                      decofile={decofile}
                      onSaveReferencedBlock={saveReferencedBlock}
                      sandbox={sandbox}
                    />
                  </div>
                )}
              </>
            )}
          <SchemaFormPanel
            activeSchema={activeSchema}
            formValue={formValue}
            formResetKey={formResetKey}
            onFormChange={handleFormChange}
            onBreadcrumbChange={setFieldBreadcrumbs}
            breadcrumbPath={fieldBreadcrumbs}
            emptyMessage={t(
              "sectionsEditor.sectionsEditor.noEditableFieldsForVariant",
            )}
            meta={meta}
            decofile={decofile}
            onSaveReferencedBlock={saveReferencedBlock}
            sandbox={sandbox}
            previewBaseUrl={sectionPreviewBase}
            onRequestAddSection={handleRequestAddSection}
          />
        </ScrollArea>
      ) : isGlobalBlockMode ? (
        <ScrollArea
          key="editor-global-block"
          viewportRef={fieldScrollRef}
          className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          <SchemaFormPanel
            activeSchema={activeSchema}
            formValue={formValue}
            formResetKey={formResetKey}
            onFormChange={handleFormChange}
            onBreadcrumbChange={setFieldBreadcrumbs}
            breadcrumbPath={fieldBreadcrumbs}
            emptyMessage={t(
              "sectionsEditor.sectionsEditor.noEditableFieldsForGlobalBlock",
            )}
            meta={meta}
            decofile={decofile}
            onSaveReferencedBlock={saveReferencedBlock}
            sandbox={sandbox}
            previewBaseUrl={sectionPreviewBase}
            onRequestAddSection={handleRequestAddSection}
          />
        </ScrollArea>
      ) : (
        <ScrollArea
          key="editor-section-list"
          className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block"
        >
          {/* Variant selector (when page sections are multivariate) */}
          {hasMultipleVariants && activePageKey && (
            <PageVariantTabs
              listKey={activePageKey}
              variants={pageVariants}
              activeIndex={safeVariantIndex}
              decofile={decofile ?? {}}
              meta={meta}
              matchers={availableMatchers}
              onSelect={selectPageVariant}
              onReorder={handleReorderPageVariants}
              onRename={setRenameVariantIndex}
              onDuplicate={handleDuplicatePageVariant}
              onDelete={handleDeletePageVariant}
              onAdd={handleAddPageVariant}
            />
          )}
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
                  {t("sectionsEditor.sectionsEditor.variantRule")}
                </span>
                {isVariantRuleOpen ? (
                  <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
              {isVariantRuleOpen && (
                <div
                  className={cn(
                    "space-y-3",
                    renameVariantPending && "pointer-events-none opacity-50",
                  )}
                >
                  <VariantRuleEditor
                    currentRt={ruleResolveType}
                    currentLabel={resolveVariantRuleLabel(
                      activeVariant?.rule,
                      decofile ?? {},
                      formatMatcher,
                      meta ?? undefined,
                    )}
                    currentGlobalKey={
                      getSavedMatcherBlockKey(
                        activeVariant?.rule,
                        decofile ?? {},
                        meta ?? undefined,
                      ) ?? undefined
                    }
                    matchers={availableMatchers}
                    globals={availableMatcherGlobals}
                    onSelect={handleMatcherTypeChange}
                    onSelectGlobal={handlePageVariantSelectGlobal}
                    schema={ruleSchema}
                    formValue={ruleFormValue}
                    onChange={handleRuleFormChange}
                    formKey={`${safeVariantIndex}:${ruleResolveType ?? ""}`}
                    formWrapperClassName="space-y-3"
                    meta={meta ?? undefined}
                    decofile={decofile}
                    onSaveReferencedBlock={saveReferencedBlock}
                    sandbox={sandbox}
                  />
                </div>
              )}
            </div>
          )}
          <div className="p-2 pt-3">
            <SectionList
              listKey={`${activePageKey ?? ""}-${safeVariantIndex}`}
              rawSections={rawSections}
              sections={parsedSections}
              meta={meta}
              selectedIndex={selectedSectionIndex}
              onSelect={handleSelectSection}
              onReorder={handleReorder}
              onDelete={handleDeleteSection}
              onDuplicate={handleDuplicateSection}
              onMakeReusable={setMakeReusableIndex}
              onToggleHidden={handleToggleHidden}
              onToggleLazy={handleToggleLazy}
              onAddVariant={handleAddSectionVariant}
              onDetach={handleDetachSection}
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

      {sectionPreviewBase && (
        <AddSectionModal
          open={addSectionOpen}
          onOpenChange={(open) => {
            setAddSectionOpen(open);
            if (!open) pendingAppendRef.current = null;
          }}
          meta={meta}
          decofile={decofile}
          previewBaseUrl={sectionPreviewBase}
          onSelect={handleSelectSectionFromModal}
        />
      )}

      {jsonOpen && activePageKey && decofile && (
        <PageJsonDialog
          open={jsonOpen}
          onOpenChange={setJsonOpen}
          pageKey={activePageKey}
          decofile={decofile}
        />
      )}

      {renameVariantIndex !== null && (
        <VariantRenameDialog
          open
          initialName={
            isSavedMatcherBlockReference(
              pageVariants[renameVariantIndex]?.rule,
              decofile ?? {},
              meta ?? undefined,
            )
              ? resolveVariantRuleLabel(
                  pageVariants[renameVariantIndex]?.rule,
                  decofile ?? {},
                  formatMatcher,
                  meta ?? undefined,
                )
              : ""
          }
          autoLabel={formatMatcher(
            resolveEffectiveMatcherRule(
              pageVariants[renameVariantIndex]?.rule,
              decofile ?? {},
              meta ?? undefined,
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

      {renameSectionVariantIndex !== null && (
        <VariantRenameDialog
          open
          initialName={
            isSavedMatcherBlockReference(
              sectionFlagVariants[renameSectionVariantIndex]?.rule,
              decofile ?? {},
              meta ?? undefined,
            )
              ? resolveVariantRuleLabel(
                  sectionFlagVariants[renameSectionVariantIndex]?.rule,
                  decofile ?? {},
                  formatMatcher,
                  meta ?? undefined,
                )
              : ""
          }
          autoLabel={formatMatcher(
            resolveEffectiveMatcherRule(
              sectionFlagVariants[renameSectionVariantIndex]?.rule,
              decofile ?? {},
              meta ?? undefined,
            ),
          )}
          isPending={renameVariantPending}
          onSubmit={async (name) => {
            await handleRenameSectionVariant(renameSectionVariantIndex, name);
          }}
          onOpenChange={(open) => {
            if (!open && !renameVariantPending)
              setRenameSectionVariantIndex(null);
          }}
        />
      )}
    </div>
  );
}

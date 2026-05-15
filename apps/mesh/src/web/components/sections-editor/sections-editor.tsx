import { useState, useRef } from "react";
import { ArrowLeft, Loading01 } from "@untitledui/icons";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { toast } from "sonner";
import { useDecofile } from "./use-decofile";
import { useLiveMeta } from "./use-live-meta";
import { useSaveBlock } from "./use-save-block";
import { extractPages } from "./page-list";
import { SectionList, parseSections } from "./section-list";
import { arrayMove } from "@dnd-kit/sortable";
import type { ParsedSection } from "./section-list";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";

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
  const prevKeyRef = useRef(pageKey);

  // Reset local state when navigating to a different page
  if (prevKeyRef.current !== pageKey) {
    prevKeyRef.current = pageKey;
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

const LAZY_SUFFIXES = [
  "website/sections/Rendering/Lazy.tsx",
  "website/sections/Rendering/SingleDeferred.tsx",
];

function isLazyResolveType(rt: string): boolean {
  return LAZY_SUFFIXES.some((suffix) => rt.endsWith(suffix));
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

  const saveBlock = useSaveBlock({ previewUrl, orgSlug, virtualMcpId, branch });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      ? (decofile[activePageKey] as { sections?: RawSection[] })
      : null;
  const rawSections: RawSection[] = pageData?.sections ?? [];
  const parsedSections = parseSections(rawSections, decofile);

  const activeSchema =
    activeResolveType && meta ? resolveSchema(activeResolveType, meta) : null;

  const scheduleAutoSave = (
    nextValue: Record<string, unknown>,
    sectionIndex: number,
  ) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const rawSection = rawSections[sectionIndex];
      if (!rawSection) return;
      const parsed = parsedSections[sectionIndex];
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
      if (!activePageKey) return;
      const fullPageData = {
        ...(decofile[activePageKey] as Record<string, unknown>),
      };
      const updatedSections = [...rawSections];

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

      fullPageData.sections = updatedSections;
      saveBlock.mutate(
        { blockKey: activePageKey, data: fullPageData },
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
    if (pageDebounceRef.current) clearTimeout(pageDebounceRef.current);
    pageDebounceRef.current = setTimeout(() => {
      const fullPageData = {
        ...(decofile[activePageKey] as Record<string, unknown>),
        [field]: value,
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
      sections: reordered,
    };
    saveBlock.mutate(
      { blockKey: activePageKey, data: fullPageData },
      {
        onSuccess: () => onSaved?.(),
        onError: (err) => toast.error(`Reorder failed: ${err.message}`),
      },
    );
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

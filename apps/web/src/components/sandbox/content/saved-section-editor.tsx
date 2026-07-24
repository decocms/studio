import { useState } from "react";
import { ChevronRight, Code01, X } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import {
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { unwrapSection } from "@/components/sections-editor/unwrap-section";
import {
  parseSections,
  type RawSection,
} from "@/components/sections-editor/section-list";
import { globalSectionLabel } from "@/components/sections-editor/page-list";
import { GLOBAL_SECTION_ICON_COLOR } from "@/components/sections-editor/section-types";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { useT } from "@/i18n/use-t.ts";

/**
 * Seed the editable form value + component resolveType for a saved (global)
 * block by reusing the same unwrap path the SectionsEditor uses, so lazy /
 * multivariate / plain saved blocks all resolve consistently.
 */
function seedFromBlock(
  blockKey: string,
  decofile: Record<string, unknown>,
): { data: Record<string, unknown>; resolveType: string } | null {
  const rawSection = { __resolveType: blockKey } as RawSection;
  const parsed = parseSections([rawSection], decofile)[0];
  if (!parsed) return null;
  return unwrapSection(rawSection, parsed, decofile);
}

/**
 * Editor for a saved (global) section. A single `formValue` state is the source
 * of truth for BOTH the form and the Monaco JSON view, so toggling between them
 * is an instant two-way sync. Every change autosaves the block (debounced).
 */
export function SavedSectionEditor({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  blockKey,
  onSaveReferencedBlock,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  blockKey: string;
  onSaveReferencedBlock: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
}) {
  const t = useT();
  const inset = useInsetContext();
  const agentSiteSlug =
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.siteSlug ?? null)
      : null;

  // Seed once: this component is remounted (via `key`) when blockKey changes.
  const [seed] = useState(() => seedFromBlock(blockKey, decofile));
  const [formValue, setFormValue] = useState<Record<string, unknown>>(
    seed?.data ?? {},
  );
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<string[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
  const [jsonError, setJsonError] = useState(false);
  // The text Monaco renders. `null` means the JSON view is closed. Seeded from
  // `formValue` on open; Monaco owns it afterwards (we don't echo edits back
  // into it, so the cursor never jumps). Because the JSON view covers the form,
  // form edits can't happen while it's open — so reseeding on open is enough.
  const [jsonCode, setJsonCode] = useState<string | null>(null);
  const jsonOpen = jsonCode !== null;

  const { save, flush } = useDebouncedSaveBlock({
    orgSlug,
    virtualMcpId,
    branch,
  });

  const schema = seed?.resolveType
    ? resolveSchema(seed.resolveType, meta)
    : null;

  const blockData = decofile[blockKey] as Record<string, unknown> | undefined;
  const title = blockData ? globalSectionLabel(blockKey, blockData) : blockKey;

  const sandbox = {
    orgSlug,
    virtualMcpId,
    branch,
    previewUrl: previewUrl ?? undefined,
    siteSlug: agentSiteSlug,
  };

  // Single source of truth: update the form value and autosave the block.
  const apply = (next: Record<string, unknown>) => {
    setFormValue(next);
    save(blockKey, next);
  };

  const toggleJson = () => {
    if (jsonOpen) {
      setJsonCode(null);
      setJsonError(false);
      // Remount the form so its fields re-read the (possibly JSON-edited)
      // formValue — nested field components cache their own state and won't
      // otherwise reflect an external change.
      setFormResetKey((key) => key + 1);
    } else {
      setJsonCode(JSON.stringify(formValue, null, 2));
    }
  };

  const handleJsonChange = (value: string | undefined) => {
    const text = value ?? "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setJsonError(false);
        apply(parsed as Record<string, unknown>);
        return;
      }
      setJsonError(true);
    } catch {
      setJsonError(true);
    }
  };

  const headerCrumbs = [title, ...fieldBreadcrumbs];
  const handleBreadcrumbClick = (index: number) => {
    setFieldBreadcrumbs(fieldBreadcrumbs.slice(0, index));
    setFormResetKey((key) => key + 1);
  };

  return (
    <div className="flex h-full w-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header: breadcrumb + JSON toggle, with the global-section accent. */}
        <div className="shrink-0 border-b px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: GLOBAL_SECTION_ICON_COLOR }}
              aria-hidden
            />
            <nav
              aria-label="Editing breadcrumb"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
            >
              {headerCrumbs.map((crumb, index) => {
                const isLast = index === headerCrumbs.length - 1;
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={jsonOpen ? "default" : "ghost"}
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={toggleJson}
                  aria-label={
                    jsonOpen
                      ? t("sandbox.savedSectionEditor.closeJsonEditor")
                      : t("sandbox.savedSectionEditor.editAsJson")
                  }
                  aria-pressed={jsonOpen}
                >
                  {jsonOpen ? <X size={14} /> : <Code01 size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {jsonOpen
                  ? t("sandbox.savedSectionEditor.closeJsonEditor")
                  : t("sandbox.savedSectionEditor.editAsJson")}
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-1.5 py-1 pl-1 text-sm leading-snug text-muted-foreground">
            {t("sandbox.savedSectionEditor.globalSectionDescription")}
          </p>
        </div>

        <div className="relative min-h-0 flex-1">
          <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="min-w-0 max-w-full overflow-x-hidden px-6 py-4">
              <div className="mx-auto max-w-2xl">
                {schema ? (
                  <SchemaForm
                    key={formResetKey}
                    schema={schema}
                    value={formValue}
                    onChange={(v) => apply(v as Record<string, unknown>)}
                    basePath=""
                    breadcrumbPath={fieldBreadcrumbs}
                    onBreadcrumbChange={setFieldBreadcrumbs}
                    meta={meta}
                    decofile={decofile}
                    onSaveReferencedBlock={onSaveReferencedBlock}
                    sandbox={sandbox}
                  />
                ) : (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {t("sandbox.savedSectionEditor.noEditableFields")}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          {/* JSON view covers the form. Monaco mounts only while open so it is
              disposed (no leaks) when toggled off or the editor unmounts. */}
          {jsonCode !== null && (
            <div className="absolute inset-0 flex flex-col bg-background">
              {jsonError && (
                <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                  {t("sandbox.savedSectionEditor.invalidJsonError")}
                </div>
              )}
              <div className="min-h-0 flex-1">
                <MonacoCodeEditor
                  language="json"
                  height="100%"
                  code={jsonCode}
                  onChange={handleJsonChange}
                  onSave={(value) => {
                    handleJsonChange(value);
                    flush();
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

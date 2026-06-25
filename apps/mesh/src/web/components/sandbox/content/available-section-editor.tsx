import { useEffect, useRef, useState } from "react";
import { ChevronRight, Save01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { SchemaForm } from "@/web/components/sections-editor/schema-form";
import {
  resolveSchema,
  type LiveMeta,
} from "@/web/components/sections-editor/resolve-schema";
import { validateBlockId } from "@/web/components/sections-editor/page-sections";
import { MakeReusableModal } from "@/web/components/sections-editor/make-reusable-modal";
import { SectionSidePanel } from "./section-side-panel";

/** Debounce before reloading the preview after a form edit. */
const PREVIEW_DEBOUNCE_MS = 600;

/**
 * Editor for an "available" (raw manifest) section that has NOT been saved as a
 * global block yet. Edits live in local state and only persist when the user
 * names and saves the section. The side panel previews the in-progress data
 * (auto-reloads, debounced) and offers an editable JSON view of the same data.
 */
export function AvailableSectionEditor({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  livePageResolveType,
  siteTheme,
  meta,
  decofile,
  resolveType,
  title,
  defaultBlockId,
  isCreating,
  onCreate,
  onSaveReferencedBlock,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  livePageResolveType: string;
  siteTheme?: Record<string, unknown>;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  resolveType: string;
  title: string;
  defaultBlockId: string;
  isCreating: boolean;
  onCreate: (blockId: string, data: Record<string, unknown>) => Promise<void>;
  onSaveReferencedBlock: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
}) {
  const inset = useInsetContext();
  const agentSiteSlug =
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.siteSlug ?? null)
      : null;

  const [formValue, setFormValue] = useState<Record<string, unknown>>({});
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<string[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel a pending debounced reload when the editor unmounts.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — timer lifecycle cleanup
  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, []);

  const schema = resolveSchema(resolveType, meta);
  const typeLabel =
    resolveType
      .split("/")
      .pop()
      ?.replace(/\.tsx?$/, "") ?? resolveType;

  const sandbox = {
    orgSlug,
    virtualMcpId,
    branch,
    previewUrl: previewUrl ?? undefined,
    siteSlug: agentSiteSlug,
  };

  const headerCrumbs = [title, ...fieldBreadcrumbs];
  const handleBreadcrumbClick = (index: number) => {
    setFieldBreadcrumbs(fieldBreadcrumbs.slice(0, index));
    setFormResetKey((key) => key + 1);
  };

  const schedulePreviewReload = () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      setPreviewReloadKey((k) => k + 1);
    }, PREVIEW_DEBOUNCE_MS);
  };

  const handleFormChange = (next: Record<string, unknown>) => {
    setFormValue(next);
    // Keep the preview in sync with what the user is typing (debounced).
    schedulePreviewReload();
  };

  // Apply edits made directly in the JSON tab back to the form state.
  const handleApplyJson = (data: Record<string, unknown>) => {
    setFormValue(data);
    setFormResetKey((key) => key + 1);
    setPreviewReloadKey((k) => k + 1);
  };

  const handleSubmit = async (blockId: string) => {
    const validationError = validateBlockId(blockId, decofile);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    await onCreate(blockId, formValue);
    setSaveOpen(false);
  };

  return (
    <div className="flex h-full w-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header: breadcrumb + save action (neutral — this section isn't global yet) */}
        <div className="shrink-0 border-b px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
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
                  size="icon"
                  className="size-8 shrink-0"
                  disabled={isCreating}
                  onClick={() => setSaveOpen(true)}
                  aria-label="Save as global section"
                >
                  <Save01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Save as global section
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-1.5 py-1 pl-1 text-sm leading-snug text-muted-foreground">
            {typeLabel} — edits stay local until you save this as a global
            section.
          </p>
        </div>

        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="min-w-0 max-w-full overflow-x-hidden px-6 py-4">
            <div className="mx-auto max-w-2xl">
              {schema ? (
                <SchemaForm
                  key={formResetKey}
                  schema={schema}
                  value={formValue}
                  onChange={(v) =>
                    handleFormChange(v as Record<string, unknown>)
                  }
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
                  No editable fields for this section.
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>

      <SectionSidePanel
        previewUrl={previewUrl}
        livePageResolveType={livePageResolveType}
        previewTarget={{ kind: "inline", resolveType, data: formValue }}
        theme={siteTheme}
        reloadKey={previewReloadKey}
        onRefreshPreview={() => setPreviewReloadKey((k) => k + 1)}
        jsonValue={JSON.stringify(formValue, null, 2)}
        onApplyJson={handleApplyJson}
      />

      <MakeReusableModal
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultBlockId={defaultBlockId}
        isPending={isCreating}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

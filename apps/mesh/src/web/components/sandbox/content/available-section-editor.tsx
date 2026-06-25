import { useState } from "react";
import { ChevronRight, Eye, Globe02 } from "@untitledui/icons";
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
import { SectionPreviewPane } from "./section-preview-pane";

/**
 * Editor for an "available" (raw manifest) section that has NOT been saved as a
 * global block yet. Edits live in local state and only persist when the user
 * names and saves the section. The preview is hidden by default and reflects
 * the in-progress form data when opened or refreshed.
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
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);

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

  const showPreview = () => {
    setPreviewVisible(true);
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
        {/* Header: breadcrumb + save action */}
        <div className="shrink-0 border-b border-global-section/22 bg-global-section/12 px-3 py-2.5 dark:bg-global-section/16">
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
                        "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-global-section/15",
                        isLast
                          ? "font-semibold text-global-section-fg dark:text-global-section-fg-dark"
                          : "text-foreground/80",
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
                <span className="shrink-0 cursor-help">
                  <Globe02 className="size-4 text-global-section-fg dark:text-global-section-fg-dark" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px]">
                Editing a new section. Save it as a global block to reuse it
                across your site.
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              className="shrink-0"
              disabled={isCreating}
              onClick={() => setSaveOpen(true)}
            >
              <Globe02 size={14} />
              Save as global section
            </Button>
          </div>
          <p className="mt-1.5 py-1 pl-1 text-sm leading-snug text-foreground">
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
                  onChange={(v) => setFormValue(v as Record<string, unknown>)}
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

      {previewVisible ? (
        <div className="flex w-1/2 min-w-[280px] shrink-0 flex-col border-l">
          <SectionPreviewPane
            previewUrl={previewUrl}
            livePageResolveType={livePageResolveType}
            target={{ kind: "inline", resolveType, data: formValue }}
            theme={siteTheme}
            reloadKey={previewReloadKey}
            onHide={() => setPreviewVisible(false)}
            onRefresh={() => setPreviewReloadKey((k) => k + 1)}
          />
        </div>
      ) : (
        <div className="flex w-9 shrink-0 items-start justify-center border-l pt-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={showPreview}
                aria-label="Show preview"
              >
                <Eye size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Show preview</TooltipContent>
          </Tooltip>
        </div>
      )}

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

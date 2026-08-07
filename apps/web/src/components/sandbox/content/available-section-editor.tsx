import { useState } from "react";
import { ChevronRight, Save01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import {
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { validateBlockId } from "@/components/sections-editor/page-sections";
import { MakeReusableModal } from "@/components/sections-editor/make-reusable-modal";

/**
 * Editor for an "available" (raw manifest) section that has NOT been saved as a
 * global block yet. Edits live in local state and only persist when the user
 * names and saves the section.
 */
export function AvailableSectionEditor({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
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
  const t = useT();
  const inset = useInsetContext();
  const agentSiteSlug =
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.siteSlug ?? null)
      : null;

  const [formValue, setFormValue] = useState<Record<string, unknown>>({});
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<string[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
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
              aria-label={t("sandbox.availableSectionEditor.editingBreadcrumb")}
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
                  aria-label={t(
                    "sandbox.availableSectionEditor.saveAsGlobalSection",
                  )}
                >
                  <Save01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("sandbox.availableSectionEditor.saveAsGlobalSection")}
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-1.5 py-1 pl-1 text-sm leading-snug text-muted-foreground">
            {t("sandbox.availableSectionEditor.localEditsHint", { typeLabel })}
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
                  {t("sandbox.availableSectionEditor.noEditableFields")}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>

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

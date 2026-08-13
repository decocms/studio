import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Code01,
  LinkExternal01,
  Loading01,
  Maximize01,
  Minimize01,
  Play,
  Save01,
  X,
} from "@untitledui/icons";
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
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import {
  type Crumb,
  crumbLabel,
} from "@/components/sections-editor/schema-form-breadcrumb";
import {
  inferSchemaFromValue,
  isFreeformPropsSchema,
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { validateBlockId } from "@/components/sections-editor/page-sections";
import { useDebouncedSaveBlock } from "@/components/sections-editor/use-save-block";
import { MakeReusableModal } from "@/components/sections-editor/make-reusable-modal";
import { SaveStatus } from "./blog/save-status";
import { runnableSingular, type RunnableKind } from "./runnable-catalog";
import { buildInvokeRunUrl, useRunBlock } from "./use-run-block";

/** What the editor is editing: an available manifest block or a saved one. */
export type RunnableTarget =
  | { mode: "available"; resolveType: string; title: string }
  | { mode: "saved"; blockKey: string; resolveType: string; title: string };

/**
 * Editor for a single loader/action. The form value is the block's `props`
 * (the schema resolved for a loader/action describes its input). A single
 * `formValue` state feeds both the schema form and the Monaco JSON view, and
 * "Run" live-invokes the block against the preview, showing the structured
 * result below.
 *
 * Two save modes mirror the Sections tab: an available (manifest) block edits
 * locally and persists only when named/saved as a global block; a saved block
 * autosaves on every change.
 */
export function RunnableBlockEditor({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  kind,
  target,
  initialValue,
  isCreating,
  onCreate,
  onSaveReferencedBlock,
  onBack,
  showRun = true,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  kind: RunnableKind;
  target: RunnableTarget;
  initialValue: Record<string, unknown>;
  isCreating: boolean;
  onCreate: (blockId: string, data: Record<string, unknown>) => Promise<void>;
  onSaveReferencedBlock: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  /** Navigates back to the folder browser. */
  onBack?: () => void;
  /** Show the "Run" button (invoke + result panel). Defaults to true. */
  showRun?: boolean;
}) {
  const t = useT();
  const inset = useInsetContext();
  const agentSiteSlug =
    inset?.entity?.id === virtualMcpId
      ? (inset.entity.metadata?.siteSlug ?? null)
      : null;

  // Tanstack registers commerce/vtex blocks with a freeform props stub (no
  // declared fields) — the block DOES take props, but the site doesn't publish
  // their schema. When a saved block carries values, infer a basic form from
  // them; otherwise the empty state points at the JSON editor toggle.
  const resolvedSchema = resolveSchema(target.resolveType, meta);
  const freeformProps =
    !resolvedSchema && isFreeformPropsSchema(target.resolveType, meta);
  const inferredSchema = freeformProps
    ? inferSchemaFromValue(initialValue)
    : null;
  const schema = resolvedSchema ?? inferredSchema;

  const [formValue, setFormValue] =
    useState<Record<string, unknown>>(initialValue);
  const [fieldBreadcrumbs, setFieldBreadcrumbs] = useState<Crumb[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
  const [jsonError, setJsonError] = useState(false);
  const [jsonCode, setJsonCode] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const jsonOpen = jsonCode !== null;

  const {
    save,
    flush,
    isPending: isSaving,
  } = useDebouncedSaveBlock({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const run = useRunBlock({ orgSlug, virtualMcpId, branch });

  // useDebouncedSaveBlock CANCELS pending saves on unmount (its documented
  // contract is that leaving callers flush explicitly). This editor unmounts on
  // back navigation and on target switch (keyed remount), so flush on the way
  // out or edits inside the debounce window would be silently lost. Capturing
  // the first render's `flush` is safe: it closes over the hook's stable refs.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — unmount flush of pending saves
  useEffect(() => {
    return () => {
      flush();
    };
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps
  }, []);

  const singular = runnableSingular(kind);
  const typeLabel =
    target.resolveType
      .split("/")
      .pop()
      ?.replace(/\.tsx?$/, "") ?? target.resolveType;

  const sandbox = {
    orgSlug,
    virtualMcpId,
    branch,
    previewUrl: previewUrl ?? undefined,
    siteSlug: agentSiteSlug,
  };

  // Persist a saved block's props on change (available blocks stay local until
  // explicitly saved). We store the block flat: `{ __resolveType, ...props }`.
  const apply = (next: Record<string, unknown>) => {
    setFormValue(next);
    if (target.mode === "saved") {
      save(target.blockKey, { __resolveType: target.resolveType, ...next });
    }
  };

  const toggleJson = () => {
    if (jsonOpen) {
      setJsonCode(null);
      setJsonError(false);
      // Remount the form so nested fields re-read the (possibly JSON-edited)
      // formValue.
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

  const handleSubmitSave = async (blockId: string) => {
    const validationError = validateBlockId(blockId, decofile);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    await onCreate(blockId, {
      __resolveType: target.resolveType,
      ...formValue,
    });
    setSaveOpen(false);
  };

  const handleRun = () => {
    setResultOpen(true);
    run.mutate({ resolveType: target.resolveType, props: formValue });
  };

  // Re-runs the invoke in a new tab (fresh cache-buster) with the current
  // form value — handy for inspecting large results with browser JSON tools.
  const handleOpenResultInNewTab = () => {
    if (!previewUrl) return;
    window.open(
      buildInvokeRunUrl(previewUrl, target.resolveType, formValue, Date.now()),
      "_blank",
      "noopener",
    );
  };

  const headerCrumbs = [target.title, ...fieldBreadcrumbs];
  const handleBreadcrumbClick = (index: number) => {
    setFieldBreadcrumbs(fieldBreadcrumbs.slice(0, index));
    setFormResetKey((key) => key + 1);
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* Header: breadcrumb + Run + Save (available only) + JSON toggle. */}
      <div className="shrink-0 border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onBack}
              aria-label={t("sandbox.runnableBlockEditor.backToList")}
            >
              <ArrowLeft size={14} />
            </Button>
          )}
          <nav
            aria-label={t("sandbox.runnableBlockEditor.editingBreadcrumb")}
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
                      "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                      isLast
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {crumbText}
                  </button>
                </span>
              );
            })}
          </nav>
          {target.mode === "saved" && (
            <SaveStatus isPending={isSaving} isError={false} />
          )}
          {showRun && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 gap-1.5"
              onClick={handleRun}
              disabled={run.isPending}
              aria-label={t("sandbox.runnableBlockEditor.runAriaLabel", {
                singular,
              })}
            >
              {run.isPending ? (
                <Loading01 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {t("sandbox.runnableBlockEditor.run")}
            </Button>
          )}
          {target.mode === "available" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  className="size-8 shrink-0"
                  disabled={isCreating}
                  onClick={() => setSaveOpen(true)}
                  aria-label={t(
                    "sandbox.runnableBlockEditor.saveAsGlobalAriaLabel",
                    {
                      singular,
                    },
                  )}
                >
                  <Save01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("sandbox.runnableBlockEditor.saveAsGlobal", {
                  singular,
                })}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={jsonOpen ? "default" : "ghost"}
                size="icon"
                className="size-8 shrink-0"
                onClick={toggleJson}
                aria-label={
                  jsonOpen
                    ? t("sandbox.runnableBlockEditor.closeJsonEditor")
                    : t("sandbox.runnableBlockEditor.editAsJson")
                }
                aria-pressed={jsonOpen}
              >
                {jsonOpen ? <X size={14} /> : <Code01 size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {jsonOpen
                ? t("sandbox.runnableBlockEditor.closeJsonEditor")
                : t("sandbox.runnableBlockEditor.editAsJson")}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-1.5 py-1 pl-1 text-sm leading-snug text-muted-foreground">
          {target.mode === "saved"
            ? t("sandbox.runnableBlockEditor.savedModeDescription", {
                singular,
              })
            : t("sandbox.runnableBlockEditor.availableModeDescription", {
                typeLabel,
                singular,
              })}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Form / JSON region — hidden while the result panel is expanded. */}
        <div
          className={cn(
            "relative min-h-0 flex-1",
            resultOpen && resultExpanded && "hidden",
          )}
        >
          <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="min-w-0 max-w-full overflow-x-hidden px-6 py-4">
              <div className="mx-auto max-w-2xl">
                {inferredSchema && schema === inferredSchema && (
                  <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs leading-snug text-muted-foreground">
                    {t("sandbox.runnableBlockEditor.inferredSchemaNotice", {
                      singular,
                    })}
                  </p>
                )}
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
                    {freeformProps
                      ? t(
                          "sandbox.runnableBlockEditor.freeformPropsEmptyState",
                          {
                            singular,
                          },
                        )
                      : t("sandbox.runnableBlockEditor.noInputEmptyState", {
                          singular,
                        })}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          {jsonCode !== null && (
            <div className="absolute inset-0 flex flex-col bg-background">
              {jsonError && (
                <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                  {t("sandbox.runnableBlockEditor.invalidJsonError")}
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

        {/* Run result panel. */}
        {resultOpen && (
          <RunResultPanel
            singular={singular}
            result={{
              isPending: run.isPending,
              error: run.error,
              data: run.data,
              hasRun: run.status !== "idle",
            }}
            expanded={resultExpanded}
            onToggleExpand={() => setResultExpanded((prev) => !prev)}
            onOpenInNewTab={previewUrl ? handleOpenResultInNewTab : undefined}
            onClose={() => {
              setResultOpen(false);
              setResultExpanded(false);
            }}
          />
        )}
      </div>

      <MakeReusableModal
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultBlockId=""
        isPending={isCreating}
        onSubmit={handleSubmitSave}
      />
    </div>
  );
}

function RunResultPanel({
  singular,
  result,
  expanded,
  onToggleExpand,
  onOpenInNewTab,
  onClose,
}: {
  singular: string;
  result: {
    isPending: boolean;
    error: Error | null;
    data: unknown;
    hasRun: boolean;
  };
  expanded: boolean;
  onToggleExpand: () => void;
  /** Absent while the preview URL is unknown (button hidden). */
  onOpenInNewTab?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const resultText =
    typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data ?? null, null, 2);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col border-t",
        expanded ? "flex-1" : "h-[45%] shrink-0",
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">
          {t("sandbox.runnableBlockEditor.resultPanelTitle")}
        </span>
        <div className="flex items-center gap-0.5">
          {onOpenInNewTab && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={onOpenInNewTab}
                  aria-label={t(
                    "sandbox.runnableBlockEditor.openResultInNewTabAriaLabel",
                  )}
                >
                  <LinkExternal01 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("sandbox.runnableBlockEditor.openInNewTabTooltip", {
                  singular,
                })}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onToggleExpand}
                aria-label={
                  expanded
                    ? t("sandbox.runnableBlockEditor.collapseResult")
                    : t("sandbox.runnableBlockEditor.expandResult")
                }
                aria-pressed={expanded}
              >
                {expanded ? <Minimize01 size={14} /> : <Maximize01 size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {expanded
                ? t("sandbox.runnableBlockEditor.collapse")
                : t("sandbox.runnableBlockEditor.expand")}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label={t("sandbox.runnableBlockEditor.closeResult")}
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {result.isPending ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loading01 size={16} className="animate-spin" />
            {t("sandbox.runnableBlockEditor.running", { singular })}
          </div>
        ) : result.error ? (
          <div className="h-full overflow-auto px-4 py-3">
            <p className="text-xs font-medium text-destructive">
              {t("sandbox.runnableBlockEditor.failedToRun", { singular })}
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive/90">
              {result.error.message}
            </pre>
          </div>
        ) : result.hasRun ? (
          <MonacoCodeEditor
            language="json"
            height="100%"
            code={resultText}
            readOnly
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("sandbox.runnableBlockEditor.pressRunToInvoke", { singular })}
          </div>
        )}
      </div>
    </div>
  );
}

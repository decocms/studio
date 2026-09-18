import { useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Flag01, Plus } from "@untitledui/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SchemaForm } from "./schema-form";
import { type Crumb, crumbLabel } from "./schema-form-breadcrumb";
import { type LiveMeta, type SchemaProperty } from "./resolve-schema";
import type { FieldProps, SandboxConfig } from "./fields/field-props";
import { SeoFormFields } from "./seo-form-fields";
import { parsePageVariants, type PageVariant } from "./page-variants";
import { formatMatcher } from "./format-matcher";
import { validatePagePath } from "./page-path-utils";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";

/**
 * A default of `[]` is a NEW array on every render, so anything derived from
 * it re-renders even when nothing changed. `never[]` is assignable to any
 * `T[]`, so one frozen constant serves every optional list prop in this file.
 */
const EMPTY_ARRAY: never[] = [];

/**
 * Editor for a variant's matcher rule (e.g. Include/Exclude Locations).
 * Owns its own breadcrumb state so users can drill into array items inside
 * the rule without affecting the section editor's breadcrumb. Caller is
 * expected to remount via `key` when the variant or rule resolveType changes.
 */
export function VariantRuleForm({
  schema,
  value,
  onChange,
  meta,
  decofile,
  onSaveReferencedBlock,
  sandbox,
}: {
  schema: SchemaProperty;
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  sandbox?: SandboxConfig | null;
}) {
  const t = useT();
  const [breadcrumbPath, setBreadcrumbPath] = useState<Crumb[]>([]);

  return (
    <div className="space-y-2">
      {breadcrumbPath.length > 0 && (
        <nav
          aria-label={t(
            "sectionsEditor.sectionsEditorPanels.variantRuleBreadcrumb",
          )}
          className="flex min-w-0 items-center gap-1 overflow-hidden text-xs"
        >
          <button
            type="button"
            onClick={() => setBreadcrumbPath([])}
            className="flex shrink-0 items-center gap-0.5 classic:rounded-md compact:rounded-lg px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title={t("sectionsEditor.sectionsEditorPanels.backToRule")}
          >
            <ChevronLeft className="size-3.5" />
          </button>
          {breadcrumbPath.map((crumb, index) => {
            const isLast = index === breadcrumbPath.length - 1;
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
                  onClick={() =>
                    setBreadcrumbPath(breadcrumbPath.slice(0, index + 1))
                  }
                  title={crumbText}
                  className={cn(
                    "min-w-0 truncate classic:rounded-md compact:rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
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
      )}
      <SchemaForm
        schema={schema}
        value={value}
        onChange={onChange}
        basePath=""
        breadcrumbPath={breadcrumbPath}
        onBreadcrumbChange={setBreadcrumbPath}
        meta={meta}
        decofile={decofile}
        onSaveReferencedBlock={onSaveReferencedBlock}
        sandbox={sandbox}
      />
    </div>
  );
}

export function SchemaFormPanel({
  activeSchema,
  formValue,
  formResetKey,
  onFormChange,
  onBreadcrumbChange,
  breadcrumbPath = EMPTY_ARRAY,
  emptyMessage,
  beforeForm,
  seoResolveType,
  siteDefaultSeo,
  meta,
  decofile,
  onSaveReferencedBlock,
  sandbox,
  previewBaseUrl,
  onRequestAddSection,
}: {
  activeSchema: SchemaProperty | null | undefined;
  formValue: unknown;
  formResetKey: number;
  onFormChange: (v: unknown) => void;
  onBreadcrumbChange: (path: Crumb[]) => void;
  breadcrumbPath?: Crumb[];
  emptyMessage: string;
  beforeForm?: ReactNode;
  seoResolveType?: string;
  siteDefaultSeo?: Record<string, unknown>;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  sandbox?: SandboxConfig | null;
  previewBaseUrl?: string | null;
  onRequestAddSection?: FieldProps["onRequestAddSection"];
}) {
  const formBody =
    activeSchema && formValue ? (
      seoResolveType ? (
        <SeoFormFields
          schema={activeSchema}
          resolveType={seoResolveType}
          value={formValue as Record<string, unknown>}
          formResetKey={formResetKey}
          onChange={onFormChange}
          onBreadcrumbChange={onBreadcrumbChange}
          siteDefaultSeo={siteDefaultSeo}
        />
      ) : (
        <SchemaForm
          key={formResetKey}
          schema={activeSchema}
          value={formValue}
          onChange={onFormChange}
          basePath=""
          breadcrumbPath={breadcrumbPath}
          onBreadcrumbChange={onBreadcrumbChange}
          meta={meta}
          decofile={decofile}
          onSaveReferencedBlock={onSaveReferencedBlock}
          sandbox={sandbox}
          previewBaseUrl={previewBaseUrl}
          onRequestAddSection={onRequestAddSection}
        />
      )
    ) : null;

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden px-6 py-4">
      <div className="mx-auto max-w-2xl">
        {beforeForm}
        {formBody ?? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}

/** The header's variant control, whether it selects one or offers the first. */
export const VARIANT_PILL_CLASS =
  "shrink-0 inline-flex items-center gap-1 rounded-[var(--studio-button-radius,calc(var(--radius)*1.333))] h-7 px-2 text-xs font-medium cursor-pointer transition-opacity hover:opacity-80";

export const VARIANT_TAB_ACTIVE_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.22)]";

/** The New Layout select: outlined rather than filled, so a variant chip reads
 *  as a control you can open rather than a status the header is reporting. Its
 *  empty state is the same pill with a dashed border. */
export const VARIANT_TAB_OUTLINE_CLASS =
  "text-[oklch(0.45_0.15_160)] border border-[oklch(0.65_0.15_160/0.5)] hover:bg-[oklch(0.65_0.15_160/0.1)] dark:text-[oklch(0.78_0.15_160)]";

const VARIANT_TAB_EMPTY_CLASS =
  "text-[oklch(0.45_0.15_160)] border border-dashed border-[oklch(0.65_0.15_160/0.5)] hover:bg-[oklch(0.65_0.15_160/0.1)] dark:text-[oklch(0.78_0.15_160)]";

export function parsePageVariantsForEditor(
  sections: unknown,
  decofile: Record<string, unknown>,
): PageVariant[] {
  return parsePageVariants(sections, decofile, formatMatcher);
}

/**
 * Editable page name + path inputs that hold local state to prevent
 * focus loss when the parent re-renders after decofile invalidation.
 */
export function PageHeaderInputs({
  pageKey,
  initialName,
  initialPath,
  onFieldChange,
  variant = "form",
}: {
  pageKey: string;
  initialName: string;
  initialPath: string;
  onFieldChange: (field: "name" | "path", value: string) => void;
  /** `header` is classic's in-place editable panel heading; `form` is the
   *  labelled pair compact shows inside the SEO screen. */
  variant?: "header" | "form";
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [path, setPath] = useState(initialPath);
  const [prevKey, setPrevKey] = useState(pageKey);
  // Path change awaiting confirmation; rewriting a live page's path is deliberate.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  // Set on Escape so the ensuing blur doesn't re-prompt.
  const skipCommitRef = useRef(false);
  const [pathError, setPathError] = useState<string | null>(null);

  // Reset local state when navigating to a different page
  if (prevKey !== pageKey) {
    setPrevKey(pageKey);
    setName(initialName);
    setPath(initialPath);
    setPendingPath(null);
    setPathError(null);
  }

  const commitPath = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    const trimmed = path.trim();
    if (trimmed === initialPath.trim()) {
      // No real change — normalize the displayed value and move on.
      setPath(initialPath);
      setPathError(null);
      return;
    }
    // Same validation the create-page flow already runs (page-path-utils).
    const error = validatePagePath(trimmed);
    if (error) {
      setPathError(error);
      setPath(initialPath);
      return;
    }
    setPathError(null);
    setPendingPath(trimmed);
  };

  const confirmPathChange = () => {
    if (pendingPath === null) return;
    setPath(pendingPath);
    onFieldChange("path", pendingPath);
    setPendingPath(null);
  };

  const cancelPathChange = () => {
    setPath(initialPath);
    setPendingPath(null);
  };

  const FIELD_CLASS =
    "w-full truncate outline-none h-9 rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20";

  const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      skipCommitRef.current = true;
      setPath(initialPath);
      setPathError(null);
      e.currentTarget.blur();
    }
  };

  const pathDialog = (
    <AlertDialog
      open={pendingPath !== null}
      onOpenChange={(next) => {
        if (!next) cancelPathChange();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("sectionsEditor.sectionsEditorPanels.changePathTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("sectionsEditor.sectionsEditorPanels.changePathDescription", {
              from: initialPath,
              to: pendingPath ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("sectionsEditor.sectionsEditorPanels.changePathCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirmPathChange();
            }}
          >
            {t("sectionsEditor.sectionsEditorPanels.changePathConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  /* Classic edits the page's name and path in place, as the panel header
     itself, so the inputs are borderless and carry the heading's own type. */
  if (variant === "header") {
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
          placeholder={t(
            "sectionsEditor.sectionsEditorPanels.pageNamePlaceholder",
          )}
        />
        <input
          type="text"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setPathError(null);
          }}
          onBlur={commitPath}
          onKeyDown={handlePathKeyDown}
          className="w-full bg-transparent text-xs text-muted-foreground truncate outline-none border-none p-0 focus:ring-0 placeholder:text-muted-foreground"
          placeholder={t("sectionsEditor.sectionsEditorPanels.pathPlaceholder")}
        />
        {pathError && <p className="text-xs text-destructive">{pathError}</p>}
        {pathDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="page-name">
          {t("sectionsEditor.sectionsEditorPanels.pageNameLabel")}
        </Label>
        <input
          type="text"
          id="page-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            onFieldChange("name", e.target.value);
          }}
          className={FIELD_CLASS}
          placeholder={t(
            "sectionsEditor.sectionsEditorPanels.pageNamePlaceholder",
          )}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="page-path">
          {t("sectionsEditor.sectionsEditorPanels.pathLabel")}
        </Label>
        <input
          type="text"
          id="page-path"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setPathError(null);
          }}
          onBlur={commitPath}
          onKeyDown={handlePathKeyDown}
          className={FIELD_CLASS}
          placeholder={t("sectionsEditor.sectionsEditorPanels.pathPlaceholder")}
        />
      </div>
      {pathError && <p className="text-xs text-destructive">{pathError}</p>}
      {pathDialog}
    </div>
  );
}

/**
 * The empty state of the variant select: it sits in the same slot, at the same
 * size and in the same green, so creating the first variant lands the control
 * exactly where the select that replaces it will be. Dashed and unfilled to
 * read as an invitation rather than an active selection.
 */
export function AddVariantButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const compact = useCompactPageLayout();

  if (!compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("sectionsEditor.sectionsEditorPanels.addVariant")}
            className="size-7 shrink-0 text-[oklch(0.65_0.15_160)]"
            onClick={onClick}
          >
            <Flag01 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sectionsEditor.sectionsEditorPanels.addVariant")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      className={cn(VARIANT_PILL_CLASS, VARIANT_TAB_EMPTY_CLASS)}
      onClick={onClick}
    >
      <Plus className="size-3 shrink-0" />
      <span className="truncate">
        {t("sectionsEditor.sectionsEditorPanels.createVariants")}
      </span>
    </button>
  );
}

import { useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Flag01,
  LayersThree01,
  Plus,
  Settings01,
  Trash01,
} from "@untitledui/icons";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AddVariantListButton } from "./page-variant-tabs";
import { SchemaForm } from "./schema-form";
import type { VariantMatcherOps } from "./variant-matcher-rename";
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
            className="flex shrink-0 items-center gap-0.5 rounded-[var(--studio-control-radius,var(--radius-md))] px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
                    "min-w-0 truncate rounded-[var(--studio-control-radius,var(--radius-md))] px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
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
  onVariantMatcherOp,
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
  onVariantMatcherOp?: VariantMatcherOps;
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
          onVariantMatcherOp={onVariantMatcherOp}
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
const VARIANT_PILL_CLASS =
  "shrink-0 inline-flex items-center gap-1 rounded-[var(--studio-button-radius,calc(var(--radius)*1.333))] h-7 px-2 text-xs font-medium cursor-pointer transition-opacity hover:opacity-80";

export const VARIANT_TAB_ACTIVE_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.22)]";

/** The pill geometry shared by the header's controls. The select itself wears
 *  the input treatment (see `HeaderSelectTrigger`); this is what is left for
 *  the empty state, which keeps a dashed border because an invitation needs one
 *  and a selection does not. */
const VARIANT_TAB_EMPTY_CLASS =
  "text-muted-foreground border border-dashed border-border hover:bg-accent hover:text-accent-foreground";

/**
 * The rule that decides when the selected variant applies. Every level shows
 * it under the list with the same label; only the editor inside differs,
 * because a page's or a section's variant can point at a saved matcher block
 * and a property's variant cannot.
 */
export function VariantRuleSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("space-y-2 border-t px-3 pt-4", className)}>
      <span className="text-xs font-medium text-muted-foreground">
        {t("sectionsEditor.sectionsEditor.variantRule")}
      </span>
      {children}
    </div>
  );
}

/**
 * The variants manager as its own screen: the list and its rule scroll, the
 * add button stays put. Used wherever the manager owns the panel — a property's
 * manager renders inside a scroller it does not own, so it composes
 * `VariantRuleSection` and its own add button instead.
 */
export function VariantsManagerScreen({
  children,
  onAdd,
}: {
  children: ReactNode;
  onAdd: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="py-2">{children}</div>
      </ScrollArea>
      <div className="shrink-0 border-t p-2">
        <AddVariantListButton onAdd={onAdd} />
      </div>
    </div>
  );
}

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
    "w-full truncate outline-none h-9 rounded-[var(--studio-control-radius,var(--radius-md))] border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/20";

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

/**
 * The header's variant select. Pages and sections carry variants with the same
 * shape and the same actions, so they render through one control — the
 * only difference is whose variants it is naming. Adding lives on the manage
 * screen's pinned button, beside the list a new variant joins.
 */
/**
 * The header's select, whatever it is choosing between: which variant of a
 * block is open, or which block a property is bound to. One pill and one
 * heading, so the two read as the same control doing two jobs.
 */
export function HeaderSelectTrigger({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 px-2 text-xs font-medium transition-colors",
          "rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] text-foreground card-shadow",
          "hover:bg-[var(--studio-outline-hover-background)] hover:text-accent-foreground",
        )}
      >
        {icon}
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
    </DropdownMenuTrigger>
  );
}

export function HeaderSelectOptions({
  heading,
  options,
  activeIndex,
  onSelect,
}: {
  heading: string;
  options: Array<{ label: string }>;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
        {heading}
      </DropdownMenuLabel>
      {options.map((option, index) => (
        <DropdownMenuItem
          key={`${option.label}-${index}`}
          onClick={() => onSelect(index)}
        >
          <Check
            className={cn(
              "size-3.5",
              index === activeIndex ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="truncate">{option.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function VariantSelect({
  variants,
  activeIndex,
  onSelect,
  onManage,
  onRemoveAll,
}: {
  variants: Array<{ label: string }>;
  activeIndex: number;
  onSelect: (index: number) => void;
  onManage: () => void;
  onRemoveAll: () => void;
}) {
  const t = useT();
  const active = variants[activeIndex];
  if (!active) return null;

  return (
    <DropdownMenu>
      <HeaderSelectTrigger
        icon={<LayersThree01 className="size-3.5 shrink-0" />}
        label={active.label}
      />
      <DropdownMenuContent align="end" className="w-52">
        <HeaderSelectOptions
          heading={t("sectionsEditor.pageVariantTabs.variantsLabel")}
          options={variants}
          activeIndex={activeIndex}
          onSelect={onSelect}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onManage}>
          <Settings01 className="size-3.5" />
          {t("sectionsEditor.sectionsEditor.manageVariants")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemoveAll}>
          <Trash01 className="size-3.5" />
          {t("sectionsEditor.sectionVariantList.removeAllVariants")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

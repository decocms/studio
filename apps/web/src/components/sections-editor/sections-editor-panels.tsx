import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Flag01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { SchemaForm } from "./schema-form";
import { type Crumb, crumbLabel } from "./schema-form-breadcrumb";
import { type LiveMeta, type SchemaProperty } from "./resolve-schema";
import type { FieldProps, SandboxConfig } from "./fields/field-props";
import { SeoFormFields } from "./seo-form-fields";
import { parsePageVariants, type PageVariant } from "./page-variants";
import { formatMatcher } from "./format-matcher";
import { useT } from "@/i18n/use-t.ts";

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
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
  breadcrumbPath = [],
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

export const VARIANT_TAB_ACTIVE_CLASS =
  "text-[oklch(0.45_0.15_160)] bg-[oklch(0.65_0.15_160/0.18)] dark:text-[oklch(0.78_0.15_160)] dark:bg-[oklch(0.65_0.15_160/0.22)]";

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
}: {
  pageKey: string;
  initialName: string;
  initialPath: string;
  onFieldChange: (field: "name" | "path", value: string) => void;
}) {
  const t = useT();
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
        placeholder={t(
          "sectionsEditor.sectionsEditorPanels.pageNamePlaceholder",
        )}
      />
      <input
        type="text"
        value={path}
        onChange={(e) => {
          setPath(e.target.value);
          onFieldChange("path", e.target.value);
        }}
        className="w-full bg-transparent text-xs text-muted-foreground truncate outline-none border-none p-0 focus:ring-0 placeholder:text-muted-foreground"
        placeholder={t("sectionsEditor.sectionsEditorPanels.pathPlaceholder")}
      />
    </div>
  );
}

export function AddVariantButton({ onClick }: { onClick: () => void }) {
  const t = useT();
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

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  DotsHorizontal,
  Globe01,
  LayoutAlt01,
} from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  blockRefLoaderConfigHasData,
  detectBlockRefType,
  enrichBlockRefOptions,
  lazyWrappedInner,
  resolveNestedBlockRefSchema,
  schemaWithoutDiscriminator,
} from "../block-ref-field-utils";
import {
  embeddedUnionBlockId,
  isEmbeddedUnionResolveType,
} from "../block-type-utils";
import { labelFromResolveType } from "../section-types";
import { crumbLabel, type Crumb } from "../schema-form-breadcrumb";
import { suggestBlockId, validateBlockId } from "../page-sections";
import type { SchemaProperty } from "../resolve-schema";
import { FieldLabel } from "./field-label";
import type { FieldProps } from "./field-props";

import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { MakeReusableModal } from "../make-reusable-modal";
import { SchemaForm } from "../schema-form";
import { unwrapBlockReference } from "../unwrap-section";

function defaultsForSchema(schema?: SchemaProperty): Record<string, unknown> {
  if (!schema?.properties) return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key.startsWith("__") || key === "@type") continue;
    if (prop.default !== undefined) {
      out[key] = prop.default;
    } else if (prop.type === "boolean") {
      out[key] = false;
    } else if (prop.type === "string") {
      out[key] = "";
    } else if (prop.type === "number" || prop.type === "integer") {
      out[key] = 0;
    } else if (prop.type === "object") {
      out[key] = {};
    }
  }
  return out;
}

function GlobalLoaderBadge({ blockKey }: { blockKey: string }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-global-section/14 px-1.5 py-0.5 text-[11px] font-medium text-global-section-fg dark:text-global-section-fg-dark">
          <Globe01 size={11} />
          {t("sectionsEditor.anyOfField.global")}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px]">
        {t("sectionsEditor.anyOfField.globalLoaderTooltip", { blockKey })}
      </TooltipContent>
    </Tooltip>
  );
}

function CollapsibleLoaderConfig({
  path,
  open,
  onOpenChange,
  title,
  nested,
  nestedBlockRef,
  globalBlockKey,
  onDetach,
  onMakeGlobal,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  nested: ReactNode;
  nestedBlockRef?: boolean;
  globalBlockKey?: string;
  onDetach?: () => void;
  onMakeGlobal?: () => void;
}) {
  const t = useT();
  const contentId = `${path}-loader-config`;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/80 bg-muted/30",
        nestedBlockRef && "ml-1",
      )}
    >
      <div className="group flex w-full min-w-0 items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-accent/50">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {title}
            </span>
            {globalBlockKey && <GlobalLoaderBadge blockKey={globalBlockKey} />}
          </span>
        </button>
        {(onDetach || onMakeGlobal) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("sectionsEditor.anyOfField.loaderActions")}
                className="h-7 w-7 shrink-0 text-muted-foreground"
              >
                <DotsHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {globalBlockKey && onDetach && (
                <DropdownMenuItem onClick={onDetach}>
                  <LayoutAlt01 className="h-4 w-4" />
                  {t("sectionsEditor.anyOfField.detach")}
                </DropdownMenuItem>
              )}
              {!globalBlockKey && onMakeGlobal && (
                <DropdownMenuItem onClick={onMakeGlobal}>
                  <Globe01 className="h-4 w-4" />
                  {t("sectionsEditor.anyOfField.makeGlobal")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {open && (
        <div
          id={contentId}
          className="border-t border-border/60 px-4 pb-4 pt-3"
        >
          <div className="border-l border-border/80 pl-4">{nested}</div>
        </div>
      )}
    </div>
  );
}

export function AnyOfField({
  schema,
  value,
  onChange,
  path,
  label,
  breadcrumbPath,
  onBreadcrumbChange,
  meta,
  decofile,
  onSaveReferencedBlock,
  sandbox,
  previewBaseUrl,
  onRequestAddSection,
}: FieldProps) {
  const t = useT();
  const baseRefs = (schema.anyOfRefs ?? []).filter((r) => r.resolveType !== "");
  const savedRef =
    decofile && value ? unwrapBlockReference(value, decofile) : null;
  const editorValue = savedRef?.data ?? value;
  // Nested section array items are Lazy-wrapped (`{ __resolveType: ".../Lazy.tsx",
  // section: { <real section> } }`). The schema resolves to the inner section
  // (via moduleResolveTypeFromBlockData) but the value must be unwrapped too,
  // otherwise the form binds against the wrapper and every field renders empty.
  // We bind the inner `section` and re-wrap on change.
  const lazyInner = savedRef ? null : lazyWrappedInner(editorValue);
  const boundValue = lazyInner ?? editorValue;
  const refs = enrichBlockRefOptions(baseRefs, {
    savedBlockKey: savedRef?.blockKey,
    editorValue,
  });
  const inferredRt =
    refs.length > 0
      ? detectBlockRefType(editorValue, refs, savedRef?.blockKey)
      : (refs[0]?.resolveType ?? "");
  const isBlockRef = schema.type === "block-ref";
  const isModuleLoaderUnion =
    isBlockRef &&
    refs.some(
      (r) =>
        r.resolveType.includes("/") &&
        !isEmbeddedUnionResolveType(r.resolveType),
    );

  // In module-loader mode the breadcrumb path passes through this component.
  // We strip our own crumb from the front before passing to the nested
  // SchemaForm so the loader's internal schema can resolve the path correctly
  // (e.g. ["Página de Listagem", "productClusterIds"] → nested receives
  // ["productClusterIds"] → loader SchemaForm finds "selectedFacets" because an
  // item label matches). nestedOnBreadcrumbChange prepends the crumb back so the
  // outer section editor sees the full path.
  // The crumb uses this field's display LABEL (not the raw key) so the breadcrumb
  // reads "Página de Listagem" instead of "page". resolveActiveFieldKey matches
  // both label and key, so resolution still works.
  const outerCrumb = label ?? (path.includes(".") ? path.split(".")[0]! : path);
  const safeBreadcrumbPath = breadcrumbPath ?? [];
  // Strip our own crumb only when it's actually at the head. The parent
  // SchemaForm may have already consumed it (via breadcrumbPathForActiveField)
  // and now re-prepends it for us (via consumedBreadcrumbPrefix). Re-prepend
  // SYMMETRICALLY — add the crumb back only when we stripped it here; otherwise
  // the parent's re-prepend would double it (["Página de Listagem", "Página de
  // Listagem", …]) when this loader union is the active narrowed field.
  const strippedOwnCrumb =
    isModuleLoaderUnion &&
    safeBreadcrumbPath.length > 0 &&
    crumbLabel(safeBreadcrumbPath[0]!) === outerCrumb;
  const nestedBreadcrumbPath = strippedOwnCrumb
    ? safeBreadcrumbPath.slice(1)
    : safeBreadcrumbPath;
  const nestedOnBreadcrumbChange: ((p: Crumb[]) => void) | undefined =
    strippedOwnCrumb
      ? (newPath) => {
          onBreadcrumbChange?.([outerCrumb, ...newPath]);
        }
      : onBreadcrumbChange;

  const [selectedRt, setSelectedRt] = useState(inferredRt);
  const [prevInferredRt, setPrevInferredRt] = useState(inferredRt);
  if (prevInferredRt !== inferredRt) {
    setPrevInferredRt(inferredRt);
    setSelectedRt(inferredRt);
  }
  const [loaderConfigOpen, setLoaderConfigOpen] = useState(() =>
    blockRefLoaderConfigHasData(editorValue, savedRef?.blockKey),
  );
  const [makeGlobalOpen, setMakeGlobalOpen] = useState(false);

  // ── block-ref mode (anyOfRefs from schema resolution) ─────────────
  if (refs.length > 0) {
    const activeRt = selectedRt || inferredRt;
    const selectedRef = refs.find((r) => r.resolveType === activeRt);
    const resolvedNestedSchema = resolveNestedBlockRefSchema(
      editorValue,
      meta,
      selectedRef?.schema,
    );
    const nestedSchema = schemaWithoutDiscriminator(
      resolvedNestedSchema ?? selectedRef?.schema ?? null,
      schema.discriminatorKey,
    );
    const discriminatorKey = schema.discriminatorKey;

    const handleRefChange = (rt: string) => {
      setSelectedRt(rt);
      const targetRef = refs.find((r) => r.resolveType === rt);
      const resolvedTargetSchema = resolveNestedBlockRefSchema(
        editorValue,
        meta,
        targetRef?.schema,
      );
      const allowed = new Set(
        Object.keys(
          (resolvedTargetSchema ?? targetRef?.schema)?.properties ?? {},
        ),
      );
      const existing =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const filtered = Object.fromEntries(
        Object.entries(existing).filter(([k]) => allowed.has(k)),
      );
      const next = {
        ...defaultsForSchema(targetRef?.schema),
        ...filtered,
      };

      if (discriminatorKey) {
        const discValue = targetRef?.discriminatorValue ?? rt;
        onChange({ ...next, [discriminatorKey]: discValue });
        return;
      }

      // Embedded union variants (ImageBanner | VideoBanner in Carousel.tsx)
      // must not get a persisted __resolveType — deco only expects plain props.
      if (isEmbeddedUnionResolveType(rt)) {
        onChange(next);
        return;
      }
      onChange({ ...next, __resolveType: rt });
    };

    const persistUnionValue = (next: unknown) => {
      if (
        discriminatorKey ||
        !isEmbeddedUnionResolveType(activeRt) ||
        next === null ||
        typeof next !== "object" ||
        Array.isArray(next)
      ) {
        onChange(next);
        return;
      }
      const { __resolveType: _, ...rest } = next as Record<string, unknown>;
      onChange(rest);
    };

    const nestedProps = nestedSchema?.properties ? (
      <SchemaForm
        schema={nestedSchema}
        value={boundValue}
        onChange={(next) => {
          if (savedRef && onSaveReferencedBlock) {
            onSaveReferencedBlock(
              savedRef.blockKey,
              next as Record<string, unknown>,
            );
            return;
          }
          // Re-wrap into the Lazy section wrapper so the decofile shape is preserved.
          if (lazyInner) {
            onChange({
              ...(editorValue as Record<string, unknown>),
              section: next,
            });
            return;
          }
          persistUnionValue(next);
        }}
        basePath={path}
        breadcrumbPath={nestedBreadcrumbPath}
        onBreadcrumbChange={nestedOnBreadcrumbChange}
        meta={meta}
        decofile={decofile}
        onSaveReferencedBlock={onSaveReferencedBlock}
        sandbox={sandbox}
        previewBaseUrl={previewBaseUrl}
        onRequestAddSection={onRequestAddSection}
      />
    ) : null;

    // Once the breadcrumb has drilled INTO this loader's content (e.g. into an
    // array item), render that nested content at FULL WIDTH — dropping the
    // loader type <Select> and the "loader configuration" card chrome — so the
    // item's form takes over the whole panel instead of staying scoped inside
    // the loader card. The breadcrumb "back" pops the crumb, `nestedBreadcrumbPath`
    // empties, and the normal select + card chrome returns.
    if (isModuleLoaderUnion && nestedProps && nestedBreadcrumbPath.length > 0) {
      return <div className="min-w-0">{nestedProps}</div>;
    }

    const isNestedBlockRef = path.includes(".");

    // Detach: convert a global (saved-block) loader into a local, inline copy.
    // Mirrors the section-level "Detach" — the resolved block data is written
    // back inline (minus the saved block's `name`), so edits no longer touch
    // the shared decofile entry referenced elsewhere on the site.
    const handleDetach = savedRef
      ? () => {
          const { name: _name, ...inlineData } = savedRef.data;
          onChange(inlineData);
        }
      : undefined;

    // Make global: save the current inline loader as a reusable decofile block
    // and point this field at it. Mirrors the section-level "Save as global".
    // Only offered for a local module loader (not already global, not a Lazy
    // wrapper, and an actual module resolveType — not an embedded union variant).
    const canMakeGlobal =
      !savedRef &&
      !lazyInner &&
      !!onSaveReferencedBlock &&
      isModuleLoaderUnion &&
      !isEmbeddedUnionResolveType(activeRt) &&
      activeRt.includes("/");
    const currentLoaderData =
      boundValue && typeof boundValue === "object" && !Array.isArray(boundValue)
        ? (boundValue as Record<string, unknown>)
        : {};
    const handleMakeGlobalSubmit = (blockId: string) => {
      if (!onSaveReferencedBlock) return;
      const trimmed = blockId.trim();
      const validationError = decofile
        ? validateBlockId(trimmed, decofile)
        : null;
      if (validationError) {
        toast.error(validationError);
        return;
      }
      onSaveReferencedBlock(trimmed, {
        ...currentLoaderData,
        __resolveType: activeRt,
        name: trimmed,
      });
      onChange({ __resolveType: trimmed });
      setMakeGlobalOpen(false);
      toast.success(
        t("sectionsEditor.anyOfField.globalBlockSaved", { name: trimmed }),
      );
    };

    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor={path}
            label={label}
            description={schema.description}
            virtualMcpId={sandbox?.virtualMcpId}
          />
          <Select value={activeRt || undefined} onValueChange={handleRefChange}>
            <SelectTrigger id={path}>
              <SelectValue
                placeholder={t("sectionsEditor.anyOfField.selectPlaceholder")}
              />
            </SelectTrigger>
            <SelectContent>
              {refs.map((ref) => {
                // If title is a file path (contains "/"), derive a human label
                // from the resolveType instead (e.g. "DeliveryPromiseProductListingPage").
                const displayTitle =
                  ref.title && !ref.title.includes("/")
                    ? ref.title
                    : (embeddedUnionBlockId(ref.resolveType) ??
                      labelFromResolveType(ref.resolveType));
                return (
                  <SelectItem key={ref.resolveType} value={ref.resolveType}>
                    {displayTitle}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        {nestedProps &&
          (isModuleLoaderUnion ? (
            <CollapsibleLoaderConfig
              path={path}
              open={loaderConfigOpen}
              onOpenChange={setLoaderConfigOpen}
              title={
                isNestedBlockRef
                  ? t("sectionsEditor.anyOfField.configuration")
                  : t("sectionsEditor.anyOfField.loaderConfiguration")
              }
              nested={nestedProps}
              nestedBlockRef={isNestedBlockRef}
              globalBlockKey={savedRef?.blockKey}
              onDetach={handleDetach}
              onMakeGlobal={
                canMakeGlobal ? () => setMakeGlobalOpen(true) : undefined
              }
            />
          ) : (
            nestedProps
          ))}
        {canMakeGlobal && (
          <MakeReusableModal
            open={makeGlobalOpen}
            onOpenChange={setMakeGlobalOpen}
            defaultBlockId={suggestBlockId(labelFromResolveType(activeRt))}
            onSubmit={handleMakeGlobalSubmit}
          />
        )}
      </div>
    );
  }

  if (schema.anyOfRefs && schema.anyOfRefs.length > 0) {
    return null;
  }

  // ── Fallback: render a basic text input for unresolved anyOf fields ──
  return (
    <div className="space-y-1.5">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      <input
        id={path}
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        placeholder={schema.description ?? ""}
      />
    </div>
  );
}

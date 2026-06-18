import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Globe01 } from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  blockRefLoaderConfigHasData,
  detectBlockRefType,
  enrichBlockRefOptions,
  resolveNestedBlockRefSchema,
  schemaWithoutDiscriminator,
} from "../block-ref-field-utils";
import {
  embeddedUnionBlockId,
  isEmbeddedUnionResolveType,
} from "../block-type-utils";
import { labelFromResolveType } from "../section-types";
import type { SchemaProperty } from "../resolve-schema";
import type { FieldProps } from "./field-props";

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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-global-section/14 px-1.5 py-0.5 text-[11px] font-medium text-global-section-fg dark:text-global-section-fg-dark">
          <Globe01 size={11} />
          Global
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px]">
        Edits the saved block &ldquo;{blockKey}&rdquo;. Changes apply everywhere
        this loader is referenced on your site.
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
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  nested: ReactNode;
  nestedBlockRef?: boolean;
  globalBlockKey?: string;
}) {
  const contentId = `${path}-loader-config`;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/80 bg-muted/30",
        nestedBlockRef && "ml-1",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
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
}: FieldProps) {
  const baseRefs = (schema.anyOfRefs ?? []).filter((r) => r.resolveType !== "");
  const savedRef =
    decofile && value ? unwrapBlockReference(value, decofile) : null;
  const editorValue = savedRef?.data ?? value;
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
  const nestedBreadcrumbPath =
    isModuleLoaderUnion && safeBreadcrumbPath[0] === outerCrumb
      ? safeBreadcrumbPath.slice(1)
      : isModuleLoaderUnion
        ? []
        : safeBreadcrumbPath;
  const nestedOnBreadcrumbChange: ((p: string[]) => void) | undefined =
    isModuleLoaderUnion
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
        value={editorValue}
        onChange={(next) => {
          if (savedRef && onSaveReferencedBlock) {
            onSaveReferencedBlock(
              savedRef.blockKey,
              next as Record<string, unknown>,
            );
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
      />
    ) : null;

    const isNestedBlockRef = path.includes(".");

    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={path}>{label}</Label>
          <Select value={activeRt || undefined} onValueChange={handleRefChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select..." />
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
          {schema.description && (
            <p className="text-xs text-muted-foreground">
              {schema.description}
            </p>
          )}
        </div>
        {nestedProps &&
          (isModuleLoaderUnion ? (
            <CollapsibleLoaderConfig
              path={path}
              open={loaderConfigOpen}
              onOpenChange={setLoaderConfigOpen}
              title={
                isNestedBlockRef ? "Configuration" : "Loader configuration"
              }
              nested={nestedProps}
              nestedBlockRef={isNestedBlockRef}
              globalBlockKey={savedRef?.blockKey}
            />
          ) : (
            nestedProps
          ))}
      </div>
    );
  }

  if (schema.anyOfRefs && schema.anyOfRefs.length > 0) {
    return null;
  }

  // ── Fallback: render a basic text input for unresolved anyOf fields ──
  return (
    <div className="space-y-1.5">
      <Label htmlFor={path}>{label}</Label>
      <input
        id={path}
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        placeholder={schema.description ?? ""}
      />
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
    </div>
  );
}

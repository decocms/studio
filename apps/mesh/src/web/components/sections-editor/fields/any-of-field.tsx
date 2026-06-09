import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  embeddedUnionBlockId,
  isEmbeddedUnionResolveType,
  unionRefMatchesValue,
} from "../block-type-utils";
import type { SchemaProperty } from "../resolve-schema";
import type { FieldProps } from "./field-props";
import { SchemaForm } from "../schema-form";

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

function detectCurrentType(
  value: unknown,
  refs: Array<{ resolveType: string; schema?: SchemaProperty }>,
): string {
  const fallback = refs[0]?.resolveType ?? "";
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const obj = value as Record<string, unknown>;

  if (typeof obj.__resolveType === "string") {
    const match = refs.find((r) =>
      unionRefMatchesValue(r.resolveType, obj.__resolveType as string),
    );
    if (match) return match.resolveType;
  }

  // Prefer branch-specific keys over shared ones (alt, action) so
  // ImageBanner|VideoBanner items don't always collapse to the first branch.
  let best = fallback;
  let bestScore = -1;
  for (const ref of refs) {
    if (!ref.schema?.properties) continue;
    const keys = Object.keys(ref.schema.properties).filter(
      (k) =>
        !k.startsWith("__") && k !== "@type" && k !== "action" && k !== "alt",
    );
    const score = keys.filter((k) => obj[k] !== undefined).length;
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = ref.resolveType;
    }
  }
  if (bestScore > 0) return best;

  for (const ref of refs) {
    if (!ref.schema?.properties) continue;
    const score = Object.keys(ref.schema.properties).filter(
      (k) => obj[k] !== undefined,
    ).length;
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = ref.resolveType;
    }
  }
  return best;
}

function CollapsibleLoaderConfig({
  path,
  open,
  onOpenChange,
  title,
  nested,
  nestedBlockRef,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  nested: ReactNode;
  nestedBlockRef?: boolean;
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
        <span className="min-w-0 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
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
}: FieldProps) {
  const refs = (schema.anyOfRefs ?? []).filter((r) => r.resolveType !== "");
  const inferredRt =
    refs.length > 0
      ? detectCurrentType(value, refs)
      : (refs[0]?.resolveType ?? "");
  const [selectedRt, setSelectedRt] = useState(inferredRt);
  const [loaderConfigOpen, setLoaderConfigOpen] = useState(false);

  // ── block-ref mode (anyOfRefs from schema resolution) ─────────────
  if (refs.length > 0) {
    const activeRt = selectedRt || inferredRt;
    const selectedRef = refs.find((r) => r.resolveType === activeRt);

    const handleRefChange = (rt: string) => {
      setSelectedRt(rt);
      const targetRef = refs.find((r) => r.resolveType === rt);
      const allowed = new Set(Object.keys(targetRef?.schema?.properties ?? {}));
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

    const nestedProps = selectedRef?.schema?.properties ? (
      <SchemaForm
        schema={selectedRef.schema}
        value={value}
        onChange={persistUnionValue}
        basePath={path}
        breadcrumbPath={breadcrumbPath}
        onBreadcrumbChange={onBreadcrumbChange}
      />
    ) : null;

    // Block-ref loaders (jsonLD, slug, …): nest props in a card so they read
    // as configuration for the selected block, not siblings of parent fields.
    const isBlockRef = schema.type === "block-ref";
    const isNestedBlockRef = path.includes(".");

    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={path}>{label}</Label>
          <Select value={activeRt} onValueChange={handleRefChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {refs.map((ref) => (
                <SelectItem key={ref.resolveType} value={ref.resolveType}>
                  {ref.title ??
                    embeddedUnionBlockId(ref.resolveType) ??
                    ref.resolveType}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {schema.description && (
            <p className="text-xs text-muted-foreground">
              {schema.description}
            </p>
          )}
        </div>
        {nestedProps &&
          (isBlockRef ? (
            <CollapsibleLoaderConfig
              path={path}
              open={loaderConfigOpen}
              onOpenChange={setLoaderConfigOpen}
              title={
                isNestedBlockRef ? "Configuration" : "Loader configuration"
              }
              nested={nestedProps}
              nestedBlockRef={isNestedBlockRef}
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

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import {
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import {
  ChevronDown,
  ChevronRight,
  LinkExternal01,
  Plus,
  Star01,
  Trash01,
  Globe02,
  Zap,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { toast } from "sonner";
import { Page } from "@/web/components/page";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";
import { usePublicConfig } from "@/web/hooks/use-public-config";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { track } from "@/web/lib/posthog-client";

// --- Types ---

type BrandColors = {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  foreground?: string;
};

type BrandFonts = {
  heading?: string;
  body?: string;
  code?: string;
};

type BrandContext = {
  id: string;
  organizationId: string;
  name: string;
  domain: string;
  overview: string;
  logo?: string | null;
  favicon?: string | null;
  ogImage?: string | null;
  fonts?: BrandFonts | null;
  colors?: BrandColors | null;
  images?: string[];
  archivedAt?: string | null;
  isDefault?: boolean;
};

// --- Section card wrapper (visual container only — autosave handles saves) ---

function BrandCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-background p-5",
        className,
      )}
    >
      <div className="mb-4">
        <span className="text-xs font-medium text-muted-foreground">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// --- Form data covering all editable brand fields ---

interface BrandFormData {
  name: string;
  domain: string;
  overview: string;
  logo: string;
  favicon: string;
  ogImage: string;
  fonts: BrandFonts;
  colors: BrandColors;
}

type BrandFormReturn = UseFormReturn<BrandFormData>;

// --- Auto-extract banner ---

function AutoExtractBanner({
  onExtract,
  isExtracting,
}: {
  onExtract: (domain: string) => void;
  isExtracting?: boolean;
}) {
  const [domain, setDomain] = useState("");

  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Zap size={18} className="text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            Auto-extract brand context
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter your website URL and we'll automatically extract your brand
            colors, fonts, logos, and company overview.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && domain.trim() && !isExtracting) {
                  onExtract(domain.trim());
                }
              }}
            />
            <Button
              variant="outline"
              disabled={!domain.trim() || isExtracting}
              onClick={() => onExtract(domain.trim())}
            >
              <Globe02 size={14} />
              {isExtracting ? "Extracting..." : "Extract"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Section: Company Overview ---

function OverviewSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  const domain = form.watch("domain");

  return (
    <BrandCard title="Company Overview">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Company name
            </label>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    onFieldChange();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    onFieldCommit();
                  }}
                  placeholder="Acme Corp"
                />
              )}
            />
          </div>
          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Domain</span>
              {domain && (
                <a
                  href={`https://${domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 transition-colors hover:text-foreground"
                >
                  <LinkExternal01 size={10} />
                  open
                </a>
              )}
            </label>
            <Controller
              control={form.control}
              name="domain"
              render={({ field }) => (
                <Input
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    onFieldChange();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    onFieldCommit();
                  }}
                  placeholder="acme.com"
                />
              )}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Overview
          </label>
          <Controller
            control={form.control}
            name="overview"
            render={({ field }) => (
              <Textarea
                {...field}
                onChange={(e) => {
                  field.onChange(e);
                  onFieldChange();
                }}
                onBlur={() => {
                  field.onBlur();
                  onFieldCommit();
                }}
                placeholder="Brief description of what the company does..."
                rows={3}
              />
            )}
          />
        </div>
      </div>
    </BrandCard>
  );
}

// --- Section: Logos ---

const CHECKERED_BG = {
  backgroundImage:
    "linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%), linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0, 4px 4px",
  backgroundColor: "#fff",
};

function LogoFieldRow({
  form,
  name,
  label,
  imgClassName = "h-full w-full object-contain p-3",
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  name: "logo" | "favicon" | "ogImage";
  label: string;
  imgClassName?: string;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  const value = form.watch(name);
  return (
    <div className="flex items-start gap-3">
      <div
        className="flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl"
        style={CHECKERED_BG}
      >
        {value ? (
          <img
            src={value}
            alt={label}
            className={imgClassName}
            loading="lazy"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground/70">
            No {label.toLowerCase()}
          </span>
        )}
      </div>
      <div className="flex-1">
        <label className="mb-1 block text-xs text-muted-foreground">
          {label} URL
        </label>
        <Controller
          control={form.control}
          name={name}
          render={({ field }) => (
            <Input
              {...field}
              onChange={(e) => {
                field.onChange(e);
                onFieldChange();
              }}
              onBlur={() => {
                field.onBlur();
                onFieldCommit();
              }}
              placeholder="https://..."
            />
          )}
        />
      </div>
    </div>
  );
}

function LogosSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Logos & Images">
      <div className="space-y-3">
        <LogoFieldRow
          form={form}
          name="logo"
          label="Logo"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
        <LogoFieldRow
          form={form}
          name="favicon"
          label="Favicon"
          imgClassName="h-12 w-12 object-contain"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
        <LogoFieldRow
          form={form}
          name="ogImage"
          label="SEO / OG image"
          imgClassName="h-full w-full object-contain"
          onFieldChange={onFieldChange}
          onFieldCommit={onFieldCommit}
        />
      </div>
    </BrandCard>
  );
}

// --- Section: Fonts ---

const FONT_ROLES = [
  { key: "heading" as const, label: "Headings" },
  { key: "body" as const, label: "Body" },
  { key: "code" as const, label: "Code" },
];

function FontsSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Fonts">
      <div className="space-y-2">
        {FONT_ROLES.map(({ key, label }) => {
          const fieldName = `fonts.${key}` as const;
          const value = form.watch(fieldName);
          return (
            <div key={key}>
              <label className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="w-7 text-base font-medium leading-none text-foreground">
                  Aa
                </span>
                <span>{label}</span>
                {value && (
                  <span
                    className="ml-auto truncate text-foreground"
                    style={{ fontFamily: value }}
                  >
                    {value}
                  </span>
                )}
              </label>
              <Controller
                control={form.control}
                name={fieldName}
                render={({ field }) => (
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      field.onChange(e);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    placeholder={`Font family for ${label.toLowerCase()}`}
                  />
                )}
              />
            </div>
          );
        })}
      </div>
    </BrandCard>
  );
}

// --- Section: Colors ---

const COLOR_ROLES = [
  { key: "primary" as const, label: "Primary" },
  { key: "secondary" as const, label: "Secondary" },
  { key: "accent" as const, label: "Accent" },
  { key: "background" as const, label: "Background" },
  { key: "foreground" as const, label: "Foreground" },
];

function ColorsSection({
  form,
  onFieldChange,
  onFieldCommit,
}: {
  form: BrandFormReturn;
  onFieldChange: () => void;
  onFieldCommit: () => void;
}) {
  return (
    <BrandCard title="Colors">
      <div className="space-y-2">
        {COLOR_ROLES.map(({ key, label }) => {
          const fieldName = `colors.${key}` as const;
          return (
            <Controller
              key={key}
              control={form.control}
              name={fieldName}
              render={({ field }) => (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={field.value ?? "#000000"}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
                  />
                  <Input
                    value={field.value ?? ""}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      onFieldChange();
                    }}
                    onBlur={() => {
                      field.onBlur();
                      onFieldCommit();
                    }}
                    placeholder="#000000"
                    className="w-28"
                  />
                  <span className="flex-1 text-xs text-muted-foreground">
                    {label}
                  </span>
                </div>
              )}
            />
          );
        })}
      </div>
    </BrandCard>
  );
}

// --- Expandable brand entry ---

function ExpandableBrandEntry({
  brand,
  client,
  onChanged,
}: {
  brand: BrandContext;
  client: ReturnType<typeof useMCPClient>;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(brand.isDefault ?? false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const form = useForm<BrandFormData>({
    values: {
      name: brand.name ?? "",
      domain: brand.domain ?? "",
      overview: brand.overview ?? "",
      logo: brand.logo ?? "",
      favicon: brand.favicon ?? "",
      ogImage: brand.ogImage ?? "",
      fonts: brand.fonts ?? {},
      colors: brand.colors ?? {},
    },
  });

  const updateBrandMutation = useMutation({
    mutationFn: async (values: BrandFormData) => {
      const fontsHasAny = Object.values(values.fonts).some((v) => v?.trim());
      const colorsHasAny = Object.values(values.colors).some((v) => v?.trim());
      const merged = {
        id: brand.id,
        name: values.name,
        domain: values.domain,
        overview: values.overview,
        logo: values.logo || null,
        favicon: values.favicon || null,
        ogImage: values.ogImage || null,
        fonts: fontsHasAny ? values.fonts : null,
        colors: colorsHasAny ? values.colors : null,
        images: brand.images,
      };
      await client.callTool({
        name: "BRAND_CONTEXT_UPDATE",
        arguments: merged,
      });
    },
    onError: () => toast.error("Failed to save brand context"),
  });

  const { schedule: scheduleSave, flush: flushAndSave } = useDebouncedAutosave({
    delayMs: 500,
    save: async () => {
      // Read live dirty state from control._formState. form.formState is a
      // Proxy over React state and lags by one render inside synchronous
      // event handlers — the same gotcha that hit virtual-mcp.
      const liveDirtyFields = (
        form.control as unknown as {
          _formState: { dirtyFields: Record<string, unknown> };
        }
      )._formState.dirtyFields;
      const dirtyKeys = Object.keys(liveDirtyFields);
      if (dirtyKeys.length === 0) return;

      const values = form.getValues();
      const previousDefaults = (
        form.control as unknown as { _defaultValues: BrandFormData }
      )._defaultValues;

      // Rebase defaults to the snapshot we're about to send. An edit during
      // the in-flight save that returns a value to its pre-save default still
      // registers as dirty for the next save. keepValues preserves the user's
      // current view; only _defaultValues advances. Replaces the post-mutate
      // form.reset(values) which used to stomp user edits made mid-flight.
      form.reset(values, { keepValues: true });

      try {
        await updateBrandMutation.mutateAsync(values);
        track("brand_updated", { brand_id: brand.id, fields: dirtyKeys });
        toast.success("Brand context updated successfully");
        onChanged();
      } catch {
        // Roll back the rebase so user edits remain dirty for the next save.
        form.reset(previousDefaults, { keepValues: true });
      }
    },
  });

  const { mutate: deleteBrand, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "BRAND_CONTEXT_DELETE",
        arguments: { id: brand.id },
      });
    },
    onSuccess: () => {
      track("brand_deleted", { brand_id: brand.id });
      setConfirmDeleteOpen(false);
      onChanged();
      toast.success("Brand deleted");
    },
    onError: () => toast.error("Failed to delete brand"),
  });

  const { mutate: toggleDefault } = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "BRAND_CONTEXT_UPDATE",
        arguments: { id: brand.id, isDefault: !brand.isDefault },
      });
    },
    onSuccess: () => {
      track(
        brand.isDefault ? "brand_unset_as_default" : "brand_set_as_default",
        {
          brand_id: brand.id,
        },
      );
      onChanged();
      toast.success(
        brand.isDefault ? "Removed as default brand" : "Set as default brand",
      );
    },
    onError: () => toast.error("Failed to update default brand"),
  });

  return (
    <div
      className={cn(
        "rounded-2xl border bg-background",
        brand.isDefault ? "border-primary/30" : "border-border/60",
      )}
    >
      {/* Collapsed header — always visible */}
      <button
        type="button"
        className="flex w-full items-center gap-3 p-5"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>

        {/* Logo thumbnail */}
        {brand.logo ? (
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
            style={{
              backgroundImage:
                "linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%), linear-gradient(45deg, #e5e7eb 25%, transparent 25%, transparent 75%, #e5e7eb 75%)",
              backgroundSize: "6px 6px",
              backgroundPosition: "0 0, 3px 3px",
              backgroundColor: "#fff",
            }}
          >
            <img
              src={brand.logo}
              alt=""
              className="h-full w-full object-contain p-1"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <span className="text-xs font-medium text-muted-foreground">
              {brand.name?.charAt(0)?.toUpperCase() || "?"}
            </span>
          </div>
        )}

        <div className="flex flex-1 flex-col items-start gap-0.5 overflow-hidden text-left">
          <span className="text-sm font-medium text-foreground">
            {brand.name || "Untitled Brand"}
          </span>
          {brand.domain && (
            <span className="truncate text-xs text-muted-foreground">
              {brand.domain}
            </span>
          )}
        </div>

        {/* Color swatches — only when collapsed */}
        {!expanded &&
          brand.colors &&
          Object.values(brand.colors).some((v) => v) && (
            <div className="flex shrink-0 gap-1">
              {Object.entries(brand.colors)
                .filter(([, v]) => v)
                .map(([role, value]) => (
                  <div
                    key={role}
                    className="h-5 w-5 rounded-full border border-border/40"
                    style={{ backgroundColor: value }}
                    title={`${role}: ${value}`}
                  />
                ))}
            </div>
          )}

        {/* Font names — only when collapsed */}
        {!expanded &&
          brand.fonts &&
          Object.values(brand.fonts).some((v) => v) && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {Object.values(brand.fonts).filter(Boolean).join(", ")}
            </span>
          )}

        {/* Default star */}
        <span
          role="button"
          tabIndex={0}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-opacity",
            brand.isDefault
              ? "opacity-100"
              : "opacity-0 hover:bg-muted group-hover:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            toggleDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              toggleDefault();
            }
          }}
          title={brand.isDefault ? "Unset as default" : "Set as default"}
        >
          <Star01
            size={13}
            className={cn(
              brand.isDefault
                ? "text-primary fill-primary"
                : "text-muted-foreground",
            )}
          />
        </span>

        {/* Delete */}
        <span
          role="button"
          tabIndex={0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDeleteOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              setConfirmDeleteOpen(true);
            }
          }}
          title="Delete brand"
        >
          <Trash01 size={13} className="text-muted-foreground" />
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="space-y-3 px-5 pb-5">
          <OverviewSection
            form={form}
            onFieldChange={scheduleSave}
            onFieldCommit={flushAndSave}
          />
          <LogosSection
            form={form}
            onFieldChange={scheduleSave}
            onFieldCommit={flushAndSave}
          />
          <div className="grid grid-cols-2 gap-3">
            <ColorsSection
              form={form}
              onFieldChange={scheduleSave}
              onFieldCommit={flushAndSave}
            />
            <FontsSection
              form={form}
              onFieldChange={scheduleSave}
              onFieldCommit={flushAndSave}
            />
          </div>
        </div>
      )}

      <AlertDialog
        open={confirmDeleteOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setConfirmDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete brand?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  This will permanently delete{" "}
                  <span className="font-medium text-foreground">
                    {brand.name || "this brand"}
                  </span>
                  . This action cannot be undone.
                </p>
                {brand.isDefault && (
                  <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                    <span className="font-medium">Heads up:</span> this is your
                    organization's default brand. Deleting it will leave your
                    organization without a default brand until you set another.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteBrand();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Main page ---

export function OrgBrandContextPage() {
  const { brandExtractEnabled } = usePublicConfig();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const { data: allBrands = [] } = useQuery<BrandContext[]>({
    queryKey: KEYS.brandContext(org.id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "BRAND_CONTEXT_LIST",
        arguments: { includeArchived: false },
      });
      const data = unwrapToolResult<{ items?: BrandContext[] }>(result);
      return Array.isArray(data?.items) ? data.items : [];
    },
  });

  const activeBrands = allBrands.filter((b) => !b.archivedAt);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.brandContext(org.id),
      refetchType: "all",
    });

  const { mutate: createBrand, isPending: isCreating } = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "BRAND_CONTEXT_CREATE",
        arguments: {
          name: "New Brand",
          domain: "example.com",
          overview: "",
        },
      });
    },
    onSuccess: () => {
      track("brand_created");
      invalidate();
      toast.success("Brand created");
    },
    onError: () => toast.error("Failed to create brand"),
  });

  const { mutate: extractBrand, isPending: isExtracting } = useMutation({
    mutationFn: async (domain: string) => {
      track("brand_extract_started", { domain });
      const result = await client.callTool({
        name: "BRAND_CONTEXT_EXTRACT",
        arguments: { domain },
      });
      // callTool doesn't throw on tool errors — check isError
      unwrapToolResult(result);
    },
    onSuccess: () => {
      track("brand_extract_succeeded");
      invalidate();
      toast.success("Brand extracted successfully");
    },
    onError: (err) => {
      track("brand_extract_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
      toast.error(
        err instanceof Error ? err.message : "Failed to extract brand",
      );
    },
  });

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <Page.Title>Brand Context</Page.Title>
                <p className="mt-1 text-sm text-muted-foreground">
                  Define your brand profiles. Each brand is available as an MCP
                  prompt for AI clients.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => createBrand()}
                disabled={isCreating}
              >
                <Plus size={14} />
                Add Brand
              </Button>
            </div>

            {brandExtractEnabled && (
              <AutoExtractBanner
                onExtract={(domain) => extractBrand(domain)}
                isExtracting={isExtracting}
              />
            )}

            {activeBrands.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No brands configured yet.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => createBrand()}
                  disabled={isCreating}
                >
                  <Plus size={14} />
                  Add your first brand
                </Button>
              </div>
            )}

            <div className="group space-y-3">
              {activeBrands.map((brand) => (
                <ExpandableBrandEntry
                  key={brand.id}
                  brand={brand}
                  client={client}
                  onChanged={invalidate}
                />
              ))}
            </div>
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

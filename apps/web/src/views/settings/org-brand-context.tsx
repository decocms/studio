import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Star01,
  Trash01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
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
import { toast } from "sonner";
import { Page } from "@/components/page";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import { usePublicConfig } from "@/hooks/use-public-config";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { track } from "@/lib/posthog-client";
import {
  AutoExtractBanner,
  ColorsSection,
  FontsSection,
  LogosSection,
  OverviewSection,
  type BrandFormData,
} from "./brand-form-sections";

// --- Types ---

// Derived from the tool's output so the page stays in sync with the server
// schema (notably images/metadata types) without a hand-maintained copy.
type BrandContext = ToolOutput<"BRAND_CONTEXT_LIST">["items"][number];

// --- Expandable brand entry ---

function ExpandableBrandEntry({
  brand,
  onChanged,
}: {
  brand: BrandContext;
  onChanged: () => void;
}) {
  const t = useT();
  const studio = useStudioTools();
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
      // Typed REST call throws on non-2xx (validation/auth/scoping), so a
      // rejected write surfaces as an error instead of a false "saved" toast.
      // `images` isn't edited here; omitting it leaves the stored value intact.
      await studio.call("BRAND_CONTEXT_UPDATE", {
        id: brand.id,
        name: values.name,
        domain: values.domain,
        overview: values.overview,
        logo: values.logo || null,
        favicon: values.favicon || null,
        ogImage: values.ogImage || null,
        fonts: fontsHasAny ? values.fonts : null,
        colors: colorsHasAny ? values.colors : null,
      });
    },
    onError: () =>
      toast.error(t("settings.orgBrandContext.failedSaveBrandContext")),
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
        toast.success(t("settings.orgBrandContext.brandContextUpdated"));
        onChanged();
      } catch {
        // Roll back the rebase so user edits remain dirty for the next save.
        form.reset(previousDefaults, { keepValues: true });
      }
    },
  });

  const { mutate: deleteBrand, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      await studio.call("BRAND_CONTEXT_DELETE", { id: brand.id });
    },
    onSuccess: () => {
      track("brand_deleted", { brand_id: brand.id });
      setConfirmDeleteOpen(false);
      onChanged();
      toast.success(t("settings.orgBrandContext.brandDeleted"));
    },
    onError: () => toast.error(t("settings.orgBrandContext.failedDeleteBrand")),
  });

  const { mutate: toggleDefault } = useMutation({
    mutationFn: async () => {
      await studio.call("BRAND_CONTEXT_UPDATE", {
        id: brand.id,
        isDefault: !brand.isDefault,
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
        brand.isDefault
          ? t("settings.orgBrandContext.removedAsDefaultBrand")
          : t("settings.orgBrandContext.setAsDefaultBrand"),
      );
    },
    onError: () =>
      toast.error(t("settings.orgBrandContext.failedUpdateDefaultBrand")),
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
            {brand.name || t("settings.orgBrandContext.untitledBrand")}
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
          title={
            brand.isDefault
              ? t("settings.orgBrandContext.unsetAsDefault")
              : t("settings.orgBrandContext.setAsDefault")
          }
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
          title={t("settings.orgBrandContext.deleteBrand")}
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
            <AlertDialogTitle>
              {t("settings.orgBrandContext.deleteBrandTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t("settings.orgBrandContext.deleteConfirmMessage", {
                    name: brand.name || t("settings.orgBrandContext.thisBrand"),
                  })}
                </p>
                {brand.isDefault && (
                  <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                    <span className="font-medium">
                      {t("settings.orgBrandContext.headsUp")}:
                    </span>{" "}
                    {t("settings.orgBrandContext.deleteDefaultBrandWarning")}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("settings.orgBrandContext.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteBrand();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting
                ? t("settings.orgBrandContext.deleting")
                : t("settings.orgBrandContext.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Main page ---

export function OrgBrandContextPage() {
  const t = useT();
  const { brandExtractEnabled } = usePublicConfig();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const { data: allBrands = [] } = useQuery<BrandContext[]>({
    queryKey: KEYS.brandContext(org.id),
    queryFn: async () => {
      const { items } = await studio.call("BRAND_CONTEXT_LIST", {
        includeArchived: false,
      });
      return items;
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
      await studio.call("BRAND_CONTEXT_CREATE", {
        name: "New Brand",
        domain: "example.com",
        overview: "",
      });
    },
    onSuccess: () => {
      track("brand_created");
      invalidate();
      toast.success(t("settings.orgBrandContext.brandCreated"));
    },
    onError: () => toast.error(t("settings.orgBrandContext.failedCreateBrand")),
  });

  const { mutate: extractBrand, isPending: isExtracting } = useMutation({
    mutationFn: async (domain: string) => {
      track("brand_extract_started", { domain });
      await studio.call("BRAND_CONTEXT_EXTRACT", { domain });
    },
    onSuccess: () => {
      track("brand_extract_succeeded");
      invalidate();
      toast.success(t("settings.orgBrandContext.brandExtractedSuccessfully"));
    },
    onError: (err) => {
      track("brand_extract_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.orgBrandContext.failedExtractBrand"),
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
                <Page.Title>
                  {t("settings.orgBrandContext.brandContext")}
                </Page.Title>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("settings.orgBrandContext.brandContextDescription")}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => createBrand()}
                disabled={isCreating}
              >
                <Plus size={14} />
                {t("settings.orgBrandContext.addBrand")}
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
                  {t("settings.orgBrandContext.noBrandsConfigured")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => createBrand()}
                  disabled={isCreating}
                >
                  <Plus size={14} />
                  {t("settings.orgBrandContext.addYourFirstBrand")}
                </Button>
              </div>
            )}

            <div className="group space-y-3">
              {activeBrands.map((brand) => (
                <ExpandableBrandEntry
                  key={brand.id}
                  brand={brand}
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

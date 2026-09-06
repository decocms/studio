import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { CollectionTableWrapper } from "@/components/collections/collection-table-wrapper.tsx";
import type { TableColumn } from "@/components/collections/collection-table.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@decocms/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { BUILTIN_ROLES } from "@decocms/shared/auth/roles";
import {
  DEFAULT_ON_FLAGS,
  type OrgFlags,
  OrgFlagsSchema,
} from "@decocms/shared/organization/schema";
import type {
  OrgNoticeInput,
  OrgNoticeSeverity,
} from "@decocms/shared/organization/notice";
import { SITE_SLUG_RE } from "@decocms/shared/site-slug";
import { adminFetch } from "@/lib/admin-fetch";
import { formatDate } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface AdminOrgNotice extends OrgNoticeInput {
  id: string;
  source: string;
  updatedAt: string;
}

interface DeploymentAdminOrg {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  /** The org's live billing notice, or null — see `organization_notices`. */
  notice: AdminOrgNotice | null;
}

interface FlagsResponse {
  flags: Record<string, unknown>;
  effective: Record<string, boolean>;
}

/** Flags to render, derived from the schema so a new flag appears here for free. */
const FLAG_FIELDS = Object.entries(OrgFlagsSchema.shape).map(
  ([key, field]) => ({
    key,
    description: (field as { description?: string }).description ?? "",
    defaultOn: DEFAULT_ON_FLAGS.has(key as keyof OrgFlags),
  }),
);

const SCHEMA_KEYS = new Set(FLAG_FIELDS.map((f) => f.key));
/** Mirrors CustomFlagKeySchema on the server; re-validated there on write. */
const FLAG_KEY_RE = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

interface FlagsPayload {
  flags: Record<string, boolean>;
  mode: "replace";
}

/** The bag as booleans, or null if a legacy non-boolean value is still in it. */
function toBooleanBag(bag: Record<string, unknown>) {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== "boolean") return null;
    out[key] = value;
  }
  return out;
}

function FlagsDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // One draft bag is the single source of truth for both views, so switching
  // between them can't lose an edit, a deletion or a newly added key.
  // null = untouched, i.e. whatever the server last returned.
  const [edited, setEdited] = useState<Record<string, unknown> | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: KEYS.deploymentAdminOrgFlags(org.id),
    queryFn: () =>
      adminFetch<FlagsResponse>(`/api/_admin/orgs/${org.id}/flags`),
    enabled: open,
  });

  // A background refetch leaves isLoading false with stale data — a replace saved
  // from that snapshot would delete flags changed since. Gate editing on both.
  const isBusy = isLoading || isFetching;
  const effective = data?.effective ?? {};
  const stored = data?.flags ?? {};
  const draft = edited ?? stored;

  const mutation = useMutation({
    mutationFn: (payload: FlagsPayload) =>
      adminFetch(`/api/_admin/orgs/${org.id}/flags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      toast.success(t("admin.orgs.flagsSaved", { org: org.name }));
      queryClient.invalidateQueries({
        queryKey: KEYS.deploymentAdminOrgFlags(org.id),
      });
      resetLocal();
      setOpen(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedSaveFlags"),
      );
    },
  });

  const resetLocal = () => {
    setEdited(null);
    setShowAdd(false);
    setNewKey("");
    setNewKeyError(null);
    setJsonMode(false);
    setJsonText("");
    setFormError(null);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) resetLocal();
  };

  // Every key the draft knows about, schema flags first.
  const seen = new Set(SCHEMA_KEYS);
  const rows = FLAG_FIELDS.map((f) => ({ ...f, known: true }));
  for (const key of Object.keys(draft)) {
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, description: "", defaultOn: false, known: false });
  }

  const setFlag = (key: string, value: boolean) =>
    setEdited({ ...draft, [key]: value });

  const handleAddCustom = () => {
    const key = newKey.trim();
    if (!FLAG_KEY_RE.test(key)) {
      setNewKeyError(t("admin.orgs.invalidFlagKey"));
      return;
    }
    if (SCHEMA_KEYS.has(key) || key in draft) {
      setNewKeyError(t("admin.orgs.duplicateFlagKey"));
      return;
    }
    setFlag(key, true);
    setNewKey("");
    setNewKeyError(null);
    setShowAdd(false);
  };

  const enterJson = () => {
    if (jsonMode) return;
    setJsonText(JSON.stringify(draft, null, 2));
    setFormError(null);
    setJsonMode(true);
  };

  const enterToggles = () => {
    if (!jsonMode) return;
    const parsed = parseJsonDraft();
    // An invalid draft stays in the JSON view rather than being thrown away.
    if (!parsed) {
      setFormError(t("admin.orgs.invalidJson"));
      return;
    }
    setEdited(parsed);
    setFormError(null);
    setJsonMode(false);
  };

  /** The JSON draft as a flag bag, or null if it isn't a valid one. */
  const parseJsonDraft = (): Record<string, boolean> | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (!FLAG_KEY_RE.test(k) || typeof v !== "boolean") return null;
    }
    return Object.fromEntries(entries) as Record<string, boolean>;
  };

  // Always a replace of the whole bag: the draft carries every key, so a
  // deletion made in the JSON view survives a trip through the toggles.
  const handleSave = () => {
    const flags = jsonMode ? parseJsonDraft() : toBooleanBag(draft);
    if (!flags) {
      setFormError(
        t(
          jsonMode ? "admin.orgs.invalidJson" : "admin.orgs.invalidStoredValue",
        ),
      );
      return;
    }
    setFormError(null);
    if (edited === null) {
      handleOpenChange(false);
      return;
    }
    mutation.mutate({ flags, mode: "replace" });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.orgs.flags")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("admin.orgs.flagsFor", { org: org.name })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("admin.orgs.flagsDescription")}
          </p>
          <div className="flex shrink-0 gap-1">
            <Button
              variant={jsonMode ? "outline" : "secondary"}
              size="sm"
              onClick={enterToggles}
              disabled={isError}
            >
              {t("admin.orgs.flagsViewToggles")}
            </Button>
            <Button
              variant={jsonMode ? "secondary" : "outline"}
              size="sm"
              onClick={enterJson}
              disabled={isBusy || isError}
            >
              {t("admin.orgs.flagsViewJson")}
            </Button>
          </div>
        </div>

        {isError ? (
          <p className="text-sm text-destructive">
            {t("admin.orgs.failedLoadFlags")}
          </p>
        ) : jsonMode ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("admin.orgs.jsonReplaceHint")}
            </p>
            <textarea
              aria-label={t("admin.orgs.jsonEditorLabel")}
              value={jsonText}
              spellCheck={false}
              disabled={mutation.isPending}
              onChange={(e) => {
                setJsonText(e.target.value);
                setFormError(null);
              }}
              className="h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-sm text-foreground"
            />
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {rows.map(({ key, description, defaultOn, known }) => {
              const value = draft[key];
              const checked =
                typeof value === "boolean" ? value : (effective[key] ?? false);
              const isUnset = value === undefined;
              const isInvalid = !isUnset && typeof value !== "boolean";
              return (
                <div key={key} className="flex items-start gap-3">
                  <Switch
                    aria-label={key}
                    checked={checked}
                    disabled={isBusy || mutation.isPending}
                    onCheckedChange={(next) => setFlag(key, next)}
                  />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-sm font-medium text-foreground">
                        {key}
                      </code>
                      {defaultOn ? (
                        <Badge variant="secondary" size="default">
                          {t("admin.orgs.flagDefaultOn")}
                        </Badge>
                      ) : null}
                      {!known ? (
                        <Badge variant="warning" size="default">
                          {t("admin.orgs.flagCustom")}
                        </Badge>
                      ) : null}
                      {isUnset ? (
                        <Badge variant="outline" size="default">
                          {t("admin.orgs.flagUnset")}
                        </Badge>
                      ) : null}
                      {isInvalid ? (
                        <Badge variant="destructive" size="default">
                          {t("admin.orgs.flagInvalid")}
                        </Badge>
                      ) : null}
                    </div>
                    {description ? (
                      <p className="text-sm text-muted-foreground">
                        {description}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {showAdd ? (
              <div className="space-y-1 border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    aria-label={t("admin.orgs.customFlagKeyLabel")}
                    value={newKey}
                    placeholder={t("admin.orgs.customFlagKeyPlaceholder")}
                    onChange={(e) => {
                      setNewKey(e.target.value);
                      setNewKeyError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddCustom();
                    }}
                    className="font-mono"
                  />
                  <Button variant="outline" onClick={handleAddCustom}>
                    {t("admin.orgs.add")}
                  </Button>
                </div>
                {newKeyError ? (
                  <p className="text-sm text-destructive">{newKeyError}</p>
                ) : null}
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setShowAdd(true)}
              >
                {t("admin.orgs.addCustomFlag")}
              </Button>
            )}
          </div>
        )}

        {formError ? (
          <p className="text-sm text-destructive">{formError}</p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t("admin.orgs.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={isBusy || isError || mutation.isPending}
          >
            {mutation.isPending ? t("admin.orgs.saving") : t("admin.orgs.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AdminOrgSite {
  slug: string;
  source: string;
}

/** Thrown from the add mutation on 409, carrying the current owner for the warning. */
class SiteConflictError extends Error {
  constructor(
    readonly slug: string,
    readonly ownerName: string | null,
    readonly ownerSlug: string | null,
  ) {
    super("owned_by_other_org");
    this.name = "SiteConflictError";
  }
}

function SitesDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    slug: string;
    ownerName: string | null;
    ownerSlug: string | null;
  } | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminOrgSites(org.id),
    queryFn: () =>
      adminFetch<{ sites: AdminOrgSite[] }>(`/api/_admin/orgs/${org.id}/sites`),
    enabled: open,
  });
  const sites = data?.sites ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.deploymentAdminOrgSites(org.id),
    });

  const addMutation = useMutation({
    mutationFn: async (vars: { slug: string; reassign?: boolean }) => {
      // Raw fetch (not adminFetch) so the 409 body's owner fields survive.
      const res = await fetch(`/api/_admin/orgs/${org.id}/sites`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        ownerOrganizationName?: string | null;
        ownerOrganizationSlug?: string | null;
      };
      if (res.status === 409 && body.error === "owned_by_other_org") {
        throw new SiteConflictError(
          vars.slug,
          body.ownerOrganizationName ?? null,
          body.ownerOrganizationSlug ?? null,
        );
      }
      if (!res.ok) {
        throw new Error(body.error || `Request failed (HTTP ${res.status})`);
      }
      return body;
    },
    onSuccess: (_result, vars) => {
      toast.success(
        vars.reassign
          ? t("admin.orgs.siteReassigned", { slug: vars.slug, org: org.name })
          : t("admin.orgs.siteAdded", { slug: vars.slug, org: org.name }),
      );
      invalidate();
      setNewSlug("");
      setAddError(null);
      setConflict(null);
    },
    onError: (error) => {
      if (error instanceof SiteConflictError) {
        setConflict({
          slug: error.slug,
          ownerName: error.ownerName,
          ownerSlug: error.ownerSlug,
        });
        return;
      }
      toast.error(
        error instanceof Error ? error.message : t("admin.orgs.failedAddSite"),
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: (slug: string) =>
      adminFetch(
        `/api/_admin/orgs/${org.id}/sites/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_result, slug) => {
      toast.success(t("admin.orgs.siteRemoved", { slug, org: org.name }));
      invalidate();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedRemoveSite"),
      );
    },
  });

  const busy = addMutation.isPending || removeMutation.isPending;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setNewSlug("");
      setAddError(null);
      setConflict(null);
    }
  };

  const handleAdd = () => {
    const slug = newSlug.trim().toLowerCase();
    if (!SITE_SLUG_RE.test(slug)) {
      setAddError(t("admin.orgs.invalidSiteSlug"));
      return;
    }
    setAddError(null);
    setConflict(null);
    addMutation.mutate({ slug });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.orgs.sites")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("admin.orgs.sitesFor", { org: org.name })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("admin.orgs.sitesDescription")}
        </p>

        {isError ? (
          <p className="text-sm text-destructive">
            {t("admin.orgs.failedLoadSites")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
              {isLoading ? (
                <p className="text-sm text-muted-foreground">
                  {t("admin.orgs.loading")}
                </p>
              ) : sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("admin.orgs.noSites")}
                </p>
              ) : (
                sites.map((site) => (
                  <div
                    key={site.slug}
                    className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="truncate text-sm font-medium text-foreground">
                        {site.slug}
                      </code>
                      <Badge variant="outline" size="default">
                        {site.source}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => removeMutation.mutate(site.slug)}
                    >
                      {t("admin.orgs.remove")}
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-1 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Input
                  value={newSlug}
                  placeholder={t("admin.orgs.siteSlugPlaceholder")}
                  disabled={addMutation.isPending}
                  onChange={(e) => {
                    setNewSlug(e.target.value);
                    setAddError(null);
                    setConflict(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                  className="font-mono"
                />
                <Button
                  variant="outline"
                  disabled={!newSlug.trim() || addMutation.isPending}
                  onClick={handleAdd}
                >
                  {t("admin.orgs.add")}
                </Button>
              </div>
              {addError ? (
                <p className="text-sm text-destructive">{addError}</p>
              ) : null}
              {conflict ? (
                <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3">
                  <p className="text-sm text-foreground">
                    {t("admin.orgs.siteReassignWarning", {
                      slug: conflict.slug,
                      owner:
                        conflict.ownerName ||
                        conflict.ownerSlug ||
                        t("admin.orgs.anotherOrg"),
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={addMutation.isPending}
                      onClick={() => setConflict(null)}
                    >
                      {t("admin.orgs.cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={addMutation.isPending}
                      onClick={() =>
                        addMutation.mutate({
                          slug: conflict.slug,
                          reassign: true,
                        })
                      }
                    >
                      {t("admin.orgs.reassignConfirm")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            {t("admin.orgs.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pins (or lifts) the billing notice on one org: a `warn` banner, or a `block`
 * that takes the org's UI and control-plane writes away until it is resolved.
 * The copy is typed here and shown verbatim to that org's members.
 */
function NoticeDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OrgNoticeInput | null>(null);
  const queryClient = useQueryClient();

  const { data: notice } = useQuery({
    queryKey: KEYS.deploymentAdminOrgNotice(org.id),
    queryFn: () =>
      adminFetch<{ notice: AdminOrgNotice | null }>(
        `/api/_admin/orgs/${org.id}/notice`,
      ).then((res) => res.notice),
    enabled: open,
    initialData: org.notice,
  });

  const form: OrgNoticeInput = draft ?? {
    severity: notice?.severity ?? "warn",
    title: notice?.title ?? "",
    message: notice?.message ?? "",
    ctaLabel: notice?.ctaLabel ?? "",
    ctaUrl: notice?.ctaUrl ?? "",
  };

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.deploymentAdminOrgNotice(org.id),
    });
    queryClient.invalidateQueries({ queryKey: KEYS.deploymentAdminOrgsList() });
  };

  const closeAndReset = () => {
    setDraft(null);
    setOpen(false);
  };

  const save = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${org.id}/notice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          severity: form.severity,
          title: form.title.trim(),
          message: form.message.trim(),
          ctaLabel: form.ctaLabel?.trim() || null,
          ctaUrl: form.ctaUrl?.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast.success(t("admin.orgs.noticeSaved", { org: org.name }));
      invalidate();
      closeAndReset();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedSaveNotice"),
      );
    },
  });

  const clear = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${org.id}/notice`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.orgs.noticeCleared", { org: org.name }));
      invalidate();
      closeAndReset();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedClearNotice"),
      );
    },
  });

  const isPending = save.isPending || clear.isPending;
  // A labelled button with no URL (or the reverse) is rejected server-side.
  const ctaIncomplete = !form.ctaLabel?.trim() !== !form.ctaUrl?.trim();
  const canSave =
    !!form.title.trim() && !!form.message.trim() && !ctaIncomplete;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : closeAndReset())}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.orgs.notice")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("admin.orgs.noticeFor", { org: org.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("admin.orgs.noticeDescription")}
          </p>
          <div className="space-y-2">
            <Label htmlFor={`notice-severity-${org.id}`}>
              {t("admin.orgs.noticeSeverity")}
            </Label>
            <Select
              value={form.severity}
              onValueChange={(value) =>
                setDraft({ ...form, severity: value as OrgNoticeSeverity })
              }
              disabled={isPending}
            >
              <SelectTrigger
                id={`notice-severity-${org.id}`}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warn">
                  {t("admin.orgs.noticeSeverityWarn")}
                </SelectItem>
                <SelectItem value="block">
                  {t("admin.orgs.noticeSeverityBlock")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`notice-title-${org.id}`}>
              {t("admin.orgs.noticeTitle")}
            </Label>
            <Input
              id={`notice-title-${org.id}`}
              value={form.title}
              onChange={(e) => setDraft({ ...form, title: e.target.value })}
              placeholder={t("admin.orgs.noticeTitlePlaceholder")}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`notice-message-${org.id}`}>
              {t("admin.orgs.noticeMessage")}
            </Label>
            <Textarea
              id={`notice-message-${org.id}`}
              value={form.message}
              onChange={(e) => setDraft({ ...form, message: e.target.value })}
              placeholder={t("admin.orgs.noticeMessagePlaceholder")}
              rows={4}
              disabled={isPending}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`notice-cta-label-${org.id}`}>
                {t("admin.orgs.noticeCtaLabel")}
              </Label>
              <Input
                id={`notice-cta-label-${org.id}`}
                value={form.ctaLabel ?? ""}
                onChange={(e) =>
                  setDraft({ ...form, ctaLabel: e.target.value })
                }
                placeholder={t("admin.orgs.noticeCtaLabelPlaceholder")}
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`notice-cta-url-${org.id}`}>
                {t("admin.orgs.noticeCtaUrl")}
              </Label>
              <Input
                id={`notice-cta-url-${org.id}`}
                value={form.ctaUrl ?? ""}
                onChange={(e) => setDraft({ ...form, ctaUrl: e.target.value })}
                placeholder="https://..."
                disabled={isPending}
              />
            </div>
          </div>
          {ctaIncomplete ? (
            <p className="text-sm text-destructive">
              {t("admin.orgs.noticeCtaIncomplete")}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {notice ? (
            <Button
              variant="outline"
              onClick={() => clear.mutate()}
              disabled={isPending}
            >
              {t("admin.orgs.noticeClear")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={closeAndReset}
            disabled={isPending}
          >
            {t("admin.orgs.cancel")}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canSave || isPending}
          >
            {save.isPending
              ? t("admin.orgs.noticeSaving")
              : t("admin.orgs.noticeSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMemberDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("user");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      adminFetch(`/api/_admin/orgs/${org.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      }),
    onSuccess: () => {
      toast.success(
        t("admin.orgs.memberAdded", { email: email.trim(), org: org.name }),
      );
      queryClient.invalidateQueries({
        queryKey: KEYS.deploymentAdminOrgsList(),
      });
      setOpen(false);
      setEmail("");
      setRole("user");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.orgs.failedAddMember"),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("admin.orgs.addMember")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("admin.orgs.addMemberTo", { org: org.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="admin-add-member-email">
              {t("admin.orgs.email")}
            </Label>
            <Input
              id="admin-add-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("admin.orgs.emailPlaceholder")}
              disabled={mutation.isPending}
            />
          </div>
          <Select
            value={role}
            onValueChange={setRole}
            disabled={mutation.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUILTIN_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  <span className="capitalize">{r}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={mutation.isPending}
          >
            {t("admin.orgs.cancel")}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!email.trim() || mutation.isPending}
          >
            {mutation.isPending
              ? t("admin.orgs.adding")
              : t("admin.orgs.addMember")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminOrgsPage() {
  const t = useT();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const { data, isLoading, isError } = useQuery({
    queryKey: KEYS.deploymentAdminOrgs(debouncedSearch),
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return adminFetch<{ organizations: DeploymentAdminOrg[] }>(
        `/api/_admin/orgs?${params}`,
      );
    },
  });

  const orgs = data?.organizations ?? [];

  const columns: TableColumn<DeploymentAdminOrg>[] = [
    {
      id: "name",
      header: t("admin.orgs.organization"),
      render: (org) => (
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {org.name}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {org.slug}
          </div>
        </div>
      ),
      cellClassName: "flex-1 min-w-0",
    },
    {
      id: "notice",
      header: t("admin.orgs.notice"),
      render: (org) =>
        org.notice ? (
          <Badge
            variant={
              org.notice.severity === "block" ? "destructive" : "outline"
            }
          >
            {org.notice.severity === "block"
              ? t("admin.orgs.noticeSeverityBlock")
              : t("admin.orgs.noticeSeverityWarn")}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
      cellClassName: "w-28 shrink-0",
    },
    {
      id: "members",
      header: t("admin.orgs.members"),
      render: (org) => (
        <span className="text-sm text-foreground">{org.memberCount}</span>
      ),
      cellClassName: "w-24 shrink-0",
    },
    {
      id: "created",
      header: t("admin.orgs.created"),
      render: (org) => (
        <span className="text-sm text-foreground">
          {formatDate(org.createdAt)}
        </span>
      ),
      cellClassName: "w-48 shrink-0",
    },
    {
      id: "actions",
      header: "",
      render: (org) => (
        <div className="flex items-center justify-end gap-2">
          <FlagsDialog org={org} />
          <SitesDialog org={org} />
          <NoticeDialog org={org} />
          <AddMemberDialog org={org} />
        </div>
      ),
      cellClassName: "w-auto shrink-0",
    },
  ];

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("admin.orgs.searchPlaceholder")}
              className="w-full md:w-[375px]"
            />
            <CollectionTableWrapper
              columns={columns}
              data={orgs}
              isLoading={isLoading}
              emptyState={
                isError ? (
                  <EmptyState
                    title={t("admin.orgs.failedLoadOrgs")}
                    description={t("admin.orgs.failedLoadOrgsDescription")}
                  />
                ) : (
                  <EmptyState
                    title={t("admin.orgs.noOrgsFound")}
                    description={
                      debouncedSearch
                        ? t("admin.orgs.noOrgsMatchSearch", {
                            search: debouncedSearch,
                          })
                        : t("admin.orgs.noOrgsYet")
                    }
                  />
                )
              }
            />
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

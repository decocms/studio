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
import { Badge } from "@decocms/ui/components/badge.tsx";
import { BUILTIN_ROLES } from "@decocms/shared/auth/roles";
import {
  DEFAULT_ON_FLAGS,
  type OrgFlags,
  OrgFlagsSchema,
} from "@decocms/shared/organization/schema";
import { adminFetch } from "@/lib/admin-fetch";
import { formatDate } from "@/lib/format-time";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface DeploymentAdminOrg {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
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
          <AddMemberDialog org={org} />
        </div>
      ),
      cellClassName: "w-48 shrink-0",
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

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
  flags: Record<string, boolean | undefined>;
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
  mode?: "replace";
}

function FlagsDialog({ org }: { org: DeploymentAdminOrg }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [customKeys, setCustomKeys] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
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
    setOverrides({});
    setCustomKeys([]);
    setShowAdd(false);
    setNewKey("");
    setNewKeyError(null);
    setJsonMode(false);
    setJsonText("");
    setJsonError(null);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) resetLocal();
  };

  // Union of schema flags and any custom keys (already stored or added this session).
  const storedCustom = Object.keys(stored).filter((k) => !SCHEMA_KEYS.has(k));
  const seen = new Set(SCHEMA_KEYS);
  const rows = FLAG_FIELDS.map((f) => ({ ...f, known: true }));
  for (const key of [...storedCustom, ...customKeys]) {
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, description: "", defaultOn: false, known: false });
  }

  const handleAddCustom = () => {
    const key = newKey.trim();
    if (!FLAG_KEY_RE.test(key)) {
      setNewKeyError(t("admin.orgs.invalidFlagKey"));
      return;
    }
    if (SCHEMA_KEYS.has(key) || key in stored || customKeys.includes(key)) {
      setNewKeyError(t("admin.orgs.duplicateFlagKey"));
      return;
    }
    setCustomKeys((prev) => [...prev, key]);
    setOverrides((prev) => ({ ...prev, [key]: true }));
    setNewKey("");
    setNewKeyError(null);
    setShowAdd(false);
  };

  const enterJson = () => {
    // Keep an existing draft so Toggles → JSON round-trips without losing edits.
    if (jsonText) {
      setJsonMode(true);
      return;
    }
    const merged: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === "boolean") merged[k] = v;
    }
    for (const [k, v] of Object.entries(overrides)) merged[k] = v;
    setJsonText(JSON.stringify(merged, null, 2));
    setJsonError(null);
    setJsonMode(true);
  };

  const handleSaveToggles = () => {
    const changed: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== effective[key]) changed[key] = value;
    }
    if (Object.keys(changed).length === 0) {
      handleOpenChange(false);
      return;
    }
    mutation.mutate({ flags: changed });
  };

  const handleSaveJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setJsonError(t("admin.orgs.invalidJson"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setJsonError(t("admin.orgs.invalidJson"));
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (!FLAG_KEY_RE.test(k) || typeof v !== "boolean") {
        setJsonError(t("admin.orgs.invalidJson"));
        return;
      }
    }
    setJsonError(null);
    mutation.mutate({
      flags: Object.fromEntries(entries) as Record<string, boolean>,
      mode: "replace",
    });
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
              onClick={() => setJsonMode(false)}
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
              onChange={(e) => setJsonText(e.target.value)}
              className="h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-sm text-foreground"
            />
            {jsonError ? (
              <p className="text-sm text-destructive">{jsonError}</p>
            ) : null}
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {rows.map(({ key, description, defaultOn, known }) => {
              const checked = overrides[key] ?? effective[key] ?? false;
              const isUnset = stored[key] === undefined;
              return (
                <div key={key} className="flex items-start gap-3">
                  <Switch
                    aria-label={key}
                    checked={checked}
                    disabled={isBusy || mutation.isPending}
                    onCheckedChange={(next) =>
                      setOverrides((prev) => ({ ...prev, [key]: next }))
                    }
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

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t("admin.orgs.cancel")}
          </Button>
          <Button
            onClick={jsonMode ? handleSaveJson : handleSaveToggles}
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

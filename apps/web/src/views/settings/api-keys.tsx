import { useState } from "react";
import { AlertCircle, Copy01, Key01, Plus, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@decocms/ui/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolsListQuery,
  useProjectContext,
} from "@/sdk";
import {
  API_KEY_EXPIRY_OPTIONS,
  type ApiKeyAccessMode,
  type ApiKeyExpiry,
  countTools,
  expiresInSeconds,
  keyPermissions,
  readOnlyToolNames,
  STUDIO_RESOURCE,
  summarizeKeyAccess,
} from "./api-key-access";
import { ApiKeyToolPicker } from "./api-key-tool-picker";
import {
  type ApiKey,
  type CreatedApiKey,
  useApiKeysList,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/hooks/use-api-keys";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import { Card } from "@decocms/ui/components/card.tsx";

function ErrorFallback({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        {t("settings.apiKeys.failedToLoadError", { error: error.message })}
      </span>
    </div>
  );
}

function ApiKeyRow({
  apiKey,
  onDelete,
}: {
  apiKey: ApiKey;
  onDelete: () => void;
}) {
  const t = useT();
  const access = summarizeKeyAccess(apiKey.permissions);
  const expiresAt = apiKey.expiresAt ? new Date(apiKey.expiresAt) : null;
  const [now] = useState(() => Date.now());
  const expired = expiresAt !== null && expiresAt.getTime() <= now;
  const expiresOn = expiresAt?.toLocaleDateString() ?? "";
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Key01 size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-sm truncate">{apiKey.name}</span>
            {access.kind === "full" ? (
              <Badge variant="warning" size="sm">
                {t("settings.apiKeys.accessFull")}
              </Badge>
            ) : (
              <Badge variant="muted" size="sm">
                {t("settings.apiKeys.toolCount", { count: access.count })}
              </Badge>
            )}
            {expired && (
              <Badge variant="destructive" size="sm">
                {t("settings.apiKeys.expired")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.apiKeys.createdAt", {
              date: new Date(apiKey.createdAt).toLocaleDateString(),
            })}
            {" · "}
            {!apiKey.expiresAt
              ? t("settings.apiKeys.neverExpires")
              : expired
                ? t("settings.apiKeys.expiredOn", { date: expiresOn })
                : t("settings.apiKeys.expiresOn", { date: expiresOn })}
          </p>
        </div>
      </div>
      <Button
        variant="ghost-destructive"
        size="icon"
        className="shrink-0"
        onClick={onDelete}
        aria-label={t("settings.apiKeys.deleteKey")}
      >
        <Trash01 size={14} />
      </Button>
    </li>
  );
}

function NoApiKeys({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <SettingsCard>
      <EmptyState
        size="inline"
        icon={<Key01 />}
        title={t("settings.apiKeys.emptyTitle")}
        description={t("settings.apiKeys.emptyDescription")}
      >
        <Button onClick={onCreate} size="sm">
          <Plus size={14} />
          {t("settings.apiKeys.newKey")}
        </Button>
      </EmptyState>
    </SettingsCard>
  );
}

function CreatedKeyDialog({
  createdKey,
  onClose,
}: {
  createdKey: CreatedApiKey | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={createdKey !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.apiKeys.createdTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.apiKeys.createdDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={createdKey?.key ?? ""}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              if (!createdKey) return;
              navigator.clipboard?.writeText(createdKey.key);
              toast.success(t("settings.apiKeys.copied"));
            }}
            aria-label={t("settings.apiKeys.copyKey")}
          >
            <Copy01 size={14} />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("settings.apiKeys.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateApiKeyForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const toolsQuery = useMCPToolsListQuery({ client });
  const tools = [...(toolsQuery.data?.tools ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const readOnlyTools = readOnlyToolNames(tools);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiKeyAccessMode>("read-only");
  const [customTools, setCustomTools] = useState<Record<
    string,
    string[]
  > | null>(null);
  const [expiry, setExpiry] = useState<ApiKeyExpiry>("90");
  const createApiKey = useCreateApiKey();

  // Custom starts from the read-only set, so narrowing it is one click away.
  const selectedTools = customTools ?? { [STUDIO_RESOURCE]: readOnlyTools };
  const needsTools = access !== "full";
  const toolsReady = !needsTools || toolsQuery.isSuccess;
  const hasTools =
    access === "full" ||
    (access === "read-only"
      ? readOnlyTools.length
      : countTools(selectedTools)) > 0;
  const canSubmit =
    !!name.trim() && toolsReady && hasTools && !createApiKey.isPending;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      const created = await createApiKey.mutateAsync({
        name: name.trim(),
        permissions: keyPermissions(access, readOnlyTools, selectedTools),
        expiresIn: expiresInSeconds(expiry),
      });
      onClose();
      onCreated(created);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.apiKeys.failedToCreateKey"),
      );
    }
  }

  const accessOptions: Array<{
    value: ApiKeyAccessMode;
    label: string;
    description: string;
  }> = [
    {
      value: "read-only",
      label: t("settings.apiKeys.accessReadOnly"),
      description: t("settings.apiKeys.accessReadOnlyDescription", {
        count: readOnlyTools.length,
      }),
    },
    {
      value: "custom",
      label: t("settings.apiKeys.accessCustom"),
      description: t("settings.apiKeys.accessCustomDescription"),
    },
    {
      value: "full",
      label: t("settings.apiKeys.accessFull"),
      description: t("settings.apiKeys.accessFullDescription"),
    },
  ];

  const expiryLabels: Record<ApiKeyExpiry, string> = {
    "7": t("settings.apiKeys.expiryDays", { days: 7 }),
    "30": t("settings.apiKeys.expiryDays", { days: 30 }),
    "90": t("settings.apiKeys.expiryDays", { days: 90 }),
    "365": t("settings.apiKeys.expiryYear"),
    never: t("settings.apiKeys.expiryNever"),
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="api-key-name">{t("settings.apiKeys.nameLabel")}</Label>
        <Input
          id="api-key-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.apiKeys.namePlaceholder")}
          autoComplete="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t("settings.apiKeys.accessLabel")}</Label>
        <RadioGroup
          value={access}
          onValueChange={(value) => {
            const next = accessOptions.find((o) => o.value === value);
            if (next) setAccess(next.value);
          }}
          className="gap-2"
        >
          {accessOptions.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 hover:bg-accent has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <div className="min-w-0">
                <span className="block text-sm font-medium">
                  {option.label}
                </span>
                <span
                  className={cn(
                    "block text-xs",
                    option.value === "full"
                      ? "text-warning"
                      : "text-muted-foreground",
                  )}
                >
                  {option.description}
                </span>
              </div>
            </label>
          ))}
        </RadioGroup>
      </div>

      {needsTools && toolsQuery.isError && (
        <p className="text-xs text-destructive">
          {t("settings.apiKeys.toolsLoadFailed")}
        </p>
      )}
      {access === "custom" && toolsQuery.isSuccess && (
        <ApiKeyToolPicker
          studioTools={tools}
          toolSet={selectedTools}
          onChange={setCustomTools}
        />
      )}

      <div className="space-y-1.5">
        <Label htmlFor="api-key-expiry">
          {t("settings.apiKeys.expiryLabel")}
        </Label>
        <Select
          value={expiry}
          onValueChange={(value) => {
            const next = API_KEY_EXPIRY_OPTIONS.find((o) => o === value);
            if (next) setExpiry(next);
          }}
        >
          <SelectTrigger id="api-key-expiry" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {API_KEY_EXPIRY_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {expiryLabels[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={createApiKey.isPending}
        >
          {t("settings.apiKeys.cancelButton")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {createApiKey.isPending
            ? t("settings.apiKeys.creatingButton")
            : t("settings.apiKeys.createButton")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settings.apiKeys.newKeyTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.apiKeys.newKeyDescription")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every open starts from a clean form. */}
        <CreateApiKeyForm
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * API keys — the whole feature as one section, so it can sit under the clients
 * it authenticates on the Connect page and still be all of `/settings/api-keys`.
 */
export function ApiKeysSection() {
  const t = useT();
  const { data, isLoading, error } = useApiKeysList();
  const deleteApiKey = useDeleteApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiKey | null>(null);
  const apiKeys = data ?? [];

  async function handleDelete() {
    if (!pendingDelete) return;
    try {
      await deleteApiKey.mutateAsync(pendingDelete.id);
      toast.success(
        t("settings.apiKeys.keyDeleted", { name: pendingDelete.name }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.apiKeys.failedToDeleteKey"),
      );
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <SettingsSection
      title={t("settings.apiKeys.sectionTitle")}
      description={t("settings.apiKeys.sectionDescription")}
      actions={
        apiKeys.length > 0 ? (
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus size={14} />
            {t("settings.apiKeys.newKey")}
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <Card className="gap-0 overflow-hidden p-0">
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {t("settings.apiKeys.loading")}
          </p>
        </Card>
      ) : /* A failed REFETCH keeps `data`, so only surface the error when it
             left us with nothing to show — otherwise a background 401 on
             window focus replaces a loaded list (and its create path) with an
             error card. */
      error && apiKeys.length === 0 ? (
        <ErrorFallback error={error} />
      ) : apiKeys.length === 0 ? (
        <NoApiKeys onCreate={() => setCreateOpen(true)} />
      ) : (
        <Card className="gap-0 overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {apiKeys.map((key) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                onDelete={() => setPendingDelete(key)}
              />
            ))}
          </ul>
        </Card>
      )}

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setCreatedKey}
      />
      <CreatedKeyDialog
        createdKey={createdKey}
        onClose={() => setCreatedKey(null)}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.apiKeys.deleteTitle", {
                name: pendingDelete?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.apiKeys.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.apiKeys.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("settings.apiKeys.deleteKey")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

export function OrgApiKeysPage() {
  return (
    <SettingsGroupPage
      group="connect"
      errorFallback={({ error }) => (
        <ErrorFallback error={error ?? new Error("Failed to load API keys")} />
      )}
    >
      <ApiKeysSection />
    </SettingsGroupPage>
  );
}

import { useState } from "react";
import { AlertCircle, Copy01, Key01, Plus, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { useT } from "@/i18n/use-t.ts";
import {
  type ApiKey,
  type CreatedApiKey,
  useApiKeysList,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/hooks/use-api-keys";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import { SettingsSection } from "@/components/settings/settings-section";
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
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Key01 size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <span className="font-medium text-sm truncate block">
            {apiKey.name}
          </span>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settings.apiKeys.createdAt", {
              date: new Date(apiKey.createdAt).toLocaleDateString(),
            })}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive shrink-0"
        onClick={onDelete}
        aria-label={t("settings.apiKeys.deleteKey")}
      >
        <Trash01 size={14} />
      </Button>
    </li>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Key01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">
          {t("settings.apiKeys.emptyTitle")}
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t("settings.apiKeys.emptyDescription")}
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="mt-2">
        <Plus size={14} />
        {t("settings.apiKeys.newKey")}
      </Button>
    </div>
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
  const [name, setName] = useState("");
  const createApiKey = useCreateApiKey();

  function handleClose() {
    setName("");
    onOpenChange(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const created = await createApiKey.mutateAsync({ name: name.trim() });
      handleClose();
      onCreated(created);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.apiKeys.failedToCreateKey"),
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
        else onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.apiKeys.newKeyTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.apiKeys.newKeyDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="api-key-name">
              {t("settings.apiKeys.nameLabel")}
            </Label>
            <Input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.apiKeys.namePlaceholder")}
              autoComplete="off"
              required
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={createApiKey.isPending}
            >
              {t("settings.apiKeys.cancelButton")}
            </Button>
            <Button
              type="submit"
              disabled={createApiKey.isPending || !name.trim()}
            >
              {createApiKey.isPending
                ? t("settings.apiKeys.creatingButton")
                : t("settings.apiKeys.createButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * API keys — the whole feature as one section, so it can sit under the clients
 * it authenticates on the Connect page and still be all of `/settings/api-keys`.
 *
 * `headerClassName="px-0"` matches the Connect page's full-bleed cards: the
 * heading aligns with the page, the card is the section's only surface.
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
      headerClassName="px-0"
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
        <EmptyState onCreate={() => setCreateOpen(true)} />
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

import { Suspense, useState } from "react";
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
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { Page } from "@/components/page";
import { SettingsPage } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import {
  type ApiKey,
  type CreatedApiKey,
  useApiKeysList,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/hooks/use-api-keys";

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
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
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
    </div>
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

function ApiKeysContent() {
  const t = useT();
  const { data: apiKeys = [] } = useApiKeysList();
  const deleteApiKey = useDeleteApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiKey | null>(null);

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

  if (apiKeys.length === 0) {
    return (
      <>
        <EmptyState onCreate={() => setCreateOpen(true)} />
        <CreateApiKeyDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={setCreatedKey}
        />
        <CreatedKeyDialog
          createdKey={createdKey}
          onClose={() => setCreatedKey(null)}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t(
            apiKeys.length === 1
              ? "settings.apiKeys.keysCountSingular"
              : "settings.apiKeys.keysCountPlural",
            { count: apiKeys.length },
          )}
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus size={14} />
          {t("settings.apiKeys.newKey")}
        </Button>
      </div>

      <section className="rounded-2xl border border-border/60 bg-background p-5">
        <div>
          {apiKeys.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              onDelete={() => setPendingDelete(key)}
            />
          ))}
        </div>
      </section>

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
    </>
  );
}

export function OrgApiKeysPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.nav.apiKeys")}</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load API keys")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <ApiKeysContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

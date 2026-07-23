import { Suspense, useState } from "react";
import { AlertCircle, Lock01, Plus, User01, Users01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { useT } from "@/web/i18n/use-t.ts";
import {
  type SecretInfo,
  type SecretScopeKind,
  useCreateSecret,
  useSecrets,
} from "@/web/hooks/use-secrets";

function ErrorFallback({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        {t("settings.secrets.failedToLoadError", { error: error.message })}
      </span>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: SecretScopeKind }) {
  const t = useT();
  const Icon = scope === "user" ? User01 : Users01;
  const label =
    scope === "user"
      ? t("settings.secrets.scopePrivate")
      : t("settings.secrets.scopeOrganization");
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-muted-foreground text-xs">
      <Icon size={12} />
      {label}
    </span>
  );
}

function SecretRow({ secret }: { secret: SecretInfo }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Lock01 size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{secret.name}</span>
            <ScopeBadge scope={secret.scope} />
          </div>
          {secret.description ? (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {secret.description}
            </p>
          ) : null}
        </div>
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {new Date(secret.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Lock01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">
          {t("settings.secrets.emptyTitle")}
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t("settings.secrets.emptyDescription")}
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="mt-2">
        <Plus size={14} />
        {t("settings.secrets.newSecret")}
      </Button>
    </div>
  );
}

interface CreateSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateSecretDialog({ open, onOpenChange }: CreateSecretDialogProps) {
  const t = useT();
  const [scope, setScope] = useState<SecretScopeKind>("organization");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const createSecret = useCreateSecret();

  function reset() {
    setScope("organization");
    setName("");
    setValue("");
    setDescription("");
  }

  // Single close path so Cancel and Radix's outside-click/Escape both clear
  // the form. Calling onOpenChange(false) directly skips the wrapper below,
  // because Radix only fires its onOpenChange when *it* initiates the close.
  function handleClose() {
    reset();
    onOpenChange(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !value) return;
    try {
      await createSecret.mutateAsync({
        scope,
        name: name.trim(),
        value,
        description: description.trim() || undefined,
      });
      toast.success(t("settings.secrets.secretCreated", { name: name.trim() }));
      handleClose();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.secrets.failedToCreateSecret"),
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
          <DialogTitle>{t("settings.secrets.newSecretTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.secrets.newSecretDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="secret-scope">
              {t("settings.secrets.scopeLabel")}
            </Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="secret-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">
                  {t("settings.secrets.scopeOrganizationDescription")}
                </SelectItem>
                <SelectItem value="user">
                  {t("settings.secrets.scopePrivateDescription")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-name">
              {t("settings.secrets.nameLabel")}
            </Label>
            <Input
              id="secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.secrets.namePlaceholder")}
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.secrets.nameHelp")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-value">
              {t("settings.secrets.valueLabel")}
            </Label>
            <Input
              id="secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-description">
              {t("settings.secrets.descriptionLabel")}
            </Label>
            <Textarea
              id="secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("settings.secrets.descriptionPlaceholder")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={createSecret.isPending}
            >
              {t("settings.secrets.cancelButton")}
            </Button>
            <Button
              type="submit"
              disabled={createSecret.isPending || !name.trim() || !value}
            >
              {createSecret.isPending
                ? t("settings.secrets.creatingButton")
                : t("settings.secrets.createButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretsContent() {
  const t = useT();
  const secrets = useSecrets();
  const [createOpen, setCreateOpen] = useState(false);

  if (secrets.length === 0) {
    return (
      <>
        <EmptyState onCreate={() => setCreateOpen(true)} />
        <CreateSecretDialog open={createOpen} onOpenChange={setCreateOpen} />
      </>
    );
  }

  const orgSecrets = secrets.filter((s) => s.scope === "organization");
  const userSecrets = secrets.filter((s) => s.scope === "user");

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t("settings.secrets.secretsCount", {
            count: secrets.length,
            plural: secrets.length === 1 ? "" : "s",
          })}
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus size={14} />
          {t("settings.secrets.newSecret")}
        </Button>
      </div>

      {orgSecrets.length > 0 ? (
        <section className="rounded-2xl border border-border/60 bg-background p-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            {t("settings.secrets.sectionOrganization")}
          </h3>
          <div>
            {orgSecrets.map((s) => (
              <SecretRow key={s.id} secret={s} />
            ))}
          </div>
        </section>
      ) : null}

      {userSecrets.length > 0 ? (
        <section className="rounded-2xl border border-border/60 bg-background p-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            {t("settings.secrets.sectionPrivate")}
          </h3>
          <div>
            {userSecrets.map((s) => (
              <SecretRow key={s.id} secret={s} />
            ))}
          </div>
        </section>
      ) : null}

      <CreateSecretDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

export function OrgSecretsPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.nav.secrets")}</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load secrets")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <SecretsContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

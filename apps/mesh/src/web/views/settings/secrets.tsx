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
import {
  type SecretInfo,
  type SecretScopeKind,
  useCreateSecret,
  useSecrets,
} from "@/web/hooks/use-secrets";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load secrets: {error.message}
      </span>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: SecretScopeKind }) {
  const Icon = scope === "user" ? User01 : Users01;
  const label = scope === "user" ? "Private" : "Organization";
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
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Lock01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">No secrets yet</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Store API keys, tokens, and other sensitive values. Values are
          encrypted at rest and never returned over the API.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="mt-2">
        <Plus size={14} />
        New secret
      </Button>
    </div>
  );
}

interface CreateSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateSecretDialog({ open, onOpenChange }: CreateSecretDialogProps) {
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
      toast.success(`Secret "${name.trim()}" created`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create secret",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            Stored encrypted in the credential vault. Choose who can read it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="secret-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="secret-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">
                  Organization — visible to all members
                </SelectItem>
                <SelectItem value="user">
                  Private — only visible to me
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="STRIPE_API_KEY"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits, underscore, dot, hyphen. Case-insensitive within
              its scope.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-value">Value</Label>
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
            <Label htmlFor="secret-description">Description (optional)</Label>
            <Textarea
              id="secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this secret used for?"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createSecret.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createSecret.isPending || !name.trim() || !value}
            >
              {createSecret.isPending ? "Creating…" : "Create secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretsContent() {
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
          {secrets.length} secret{secrets.length === 1 ? "" : "s"} stored
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus size={14} />
          New secret
        </Button>
      </div>

      {orgSecrets.length > 0 ? (
        <section className="rounded-2xl border border-border/60 bg-background p-5">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Organization
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
            Private to me
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
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Secrets</Page.Title>
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

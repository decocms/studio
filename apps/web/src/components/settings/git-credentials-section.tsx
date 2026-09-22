import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Plus, Trash01 } from "@untitledui/icons";
import {
  SUBMODULE_HOST_RE,
  type SubmoduleCredential,
} from "@decocms/shared/organization/schema";
import { useT } from "@/i18n/use-t.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  SECRET_NAME_RE,
  ScopeIcon,
  SecretPickerValue,
} from "@/components/sandbox/runtime-card/secret-picker";
import {
  type SecretInfo,
  type SecretScopeKind,
  useCreateSecret,
  useSecrets,
} from "@/hooks/use-secrets";
import {
  useGitCredentials,
  useSetGitCredentials,
} from "@/hooks/use-organization-settings";

/**
 * Settings → Repositories → Git credentials.
 *
 * Each row maps a host (e.g. "github.com") to a vault secret holding a PAT.
 * Studio resolves it on every SANDBOX_START and hands the token to the daemon
 * on a git-only channel, which installs it in the sandbox's git config — so
 * `git submodule update` and the git a package manager spawns (`flutter pub
 * get`, `go mod download`, npm, cargo) both authenticate against hosts the
 * repo's own clone token cannot reach.
 *
 * Org-level: the same host PAT applies to every repo and every agent, and a
 * task-board run's sandbox belongs to Decopilot, which has no agent settings
 * to read one from.
 *
 * The secret list is read via Suspense; the wrapper renders a skeleton while
 * it loads so the rest of the page stays interactive.
 */
export function GitCredentialsSection() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.gitCredentials.title")}
      description={t("settings.gitCredentials.description")}
    >
      <ErrorBoundary
        fallback={({ error }) => (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error?.message ?? t("settings.gitCredentials.failedToLoadSecrets")}
          </div>
        )}
      >
        <Suspense fallback={<Skeleton className="h-9 w-full" />}>
          <GitCredentialsEditor />
        </Suspense>
      </ErrorBoundary>
    </SettingsSection>
  );
}

function isComplete(row: SubmoduleCredential): boolean {
  return SUBMODULE_HOST_RE.test(row.host) && row.secretId.length > 0;
}

function GitCredentialsEditor() {
  const t = useT();
  const saved = useGitCredentials();
  const setCredentials = useSetGitCredentials();

  /** Edits in progress. Null until the first one, so the query drives the list. */
  const [draft, setDraft] = useState<SubmoduleCredential[] | null>(null);
  const rows = draft ?? saved;

  // Org-scoped only: a `user`-scoped secret resolves for its creator alone.
  const secrets = useSecrets().filter((s) => s.scope === "organization");
  const secretById = new Map<string, SecretInfo>();
  for (const s of secrets) secretById.set(s.id, s);

  // Index of the row whose "create new secret" dialog is open, or null.
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);

  async function commit(next: SubmoduleCredential[]) {
    const trimmed = next.map((r) => ({ ...r, host: r.host.trim() }));
    setDraft(trimmed);
    // A half-filled row is not a deletion — hold the write until it's whole.
    if (!trimmed.every(isComplete)) return;
    try {
      await setCredentials.mutateAsync(trimmed);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.gitCredentials.failedToSave"),
      );
    }
  }

  const replaceAt = (index: number, row: SubmoduleCredential) =>
    rows.map((r, i) => (i === index ? row : r));

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li
            // Positional: a credential row carries no id of its own.
            key={index}
            className="rounded-md border border-border bg-background"
          >
            <GitCredentialRow
              index={index}
              row={row}
              secrets={secrets}
              secretById={secretById}
              onEdit={(next) => setDraft(replaceAt(index, next))}
              onCommit={() => void commit(rows)}
              onPickSecret={(secretId) =>
                void commit(replaceAt(index, { ...row, secretId }))
              }
              onCreateNewSecret={() => setDialogIndex(index)}
              onRemove={() => void commit(rows.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>

      {rows.length > 0 ? (
        <p className="text-xs text-warning">
          {t("settings.gitCredentials.tokenExposureWarning")}
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDraft([...rows, { host: "", secretId: "" }])}
        className="w-full"
      >
        <Plus className="size-3.5" />
        {t("settings.gitCredentials.addCredential")}
      </Button>

      {dialogIndex !== null ? (
        <CreateSecretDialog
          onClose={() => setDialogIndex(null)}
          onSaved={(secretId) => {
            const row = rows[dialogIndex];
            if (row) void commit(replaceAt(dialogIndex, { ...row, secretId }));
            setDialogIndex(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface GitCredentialRowProps {
  index: number;
  row: SubmoduleCredential;
  secrets: SecretInfo[];
  secretById: Map<string, SecretInfo>;
  onEdit: (next: SubmoduleCredential) => void;
  onCommit: () => void;
  onPickSecret: (secretId: string) => void;
  onCreateNewSecret: () => void;
  onRemove: () => void;
}

function GitCredentialRow({
  index,
  row,
  secrets,
  secretById,
  onEdit,
  onCommit,
  onPickSecret,
  onCreateNewSecret,
  onRemove,
}: GitCredentialRowProps) {
  const t = useT();
  const trimmed = row.host.trim();
  const invalid = trimmed.length > 0 && !SUBMODULE_HOST_RE.test(trimmed);

  return (
    <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <div className="space-y-1">
          <Input
            value={row.host}
            onChange={(e) => onEdit({ ...row, host: e.target.value })}
            onBlur={onCommit}
            placeholder={t("settings.gitCredentials.hostPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "font-mono",
              invalid && "border-destructive focus-visible:ring-destructive",
            )}
            aria-invalid={invalid}
            aria-label={t("settings.gitCredentials.hostAriaLabel", {
              index: index + 1,
            })}
          />
          {invalid ? (
            <p className="text-[11px] text-destructive">
              {t("settings.gitCredentials.hostInvalidMessage")}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-[2] min-w-0 items-center gap-1">
        <Select value={row.secretId || ""} onValueChange={onPickSecret}>
          <SelectTrigger
            className={cn(
              "h-9 w-full",
              !row.secretId && "text-muted-foreground",
            )}
          >
            <SelectValue
              placeholder={t("settings.gitCredentials.pickSecretPlaceholder")}
            >
              <SecretPickerValue
                field={{ value: row.secretId }}
                secretById={secretById}
              />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {secrets.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("settings.gitCredentials.noSecretsYet")}
              </div>
            ) : (
              secrets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  <span className="inline-flex items-center gap-2">
                    <ScopeIcon scope={s.scope} />
                    <span className="font-mono">{s.name}</span>
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("settings.gitCredentials.createNewSecretAriaLabel")}
              onClick={onCreateNewSecret}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("settings.gitCredentials.createNewSecret")}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("settings.gitCredentials.removeAriaLabel")}
              onClick={onRemove}
            >
              <Trash01 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("settings.gitCredentials.remove")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

interface CreateSecretDialogProps {
  onClose: () => void;
  onSaved: (secretId: string) => void;
}

function CreateSecretDialog({ onClose, onSaved }: CreateSecretDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const scope: SecretScopeKind = "organization";
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const createSecret = useCreateSecret();

  const trimmedName = name.trim();
  const canSubmit =
    value.length > 0 &&
    trimmedName.length > 0 &&
    SECRET_NAME_RE.test(trimmedName);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      const result = await createSecret.mutateAsync({
        scope,
        name: trimmedName,
        value,
        description: description.trim() || undefined,
      });
      toast.success(
        t("settings.gitCredentials.secretSaved", { name: result.name }),
      );
      onSaved(result.id);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.gitCredentials.failedToSaveSecret"),
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("settings.gitCredentials.createNewSecretTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.gitCredentials.createNewSecretDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="git-credential-secret-name">
              {t("settings.gitCredentials.nameLabel")}
            </Label>
            <Input
              id="git-credential-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.gitCredentials.namePlaceholder")}
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.gitCredentials.nameHelperText")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-credential-secret-value">
              {t("settings.gitCredentials.tokenLabel")}
            </Label>
            <Input
              id="git-credential-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("settings.gitCredentials.tokenPlaceholder")}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-credential-secret-description">
              {t("settings.gitCredentials.descriptionLabel")}
            </Label>
            <Textarea
              id="git-credential-secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("settings.gitCredentials.descriptionPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={createSecret.isPending}
            >
              {t("settings.gitCredentials.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || createSecret.isPending}
            >
              {createSecret.isPending
                ? t("settings.gitCredentials.saving")
                : t("settings.gitCredentials.saveSecret")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

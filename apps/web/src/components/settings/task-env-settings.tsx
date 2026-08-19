/**
 * Settings → Env vars every task-board run gets.
 *
 * Vault references only: the list stores `key → secretId`, never a value, so
 * nothing secret rides in the org-settings payload the whole org reads. The
 * value is resolved server-side at dispatch.
 *
 * No draft state — add and remove each write the whole list immediately, the
 * same shape the Secrets page uses. A rarely-edited list doesn't need autosave.
 */

import { Suspense, useState } from "react";
import { Lock01, Plus, Trash01 } from "@untitledui/icons";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { ENV_VAR_KEY_RE } from "@/sdk";
import { ScopeIcon } from "@/components/sandbox/runtime-card/secret-picker";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { useSecrets } from "@/hooks/use-secrets";
import {
  useSetTaskBoardEnv,
  useTaskBoardEnv,
} from "@/hooks/use-organization-settings";

export function TaskEnvSettings() {
  const t = useT();
  const entries = useTaskBoardEnv();
  const setEnv = useSetTaskBoardEnv();
  const [adding, setAdding] = useState(false);

  const write = async (next: { key: string; secretId: string }[]) => {
    try {
      await setEnv.mutateAsync(next);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("settings.taskEnv.updateError"),
      );
      throw err;
    }
  };

  return (
    <SettingsSection
      title={t("settings.taskEnv.title")}
      description={t("settings.taskEnv.description")}
      actions={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus size={14} />
          {t("settings.taskEnv.add")}
        </Button>
      }
    >
      <SettingsCard>
        {entries.length === 0 ? (
          <SettingsCardItem
            icon={<Lock01 size={16} />}
            title={t("settings.taskEnv.emptyTitle")}
            description={t("settings.taskEnv.emptyDescription")}
          />
        ) : (
          entries.map((entry) => (
            <SettingsCardItem
              key={entry.key}
              icon={<Lock01 size={16} />}
              title={<span className="font-mono text-sm">{entry.key}</span>}
              description={
                <Suspense fallback={<Skeleton className="h-4 w-24" />}>
                  <SecretName secretId={entry.secretId} />
                </Suspense>
              }
              action={
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={setEnv.isPending}
                  aria-label={t("settings.taskEnv.removeAriaLabel", {
                    key: entry.key,
                  })}
                  onClick={() =>
                    write(entries.filter((e) => e.key !== entry.key)).catch(
                      () => {},
                    )
                  }
                >
                  <Trash01 className="size-3.5" />
                </Button>
              }
            />
          ))
        )}
      </SettingsCard>

      {adding ? (
        <Suspense fallback={null}>
          <AddVarDialog
            takenKeys={entries.map((e) => e.key)}
            onClose={() => setAdding(false)}
            onAdd={async (entry) => {
              await write([...entries, entry]);
              setAdding(false);
            }}
          />
        </Suspense>
      ) : null}
    </SettingsSection>
  );
}

/** The secret a row points at, or a warning when it no longer exists. */
function SecretName({ secretId }: { secretId: string }) {
  const t = useT();
  const secret = useSecrets().find((s) => s.id === secretId);
  if (!secret) {
    return (
      <span className="text-destructive">
        {t("settings.taskEnv.missingSecret")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <ScopeIcon scope={secret.scope} />
      <span className="font-mono">{secret.name}</span>
    </span>
  );
}

function AddVarDialog({
  takenKeys,
  onClose,
  onAdd,
}: {
  takenKeys: string[];
  onClose: () => void;
  onAdd: (entry: { key: string; secretId: string }) => Promise<void>;
}) {
  const t = useT();
  // Org-scoped only: a user-scoped secret resolves for its owner alone.
  const secrets = useSecrets().filter((s) => s.scope === "organization");
  const [key, setKey] = useState("");
  const [secretId, setSecretId] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmed = key.trim();
  const keyInvalid = trimmed.length > 0 && !ENV_VAR_KEY_RE.test(trimmed);
  const duplicate = takenKeys.includes(trimmed);
  const canSubmit =
    trimmed.length > 0 && !keyInvalid && !duplicate && secretId.length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onAdd({ key: trimmed, secretId });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.taskEnv.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.taskEnv.addDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-env-key">
              {t("settings.taskEnv.keyLabel")}
            </Label>
            <Input
              id="task-env-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("settings.taskEnv.keyPlaceholder")}
              className={cn(
                "font-mono",
                (keyInvalid || duplicate) &&
                  "border-destructive focus-visible:ring-destructive",
              )}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={keyInvalid || duplicate}
              required
            />
            {keyInvalid ? (
              <p className="text-[11px] text-destructive">
                {t("settings.taskEnv.invalidKey")}
              </p>
            ) : null}
            {duplicate ? (
              <p className="text-[11px] text-destructive">
                {t("settings.taskEnv.duplicateKey")}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-env-secret">
              {t("settings.taskEnv.secretLabel")}
            </Label>
            <Select value={secretId} onValueChange={setSecretId}>
              <SelectTrigger id="task-env-secret">
                <SelectValue
                  placeholder={t("settings.taskEnv.secretPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {secrets.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {t("settings.taskEnv.noSecrets")}
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
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              {t("settings.taskEnv.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || saving}>
              {saving
                ? t("settings.taskEnv.saving")
                : t("settings.taskEnv.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

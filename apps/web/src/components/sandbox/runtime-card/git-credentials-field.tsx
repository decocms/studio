import { Suspense, useState } from "react";
import type {
  Control,
  FieldPath,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";
import { useWatch } from "react-hook-form";
import { Button } from "@decocms/ui/components/button.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Plus } from "@untitledui/icons";
import {
  GIT_CREDENTIALS_MAX,
  type SubmoduleCredential,
} from "@decocms/shared/organization/schema";
import { useT } from "@/i18n/use-t.ts";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  CreateSecretDialog,
  GitCredentialRow,
} from "@/components/settings/git-credentials-section";
import { type SecretInfo, useSecrets } from "@/hooks/use-secrets";
import {
  normalizeGitHost,
  repeatsEarlierGitHost,
} from "./complete-git-credentials";

export interface GitCredentialsFieldProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
}

/**
 * Form-bound editor for `metadata.runtime.gitCredentials`: the project's own
 * per-host git credentials, laid over the organization's (Settings →
 * Repositories) when a sandbox starts for this project. Same rows as that
 * section; what differs is where the list is stored.
 *
 * The secret list is read via Suspense; the wrapper renders a skeleton while
 * it loads so the rest of the card stays interactive.
 */
export function GitCredentialsField<T extends FieldValues>({
  control,
  form,
}: GitCredentialsFieldProps<T>) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label className="font-normal text-foreground">
        {t("sandbox.gitCredentialsField.title")}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t("sandbox.gitCredentialsField.description")}
      </p>
      <ErrorBoundary
        fallback={({ error }) => (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error?.message ?? t("settings.gitCredentials.failedToLoadSecrets")}
          </div>
        )}
      >
        <Suspense fallback={<Skeleton className="h-9 w-full" />}>
          <GitCredentialsEditor control={control} form={form} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function GitCredentialsEditor<T extends FieldValues>({
  control,
  form,
}: GitCredentialsFieldProps<T>) {
  const t = useT();
  const fieldPath = "metadata.runtime.gitCredentials" as FieldPath<T>;
  const rows =
    (useWatch({ control, name: fieldPath }) as
      | SubmoduleCredential[]
      | null
      | undefined) ?? [];

  const setRows = (next: SubmoduleCredential[]) =>
    form.setValue(fieldPath, next as never, {
      shouldDirty: true,
      shouldTouch: true,
    });
  const replaceAt = (index: number, row: SubmoduleCredential) =>
    rows.map((r, i) => (i === index ? row : r));

  const secrets = useSecrets();
  const secretById = new Map<string, SecretInfo>();
  for (const s of secrets) secretById.set(s.id, s);

  // Index of the row whose "create new secret" dialog is open, or null.
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);

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
              hostError={
                repeatsEarlierGitHost(rows, index)
                  ? t("sandbox.gitCredentialsField.hostDuplicateMessage")
                  : undefined
              }
              secrets={secrets}
              secretById={secretById}
              onEdit={(next) => setRows(replaceAt(index, next))}
              onCommit={() => {
                const host = normalizeGitHost(row.host);
                if (host !== row.host)
                  setRows(replaceAt(index, { ...row, host }));
              }}
              onPickSecret={(secretId) =>
                setRows(replaceAt(index, { ...row, secretId }))
              }
              onCreateNewSecret={() => setDialogIndex(index)}
              onRemove={() => setRows(rows.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>

      {rows.length > 0 ? (
        <p className="text-xs text-warning">
          {t("settings.gitCredentials.tokenExposureWarning")}
        </p>
      ) : null}

      {rows.length >= GIT_CREDENTIALS_MAX ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.gitCredentials.maxReached", {
            max: GIT_CREDENTIALS_MAX,
          })}
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={rows.length >= GIT_CREDENTIALS_MAX}
        onClick={() => setRows([...rows, { host: "", secretId: "" }])}
      >
        <Plus className="size-3.5" />
        {t("settings.gitCredentials.addCredential")}
      </Button>

      {dialogIndex !== null ? (
        <CreateSecretDialog
          onClose={() => setDialogIndex(null)}
          onSaved={(secretId) => {
            const row = rows[dialogIndex];
            if (row) setRows(replaceAt(dialogIndex, { ...row, secretId }));
            setDialogIndex(null);
          }}
        />
      ) : null}
    </div>
  );
}

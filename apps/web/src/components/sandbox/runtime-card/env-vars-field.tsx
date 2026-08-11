import { Suspense, useState } from "react";
import type {
  Control,
  FieldPath,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";
import { Controller, useFieldArray, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ENV_VAR_KEY_RE } from "@/sdk";
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
import {
  AlertTriangle,
  ClipboardCheck,
  Key01,
  Loading01,
  Lock01,
  Plus,
  RefreshCw01,
  Save01,
  Trash01,
} from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { ErrorBoundary } from "@/components/error-boundary";
import { parseDotenv } from "@/components/sandbox/preview/drawer/parse-dotenv";
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

export interface EnvVarsFieldProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
  /** Used to scope the restart request to the right agent. */
  virtualMcpId: string;
  /** Used to build the /vm/.../setup/start URL for the restart action. */
  orgSlug: string;
}

/**
 * Form-bound env editor for `metadata.runtime.env` on a virtual MCP.
 * Studio resolves secret entries against the credential vault on every
 * SANDBOX_START; literal entries are sent inline.
 *
 * The secret list is read via Suspense; the wrapper renders a skeleton
 * while it loads so the rest of the Sandbox card stays interactive.
 */
export function EnvVarsField<T extends FieldValues>({
  control,
  form,
  virtualMcpId,
  orgSlug,
}: EnvVarsFieldProps<T>) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="font-normal text-foreground">
          {t("sandbox.envVarsField.title")}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("sandbox.envVarsField.description")}
      </p>
      <RunningSandboxNotice
        control={control}
        form={form}
        virtualMcpId={virtualMcpId}
        orgSlug={orgSlug}
      />
      <ErrorBoundary
        fallback={({ error }) => (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error?.message ?? t("sandbox.envVarsField.failedToLoadSecrets")}
          </div>
        )}
      >
        <Suspense fallback={<Skeleton className="h-9 w-full" />}>
          <EnvVarsEditor control={control} form={form} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

interface RunningSandboxNoticeProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
  virtualMcpId: string;
  orgSlug: string;
}

/**
 * Banner shown above the env list when:
 *   (a) the caller already has a sandbox provisioned for this agent
 *       (sandboxMap has an entry under their userId), and
 *   (b) the env array changed since the last push to the daemon.
 *
 * The push to the daemon happens server-side on /setup/start (which
 * resolves secrets + PUTs /config before proxying to the daemon's
 * orchestrator). A daemon already running a dev script won't pick up new
 * env until that process restarts, so this notice + button recycle the
 * dev script for each of the caller's branches.
 *
 * Both baseline and `current` are passed through `normalizeEnvForCompare`
 * so in-progress rows (no key, invalid key, secret without secretId) —
 * which autosave already strips — never count as a real change.
 */
function RunningSandboxNotice<T extends FieldValues>({
  control,
  form,
  virtualMcpId,
  orgSlug,
}: RunningSandboxNoticeProps<T>) {
  const t = useT();
  const session = authClient.useSession();
  const userId = session.data?.user?.id;

  const fieldPath = "metadata.runtime.env" as FieldPath<T>;
  const sandboxMapPath = "metadata.sandboxMap" as FieldPath<T>;

  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(normalizeEnvForCompare(form.getValues(fieldPath))),
  );
  const current = useWatch({ control, name: fieldPath });
  const currentStr = JSON.stringify(normalizeEnvForCompare(current));
  const envChanged = currentStr !== baseline;

  const sandboxMap = form.getValues(sandboxMapPath) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const userBranches = userId ? Object.keys(sandboxMap?.[userId] ?? {}) : [];
  const hasActiveSandbox = userBranches.length > 0;

  const [isRestarting, setRestarting] = useState(false);

  if (!envChanged || !hasActiveSandbox) return null;

  const handleRestart = async () => {
    setRestarting(true);
    const results = await Promise.allSettled(
      userBranches.map(async (branch) => {
        const url = `/api/${encodeURIComponent(orgSlug)}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/setup/start`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          throw new Error(body || res.statusText);
        }
      }),
    );
    setRestarting(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      setBaseline(currentStr);
      toast.success(
        userBranches.length === 1
          ? t("sandbox.envVarsField.restartedSingle")
          : t("sandbox.envVarsField.restartedMultiple", {
              count: userBranches.length,
            }),
      );
    } else {
      toast.error(
        t("sandbox.envVarsField.restartFailed", {
          failed,
          total: userBranches.length,
        }),
      );
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-warning">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="truncate">
          {t("sandbox.envVarsField.sandboxRunningNotice")}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleRestart}
        disabled={isRestarting}
        className="shrink-0"
      >
        {isRestarting ? (
          <Loading01 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw01 className="size-3.5" />
        )}
        {isRestarting
          ? t("sandbox.envVarsField.restarting")
          : t("sandbox.envVarsField.restartDev")}
      </Button>
    </div>
  );
}

type SecretDialogMode =
  // "Save value as secret" on a literal row — value is pre-filled from the
  // row's current `value` and the dialog persists it to the vault.
  | {
      kind: "save-literal";
      index: number;
      presetValue: string;
      presetKey: string;
    }
  // "Create new secret" launched from inside the secret picker — user types
  // the value in the dialog; on save the row's secretId snaps to the new id.
  | { kind: "create-new"; index: number; presetKey: string };

interface EnvVarsEditorProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
}

function EnvVarsEditor<T extends FieldValues>({
  control,
  form,
}: EnvVarsEditorProps<T>) {
  const t = useT();
  const fieldPath = "metadata.runtime.env" as FieldPath<T>;
  // useFieldArray rejects string literals on the generic form path; the
  // runtime contract for `metadata.runtime.env` is asserted via the same
  // `as never` cast used in RuntimeFields. Local `fieldArray` keeps the
  // narrowed methods we hand off to EnvRow.
  const fieldArray = useFieldArray({
    control,
    name: fieldPath as never,
  });
  const { fields, append, remove } = fieldArray;

  // Replace a whole entry without going through useFieldArray.update — that
  // remounts the row (new field.id) and we've seen the dirty-flag/autosave
  // signal miss the swap. setValue with shouldDirty:true keeps the row
  // mounted and reliably propagates the change to autosave + Controllers.
  const updateEntry = (i: number, entry: unknown) => {
    form.setValue(`${fieldPath}.${i}` as FieldPath<T>, entry as never, {
      shouldDirty: true,
      shouldTouch: true,
    });
  };

  const secrets = useSecrets();
  const secretById = new Map<string, SecretInfo>();
  for (const s of secrets) secretById.set(s.id, s);

  const [dialogMode, setDialogMode] = useState<SecretDialogMode | null>(null);

  const handleAdd = () => {
    append({ key: "", kind: "literal", value: "" } as never);
  };

  // Paste a .env blob from the clipboard. New keys are appended as literal
  // rows; keys that already exist on the form are skipped so the paste never
  // overwrites a manually-curated value or an existing secret reference.
  const handlePasteDotenv = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error(t("sandbox.envVarsField.clipboardReadFailed"));
      return;
    }
    if (!text.trim()) {
      toast.error(t("sandbox.envVarsField.clipboardEmpty"));
      return;
    }
    let parsed: Record<string, string>;
    try {
      parsed = parseDotenv(text);
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    const entries = Object.entries(parsed);
    if (entries.length === 0) {
      toast.error(t("sandbox.envVarsField.nothingToAdd"));
      return;
    }
    const existing = (form.getValues(fieldPath) ?? []) as Array<{
      key?: string;
    }>;
    const existingKeys = new Set<string>();
    for (const e of existing) {
      const k = (e.key ?? "").trim();
      if (k) existingKeys.add(k);
    }
    let added = 0;
    let skipped = 0;
    for (const [key, value] of entries) {
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      append({ key, kind: "literal", value } as never);
      existingKeys.add(key);
      added++;
    }
    if (added === 0 && skipped > 0) {
      toast.message(t("sandbox.envVarsField.allKeysExist", { count: skipped }));
    } else {
      toast.success(
        skipped > 0
          ? t("sandbox.envVarsField.addedWithSkipped", { added, skipped })
          : t("sandbox.envVarsField.added", { added }),
      );
    }
  };

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {fields.map((field, index) => (
          <li
            key={field.id}
            className="rounded-md border border-border bg-background"
          >
            <EnvRow
              index={index}
              control={control}
              form={form}
              onUpdateEntry={updateEntry}
              fieldPath={fieldPath}
              secrets={secrets}
              secretById={secretById}
              onSaveAsSecret={(presetKey, presetValue) =>
                setDialogMode({
                  kind: "save-literal",
                  index,
                  presetKey,
                  presetValue,
                })
              }
              onCreateNewSecret={(presetKey) =>
                setDialogMode({ kind: "create-new", index, presetKey })
              }
              onRemove={() => remove(index)}
            />
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAdd}
          className="flex-1"
        >
          <Plus className="size-3.5" />
          {t("sandbox.envVarsField.addEnvVar")}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePasteDotenv}
              aria-label={t("sandbox.envVarsField.pasteDotenvAriaLabel")}
            >
              <ClipboardCheck className="size-3.5" />
              {t("sandbox.envVarsField.pasteDotenv")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("sandbox.envVarsField.pasteDotenvTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>

      {dialogMode !== null ? (
        <SaveAsSecretDialog
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onSaved={(secretId) => {
            const key =
              (
                form.getValues(
                  `${fieldPath}.${dialogMode.index}.key` as FieldPath<T>,
                ) as unknown as string | undefined
              )?.trim() ?? "";
            updateEntry(dialogMode.index, {
              key,
              kind: "secret",
              secretId,
            });
            setDialogMode(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface EnvRowProps<T extends FieldValues> {
  index: number;
  control: Control<T>;
  form: UseFormReturn<T>;
  onUpdateEntry: (index: number, entry: unknown) => void;
  fieldPath: FieldPath<T>;
  secrets: SecretInfo[];
  secretById: Map<string, SecretInfo>;
  onSaveAsSecret: (presetKey: string, presetValue: string) => void;
  onCreateNewSecret: (presetKey: string) => void;
  onRemove: () => void;
}

function EnvRow<T extends FieldValues>({
  index,
  control,
  form,
  onUpdateEntry,
  fieldPath,
  secrets,
  secretById,
  onSaveAsSecret,
  onCreateNewSecret,
  onRemove,
}: EnvRowProps<T>) {
  const t = useT();
  const keyName = `${fieldPath}.${index}.key` as FieldPath<T>;
  const valueName = `${fieldPath}.${index}.value` as FieldPath<T>;
  const secretIdName = `${fieldPath}.${index}.secretId` as FieldPath<T>;
  const kindName = `${fieldPath}.${index}.kind` as FieldPath<T>;

  // useWatch subscribes the row to its kind so a switch causes an immediate
  // re-render with the correct value-column shape. `form.getValues()` alone
  // is not reactive.
  const kindRaw = useWatch({ control, name: kindName }) as
    | "literal"
    | "secret"
    | undefined;
  const kind: "literal" | "secret" =
    kindRaw === "secret" ? "secret" : "literal";

  const switchKind = (next: "literal" | "secret") => {
    const key =
      (form.getValues(keyName) as unknown as string | undefined)?.trim() ?? "";
    if (next === "literal") {
      onUpdateEntry(index, { key, kind: "literal", value: "" });
      return;
    }
    // Literal → Secret: if there's already a value (often from a .env paste),
    // hand it to the create-secret dialog instead of blanking it. The row
    // stays a literal until the dialog confirms; cancel keeps the value.
    const currentValue =
      (form.getValues(valueName) as unknown as string | undefined) ?? "";
    if (currentValue.length > 0) {
      onSaveAsSecret(key, currentValue);
      return;
    }
    onUpdateEntry(index, { key, kind: "secret", secretId: "" });
  };

  return (
    <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <Controller
          control={control}
          name={keyName}
          render={({ field }) => {
            const v = ((field.value as string | undefined) ?? "").trim();
            const invalid = v.length > 0 && !ENV_VAR_KEY_RE.test(v);
            return (
              <div className="space-y-1">
                <Input
                  {...field}
                  value={(field.value as string | undefined) ?? ""}
                  placeholder={t("sandbox.envVarsField.keyPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={cn(
                    "font-mono",
                    invalid &&
                      "border-destructive focus-visible:ring-destructive",
                  )}
                  aria-invalid={invalid}
                  aria-label={t("sandbox.envVarsField.envVarKeyLabel", {
                    index: index + 1,
                  })}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    field.onChange(next);
                    field.onBlur();
                  }}
                />
                {invalid ? (
                  <p className="text-[11px] text-destructive">
                    {t("sandbox.envVarsField.invalidKeyMessage")}
                  </p>
                ) : null}
              </div>
            );
          }}
        />
      </div>

      <div className="shrink-0">
        <Select
          value={kind}
          onValueChange={(v) => switchKind(v as "literal" | "secret")}
        >
          <SelectTrigger className="h-9 w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="literal">
              <span className="inline-flex items-center gap-1.5">
                <Key01 className="size-3.5" />
                {t("sandbox.envVarsField.literal")}
              </span>
            </SelectItem>
            <SelectItem value="secret">
              <span className="inline-flex items-center gap-1.5">
                <Lock01 className="size-3.5" />
                {t("sandbox.envVarsField.secret")}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-[2] min-w-0 items-center gap-1">
        {kind === "literal" ? (
          <Controller
            control={control}
            name={valueName}
            render={({ field }) => (
              <Input
                {...field}
                value={(field.value as string | undefined) ?? ""}
                type="password"
                placeholder={t("sandbox.envVarsField.valuePlaceholder")}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                aria-label={t("sandbox.envVarsField.envVarValueLabel", {
                  index: index + 1,
                })}
                onBlur={(e) => {
                  field.onChange(e.target.value);
                  field.onBlur();
                }}
              />
            )}
          />
        ) : (
          <>
            <Controller
              control={control}
              name={secretIdName}
              render={({ field }) => (
                <Select
                  value={(field.value as string | undefined) || ""}
                  onValueChange={(v) => field.onChange(v)}
                >
                  <SelectTrigger
                    className={cn(
                      "h-9 w-full",
                      !field.value && "text-muted-foreground",
                    )}
                  >
                    <SelectValue
                      placeholder={t(
                        "sandbox.envVarsField.pickSecretPlaceholder",
                      )}
                    >
                      <SecretPickerValue
                        field={field}
                        secretById={secretById}
                      />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {secrets.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        {t("sandbox.envVarsField.noSecretsYet")}
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
              )}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t(
                    "sandbox.envVarsField.createNewSecretAriaLabel",
                  )}
                  onClick={() => {
                    const presetKey =
                      (
                        form.getValues(keyName) as unknown as string | undefined
                      )?.trim() ?? "";
                    onCreateNewSecret(presetKey);
                  }}
                >
                  <Plus className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("sandbox.envVarsField.createNewSecret")}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {kind === "literal" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("sandbox.envVarsField.saveAsSecretAriaLabel")}
                onClick={() => {
                  const presetKey =
                    (
                      form.getValues(keyName) as unknown as string | undefined
                    )?.trim() ?? "";
                  const presetValue =
                    (form.getValues(valueName) as unknown as
                      | string
                      | undefined) ?? "";
                  onSaveAsSecret(presetKey, presetValue);
                }}
              >
                <Save01 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("sandbox.envVarsField.saveAsSecret")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("sandbox.envVarsField.removeEnvVarAriaLabel")}
              onClick={onRemove}
            >
              <Trash01 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("sandbox.envVarsField.remove")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

interface SaveAsSecretDialogProps {
  mode: SecretDialogMode;
  onClose: () => void;
  onSaved: (secretId: string) => void;
}

function SaveAsSecretDialog({
  mode,
  onClose,
  onSaved,
}: SaveAsSecretDialogProps) {
  const t = useT();
  const presetValue = mode.kind === "save-literal" ? mode.presetValue : "";
  const presetKey = mode.presetKey;
  const [name, setName] = useState(() => sanitizeSecretName(presetKey));
  const [scope, setScope] = useState<SecretScopeKind>("organization");
  const [value, setValue] = useState(presetValue);
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
        t("sandbox.envVarsField.secretSaved", { name: result.name }),
      );
      onSaved(result.id);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.envVarsField.failedToSaveSecret"),
      );
    }
  };

  const title =
    mode.kind === "save-literal"
      ? t("sandbox.envVarsField.saveValueAsSecretTitle")
      : t("sandbox.envVarsField.createNewSecretTitle");
  const description_ =
    mode.kind === "save-literal"
      ? t("sandbox.envVarsField.saveValueAsSecretDescription")
      : t("sandbox.envVarsField.createNewSecretDescription");

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description_}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-scope">
              {t("sandbox.envVarsField.scopeLabel")}
            </Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="save-secret-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">
                  {t("sandbox.envVarsField.scopeOrganization")}
                </SelectItem>
                <SelectItem value="user">
                  {t("sandbox.envVarsField.scopePrivate")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-name">
              {t("sandbox.envVarsField.nameLabel")}
            </Label>
            <Input
              id="save-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("sandbox.envVarsField.namePlaceholder")}
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("sandbox.envVarsField.nameHelperText")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-value">
              {t("sandbox.envVarsField.valueLabel")}
            </Label>
            <Input
              id="save-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("sandbox.envVarsField.secretValuePlaceholder")}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-description">
              {t("sandbox.envVarsField.descriptionLabel")}
            </Label>
            <Textarea
              id="save-secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("sandbox.envVarsField.descriptionPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={createSecret.isPending}
            >
              {t("sandbox.envVarsField.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || createSecret.isPending}
            >
              {createSecret.isPending
                ? t("sandbox.envVarsField.saving")
                : t("sandbox.envVarsField.saveSecret")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Mirrors `stripIncompleteEnvEntries` in views/virtual-mcp/index.tsx so the
// banner's notion of "changed" matches what autosave actually sends.
function normalizeEnvForCompare(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      key?: string;
      kind?: string;
      value?: string;
      secretId?: string;
    };
    const key = (e.key ?? "").trim();
    if (!key || !ENV_VAR_KEY_RE.test(key)) continue;
    if (e.kind === "literal") {
      out.push({ key, kind: "literal", value: e.value ?? "" });
      continue;
    }
    if (e.kind === "secret" && e.secretId) {
      out.push({ key, kind: "secret", secretId: e.secretId });
    }
  }
  return out;
}

function sanitizeSecretName(envKey: string): string {
  const stripped = envKey.trim();
  if (!stripped) return "";
  // Env keys already constrain to [A-Za-z_][A-Za-z0-9_]*, which is a subset
  // of the secret-name charset — pass-through is safe and gives users a
  // predictable default.
  return ENV_VAR_KEY_RE.test(stripped) ? stripped : "";
}

import { Suspense, useState } from "react";
import type {
  Control,
  FieldPath,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";
import { Controller, useFieldArray, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ENV_VAR_KEY_RE } from "@decocms/mesh-sdk";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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
  User01,
  Users01,
} from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { parseDotenv } from "@/web/components/vm/preview/drawer/parse-dotenv";
import {
  type SecretInfo,
  type SecretScopeKind,
  useCreateSecret,
  useSecrets,
} from "@/web/hooks/use-secrets";

const SECRET_NAME_RE = /^[A-Za-z0-9_.-]+$/;

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
 * Mesh resolves secret entries against the credential vault on every
 * VM_START; literal entries are sent inline.
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
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="font-normal text-foreground">
          Environment variables
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Injected into the sandbox on every start. Reference an org/user secret
        to keep values out of metadata; literals are stored inline.
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
            {error?.message ?? "Failed to load secrets"}
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
 *       (vmMap has an entry under their userId), and
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
  const session = authClient.useSession();
  const userId = session.data?.user?.id;

  const fieldPath = "metadata.runtime.env" as FieldPath<T>;
  const vmMapPath = "metadata.vmMap" as FieldPath<T>;

  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(normalizeEnvForCompare(form.getValues(fieldPath))),
  );
  const current = useWatch({ control, name: fieldPath });
  const currentStr = JSON.stringify(normalizeEnvForCompare(current));
  const envChanged = currentStr !== baseline;

  const vmMap = form.getValues(vmMapPath) as
    | Record<string, Record<string, unknown>>
    | undefined;
  const userBranches = userId ? Object.keys(vmMap?.[userId] ?? {}) : [];
  const hasActiveSandbox = userBranches.length > 0;

  const [isRestarting, setRestarting] = useState(false);

  if (!envChanged || !hasActiveSandbox) return null;

  const handleRestart = async () => {
    setRestarting(true);
    const results = await Promise.allSettled(
      userBranches.map(async (branch) => {
        const url = `/api/${encodeURIComponent(orgSlug)}/vm/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/setup/start`;
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
          ? "Restarted dev with new env"
          : `Restarted ${userBranches.length} branches with new env`,
      );
    } else {
      toast.error(
        `Failed to restart ${failed} of ${userBranches.length} branch(es)`,
      );
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
      <div className="flex min-w-0 items-center gap-2 text-amber-900 dark:text-amber-200">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span className="truncate">
          Your sandbox is running. Restart the dev script to apply the new env.
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
        {isRestarting ? "Restarting…" : "Restart dev"}
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
      toast.error("Couldn't read clipboard");
      return;
    }
    if (!text.trim()) {
      toast.error("Clipboard is empty");
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
      toast.error("Nothing to add");
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
      toast.message(
        `All ${skipped} key${skipped === 1 ? "" : "s"} already exist`,
      );
    } else {
      toast.success(
        skipped > 0
          ? `Added ${added} var${added === 1 ? "" : "s"} (${skipped} already existed)`
          : `Added ${added} var${added === 1 ? "" : "s"}`,
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
          Add env var
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePasteDotenv}
              aria-label="Paste .env"
            >
              <ClipboardCheck className="size-3.5" />
              Paste .env
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Read a .env blob from the clipboard. Each pair is staged as a
            literal — save individual rows as secrets after.
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
                  placeholder="KEY"
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
                  aria-label={`Env var ${index + 1} key`}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    field.onChange(next);
                    field.onBlur();
                  }}
                />
                {invalid ? (
                  <p className="text-[11px] text-destructive">
                    Letters, digits, underscores. Must start with a letter or
                    underscore.
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
                Literal
              </span>
            </SelectItem>
            <SelectItem value="secret">
              <span className="inline-flex items-center gap-1.5">
                <Lock01 className="size-3.5" />
                Secret
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
                placeholder="value"
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                aria-label={`Env var ${index + 1} value`}
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
                    <SelectValue placeholder="Pick a secret…">
                      <SecretPickerValue
                        field={field}
                        secretById={secretById}
                      />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {secrets.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        No secrets yet. Use the “+” to create one.
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
                  aria-label="Create new secret"
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
              <TooltipContent>Create new secret</TooltipContent>
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
                aria-label="Save value as secret"
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
            <TooltipContent>Save value as secret</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove env var"
              onClick={onRemove}
            >
              <Trash01 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SecretPickerValue({
  field,
  secretById,
}: {
  field: { value: unknown };
  secretById: Map<string, SecretInfo>;
}) {
  const id = (field.value as string | undefined) || "";
  if (!id) return null;
  const secret = secretById.get(id);
  if (!secret) {
    return <span className="text-destructive">Missing secret ({id})</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 truncate">
      <ScopeIcon scope={secret.scope} />
      <span className="truncate font-mono">{secret.name}</span>
    </span>
  );
}

function ScopeIcon({ scope }: { scope: SecretScopeKind }) {
  const Icon = scope === "user" ? User01 : Users01;
  return <Icon className="size-3 text-muted-foreground" />;
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
      toast.success(`Saved secret "${result.name}"`);
      onSaved(result.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const title =
    mode.kind === "save-literal" ? "Save value as secret" : "Create new secret";
  const description_ =
    mode.kind === "save-literal"
      ? "Move this value into the encrypted vault. The env var will then reference the secret by id — its value never leaves the server."
      : "Stored encrypted in the credential vault. The env var will reference the new secret by id.";

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
            <Label htmlFor="save-secret-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="save-secret-scope">
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
            <Label htmlFor="save-secret-name">Name</Label>
            <Input
              id="save-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="STRIPE_API_KEY"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits, underscore, dot, hyphen. Independent of the env
              var key.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-value">Value</Label>
            <Input
              id="save-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="secret value"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="save-secret-description">
              Description (optional)
            </Label>
            <Textarea
              id="save-secret-description"
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
              onClick={onClose}
              disabled={createSecret.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || createSecret.isPending}
            >
              {createSecret.isPending ? "Saving…" : "Save secret"}
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

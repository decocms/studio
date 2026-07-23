import { Suspense, useState } from "react";
import type {
  Control,
  FieldPath,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";
import { Controller, useFieldArray } from "react-hook-form";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Plus, Trash01 } from "@untitledui/icons";
import { SUBMODULE_HOST_RE } from "@decocms/mesh-sdk";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  SECRET_NAME_RE,
  ScopeIcon,
  SecretPickerValue,
} from "@/web/components/sandbox/runtime-card/secret-picker";
import {
  type SecretInfo,
  type SecretScopeKind,
  useCreateSecret,
  useSecrets,
} from "@/web/hooks/use-secrets";

export interface SubmoduleCredentialsFieldProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
}

/**
 * Form-bound editor for `metadata.runtime.submoduleCredentials` on a virtual
 * MCP. Each entry maps a host (e.g. "github.com") to a vault secret holding a
 * PAT. Studio resolves the secret on every SANDBOX_START and hands the token to
 * the daemon on a git-only channel so `git submodule update` can fetch private
 * submodules the main clone token can't reach.
 *
 * The secret list is read via Suspense; the wrapper renders a skeleton while it
 * loads so the rest of the Sandbox card stays interactive.
 */
export function SubmoduleCredentialsField<T extends FieldValues>({
  control,
  form,
}: SubmoduleCredentialsFieldProps<T>) {
  return (
    <div className="space-y-2">
      <Label className="font-normal text-foreground">
        Submodule credentials
      </Label>
      <p className="text-xs text-muted-foreground">
        Personal access tokens for cloning private git submodules that live in
        other repositories. Reference an org/user secret per host; SSH submodule
        URLs are rewritten to HTTPS so the token applies.
      </p>
      <ErrorBoundary
        fallback={({ error }) => (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error?.message ?? "Failed to load secrets"}
          </div>
        )}
      >
        <Suspense fallback={<Skeleton className="h-9 w-full" />}>
          <SubmoduleCredentialsEditor control={control} form={form} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

interface EditorProps<T extends FieldValues> {
  control: Control<T>;
  form: UseFormReturn<T>;
}

function SubmoduleCredentialsEditor<T extends FieldValues>({
  control,
  form,
}: EditorProps<T>) {
  const fieldPath = "metadata.runtime.submoduleCredentials" as FieldPath<T>;
  const { fields, append, remove } = useFieldArray({
    control,
    name: fieldPath as never,
  });

  const secrets = useSecrets();
  const secretById = new Map<string, SecretInfo>();
  for (const s of secrets) secretById.set(s.id, s);

  // Index of the row whose "create new secret" dialog is open, or null.
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {fields.map((field, index) => (
          <li
            key={field.id}
            className="rounded-md border border-border bg-background"
          >
            <SubmoduleRow
              index={index}
              control={control}
              fieldPath={fieldPath}
              secrets={secrets}
              secretById={secretById}
              onCreateNewSecret={() => setDialogIndex(index)}
              onRemove={() => remove(index)}
            />
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ host: "", secretId: "" } as never)}
        className="w-full"
      >
        <Plus className="size-3.5" />
        Add submodule credential
      </Button>

      {dialogIndex !== null ? (
        <CreateSecretDialog
          onClose={() => setDialogIndex(null)}
          onSaved={(secretId) => {
            form.setValue(
              `${fieldPath}.${dialogIndex}.secretId` as FieldPath<T>,
              secretId as never,
              { shouldDirty: true, shouldTouch: true },
            );
            setDialogIndex(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface SubmoduleRowProps<T extends FieldValues> {
  index: number;
  control: Control<T>;
  fieldPath: FieldPath<T>;
  secrets: SecretInfo[];
  secretById: Map<string, SecretInfo>;
  onCreateNewSecret: () => void;
  onRemove: () => void;
}

function SubmoduleRow<T extends FieldValues>({
  index,
  control,
  fieldPath,
  secrets,
  secretById,
  onCreateNewSecret,
  onRemove,
}: SubmoduleRowProps<T>) {
  const hostName = `${fieldPath}.${index}.host` as FieldPath<T>;
  const secretIdName = `${fieldPath}.${index}.secretId` as FieldPath<T>;

  return (
    <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
      <div className="flex-1 min-w-0">
        <Controller
          control={control}
          name={hostName}
          render={({ field }) => {
            const v = ((field.value as string | undefined) ?? "").trim();
            const invalid = v.length > 0 && !SUBMODULE_HOST_RE.test(v);
            return (
              <div className="space-y-1">
                <Input
                  {...field}
                  value={(field.value as string | undefined) ?? ""}
                  placeholder="github.com"
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
                  aria-label={`Submodule credential ${index + 1} host`}
                  onBlur={(e) => {
                    field.onChange(e.target.value.trim());
                    field.onBlur();
                  }}
                />
                {invalid ? (
                  <p className="text-[11px] text-destructive">
                    Bare hostname, e.g. github.com (no scheme or path).
                  </p>
                ) : null}
              </div>
            );
          }}
        />
      </div>

      <div className="flex flex-[2] min-w-0 items-center gap-1">
        <Controller
          control={control}
          name={secretIdName}
          render={({ field }) => (
            <Select
              value={(field.value as string | undefined) || ""}
              onValueChange={(val) => field.onChange(val)}
            >
              <SelectTrigger
                className={cn(
                  "h-9 w-full",
                  !field.value && "text-muted-foreground",
                )}
              >
                <SelectValue placeholder="Pick a secret…">
                  <SecretPickerValue field={field} secretById={secretById} />
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
              onClick={onCreateNewSecret}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Create new secret</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove submodule credential"
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

interface CreateSecretDialogProps {
  onClose: () => void;
  onSaved: (secretId: string) => void;
}

function CreateSecretDialog({ onClose, onSaved }: CreateSecretDialogProps) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SecretScopeKind>("organization");
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
      toast.success(`Saved secret "${result.name}"`);
      onSaved(result.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
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
          <DialogTitle>Create new secret</DialogTitle>
          <DialogDescription>
            Stored encrypted in the credential vault. The submodule credential
            will reference the new secret by id — its value never leaves the
            server.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="submodule-secret-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="submodule-secret-scope">
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
            <Label htmlFor="submodule-secret-name">Name</Label>
            <Input
              id="submodule-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="GITHUB_SUBMODULE_PAT"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits, underscore, dot, hyphen.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="submodule-secret-value">
              Personal access token
            </Label>
            <Input
              id="submodule-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="ghp_…"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="submodule-secret-description">
              Description (optional)
            </Label>
            <Textarea
              id="submodule-secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this token used for?"
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

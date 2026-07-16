import { useState } from "react";
import { ShieldTick } from "@untitledui/icons";
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
import { type SecretScopeKind, useCreateSecret } from "@/hooks/use-secrets";
import {
  type DetectedSecret,
  maskSecret,
  secretRef,
} from "@/utils/secret-detect";

export interface StoreSecretResult {
  name: string;
  secretId: string;
}

export type StoreSecretMode = "paste" | "send";

interface StoreSecretDialogProps {
  detected: DetectedSecret;
  /** "paste": caught in the draft (swap/keep, no send). "send": before sending. */
  mode: StoreSecretMode;
  /** Vaulted successfully — caller swaps the raw value for the reference. */
  onSaved: (result: StoreSecretResult) => void;
  /** User chose to keep the raw value (paste: leave draft; send: send raw). */
  onKeepRaw: () => void;
  onCancel: () => void;
}

/**
 * "This looks like a secret" — offered before a raw token lands in chat
 * history. Saves it to the encrypted vault under a chosen name and hands the
 * agent a `{{secret:name}}` reference instead. Mirrors the vault contract:
 * values are never echoed back; the runtime resolves the reference at use.
 */
export function StoreSecretDialog({
  detected,
  mode,
  onSaved,
  onKeepRaw,
  onCancel,
}: StoreSecretDialogProps) {
  const [name, setName] = useState(detected.suggestedName);
  const [scope, setScope] = useState<SecretScopeKind>("organization");
  const createSecret = useCreateSecret();

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const key = name.trim();
    if (!key) return;
    try {
      const info = await createSecret.mutateAsync({
        scope,
        name: key,
        value: detected.value,
      });
      toast.success(`Secret "${key}" saved to the vault`);
      onSaved({ name: info.name, secretId: info.id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save secret");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldTick className="size-4 text-success" />
            This looks like {article(detected.label)}{" "}
            {detected.label.toLowerCase()}
          </DialogTitle>
          <DialogDescription>
            {mode === "paste"
              ? "Save it to the encrypted vault and drop a reference into your message instead, so the raw value never lands in the chat."
              : "Save it to the encrypted vault and send a reference instead, so the raw value never lands in this conversation's history."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
            {maskSecret(detected.value)}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="store-secret-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as SecretScopeKind)}
            >
              <SelectTrigger id="store-secret-scope">
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
            <Label htmlFor="store-secret-name">Secret name</Label>
            <Input
              id="store-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="openai_api_key"
              className="font-mono"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              The agent will see{" "}
              <span className="font-mono">{secretRef(name || "name")}</span> and
              resolve it from the vault when needed.
            </p>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={onKeepRaw}
              disabled={createSecret.isPending}
            >
              {mode === "paste" ? "Keep raw in message" : "Send raw"}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                disabled={createSecret.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createSecret.isPending || !name.trim()}
              >
                {createSecret.isPending
                  ? "Saving…"
                  : mode === "paste"
                    ? "Save & use reference"
                    : "Save & send reference"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "a"/"an" for the label, so the title reads naturally. */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

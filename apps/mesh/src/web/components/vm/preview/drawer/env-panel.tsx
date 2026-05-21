import { useRef, useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Plus, RefreshCw01, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { KEYS } from "@/web/lib/query-keys";
import { ENV_KEY_RE, parseDotenv } from "./parse-dotenv";

export interface EnvPanelProps {
  orgSlug: string;
  virtualMcpId: string | null;
  branch: string | null;
}

interface ConfigResponse {
  envKeys?: string[];
}

export function EnvPanel({ orgSlug, virtualMcpId, branch }: EnvPanelProps) {
  const ready = !!virtualMcpId && !!branch;
  const queryClient = useQueryClient();

  const vmBase = ready
    ? `/api/${encodeURIComponent(orgSlug)}/vm/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}`
    : "";
  const configUrl = `${vmBase}/config`;
  const startUrl = `${vmBase}/setup/start`;

  const queryKey = ready
    ? KEYS.vmEnv(orgSlug, virtualMcpId, branch)
    : (["vm-env", "disabled"] as const);

  const keysQuery = useQuery({
    queryKey,
    enabled: ready,
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(configUrl, { method: "GET" });
      if (!res.ok) throw new Error(`Failed to load env: ${res.statusText}`);
      const body = (await res.json()) as ConfigResponse;
      return body.envKeys ?? [];
    },
  });

  const writeMutation = useMutation({
    mutationFn: async (patch: Record<string, string | null>) => {
      if (!ready) throw new Error("Sandbox not ready");
      const res = await fetch(configUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env: patch }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || res.statusText);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      if (!ready) throw new Error("Sandbox not ready");
      const res = await fetch(startUrl, { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || res.statusText);
      }
    },
  });

  const [pending, setPending] = useState<Array<{ key: string; value: string }>>(
    [],
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  const upsertPending = (entries: Array<{ key: string; value: string }>) => {
    setPending((prev) => {
      const map = new Map(prev.map((e) => [e.key, e.value]));
      for (const e of entries) map.set(e.key, e.value);
      return Array.from(map, ([key, value]) => ({ key, value }));
    });
  };

  const stageSingle = () => {
    const key = keyDraft.trim();
    if (!key) return;
    if (!ENV_KEY_RE.test(key)) {
      toast.error(`Invalid key "${key}"`);
      return;
    }
    upsertPending([{ key, value: valueDraft }]);
    setKeyDraft("");
    setValueDraft("");
    keyInputRef.current?.focus();
  };

  const handlePasteButton = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error("Couldn't read clipboard");
      return;
    }
    if (!text) {
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
    const entries = Object.entries(parsed).map(([key, value]) => ({
      key,
      value,
    }));
    if (entries.length === 0) {
      toast.error("Nothing to add");
      return;
    }
    upsertPending(entries);
  };

  const handleSave = async () => {
    if (pending.length === 0) return;
    const patch: Record<string, string> = {};
    for (const { key, value } of pending) patch[key] = value;
    try {
      await writeMutation.mutateAsync(patch);
      const n = pending.length;
      setPending([]);
      toast.success(n === 1 ? "Saved 1 var" : `Saved ${n} vars`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleDelete = async (key: string) => {
    try {
      await writeMutation.mutateAsync({ [key]: null });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleRestart = async () => {
    try {
      await restartMutation.mutateAsync();
      toast.success("Restarting dev with new env");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sandbox not ready
      </div>
    );
  }

  const savedKeys = keysQuery.data ?? [];
  const pendingKeySet = new Set(pending.map((e) => e.key));
  const visibleSaved = savedKeys.filter((k) => !pendingKeySet.has(k));
  const hasAnyRows = visibleSaved.length > 0 || pending.length > 0;
  const isBusy = writeMutation.isPending;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Injected into <span className="font-mono">process.env</span> for the
          dev script and install. Values are write-only — once set, the daemon
          never returns them.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRestart}
          disabled={restartMutation.isPending}
        >
          <RefreshCw01 className="size-3.5" />
          Restart dev
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {keysQuery.isLoading ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : keysQuery.isError ? (
          <p className="px-3 py-6 text-center text-sm text-destructive">
            Failed to load env vars:{" "}
            {(keysQuery.error as Error | undefined)?.message ?? "unknown error"}
          </p>
        ) : !hasAnyRows ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No env vars set.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visibleSaved.map((key) => (
              <li
                key={`saved-${key}`}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="truncate font-mono text-sm text-foreground">
                    {key}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ●●●●●●●●
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(key)}
                  disabled={isBusy}
                  aria-label={`Delete ${key}`}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Trash01 className="size-3.5" />
                </button>
              </li>
            ))}
            {pending.map(({ key, value }) => (
              <li
                key={`pending-${key}`}
                className="flex items-center justify-between gap-2 bg-amber-50/40 px-3 py-2 dark:bg-amber-950/20"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="truncate font-mono text-sm text-foreground">
                    {key}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {value || <em className="not-italic">(empty)</em>}
                  </span>
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                    Pending
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setPending((prev) => prev.filter((e) => e.key !== key))
                  }
                  disabled={isBusy}
                  aria-label={`Discard pending ${key}`}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Trash01 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          stageSingle();
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2">
          <Input
            ref={keyInputRef}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value.trim())}
            placeholder="KEY"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 font-mono"
            aria-label="Env var key"
          />
          <span className="font-mono text-sm text-muted-foreground">=</span>
          <Input
            value={valueDraft}
            onChange={(e) => setValueDraft(e.target.value)}
            placeholder="value"
            spellCheck={false}
            autoComplete="off"
            className="flex-[2] font-mono"
            aria-label="Env var value"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!keyDraft.trim()}
            aria-label="Add to pending"
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Paste a <span className="font-mono">.env</span> blob to stage
            multiple vars at once — nothing is written until you save.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handlePasteButton}
          >
            <ClipboardCheck className="size-3.5" />
            Paste
          </Button>
        </div>
      </form>

      {pending.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPending([])}
            disabled={isBusy}
          >
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={isBusy}
          >
            {isBusy
              ? "Saving…"
              : `Save ${pending.length} ${pending.length === 1 ? "var" : "vars"}`}
          </Button>
        </div>
      )}
    </div>
  );
}

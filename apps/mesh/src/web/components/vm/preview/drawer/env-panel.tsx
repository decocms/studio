import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw01, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { KEYS } from "@/web/lib/query-keys";
import { parseDotenv } from "./parse-dotenv";

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

  const qs = ready
    ? `?virtualMcpId=${encodeURIComponent(virtualMcpId)}&branch=${encodeURIComponent(branch)}`
    : "";
  const url = `/api/${encodeURIComponent(orgSlug)}/vm-config${qs}`;

  const queryKey = ready
    ? KEYS.vmEnv(orgSlug, virtualMcpId, branch)
    : (["vm-env", "disabled"] as const);

  const keysQuery = useQuery({
    queryKey,
    enabled: ready,
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`Failed to load env: ${res.statusText}`);
      const body = (await res.json()) as ConfigResponse;
      return body.envKeys ?? [];
    },
  });

  const writeMutation = useMutation({
    mutationFn: async (patch: Record<string, string | null>) => {
      if (!ready) throw new Error("Sandbox not ready");
      const res = await fetch(url, {
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
      const res = await fetch(
        `/api/${encodeURIComponent(orgSlug)}/vm-setup/start${qs}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || res.statusText);
      }
    },
  });

  const [draftText, setDraftText] = useState("");

  const handleAdd = async () => {
    if (!draftText.trim()) return;
    let parsed: Record<string, string>;
    try {
      parsed = parseDotenv(draftText);
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    if (Object.keys(parsed).length === 0) {
      toast.error("Nothing to add");
      return;
    }
    try {
      await writeMutation.mutateAsync(parsed);
      setDraftText("");
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

  const keys = keysQuery.data ?? [];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
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

      <div className="flex flex-col gap-1">
        {keysQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No env vars set.</p>
        ) : (
          keys.map((key) => (
            <div
              key={key}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="truncate font-mono text-sm text-foreground">
                  {key}
                </span>
                <span className="text-xs text-muted-foreground">●●●●●●●●</span>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(key)}
                disabled={writeMutation.isPending}
                aria-label={`Delete ${key}`}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <Trash01 className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
        className="flex flex-col gap-2 border-t border-border pt-3"
      >
        <Textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder={"KEY=value\nANOTHER=value with spaces\n# comments OK"}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          aria-label="Env vars (KEY=value per line)"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            One <span className="font-mono">KEY=value</span> per line. Quotes
            and <span className="font-mono">export</span> optional. Existing
            keys are overwritten.
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={!draftText.trim() || writeMutation.isPending}
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </form>
    </div>
  );
}

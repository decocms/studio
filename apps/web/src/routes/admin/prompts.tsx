import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loading01 } from "@untitledui/icons";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { adminFetch } from "@/lib/admin-fetch";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface AdminPrompt {
  id: string;
  label: string;
  path: string;
  /** Null when the marker pair is gone from the file — nothing to edit. */
  content: string | null;
}

interface AdminPromptsResponse {
  repo: string;
  branch: string;
  baseSha: string;
  prompts: AdminPrompt[];
}

export default function AdminPromptsPage() {
  const t = useT();
  // Edits keyed by prompt id; a prompt absent here is unedited, which is what
  // the save sends (only edited prompts are committed).
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: KEYS.deploymentAdminPrompts(),
    queryFn: () => adminFetch<AdminPromptsResponse>("/api/_admin/prompts"),
  });

  const prompts = data?.prompts ?? [];
  const selected = prompts.find((p) => p.id === selectedId) ?? prompts[0];
  const editedIds = Object.keys(edits).filter(
    (id) => edits[id] !== prompts.find((p) => p.id === id)?.content,
  );

  const pullRequest = useMutation({
    mutationFn: () =>
      adminFetch<{ number: number; url: string }>(
        "/api/_admin/prompts/pull-request",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim() || undefined,
            baseSha: data?.baseSha,
            edits: editedIds.map((id) => ({ id, content: edits[id] })),
          }),
        },
      ),
    onSuccess: (pr) => {
      toast.success(
        t("admin.prompts.prOpened", { number: String(pr.number) }),
        {
          action: {
            label: t("admin.prompts.viewPr"),
            onClick: () => window.open(pr.url, "_blank"),
          },
        },
      );
      setEdits({});
      setTitle("");
      refetch();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("admin.prompts.prFailed"),
      );
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !selected) {
    return (
      <EmptyState
        title={t("admin.prompts.failedToLoadTitle")}
        description={t("admin.prompts.failedToLoadDescription")}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("admin.prompts.retry")}
          </Button>
        }
      />
    );
  }

  const value = edits[selected.id] ?? selected.content ?? "";

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t("admin.prompts.description", {
                repo: data?.repo ?? "",
                branch: data?.branch ?? "",
              })}
            </p>

            <div className="flex flex-wrap gap-1">
              {prompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt.id}
                  onClick={() => setSelectedId(prompt.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    prompt.id === selected.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {prompt.label}
                  {editedIds.includes(prompt.id) ? " •" : ""}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="prompt-source">{selected.path}</Label>
              <Textarea
                id="prompt-source"
                className="min-h-[420px] font-mono text-xs"
                spellCheck={false}
                value={value}
                disabled={selected.content === null}
                onChange={(e) =>
                  setEdits({ ...edits, [selected.id]: e.target.value })
                }
              />
              {selected.content === null ? (
                <p className="text-sm text-destructive">
                  {t("admin.prompts.markerMissing", { id: selected.id })}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div className="flex w-full flex-col gap-2 md:max-w-md">
                <Label htmlFor="pr-title">
                  {t("admin.prompts.prTitleLabel")}
                </Label>
                <Input
                  id="pr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("admin.prompts.prTitlePlaceholder")}
                />
              </div>
              <Button
                disabled={editedIds.length === 0 || pullRequest.isPending}
                onClick={() => pullRequest.mutate()}
              >
                {pullRequest.isPending
                  ? t("admin.prompts.opening")
                  : t("admin.prompts.openPr", {
                      count: String(editedIds.length),
                    })}
              </Button>
            </div>
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

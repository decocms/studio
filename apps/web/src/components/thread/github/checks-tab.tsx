import { useProjectContext } from "@/sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronRight, LinkExternal01 } from "@untitledui/icons";
import { useState } from "react";
import { MemoizedMarkdown } from "@/components/chat/markdown.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useChatStream } from "../../chat/chat-context.tsx";
import * as tpl from "./message-templates.ts";
import {
  useCheckRunDetail,
  useChecks,
  type CheckRun,
  type PrSummary,
} from "./use-pr-data.ts";

interface Props {
  pr: PrSummary;
  connectionId: string;
  owner: string;
  repo: string;
}

/**
 * Checks sub-tab: list of CI runs for the PR head SHA. Each row shows
 * the run name, status/conclusion, duration, a link to the provider's
 * run page, and a Re-run button that sends a templated chat message.
 * Rows expand to render the check run's `output` (e.g. the QA journey's
 * step-by-step table) inline, lazily fetched via GET_CHECK_RUN.
 */
export function ChecksTab({ pr, connectionId, owner, repo }: Props) {
  const { org } = useProjectContext();
  const chat = useChatStream();
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const checksQuery = useChecks({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId,
    owner,
    repo,
    prNumber: pr.number,
  });

  const rerun = (name: string) =>
    chat.sendMessage({
      parts: [
        {
          type: "text",
          text: tpl.rerunCheck({ prNumber: pr.number, checkName: name }),
        },
      ],
    });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (checksQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("thread.checksTab.loadingChecks")}
      </div>
    );
  }

  if (checksQuery.isError) {
    return (
      <div className="flex flex-col gap-1 text-sm text-destructive">
        <span>{t("thread.checksTab.couldntLoadCheckRuns")}</span>
        {checksQuery.error?.message && (
          <span className="text-xs text-muted-foreground">
            {checksQuery.error.message}
          </span>
        )}
      </div>
    );
  }

  const checks = checksQuery.data ?? [];

  if (checks.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("thread.checksTab.noCheckRunsOnPrHeadCommit")}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {checks.map((c) => {
        const isOpen = expanded.has(c.id);
        const checkRunId = Number(c.id);
        return (
          <li key={c.id} className="flex flex-col">
            <div className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <button
                type="button"
                onClick={() => toggle(c.id)}
                aria-expanded={isOpen}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                <StatusIcon check={c} />
                <span className="truncate">{c.name}</span>
                {c.durationMs != null && (
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(c.durationMs)}
                  </span>
                )}
              </button>
              <span className="flex shrink-0 items-center gap-1">
                {c.htmlUrl && (
                  <a
                    href={c.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-7 items-center justify-center rounded px-2 text-xs text-muted-foreground hover:bg-background"
                    title={t("thread.checksTab.viewRun")}
                  >
                    <LinkExternal01 className="h-3.5 w-3.5" />
                  </a>
                )}
                {c.conclusion === "failure" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={chat.isStreaming}
                    onClick={() => rerun(c.name)}
                  >
                    {t("thread.checksTab.rerun")}
                  </Button>
                )}
              </span>
            </div>
            {isOpen && (
              <CheckRunDetail
                orgId={org.id}
                orgSlug={org.slug}
                connectionId={connectionId}
                owner={owner}
                repo={repo}
                checkRunId={Number.isFinite(checkRunId) ? checkRunId : null}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface CheckRunDetailProps {
  orgId: string;
  orgSlug: string;
  connectionId: string;
  owner: string;
  repo: string;
  checkRunId: number | null;
}

/** Lazily-loaded detail rendered under an expanded check row. */
function CheckRunDetail({ checkRunId, ...repo }: CheckRunDetailProps) {
  const t = useT();
  const detailQuery = useCheckRunDetail({ ...repo, checkRunId, enabled: true });

  if (detailQuery.isLoading) {
    return (
      <div className="px-7 py-2 text-xs text-muted-foreground">
        {t("thread.checksTab.loadingCheckDetail")}
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex flex-col gap-1 px-7 py-2 text-xs text-destructive">
        <span>{t("thread.checksTab.couldntLoadCheckDetail")}</span>
        {detailQuery.error?.message && (
          <span className="text-muted-foreground">
            {detailQuery.error.message}
          </span>
        )}
      </div>
    );
  }

  const output = detailQuery.data;
  const body = output?.summary?.trim() || output?.text?.trim();

  if (!body) {
    return (
      <div className="px-7 py-2 text-xs text-muted-foreground">
        {t("thread.checksTab.noCheckDetail")}
      </div>
    );
  }

  return (
    <div className="px-7 pb-3 pt-1 text-sm">
      {output?.title && (
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {output.title}
        </div>
      )}
      <MemoizedMarkdown id={`check-${checkRunId}`} text={body} />
    </div>
  );
}

function StatusIcon({ check }: { check: CheckRun }) {
  const t = useT();
  if (check.status !== "completed") {
    return (
      <span
        className="text-muted-foreground"
        aria-label={t("thread.checksTab.inProgress")}
      >
        ○
      </span>
    );
  }
  if (check.conclusion === "success") {
    return (
      <span className="text-success" aria-label={t("thread.checksTab.success")}>
        ✓
      </span>
    );
  }
  if (check.conclusion === "failure") {
    return (
      <span
        className="text-destructive"
        aria-label={t("thread.checksTab.failure")}
      >
        ✗
      </span>
    );
  }
  return (
    <span
      className="text-muted-foreground"
      aria-label={check.conclusion ?? "—"}
    >
      —
    </span>
  );
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

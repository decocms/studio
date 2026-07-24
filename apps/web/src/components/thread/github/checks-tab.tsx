import { useProjectContext } from "@/sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { LinkExternal01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useChatStream } from "../../chat/chat-context.tsx";
import * as tpl from "./message-templates.ts";
import { useChecks, type CheckRun, type PrSummary } from "./use-pr-data.ts";

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
 */
export function ChecksTab({ pr, connectionId, owner, repo }: Props) {
  const { org } = useProjectContext();
  const chat = useChatStream();
  const t = useT();

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

  if (checksQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("thread.checksTab.loadingChecks")}
      </div>
    );
  }

  if (checksQuery.isError) {
    return (
      <div className="text-sm text-destructive">
        {t("thread.checksTab.couldntLoadCheckRuns")}
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
      {checks.map((c) => (
        <li
          key={c.id}
          className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            <StatusIcon check={c} />
            <span className="truncate">{c.name}</span>
            {c.durationMs != null && (
              <span className="text-xs text-muted-foreground">
                {formatDuration(c.durationMs)}
              </span>
            )}
          </span>
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
        </li>
      ))}
    </ul>
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

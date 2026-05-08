import { useProjectContext } from "@decocms/mesh-sdk";
import { LinkExternal01 } from "@untitledui/icons";
import { usePrFiles, type PrSummary } from "./use-pr-data.ts";

interface Props {
  pr: PrSummary;
  connectionId: string;
  owner: string;
  repo: string;
}

/**
 * Changes sub-tab: file list with additions / deletions per file. No
 * inline diffs — click a filename to jump to the blob on GitHub (opens
 * in a new tab).
 */
export function ChangesTab({ pr, connectionId, owner, repo }: Props) {
  const { org } = useProjectContext();
  const filesQuery = usePrFiles({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId,
    owner,
    repo,
    prNumber: pr.number,
  });

  if (filesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading files…</div>;
  }

  if (filesQuery.isError) {
    return (
      <div className="text-sm text-destructive">Couldn't load file list.</div>
    );
  }

  const files = filesQuery.data ?? [];

  if (files.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">No files changed.</div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="pb-2 text-xs text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} changed ·{" "}
        <a
          href={`${pr.htmlUrl}/files`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-foreground"
        >
          View diffs on GitHub
        </a>
      </div>
      <ul className="space-y-0.5">
        {files.map((f) => (
          <li key={f.filename}>
            <a
              href={f.blobUrl ?? `${pr.htmlUrl}/files`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between rounded px-2 py-1 font-mono text-xs hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusBadge status={f.status} />
                <span className="truncate">{f.filename}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span>
                  <span className="text-success">+{f.additions}</span>{" "}
                  <span className="text-destructive">−{f.deletions}</span>
                </span>
                <LinkExternal01 className="h-3 w-3 text-muted-foreground" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const letter =
    status === "added"
      ? "A"
      : status === "removed"
        ? "D"
        : status === "renamed"
          ? "R"
          : status === "copied"
            ? "C"
            : "M";
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground">
      {letter}
    </span>
  );
}

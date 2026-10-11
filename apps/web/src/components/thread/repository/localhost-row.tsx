import type { Ref } from "react";
import { Check, Loading02 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ContentBackend } from "@/components/sections-editor/content-backend";
import {
  DEFAULT_SERVE_ENDPOINT,
  endpointHost,
  SERVE_COMMAND,
  type ServeProblem,
} from "@/components/sections-editor/deco-serve-connection";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import {
  CommandSnippet,
  RichCode,
  serveProblemCopy,
} from "@/components/sections-editor/deco-serve-notices";
import type { DecoServeConnectionState } from "@/hooks/use-deco-serve-connection";
import {
  type LocalNetworkAccess,
  useLocalNetworkAccess,
} from "@/hooks/use-deco-serve-discovery";
import { useT } from "@/i18n/use-t.ts";

/** What the Localhost row says (Blocks v8 sites only). */
export type LocalhostStatus =
  /** Not chosen: what it is. */
  | { kind: "available" }
  /** Chosen, first answer pending. */
  | { kind: "connecting" }
  | { kind: "connected" }
  /** Nothing answers: how to start it. Keeps retrying. */
  | { kind: "not-running" }
  /** Chrome blocks Studio from reaching this machine. */
  | { kind: "needs-permission" }
  /** Something answered but can't be used: another site, out of date, … */
  | { kind: "problem"; problem: ServeProblem };

/**
 * The row's state, from whether Localhost is chosen, the editor's content
 * backend and Chrome's local-network permission.
 */
export function localhostStatus(input: {
  selected: boolean;
  backend: ContentBackend;
  access: LocalNetworkAccess;
}): LocalhostStatus {
  if (!input.selected) return { kind: "available" };
  const { backend } = input;
  if (backend.kind === "protocol" && backend.source === "local") {
    return { kind: "connected" };
  }
  if (backend.kind === "unavailable" && backend.source === "local") {
    const problem = backend.problem;
    if (!problem || problem.reason === "not-answering") {
      return input.access === "denied"
        ? { kind: "needs-permission" }
        : { kind: "not-running" };
    }
    return { kind: "problem", problem };
  }
  return { kind: "connecting" };
}

/**
 * The Localhost row wired to the editor (Blocks v8 only, so a v7 draft
 * selector runs none of these hooks): its state is the editor's own content
 * backend, so the row and the editor never disagree.
 */
export function V8LocalhostRow({
  virtualMcpId,
  branch,
  serve,
  rowRef,
}: {
  virtualMcpId: string;
  branch: string | null | undefined;
  serve: DecoServeConnectionState;
  rowRef?: Ref<HTMLDivElement>;
}) {
  const backend = useContentBackend(virtualMcpId, branch);
  const access = useLocalNetworkAccess();
  const selected = !!serve.connection;
  return (
    <LocalhostRow
      rowRef={rowRef}
      status={localhostStatus({ selected, backend, access })}
      host={endpointHost(
        serve.connection?.endpoint ??
          serve.lastEndpoint ??
          DEFAULT_SERVE_ENDPOINT,
      )}
      onSelect={() => {
        if (selected) return;
        // Where this user last connected the project, else the default
        // port. Nothing answering yet is fine: the editor connects as soon
        // as `deco serve` starts.
        serve.set({
          endpoint: serve.lastEndpoint ?? DEFAULT_SERVE_ENDPOINT,
        });
      }}
      onTurnOff={() => serve.clear()}
    />
  );
}

/**
 * "Localhost" in the drafts list of a Blocks v8 site: schema and content
 * from the `deco serve` on this computer, the preview from the app it
 * reports. Choosing it connects on its own once `deco serve` runs; every
 * state says the one next step.
 */
export function LocalhostRow({
  rowRef,
  status,
  host,
  onSelect,
  onTurnOff,
}: {
  rowRef?: Ref<HTMLDivElement>;
  status: LocalhostStatus;
  /** The endpoint's `host:port`. */
  host: string;
  onSelect: () => void;
  onTurnOff: () => void;
}) {
  const t = useT();
  const selected = status.kind !== "available";
  return (
    <div
      ref={rowRef}
      className={cn("flex flex-col rounded-lg", selected && "bg-accent")}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm",
          !selected && "hover:bg-accent",
        )}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-special" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {t("thread.branchPicker.localhost.label")}
          </span>
          <LocalhostStatusLine status={status} host={host} />
        </span>
        {status.kind === "connected" && (
          <Check className="h-4 w-4 shrink-0 text-success" />
        )}
      </button>
      {selected &&
        status.kind !== "connected" &&
        status.kind !== "connecting" && (
          <div className="flex flex-col gap-2 px-2 pb-2 text-xs text-muted-foreground">
            <LocalhostGuide status={status} host={host} />
          </div>
        )}
      {selected && (
        <div className="flex justify-end px-1 pb-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={onTurnOff}
          >
            {t("thread.branchPicker.localhost.turnOff")}
          </Button>
        </div>
      )}
    </div>
  );
}

function LocalhostStatusLine({
  status,
  host,
}: {
  status: LocalhostStatus;
  host: string;
}) {
  const t = useT();
  const text =
    status.kind === "available"
      ? t("thread.branchPicker.localhost.available")
      : status.kind === "connected"
        ? t("thread.branchPicker.localhost.connected", { host })
        : status.kind === "connecting"
          ? t("thread.branchPicker.localhost.connecting")
          : null;
  if (!text) return null;
  return (
    <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
      {status.kind === "connecting" && (
        <Loading02 className="h-3 w-3 shrink-0 animate-spin" />
      )}
      {text}
    </span>
  );
}

/** The next step for a chosen Localhost that isn't connected. */
function LocalhostGuide({
  status,
  host,
}: {
  status: LocalhostStatus;
  host: string;
}) {
  const t = useT();
  if (status.kind === "not-running") {
    return (
      <>
        <p>
          <RichCode text={t("thread.branchPicker.localhost.notRunning")} />
        </p>
        <CommandSnippet command={SERVE_COMMAND} />
        <p className="flex items-center gap-1">
          <Loading02 className="h-3 w-3 shrink-0 animate-spin" />
          {t("thread.branchPicker.localhost.notRunningHint")}
        </p>
      </>
    );
  }
  if (status.kind === "needs-permission") {
    return (
      <>
        <p className="font-medium text-foreground">
          {t("decoServe.lna.deniedTitle")}
        </p>
        <p>{t("decoServe.lna.deniedBody")}</p>
      </>
    );
  }
  if (status.kind === "problem") {
    const { title, body } = serveProblemCopy(t, status.problem, host);
    return (
      <div role="alert" className="flex flex-col gap-1">
        <p className="font-medium text-foreground">{title}</p>
        <p>
          <RichCode text={body} />
        </p>
      </div>
    );
  }
  return null;
}

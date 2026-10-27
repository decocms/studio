import type { Ref } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { DEFAULT_SERVE_ENDPOINT } from "@/components/sections-editor/deco-serve-connection";
import { useContentBackend } from "@/components/sections-editor/use-content-backend";
import type { DecoServeConnectionState } from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";

/**
 * The Localhost row wired to the editor (Blocks v8 only, so a v7 draft
 * selector runs none of these hooks). Choosing it connects on its own once
 * `deco serve` runs; picking a draft turns it off. Every step to get there
 * (the command, waiting, a problem) is in the Preview's empty state.
 */
export function V8LocalhostRow({
  virtualMcpId,
  branch,
  serve,
  rowRef,
  onPicked,
}: {
  virtualMcpId: string;
  branch: string | null | undefined;
  serve: DecoServeConnectionState;
  rowRef?: Ref<HTMLDivElement>;
  /** Called on every pick, chosen already or not, so the drafts menu
   *  closes the way it does for a draft row. */
  onPicked?: () => void;
}) {
  const backend = useContentBackend(virtualMcpId, branch);
  const selected = !!serve.connection;
  return (
    <LocalhostRow
      rowRef={rowRef}
      selected={selected}
      connected={
        selected && backend.kind === "protocol" && backend.source === "local"
      }
      onSelect={() => chooseLocalhost(serve, onPicked)}
    />
  );
}

/**
 * Choosing Localhost: closes the drafts menu like a draft row does (even
 * when it is chosen already), then connects to where this user last
 * connected the project, else the default port. Nothing answering yet is
 * fine: the editor connects as soon as `deco serve` starts.
 */
export function chooseLocalhost(
  serve: Pick<DecoServeConnectionState, "connection" | "lastEndpoint" | "set">,
  onPicked?: () => void,
) {
  onPicked?.();
  if (serve.connection) return;
  serve.set({ endpoint: serve.lastEndpoint ?? DEFAULT_SERVE_ENDPOINT });
}

/**
 * "Localhost" in the drafts list of a Blocks v8 site: schema and content
 * from the `deco serve` on this computer, the preview from the app it
 * reports. A black dot and its name; "Connected" once it is.
 */
export function LocalhostRow({
  rowRef,
  selected,
  connected,
  onSelect,
}: {
  rowRef?: Ref<HTMLDivElement>;
  selected: boolean;
  connected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <div
      ref={rowRef}
      className={cn(
        "flex rounded-lg",
        selected ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-2.5 px-2 py-2 text-left text-sm"
      >
        {/* Always black, whatever the connection state. */}
        <span
          data-testid="localhost-dot"
          className="h-2 w-2 shrink-0 rounded-full bg-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          {t("thread.branchPicker.localhost.label")}
        </span>
        {connected && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("thread.branchPicker.localhost.connected")}
          </span>
        )}
      </button>
    </div>
  );
}

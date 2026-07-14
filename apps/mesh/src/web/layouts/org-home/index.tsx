/**
 * Org landing (`/$org`).
 *
 * There is no bespoke "home" screen anymore — the org landing is just the
 * Super Agent, like every other agent. This resolver sends `/$org` to the
 * Super Agent's home thread: it reuses the agent's existing empty "New chat"
 * when there is one, otherwise mints a fresh id the agent shell will ensure via
 * `useEnsureTask`. The Super Agent opens on its Overview default view (recent
 * team activity) with chat alongside — driven entirely by its
 * `metadata.ui.layout`, no special-casing here.
 */
import { useState } from "react";
import { Navigate } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useThreads } from "@/web/components/chat/store/hooks";
import { ShellRouteLoading } from "@/web/layouts/shell-route-loading";

export default function OrgHome() {
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const { threads, status } = useThreads();
  // Stable id for this mount, used only when there's no reusable "New chat".
  const [freshId] = useState(() => crypto.randomUUID());

  // Wait for the open-thread list before deciding so a cold load reuses an
  // existing Super Agent "New chat" instead of minting a duplicate.
  if (status.kind === "loading") return <ShellRouteLoading />;

  const existing = threads.find(
    (t) =>
      !t.hidden &&
      t.virtual_mcp_id === decopilotId &&
      t.title === "New chat" &&
      (!t.status || t.status === "in_progress"),
  );
  const taskId = existing?.id ?? freshId;

  return (
    <Navigate
      to="/$org/$taskId"
      params={{ org: org.slug, taskId }}
      search={{ virtualmcpid: decopilotId }}
      replace
    />
  );
}

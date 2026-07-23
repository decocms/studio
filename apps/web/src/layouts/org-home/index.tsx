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
import { Navigate, useSearch } from "@tanstack/react-router";
import { getWellKnownDecopilotVirtualMCP, useProjectContext } from "@/sdk";
import { useThreads } from "@/components/chat/store/hooks";
import { authClient } from "@/lib/auth-client.ts";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";
import { findReusableNewChat } from "@/lib/reusable-new-chat";

export default function OrgHome() {
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const { data: session } = authClient.useSession();
  const { threads, status } = useThreads();
  const { connect, siteUrl } = useSearch({ strict: false }) as {
    connect?: string;
    siteUrl?: string;
  };
  // Stable id for this mount, used only when there's no reusable "New chat".
  const [freshId] = useState(() => crypto.randomUUID());

  // Wait for the open-thread list before deciding so a cold load reuses an
  // existing Super Agent "New chat" instead of minting a duplicate.
  if (status.kind === "loading") return <ShellRouteLoading />;

  // Reuse the Super Agent's existing empty "New chat" so revisiting `/$org`
  // doesn't pile up duplicates (see findReusableNewChat).
  const existing = findReusableNewChat(threads, decopilotId, session?.user?.id);
  const taskId = existing?.id ?? freshId;

  return (
    <Navigate
      to="/$org/$taskId"
      params={{ org: org.slug, taskId }}
      search={{ virtualmcpid: decopilotId, connect, siteUrl }}
      replace
    />
  );
}

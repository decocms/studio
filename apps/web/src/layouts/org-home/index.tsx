/**
 * Org landing (`/$org`).
 *
 * There is no bespoke "home" screen — the org landing is just an agent, like
 * every other. By default that's the Super Agent, but an org can pick a "main
 * agent" (org-scoped, see `useMainAgentId`); when set and still present, the
 * landing opens that agent instead. This resolver sends `/$org` to the landing
 * agent's home thread: it reuses the agent's existing empty "New chat" when
 * there is one, otherwise mints a fresh id the agent shell will ensure via
 * `useEnsureTask`. The Super Agent opens on its Overview default view (recent
 * team activity) with chat alongside — driven entirely by its
 * `metadata.ui.layout`, no special-casing here.
 */
import { useState } from "react";
import { Navigate, useSearch } from "@tanstack/react-router";
import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import { useThreads } from "@/components/chat/store/hooks";
import { useMainAgentId } from "@/hooks/use-organization-settings";
import { authClient } from "@/lib/auth-client.ts";
import { ShellRouteLoading } from "@/layouts/shell-route-loading";
import { findReusableNewChat } from "@/lib/reusable-new-chat";

export default function OrgHome() {
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const { data: session } = authClient.useSession();
  const { threads, status } = useThreads();
  const { mainAgentId, isPending: settingsPending } = useMainAgentId();
  // Suspense read (cache-warm from the shell); used to validate the main agent
  // still exists so a deleted one falls back to the Super Agent.
  const agents = useVirtualMCPs();
  // `main` carries a deep link into a main-panel overlay (e.g. `board` =
  // Tasks, `files` = Library) through the redirect to the landing thread.
  const { connect, siteUrl, main } = useSearch({ strict: false }) as {
    connect?: string;
    siteUrl?: string;
    main?: string;
  };
  // Stable id for this mount, used only when there's no reusable "New chat".
  const [freshId] = useState(() => crypto.randomUUID());

  // Wait for the open-thread list and org settings before deciding so a cold
  // load reuses an existing "New chat" instead of minting a duplicate, and
  // doesn't flash the Super Agent before the main agent resolves.
  if (settingsPending || status.kind === "loading")
    return <ShellRouteLoading />;

  // Land on the org's main agent when set and still present; otherwise the
  // Super Agent. The Super Agent is synthesized (not in the list), so we only
  // validate real main-agent ids against it.
  const mainAgentValid =
    mainAgentId != null && (agents ?? []).some((a) => a.id === mainAgentId);
  const landingAgentId = mainAgentValid ? mainAgentId : decopilotId;

  // Reuse the landing agent's existing empty "New chat" so revisiting `/$org`
  // doesn't pile up duplicates (see findReusableNewChat).
  const existing = findReusableNewChat(
    threads,
    landingAgentId,
    session?.user?.id,
  );
  const taskId = existing?.id ?? freshId;

  return (
    <Navigate
      to="/$org/$taskId"
      params={{ org: org.slug, taskId }}
      search={{ virtualmcpid: landingAgentId, connect, siteUrl, main }}
      replace
    />
  );
}

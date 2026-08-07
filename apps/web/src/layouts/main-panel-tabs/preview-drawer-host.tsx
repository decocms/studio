/**
 * PreviewDrawerHost — mounts the sandbox PreviewDrawer below the tab body.
 *
 * Reads sandbox state + actions from useSandboxLifecycle() and SSE state
 * from useSandboxEvents(). Owns the persisted drawer-open boolean (per
 * virtualMcpId, localStorage). Keys the drawer on the current vmId so per-VM
 * internal state (active tab, scriptTabs, killingScripts) resets cleanly on
 * VM switch.
 */

import { useRef, useState } from "react";
import { useProjectContext } from "@/sdk";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import {
  useSandboxChunkHandler,
  useSandboxEvents,
} from "@/components/sandbox/hooks/use-sandbox-events";
import { PreviewDrawer } from "@/components/sandbox/preview/drawer/drawer";

const STORAGE_KEY = (id: string) => `preview-drawer:${id}`;

// Clone aborts (exit 128) when the GitHub token studio handed the orchestrator is
// stale/invalid. A restart re-mints a fresh installation token, so auto
// stop+start once per VM to recover. Match the auth-specific lines, not the
// bare exit code (which covers unrelated git failures).
const GIT_AUTH_FAILURE_RE =
  /Authentication failed for|Invalid username or token|Password authentication is not supported/i;

interface DrawerState {
  open: boolean;
  /** Open-drawer height in px; `null` = default (50% of the pane). */
  height: number | null;
}

function readPersisted(virtualMcpId: string): DrawerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(virtualMcpId));
    if (!raw) return { open: false, height: null };
    const parsed = JSON.parse(raw);
    return {
      open: !!parsed.open,
      height: typeof parsed.height === "number" ? parsed.height : null,
    };
  } catch {
    return { open: false, height: null };
  }
}

function writePersisted(virtualMcpId: string, state: DrawerState): void {
  try {
    localStorage.setItem(STORAGE_KEY(virtualMcpId), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function PreviewDrawerHost() {
  const inset = useInsetContext();
  const { org } = useProjectContext();
  const virtualMcpId = inset?.virtualMcpId ?? null;
  const lifecycle = useSandboxLifecycle();
  const events = useSandboxEvents();

  // Detect the git-auth clone failure in the live "setup" log stream and
  // auto-recover with one stop+start. Test the accumulated buffer (not the raw
  // chunk) so a message split across SSE frames still matches. Guard by
  // virtualMcpId so we recover at most once per VM — never loop on a token
  // that's permanently revoked.
  const autoRestartedVmcpRef = useRef<string | null>(null);
  useSandboxChunkHandler((source) => {
    if (source !== "setup" || !virtualMcpId) return;
    if (autoRestartedVmcpRef.current === virtualMcpId) return;
    if (!GIT_AUTH_FAILURE_RE.test(events.getBuffer("setup"))) return;
    autoRestartedVmcpRef.current = virtualMcpId;
    void lifecycle.restart();
  });

  // `null` = not yet hydrated for this VM. Render-time setState gated by a ref
  // re-hydrates when virtualMcpId changes (idiomatic in this codebase;
  // useEffect is banned for derived state).
  const storageKey = virtualMcpId ?? "__no-vmcp__";
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null);
  const lastHydratedKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
  if (lastHydratedKeyRef.current !== storageKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
    lastHydratedKeyRef.current = storageKey;
    const persisted = readPersisted(storageKey);
    setDrawerOpen(persisted.open);
    setDrawerHeight(persisted.height);
  }

  // The drawer's open state is driven entirely by the user's persisted
  // preference. The setup tab inside renders the daemon's clone+install
  // log stream as soon as it's available, so expanding the drawer is
  // valuable even while the sandbox is still booting — don't override
  // the user's intent.
  const open = drawerOpen ?? false;

  const handleOpenChange = (next: boolean) => {
    setDrawerOpen(next);
    writePersisted(storageKey, { open: next, height: drawerHeight });
  };

  const handleHeightChange = (next: number) => {
    setDrawerHeight(next);
    writePersisted(storageKey, { open, height: next });
  };

  return (
    <PreviewDrawer
      key={lifecycle.vmEntry?.sandboxHandle ?? "no-vm"}
      vmId={lifecycle.vmEntry?.sandboxHandle ?? null}
      orgSlug={org.slug}
      virtualMcpId={virtualMcpId}
      branch={lifecycle.branch}
      status={lifecycle.status}
      scripts={events.scripts}
      open={open}
      onOpenChange={handleOpenChange}
      height={drawerHeight}
      onHeightChange={handleHeightChange}
      onStart={lifecycle.start}
      onStop={lifecycle.stop}
      onRestart={lifecycle.restart}
      onResume={lifecycle.resume}
      onRetry={lifecycle.retry}
    />
  );
}

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
import { useProjectContext } from "@decocms/mesh-sdk";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import { useSandboxLifecycle } from "@/web/components/sandbox/hooks/sandbox-lifecycle-context";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { PreviewDrawer } from "@/web/components/sandbox/preview/drawer/drawer";

const STORAGE_KEY = (id: string) => `preview-drawer:${id}`;

function readPersisted(virtualMcpId: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(virtualMcpId));
    if (!raw) return false;
    return !!JSON.parse(raw).open;
  } catch {
    return false;
  }
}

function writePersisted(virtualMcpId: string, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY(virtualMcpId), JSON.stringify({ open }));
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

  // `null` = not yet hydrated for this VM. Render-time setState gated by a ref
  // re-hydrates when virtualMcpId changes (idiomatic in this codebase;
  // useEffect is banned for derived state).
  const storageKey = virtualMcpId ?? "__no-vmcp__";
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const lastHydratedKeyRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
  if (lastHydratedKeyRef.current !== storageKey) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- hydrate on VM switch
    lastHydratedKeyRef.current = storageKey;
    setDrawerOpen(readPersisted(storageKey));
  }

  // The drawer's open state is driven entirely by the user's persisted
  // preference. The setup tab inside renders the daemon's clone+install
  // log stream as soon as it's available, so expanding the drawer is
  // valuable even while the sandbox is still booting — don't override
  // the user's intent.
  const open = drawerOpen ?? false;

  const handleOpenChange = (next: boolean) => {
    setDrawerOpen(next);
    writePersisted(storageKey, next);
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
      onStart={lifecycle.start}
      onStop={lifecycle.stop}
      onRestart={lifecycle.restart}
      onResume={lifecycle.resume}
      onRetry={lifecycle.retry}
    />
  );
}

/**
 * VirtualMCPProvider — Unified provider for agent routes.
 *
 * Combines:
 * 1. Entity fetch (useVirtualMCP) — Suspense-based
 * 2. ProjectContextProvider override (agent-scoped)
 * 3. VirtualMCPContext (URL-driven mainView)
 *
 * Navigation actions (openMainView, openTask) have moved to useLayoutState
 * and useChatNavigation respectively.
 */

import { Suspense, type ReactNode } from "react";
import { useNavigate, useMatch, useSearch } from "@tanstack/react-router";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { AlertCircle } from "@untitledui/icons";
import {
  VirtualMCPContext,
  type MainView,
  type VirtualMCPContextValue,
} from "@/web/contexts/virtual-mcp-context";

// ---------------------------------------------------------------------------
// Inner content (uses Suspense-based useVirtualMCP)
// ---------------------------------------------------------------------------

function VirtualMCPProviderContent({
  virtualMcpId,
  children,
}: {
  virtualMcpId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  const agentsMatch = useMatch({
    from: "/shell/$org/$virtualMcpId",
    shouldThrow: false,
  });
  const orgHomeMatch = useMatch({
    from: "/shell/$org/",
    shouldThrow: false,
  });

  const orgSlug = agentsMatch?.params.org ?? orgHomeMatch?.params.org ?? "";

  // Fetch entity (Suspense-based — resolved before render)
  const entity = useVirtualMCP(virtualMcpId);

  // Not found
  if (!entity) {
    return (
      <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
        <div className="flex flex-col h-full bg-card overflow-hidden border border-sidebar-border shadow-sm rounded-[0.75rem]">
          <EmptyState
            image={<AlertCircle size={48} className="text-muted-foreground" />}
            title="Agent not found"
            description={`The agent "${virtualMcpId}" does not exist in this organization.`}
            actions={
              <Button
                variant="outline"
                onClick={() =>
                  navigate({
                    to: "/$org",
                    params: { org: orgSlug },
                  })
                }
              >
                Go to organization home
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // --- VirtualMCPContext: URL-driven state ---
  const search = useSearch({ strict: false }) as {
    main?: string;
    id?: string;
    toolName?: string;
  };

  // Derive mainView from URL search params
  let mainView: MainView;
  if (search.main === "settings") {
    mainView = { type: "settings" };
  } else if (search.main === "automation") {
    const id = search.id ?? "";
    mainView = id ? { type: "automation", id } : { type: "settings" };
  } else if (search.main === "ext-apps") {
    const id = search.id ?? "";
    mainView = id
      ? { type: "ext-apps", id, toolName: search.toolName }
      : { type: "settings" };
  } else {
    mainView = null;
  }

  const virtualMcpContextValue: VirtualMCPContextValue = {
    virtualMcpId,
    mainView,
  };

  return (
    <VirtualMCPContext value={virtualMcpContextValue}>
      {children}
    </VirtualMCPContext>
  );
}

// ---------------------------------------------------------------------------
// Public provider (with Suspense boundary)
// ---------------------------------------------------------------------------

export function VirtualMCPProvider({
  virtualMcpId,
  children,
}: {
  virtualMcpId: string;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<div className="flex-1 min-h-0" />}>
      <VirtualMCPProviderContent virtualMcpId={virtualMcpId}>
        {children}
      </VirtualMCPProviderContent>
    </Suspense>
  );
}

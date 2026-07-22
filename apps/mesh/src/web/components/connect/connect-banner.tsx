import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { ArrowRight, LinkExternal01, XClose } from "@untitledui/icons";

function storageKey(orgId: string) {
  return `connect-banner-dismissed:${orgId}`;
}

function readDismissed(orgId: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(storageKey(orgId)) === "1";
  } catch {
    return false;
  }
}

export function ConnectBanner() {
  const { org } = useProjectContext();
  const [dismissed, setDismissed] = useState(() => readDismissed(org.id));

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey(org.id), "1");
    } catch {
      // ignore
    }
  };

  return (
    <Alert variant="info" className="items-center">
      <LinkExternal01 />
      <AlertDescription className="flex-1 flex items-center justify-between gap-2 text-sm">
        <span>
          Use Studio MCP anywhere — paste a command into Claude Code, Cursor,
          Codex, or any MCP client.
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <Button asChild size="sm" variant="ghost" className="text-xs gap-1">
            <Link to="/$org/settings/connect" params={{ org: org.slug }}>
              Connect to clients <ArrowRight size={12} />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleDismiss}
            aria-label="Dismiss"
          >
            <XClose size={14} />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

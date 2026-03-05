import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  isConnectionAuthenticated,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { useSlotResolution, type ConnectionSlot } from "./use-slot-resolution";
import { useConnectionPoller } from "./use-connection-poller";
import { type SlotPhase } from "./slot-resolution";
import {
  resolveAuthPhase,
  onAuthed,
  onInstallFresh,
  onInstalled,
  onPickActive,
  onPickInactive,
  onPollerActive,
  onPollerTimeout,
  onReset,
  type SlotCardState,
} from "./slot-card-transitions";
import { SlotDone } from "./slot-done";
import { SlotInstallForm } from "./slot-install-form";
import { SlotAuthOAuth } from "./slot-auth-oauth";
import { SlotAuthToken } from "./slot-auth-token";

interface SlotCardProps {
  slot: ConnectionSlot;
  onComplete: (connectionId: string) => void;
}

/** Apply a partial state transition to the individual React state setters. */
function applyTransition(
  t: Partial<SlotCardState>,
  setters: {
    setPhase: (v: SlotPhase | null) => void;
    setPollingConnectionId: (v: string | null) => void;
    setSelectedConnection: (v: ConnectionEntity | null) => void;
    setAuthCheckId: (v: string | null) => void;
  },
) {
  if ("phase" in t) setters.setPhase(t.phase ?? null);
  if ("pollingConnectionId" in t)
    setters.setPollingConnectionId(t.pollingConnectionId ?? null);
  if ("selectedConnection" in t)
    setters.setSelectedConnection(t.selectedConnection ?? null);
  if ("authCheckId" in t) setters.setAuthCheckId(t.authCheckId ?? null);
}

export function SlotCard({ slot, onComplete }: SlotCardProps) {
  const resolution = useSlotResolution(slot);
  const [phase, setPhase] = useState<SlotPhase | null>(null);
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(
    null,
  );
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectionEntity | null>(null);
  // ID of the connection whose auth status is being checked
  const [authCheckId, setAuthCheckId] = useState<string | null>(null);

  // Tracks whether the auth check was triggered by an active poller ("active")
  // or a timeout/error ("timeout"). Determines the done-vs-auth-token outcome.
  const authCheckSourceRef = useRef<"active" | "timeout">("timeout");
  // Prevents onComplete from firing more than once per unique connection
  const completedIdRef = useRef<string | null>(null);

  const setters = {
    setPhase,
    setPollingConnectionId,
    setSelectedConnection,
    setAuthCheckId,
  };

  const poller = useConnectionPoller(pollingConnectionId);

  const authUrl = authCheckId
    ? new URL(`/mcp/${authCheckId}`, window.location.origin).href
    : "";

  const { data: authStatus } = useQuery({
    queryKey: KEYS.isMCPAuthenticated(authUrl, null),
    queryFn: () => isConnectionAuthenticated({ url: authUrl, token: null }),
    enabled: Boolean(authCheckId),
  });

  // Derive effective phase: explicit override takes priority, else from resolution
  const effectivePhase: SlotPhase = phase ?? resolution.initialPhase;

  // React to poller becoming active — always check auth before marking done.
  // Some connections (e.g. Gmail) respond 200 at the transport level even
  // without OAuth, so we can't trust "active" to mean "authenticated".
  if (pollingConnectionId && poller.isActive && poller.connection) {
    authCheckSourceRef.current = "active";
    applyTransition(onPollerActive(poller.connection), setters);
  }

  // React to poller timeout/error — check auth to determine token vs OAuth
  if (
    pollingConnectionId &&
    (poller.isTimedOut || poller.connection?.status === "error")
  ) {
    authCheckSourceRef.current = "timeout";
    applyTransition(
      onPollerTimeout(pollingConnectionId, poller.connection ?? null),
      setters,
    );
  }

  // React to auth check result
  if (
    authCheckId &&
    authStatus &&
    phase !== "auth-oauth" &&
    phase !== "auth-token" &&
    phase !== "done"
  ) {
    const source = authCheckSourceRef.current;
    const connId = selectedConnection?.id ?? authCheckId;
    const nextPhase = resolveAuthPhase(authStatus, selectedConnection, source);

    if (nextPhase === "done") {
      // Only call onComplete once per connection
      if (completedIdRef.current !== connId) {
        completedIdRef.current = connId;
        setPhase("done");
        onComplete(connId);
      }
    } else {
      setPhase(nextPhase);
    }
  }

  const handleInstalled = (connectionId: string) => {
    applyTransition(onInstalled(connectionId), setters);
  };

  const handleAuthed = () => {
    applyTransition(
      onAuthed({ pollingConnectionId, selectedConnection, authCheckId }),
      setters,
    );
  };

  const handleReset = () => {
    const hasExisting = resolution.matchingConnections.length > 0;
    applyTransition(onReset(hasExisting), setters);
    completedIdRef.current = null;
    onComplete("");
  };

  const resolvedConnection =
    selectedConnection ?? resolution.satisfiedConnection ?? null;

  // Fallback to authCheckId when connection entity wasn't fetched before timeout
  const authConnectionId = selectedConnection?.id ?? authCheckId;

  if (effectivePhase === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{slot.label}</p>
      </div>
    );
  }

  if (resolution.registryError) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertCircle className="size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-medium">{slot.label}</p>
          <p className="text-xs text-muted-foreground">
            {resolution.registryError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card px-4 py-4 space-y-3">
      {effectivePhase !== "done" && (
        <p className="text-sm font-medium text-foreground">{slot.label}</p>
      )}

      {effectivePhase === "done" && resolvedConnection && (
        <SlotDone
          label={slot.label}
          connection={resolvedConnection}
          onReset={handleReset}
        />
      )}

      {effectivePhase === "picker" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Already installed:</p>
          <div className="space-y-1">
            {resolution.matchingConnections.map((conn) => (
              <button
                key={conn.id}
                type="button"
                onClick={() => {
                  if (conn.status === "active") {
                    applyTransition(onPickActive(conn), setters);
                    onComplete(conn.id);
                  } else {
                    applyTransition(onPickInactive(conn), setters);
                  }
                }}
                className="w-full flex items-center justify-between rounded border px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <span>{conn.title}</span>
                <span className="text-xs text-muted-foreground">
                  {conn.status}
                </span>
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => applyTransition(onInstallFresh(), setters)}
          >
            Install fresh
          </Button>
        </div>
      )}

      {effectivePhase === "install" && resolution.registryItem && (
        <SlotInstallForm
          registryItem={resolution.registryItem}
          onInstalled={handleInstalled}
        />
      )}

      {effectivePhase === "polling" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Connecting...
        </div>
      )}

      {effectivePhase === "auth-oauth" && authConnectionId && (
        <SlotAuthOAuth
          connectionId={authConnectionId}
          providerName={resolution.registryItem?.title ?? slot.label}
          onAuthed={handleAuthed}
        />
      )}

      {effectivePhase === "auth-token" && authConnectionId && (
        <SlotAuthToken
          connectionId={authConnectionId}
          onAuthed={handleAuthed}
        />
      )}
    </div>
  );
}

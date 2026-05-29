import { Link } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { Loading01 } from "@untitledui/icons";
import { IntegrationIcon } from "@/web/components/integration-icon";
import { useConnectApp } from "@/web/hooks/use-connect-app";
import type { ResolvedSlotAppDisplay } from "@/web/hooks/use-slot-app-displays";

/**
 * One row of the connect gate. Registry apps show their icon + friendly name and
 * connect inline (OAuth in place); non-registry / synthetic slots show the raw
 * app_id and deep-link to the connections page.
 */
export function ConnectSlotRow({
  display,
  orgSlug,
}: {
  display: ResolvedSlotAppDisplay;
  orgSlug: string;
}) {
  const { connect, status, error } = useConnectApp();
  const registryItem =
    display.kind === "registry" ? display.registryItem : null;
  const busy =
    status === "connecting" ||
    status === "authenticating" ||
    status === "ready";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <IntegrationIcon
        icon={display.icon}
        name={display.title}
        size="sm"
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{display.title}</p>
        {status === "error" && error ? (
          <p className="text-xs text-destructive truncate">{error}</p>
        ) : null}
      </div>
      {registryItem ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          disabled={busy}
          onClick={() => connect(registryItem)}
        >
          {status === "connecting" || status === "ready" ? (
            <>
              <Loading01 size={12} className="animate-spin" />
              Connecting…
            </>
          ) : status === "authenticating" ? (
            <>
              <Loading01 size={12} className="animate-spin" />
              Authenticating…
            </>
          ) : status === "error" ? (
            "Try again"
          ) : (
            "Connect"
          )}
        </Button>
      ) : (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
        >
          <Link to="/$org/settings/connections" params={{ org: orgSlug }}>
            Connect
          </Link>
        </Button>
      )}
    </div>
  );
}

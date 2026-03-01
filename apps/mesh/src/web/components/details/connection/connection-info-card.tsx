import { User } from "@/web/components/user/user.tsx";
import { formatTimeAgo } from "@/web/lib/format-time.ts";
import type { ConnectionEntity } from "@decocms/mesh-sdk";

interface ConnectionInfoCardProps {
  connection: ConnectionEntity;
  onOpenSettings: () => void;
}

export function ConnectionInfoCard({
  connection,
  onOpenSettings,
}: ConnectionInfoCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Connection</h3>
        <button
          type="button"
          onClick={onOpenSettings}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
        >
          Configure
        </button>
      </div>
      <div className="px-5 py-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Added by</span>
          <User id={connection.created_by} size="2xs" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Updated</span>
          <span className="text-xs text-foreground">
            {connection.updated_at
              ? formatTimeAgo(new Date(connection.updated_at))
              : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Protocol</span>
          <span className="text-xs font-mono text-foreground">
            {connection.connection_type}
          </span>
        </div>
      </div>
    </div>
  );
}

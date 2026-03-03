import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { useState } from "react";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ConnectionInstanceRow } from "./connection-instance-row.tsx";

export interface ConnectionServiceGroupProps {
  serviceName: string;
  icon: string | null;
  instances: ConnectionEntity[];
  defaultOpen?: boolean;
  onInstanceClick: (connectionId: string) => void;
}

export function ConnectionServiceGroup({
  serviceName,
  icon,
  instances,
  defaultOpen,
  onInstanceClick,
}: ConnectionServiceGroupProps) {
  const firstInstance = instances[0];
  const isSolo =
    instances.length === 1 && firstInstance != null && !firstInstance.app_name;
  const resolvedDefaultOpen = defaultOpen ?? instances.length === 1;
  const [open, setOpen] = useState(resolvedDefaultOpen);

  if (isSolo && firstInstance != null) {
    return (
      <div className="border border-border rounded-xl overflow-hidden bg-card">
        <ConnectionInstanceRow
          connection={firstInstance}
          onClick={() => onInstanceClick(firstInstance.id)}
          showIcon
        />
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-border rounded-xl overflow-hidden bg-card"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/30 transition-colors"
        >
          <IntegrationIcon icon={icon} name={serviceName} size="sm" />
          <span className="text-sm font-medium text-foreground flex-1 text-left">
            {serviceName}
          </span>
          <span className="text-xs text-muted-foreground">
            {instances.length} instances
          </span>
          {open ? (
            <ChevronDown size={14} className="text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight
              size={14}
              className="text-muted-foreground shrink-0"
            />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border">
          {instances.map((instance) => (
            <ConnectionInstanceRow
              key={instance.id}
              connection={instance}
              onClick={() => onInstanceClick(instance.id)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

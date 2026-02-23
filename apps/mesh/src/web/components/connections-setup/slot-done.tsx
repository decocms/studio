import { CheckCircle, ChevronDown } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import type { ConnectionEntity } from "@decocms/mesh-sdk";

interface SlotDoneProps {
  label: string;
  connection: ConnectionEntity;
  onReset: () => void;
}

export function SlotDone({ label, connection, onReset }: SlotDoneProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-4 py-3">
      <CheckCircle className="size-4 shrink-0 text-success" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground truncate">
          {connection.title}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReset}
        className="gap-1 shrink-0"
      >
        Change <ChevronDown className="size-3" />
      </Button>
    </div>
  );
}

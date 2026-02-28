import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type StatusArgs = {
  status?: "online" | "offline" | "error" | "warning";
  label?: string;
};

const STATUS_CONFIG = {
  online: { color: "bg-green-500", text: "Online" },
  offline: { color: "bg-gray-400", text: "Offline" },
  error: { color: "bg-red-500", text: "Error" },
  warning: { color: "bg-yellow-500", text: "Warning" },
} as const;

export default function Status() {
  const { args } = useWidget<StatusArgs>();

  if (!args) return null;

  const { status = "online", label = "Status" } = args;
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.online;

  return (
    <div className="p-4 font-sans flex items-center gap-3">
      <div className={cn("size-3 rounded-full shrink-0", config.color)} />
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{config.text}</div>
      </div>
    </div>
  );
}

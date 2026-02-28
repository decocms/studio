import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type NotificationArgs = {
  type?: "info" | "success" | "warning" | "error";
  title?: string;
  message?: string;
};

const TYPE_CONFIG = {
  info: {
    icon: "ℹ",
    bg: "bg-blue-50",
    border: "border-blue-200",
    iconColor: "text-blue-600",
    titleColor: "text-blue-900",
    msgColor: "text-blue-700",
  },
  success: {
    icon: "✓",
    bg: "bg-green-50",
    border: "border-green-200",
    iconColor: "text-green-600",
    titleColor: "text-green-900",
    msgColor: "text-green-700",
  },
  warning: {
    icon: "⚠",
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    iconColor: "text-yellow-600",
    titleColor: "text-yellow-900",
    msgColor: "text-yellow-700",
  },
  error: {
    icon: "✕",
    bg: "bg-red-50",
    border: "border-red-200",
    iconColor: "text-red-600",
    titleColor: "text-red-900",
    msgColor: "text-red-700",
  },
} as const;

export default function Notification() {
  const { args } = useWidget<NotificationArgs>();

  if (!args) return null;

  const { type = "info", title, message = "" } = args;
  const config = TYPE_CONFIG[type] ?? TYPE_CONFIG.info;

  return (
    <div className="p-4 font-sans">
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border px-3 py-3",
          config.bg,
          config.border,
        )}
      >
        <span
          className={cn("text-sm font-bold shrink-0 mt-0.5", config.iconColor)}
        >
          {config.icon}
        </span>
        <div className="min-w-0">
          {title && (
            <div
              className={cn("text-sm font-semibold mb-0.5", config.titleColor)}
            >
              {title}
            </div>
          )}
          <div className={cn("text-sm", config.msgColor)}>{message}</div>
        </div>
      </div>
    </div>
  );
}

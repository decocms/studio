import { AgentAvatar } from "@/web/components/agent-icon";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { Tool02, Zap } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";

/**
 * Resolves a virtualMCP by id and renders its avatar.
 * React Query deduplicates the fetch across rows.
 */
export function McpAvatar({
  virtualMcpId,
  size = "sm",
  showAutomationBadge,
}: {
  virtualMcpId: string | null | undefined;
  size?: "xs" | "sm" | "md";
  showAutomationBadge?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      {virtualMcpId ? (
        <McpAvatarInner virtualMcpId={virtualMcpId} size={size} />
      ) : (
        <AgentAvatar icon={null} name="?" size={size} />
      )}
      {showAutomationBadge && (
        <span
          aria-label="Automation-triggered"
          className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-blue-500 border border-blue-600 text-white"
        >
          <Zap size={10} className="text-white" />
        </span>
      )}
    </div>
  );
}

function McpAvatarInner({
  virtualMcpId,
  size,
}: {
  virtualMcpId: string;
  size: "xs" | "sm" | "md";
}) {
  const entity = useVirtualMCP(virtualMcpId);
  if (!entity) return <AgentAvatar icon={null} name="?" size={size} />;
  return (
    <AgentAvatar icon={entity.icon ?? null} name={entity.title} size={size} />
  );
}

/**
 * Avatar variant for deterministic tool-call automation runs (threads with
 * metadata.kind='tool_call_run'). No agent / virtual MCP is attached, so
 * we render a tool icon in a neutral square that lines up visually with
 * the regular McpAvatar slot.
 */
export function ToolCallRunAvatar({
  size = "sm",
  showAutomationBadge,
}: {
  size?: "xs" | "sm" | "md";
  showAutomationBadge?: boolean;
}) {
  const sizeClass =
    size === "xs" ? "size-6" : size === "sm" ? "size-7" : "size-8";
  const iconSize = size === "xs" ? 12 : size === "sm" ? 14 : 16;
  return (
    <div className="relative shrink-0">
      <div
        className={cn(
          sizeClass,
          "flex items-center justify-center rounded-md bg-muted text-muted-foreground",
        )}
        aria-label="Tool-call run"
      >
        <Tool02 size={iconSize} />
      </div>
      {showAutomationBadge && (
        <span
          aria-label="Automation-triggered"
          className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-blue-500 border border-blue-600 text-white"
        >
          <Zap size={10} className="text-white" />
        </span>
      )}
    </div>
  );
}

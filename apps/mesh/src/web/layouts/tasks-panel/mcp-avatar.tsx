import { AgentAvatar } from "@/web/components/agent-icon";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { Zap } from "@untitledui/icons";

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

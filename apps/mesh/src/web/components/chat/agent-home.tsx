import {
  getWellKnownDecopilotVirtualMCP,
  useProjectContext,
  useVirtualMCP,
} from "@decocms/mesh-sdk";
import { AgentAvatar } from "@/web/components/agent-icon";
import { Chat } from "./index";
import { useChatPrefs } from "./context";

export function AgentHome({
  onOpenContextPanel,
}: {
  onOpenContextPanel: () => void;
}) {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  const defaultAgent = getWellKnownDecopilotVirtualMCP(org.id);
  const agent = selectedVirtualMcp ?? defaultAgent;
  const fullVm = useVirtualMCP(agent.id);

  // Synthesized agents (the Super Agent) aren't persisted, so useVirtualMCP
  // returns null — fall back to the resolved agent for the identity block.
  const entity = fullVm ?? agent;
  const title = entity.title ?? "Super Agent";
  const icon = (entity.icon as string | null | undefined) ?? null;
  const description = entity.description ?? null;

  return (
    <>
      {/* Empty-chat identity — the agent's icon/title/description centered in
          the void above the composer, so an empty thread doesn't read as a
          blank panel. Threads for this agent live in the sidebar. */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 px-6 text-center overflow-hidden">
        <AgentAvatar icon={icon} name={title} size="lg" />
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description ? (
            <p className="text-sm text-muted-foreground max-w-md text-balance">
              {description}
            </p>
          ) : null}
        </div>
      </div>

      {/* docked input */}
      <Chat.Footer>
        <Chat.IceBreakers className="pb-3" />
        <Chat.Input onOpenContextPanel={onOpenContextPanel} />
      </Chat.Footer>
    </>
  );
}

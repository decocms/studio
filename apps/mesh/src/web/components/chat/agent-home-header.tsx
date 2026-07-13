import { IntegrationIcon } from "@/web/components/integration-icon";
import { Users03 } from "@untitledui/icons";

interface AgentHomeHeaderProps {
  agent: {
    icon?: string | null;
    title: string;
  };
  currentBranch: string | null;
}

export function AgentHomeHeader({
  agent,
  currentBranch,
}: AgentHomeHeaderProps) {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-8 pb-4 flex items-center gap-3">
      <IntegrationIcon
        icon={agent.icon}
        name={agent.title}
        size="sm"
        fallbackIcon={<Users03 size={16} />}
        className="size-8 min-w-8 rounded-lg shrink-0"
      />
      <div className="min-w-0 flex items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium text-base text-foreground">
          {agent.title}
        </span>
        {currentBranch && (
          <>
            <span className="text-sm text-muted-foreground">/</span>
            <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">
              {currentBranch}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

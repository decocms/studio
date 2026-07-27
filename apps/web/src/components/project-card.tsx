import { DotsVertical, Home02, Settings02, Trash01 } from "@untitledui/icons";
import { formatDistanceToNow } from "date-fns";
import { ptBR as ptBRLocale } from "date-fns/locale/pt-BR";
import { toast } from "sonner";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { usePreferences } from "@/hooks/use-preferences.ts";
import {
  useMainAgentId,
  useSetMainAgent,
} from "@/hooks/use-organization-settings";
import { useCapability } from "@/hooks/use-capability";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useT } from "@/i18n/use-t.ts";

interface ProjectCardProps {
  project: VirtualMCPEntity;
  lastUsedAt?: string;
  onDeleteClick?: (e: React.MouseEvent) => void;
}

export function ProjectCard({
  project,
  lastUsedAt,
  onDeleteClick,
}: ProjectCardProps) {
  const navigateToAgent = useNavigateToAgent();
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language === "pt-BR" ? ptBRLocale : undefined;
  const { mainAgentId } = useMainAgentId();
  const setMainAgent = useSetMainAgent();
  const { granted: canManageAgents } = useCapability("agents:manage");
  const isMainAgent = mainAgentId === project.id;

  const toggleMainAgent = () => {
    const next = isMainAgent ? null : project.id;
    setMainAgent.mutate(next, {
      onSuccess: () =>
        toast.success(
          isMainAgent
            ? t("home.projectCard.mainAgentUnset", { title: project.title })
            : t("home.projectCard.mainAgentSet", { title: project.title }),
        ),
      onError: () => toast.error(t("home.projectCard.mainAgentError")),
    });
  };

  return (
    <Card className="relative transition-colors group overflow-hidden flex flex-col h-full hover:bg-muted/50">
      {/* Overlay button — pins agent to sidebar and navigates */}
      <button
        type="button"
        onClick={() => navigateToAgent(project.id)}
        className="absolute inset-0 z-0"
        aria-label={project.title}
      />
      {/* pointer-events-none lets clicks fall through to the overlay link */}
      <div className="flex flex-col flex-1 pointer-events-none">
        <div className="flex flex-col gap-3 p-4.5">
          {/* Header: Icon + Actions */}
          <div className="flex items-start justify-between">
            <AgentAvatar
              icon={project.icon}
              name={project.title}
              size="sm"
              className="shrink-0 shadow-sm"
            />
            {/* pointer-events-auto re-enables the dropdown */}
            <div className="relative z-10 pointer-events-auto transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <DotsVertical size={20} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      navigateToAgent(project.id, {
                        search: { main: "settings" },
                      })
                    }
                  >
                    <Settings02 size={16} />
                    Settings
                  </DropdownMenuItem>
                  {canManageAgents && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMainAgent();
                      }}
                    >
                      <Home02 size={16} />
                      {isMainAgent
                        ? t("home.projectCard.unsetMainAgent")
                        : t("home.projectCard.setAsMainAgent")}
                    </DropdownMenuItem>
                  )}
                  {onDeleteClick && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteClick(e);
                      }}
                    >
                      <Trash01 size={16} />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Title and Description */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-medium text-foreground truncate">
                {project.title}
              </h3>
              {isMainAgent && (
                <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  <Home02 size={12} />
                  {t("home.projectCard.mainAgentBadge")}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {project.description || "No description"}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border mt-auto">
          <div className="h-10 flex items-center px-4.5">
            <p className="text-xs text-muted-foreground">
              {lastUsedAt
                ? t("home.projectCard.lastUsed", {
                    time: formatDistanceToNow(new Date(lastUsedAt), {
                      addSuffix: true,
                      locale,
                    }),
                  })
                : t("home.projectCard.updated", {
                    time: formatDistanceToNow(new Date(project.updated_at), {
                      addSuffix: true,
                      locale,
                    }),
                  })}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

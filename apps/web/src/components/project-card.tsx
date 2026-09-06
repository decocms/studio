import { DotsVertical, Settings02, Trash01 } from "@untitledui/icons";
import { formatDistanceToNow } from "date-fns";
import { ptBR as ptBRLocale } from "date-fns/locale/pt-BR";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { landingTabIdFor } from "@/layouts/main-panel-tabs/tab-id";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
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
  // The main agent is org-wide config written via ORGANIZATION_SETTINGS_UPDATE,
  // which the backend gates on `org:manage` — not `agents:manage`. Match it so
  // the action isn't shown to users whose click would fail server-side.

  /**
   * Where this card lands: the agent's OWN chosen main view, the same
   * `defaultMainView` the workspace resolves — so a Site Editor agent opens on
   * the Site Editor rather than a generic default. An agent that names no view
   * (or names Chat) still lands with no panel at all, exactly as before, so the
   * card cannot force a panel open on an agent configured chat-first.
   */
  const landingPanel = landingTabIdFor(project.metadata?.ui?.layout);

  return (
    <Card className="relative transition-colors group overflow-hidden flex flex-col h-full hover:bg-muted/50">
      {/* Overlay button — pins agent to sidebar and navigates */}
      <button
        type="button"
        onClick={() => navigateToAgent(project.id, { panel: landingPanel })}
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
                      navigateToAgent(project.id, { panel: "settings" })
                    }
                  >
                    <Settings02 size={16} />
                    Settings
                  </DropdownMenuItem>
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

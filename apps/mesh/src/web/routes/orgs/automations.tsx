import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { formatTimeAgo } from "@/web/lib/format-time";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Zap } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  Locator,
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
} from "@decocms/mesh-sdk";

interface AutomationTool {
  icon: string | null;
  name: string;
}

interface Automation {
  id: string;
  title: string;
  active: boolean;
  updatedAt: Date;
  tools: AutomationTool[];
}

const MOCK_AUTOMATIONS: Automation[] = [
  {
    id: "daily-standup",
    title: "Daily Standup Summary",
    active: true,
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    tools: [
      { icon: null, name: "GitHub" },
      { icon: null, name: "Slack" },
    ],
  },
  {
    id: "pr-review-digest",
    title: "PR Review Digest",
    active: false,
    updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    tools: [
      { icon: null, name: "GitHub" },
      { icon: null, name: "Linear" },
    ],
  },
];

export default function AutomationsPage() {
  const { locator } = useProjectContext();
  const { org } = Locator.parse(locator);
  const navigate = useNavigate();

  const automations = MOCK_AUTOMATIONS;

  function handleNewAutomation() {
    navigate({
      to: "/$org/$project/automations/$automationId",
      params: { org, project: ORG_ADMIN_PROJECT_SLUG, automationId: "new" },
    });
  }

  function handleAutomationClick(automation: Automation) {
    navigate({
      to: "/$org/$project/automations/$automationId",
      params: {
        org,
        project: ORG_ADMIN_PROJECT_SLUG,
        automationId: automation.id,
      },
    });
  }

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Automations</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <Button size="sm" onClick={handleNewAutomation}>
            New Automation
          </Button>
        </Page.Header.Right>
      </Page.Header>

      <Page.Content>
        {automations.length === 0 ? (
          <EmptyState
            image={<Zap size={36} className="text-muted-foreground" />}
            title="No automations yet"
            description="Create your first automation to get started."
            actions={
              <Button size="sm" onClick={handleNewAutomation}>
                New Automation
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {automations.map((automation) => (
              <button
                key={automation.id}
                type="button"
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors text-left w-full cursor-pointer"
                onClick={() => handleAutomationClick(automation)}
              >
                {/* Status dot */}
                <span
                  title={automation.active ? "Active" : "Inactive"}
                  className={cn(
                    "shrink-0 size-2 rounded-full",
                    automation.active
                      ? "bg-green-500"
                      : "bg-muted-foreground/40",
                  )}
                />

                {/* Title */}
                <span className="flex-1 text-sm font-medium text-foreground truncate">
                  {automation.title}
                </span>

                {/* Tool icon stack */}
                <div className="flex items-center -space-x-2 shrink-0">
                  {automation.tools.map((tool) => (
                    <IntegrationIcon
                      key={tool.name}
                      icon={tool.icon}
                      name={tool.name}
                      size="2xs"
                      fallbackIcon={
                        <Zap size={8} className="text-muted-foreground" />
                      }
                    />
                  ))}
                </div>

                {/* Timestamp */}
                <span className="shrink-0 text-xs text-muted-foreground w-12 text-right">
                  {formatTimeAgo(automation.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Page.Content>
    </Page>
  );
}

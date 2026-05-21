import { parseAutomationTabId } from "./tab-id";
import { SettingsTab as AutomationInlineDetail } from "@/web/views/automations/automation-detail";
import { useAutomation } from "@/web/hooks/use-automations";
import { Page } from "@/web/components/page";
import { Loading01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { Suspense } from "react";

export function AutomationTab({ tabId }: { tabId: string }) {
  const parsed = parseAutomationTabId(tabId);
  if (!parsed) return null;

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <Loading01
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            }
          >
            <AutomationTabInner id={parsed.id} />
          </Suspense>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

function AutomationTabInner({ id }: { id: string }) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { data: automation, isLoading } = useAutomation(id);
  const isToolCall = automation?.kind === "tool_call";

  const onBack = () => {
    if (isToolCall) {
      // Tool-call automations are org-scoped (no virtual_mcp_id), so the
      // natural list view is the org-wide settings page rather than the
      // current agent shell's automations tab.
      navigate({
        to: "/$org/settings/automations",
        params: { org: org.slug },
      });
      return;
    }
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        main: "automations",
      }),
      replace: true,
    });
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Automation not found
      </div>
    );
  }

  return (
    <AutomationInlineDetail
      automationId={id}
      automation={automation}
      onBack={onBack}
    />
  );
}

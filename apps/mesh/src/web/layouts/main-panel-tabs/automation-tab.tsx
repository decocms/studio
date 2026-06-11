import { parseAutomationTabId } from "./tab-id";
import { SettingsTab as AutomationInlineDetail } from "@/web/views/automations/automation-detail";
import { useAutomation } from "@/web/hooks/use-automations";
import { Page } from "@/web/components/page";
import { useNavigate } from "@tanstack/react-router";
import { Suspense } from "react";
import { MainPanelLoading } from "./main-panel-loading";

export function AutomationTab({ tabId }: { tabId: string }) {
  const parsed = parseAutomationTabId(tabId);
  if (!parsed) return null;

  return (
    <Suspense fallback={<MainPanelLoading />}>
      <AutomationTabInner id={parsed.id} />
    </Suspense>
  );
}

function AutomationTabInner({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data: automation, isLoading } = useAutomation(id);

  const onBack = () => {
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
    return <MainPanelLoading />;
  }

  if (!automation) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Automation not found
      </div>
    );
  }

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <AutomationInlineDetail
            automationId={id}
            automation={automation}
            onBack={onBack}
          />
        </Page.Body>
      </Page.Content>
    </Page>
  );
}

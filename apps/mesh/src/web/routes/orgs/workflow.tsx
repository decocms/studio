import { SELF_MCP_ALIAS_ID, useProjectContext } from "@decocms/mesh-sdk";
import { CollectionTab } from "@/web/components/details/connection/collection-tab";
import { PluginNotEnabledEmptyState } from "@/web/components/plugin-not-enabled-empty-state";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { Dataflow03 } from "@untitledui/icons";

const WORKFLOWS_PLUGIN_ID = "MCP Workflows";

const WORKFLOW_COLLECTION = {
  name: "WORKFLOW",
  displayName: "Workflow",
  hasCreateTool: true,
  hasUpdateTool: true,
  hasDeleteTool: true,
};

export default function WorkflowPage() {
  const { project, org } = useProjectContext();
  const enabledPlugins = project.enabledPlugins ?? [];
  const isPluginEnabled = enabledPlugins.includes(WORKFLOWS_PLUGIN_ID);

  if (!isPluginEnabled) {
    return (
      <Page>
        <Page.Header>
          <Page.Header.Left>
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>Workflows</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </Page.Header.Left>
        </Page.Header>

        <Page.Content>
          <div className="flex flex-col items-center justify-center h-full">
            <PluginNotEnabledEmptyState
              pluginId={WORKFLOWS_PLUGIN_ID}
              title="Enable Workflows"
              description="Automate multi-step processes by enabling the Workflows plugin. Once enabled you can create, run, and monitor workflows."
              icon={
                <div className="bg-muted p-4 rounded-full">
                  <Dataflow03 className="size-8 text-muted-foreground" />
                </div>
              }
            />
          </div>
        </Page.Content>
      </Page>
    );
  }

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Workflows</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>

      <Page.Content>
        <CollectionTab
          connectionId={SELF_MCP_ALIAS_ID}
          org={org.slug}
          activeCollection={WORKFLOW_COLLECTION}
        />
      </Page.Content>
    </Page>
  );
}

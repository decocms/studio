/**
 * Hook to create a new "template" agent: a virtual MCP whose sandbox boots
 * from a public GitHub repo — no GitHub connection required. Each template
 * is a `{ title, description, url, owner, name }` descriptor; the daemon
 * does an anonymous clone of the repo's default branch.
 */

import { useVirtualMCPActions } from "@decocms/mesh-sdk";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";

export type AgentTemplate = {
  title: string;
  description: string;
  url: string;
  owner: string;
  name: string;
};

export const WEBSITE_TEMPLATE: AgentTemplate = {
  title: "New Website",
  description: "Website cloned from a public template",
  url: "https://github.com/decocms/webapp-template",
  owner: "decocms",
  name: "webapp-template",
};

export const HYDROGEN_TEMPLATE: AgentTemplate = {
  title: "Shopify Headless Store",
  description: "Shopify Headless Store cloned from a public template",
  url: "https://github.com/Shopify/hydrogen-demo-store",
  owner: "Shopify",
  name: "hydrogen-demo-store",
};

export function useCreateAgentFromTemplate() {
  const actions = useVirtualMCPActions();
  const navigateToAgent = useNavigateToAgent();

  const createFromTemplate = async (template: AgentTemplate) => {
    const virtualMcp = await actions.create.mutateAsync({
      title: template.title,
      description: template.description,
      status: "active",
      pinned: true,
      connections: [],
      metadata: {
        githubRepo: {
          url: template.url,
          owner: template.owner,
          name: template.name,
        },
        instructions: null,
        ui: {
          pinnedViews: null,
          layout: {
            defaultMainView: { type: "preview" },
            chatDefaultOpen: true,
          },
        },
      },
    });

    if (virtualMcp.id) {
      navigateToAgent(virtualMcp.id);
    }

    return virtualMcp;
  };

  return {
    createFromTemplate,
    isCreating: actions.create.isPending,
  };
}

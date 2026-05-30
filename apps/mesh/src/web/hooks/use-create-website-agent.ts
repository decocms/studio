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
  icon?: string;
};

const SHOPIFY_HYDROGEN_ICON_SVG = `<svg width="74" height="84" viewBox="0 0 74 84" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M63.4462 15.3005C63.1414 15.2764 57.2333 15.1845 57.2333 15.1845C57.2333 15.1845 52.2906 10.3849 51.8019 9.89426C51.6127 9.71981 51.3729 9.60981 51.1172 9.58008V83.0253L73.2664 77.5175C73.2664 77.5175 64.2277 16.3953 64.1696 15.9772C64.1417 15.7997 64.055 15.6366 63.9235 15.5139C63.7919 15.3913 63.6255 15.3162 63.4462 15.3005Z" fill="#171717"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M32.748 0.00356357C34.8334 -0.0568526 36.5759 0.651298 37.9307 2.10122C38.0276 2.20613 38.1209 2.31463 38.2109 2.42544L38.2354 2.42349C38.4434 2.40657 38.6494 2.38638 38.8574 2.38638H38.8672C41.9831 2.3913 44.5571 4.16796 46.3184 7.527C46.8023 8.4621 47.2004 9.43976 47.5068 10.4469L49.9883 9.67837C50.3609 9.56961 51.315 9.42163 51.8037 9.90981L51.9922 82.3883L51.1162 83.0387L0 74.1979C0.0195597 74.0466 6.09952 27.0238 6.3291 25.3629C6.63636 23.1661 6.70922 23.0933 9.03906 22.361L16.957 19.9079C17.4531 16.377 19.1884 11.8165 21.4746 8.18423C24.7237 3.02487 28.7273 0.119714 32.748 0.00356357ZM38.8408 26.7077C38.8133 26.694 36.5926 25.6009 32.2842 25.8747C21.032 26.5853 15.9341 34.4515 16.4229 42.2213C17.0059 51.4485 26.2283 51.1199 26.584 56.734C26.6686 58.0922 25.8271 60.0114 23.4658 60.1588C19.8562 60.3883 15.3438 56.9831 15.3438 56.9831L13.6191 64.3249C13.6191 64.3249 18.1021 69.1296 26.2432 68.6149C33.027 68.1895 37.7351 62.759 37.2344 54.8249C36.5981 44.7397 25.2729 43.7966 25.002 39.4948C24.9512 38.7038 25.0055 35.556 29.9932 35.2418C33.3786 35.0279 36.2354 36.3195 36.2666 36.3336L38.8408 26.7077ZM32.8262 2.6813C26.6181 2.86014 21.2028 12.5587 19.8213 19.0211L26.8311 16.8512C27.6101 12.7476 29.5648 8.48928 32.1221 5.74868C33.0162 4.76667 34.0719 3.94401 35.2432 3.31704H35.2451C34.5654 2.87005 33.7695 2.66203 32.8262 2.6813ZM36.9775 5.46548C35.7921 5.95366 34.7952 6.80972 34.0791 7.57583C32.1608 9.63716 30.5951 12.7807 29.7725 15.9391L38.3057 13.2956C38.3322 11.0721 38.0904 7.7854 36.9775 5.46548ZM39.7568 5.14907C40.7052 7.59721 40.9505 10.4321 40.9795 12.4694L44.9473 11.2389C44.3133 9.17981 42.8075 5.72907 39.7568 5.14907Z" fill="#393939"/>
</svg>`;

export const SHOPIFY_HYDROGEN_ICON = `data:image/svg+xml,${encodeURIComponent(
  SHOPIFY_HYDROGEN_ICON_SVG,
)}`;

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
  icon: SHOPIFY_HYDROGEN_ICON,
};

export function useCreateAgentFromTemplate() {
  const actions = useVirtualMCPActions();
  const navigateToAgent = useNavigateToAgent();

  const createFromTemplate = async (template: AgentTemplate) => {
    const virtualMcp = await actions.create.mutateAsync({
      title: template.title,
      description: template.description,
      icon: template.icon ?? null,
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

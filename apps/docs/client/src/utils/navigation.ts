import { getCollection } from "astro:content";
import { LATEST_VERSION } from "../config/versions";

export interface NavigationLink {
  title: string;
  description?: string;
  href: string;
}

export async function getNavigationLinks(
  currentDocId: string,
  locale: string,
): Promise<{ previous?: NavigationLink; next?: NavigationLink }> {
  const allDocs = await getCollection("docs");
  // doc.id format: "version/locale/...path" (e.g. "latest/en/mcp-mesh/overview")
  const [docVersion, docLocale] = currentDocId.split("/");
  const isLatest = docVersion === LATEST_VERSION.id;
  const legacyPrefixes = ["no-code-guides/", "full-code-guides/"];
  const docs = allDocs.filter((doc) => {
    if (
      doc.id.split("/")[0] !== docVersion ||
      doc.id.split("/")[1] !== docLocale
    )
      return false;
    // For the latest version, exclude legacy admin guides from navigation
    if (isLatest) {
      const path = doc.id.split("/").slice(2).join("/");
      if (legacyPrefixes.some((p) => path.startsWith(p))) return false;
    }
    return true;
  });

  // Define the correct order for navigation, version-aware
  const latestOrder = [
    // 1. Welcome
    "studio/overview",
    "studio/quickstart",

    // 2. Core Concepts
    "studio/concepts",

    // 3. The product, page by page
    "studio/agents",
    "studio/connections",
    "studio/automations",
    "studio/monitoring",
    "studio/ai-providers",

    // 4. Decopilot
    "studio/decopilot/overview",
    "studio/decopilot/context-and-tasks",
    "studio/decopilot/tools",

    // 5. Solutions
    "studio/solutions/overview",
    "studio/solutions/agentic-cms",

    // 6. Coming soon
    "studio/projects",

    // 7. Catalog & admin
    "studio/store",
    "studio/api-keys",
    "studio/user-management",

    // 9. API Reference
    "studio/api-reference/connection-proxy",
    "studio/api-reference/built-in-tools",
    "studio/api-reference/built-in-tools/tool-search",
    "studio/api-reference/built-in-tools/tool-enable",
    "studio/api-reference/built-in-tools/agent-search",
    "studio/api-reference/built-in-tools/subtask-run",
    "studio/api-reference/built-in-tools/user-ask",
    "studio/api-reference/built-in-tools/resource-read",
    "studio/api-reference/built-in-tools/prompt-read",

    // 10. Self-Hosting
    "studio/self-hosting/quickstart",
    "studio/self-hosting/authentication",
    "studio/self-hosting/monitoring",
    "studio/self-hosting/deploy/docker-compose",
    "studio/self-hosting/deploy/kubernetes",
  ];

  const previousOrder = [
    // Introduction
    "introduction",

    // MCP Mesh section
    "mcp-mesh/overview",
    "mcp-mesh/quickstart",
    "mcp-mesh/concepts",
    "mcp-mesh/connect-clients",
    "mcp-mesh/authentication",
    "mcp-mesh/authorization-and-roles",
    "mcp-mesh/mcp-servers",
    "mcp-mesh/mcp-gateways",
    "mcp-mesh/api-keys",
    "mcp-mesh/monitoring",
    "mcp-mesh/api-reference",
    "mcp-mesh/deploy/local-docker-compose",
    "mcp-mesh/deploy/kubernetes-helm-chart",

    // MCP Studio
    "mcp-studio/overview",

    // Legacy Admin
    "getting-started/ai-builders",
    "getting-started/developers",
    "no-code-guides/creating-tools",
    "no-code-guides/creating-agents",
    "full-code-guides/project-structure",
    "full-code-guides/building-tools",
    "full-code-guides/building-views",
    "full-code-guides/resources",
    "full-code-guides/deployment",

    // API reference (legacy location)
    "api-reference/built-in-tools/user-ask",
  ];

  const order = isLatest ? latestOrder : previousOrder;

  // Sort docs according to the defined order
  const sortedDocs = docs.sort((a, b) => {
    // Strip version and locale prefix to get the path relative to the content root
    const aPath = a.id.split("/").slice(2).join("/");
    const bPath = b.id.split("/").slice(2).join("/");

    const aIndex = order.indexOf(aPath);
    const bIndex = order.indexOf(bPath);

    // If both are in the order array, sort by their position
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }

    // If only one is in the order array, it comes first
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;

    // If neither is in the order array, sort alphabetically
    return aPath.localeCompare(bPath);
  });

  const currentIndex = sortedDocs.findIndex((doc) => doc.id === currentDocId);

  if (currentIndex === -1) {
    return {};
  }

  const previous = currentIndex > 0 ? sortedDocs[currentIndex - 1] : undefined;
  const next =
    currentIndex < sortedDocs.length - 1
      ? sortedDocs[currentIndex + 1]
      : undefined;

  return {
    previous: previous
      ? {
          title: previous.data.title,
          description: previous.data.description,
          href: `/${docVersion}/${docLocale}/${previous.id.split("/").slice(2).join("/")}`,
        }
      : undefined,
    next: next
      ? {
          title: next.data.title,
          description: next.data.description,
          href: `/${docVersion}/${docLocale}/${next.id.split("/").slice(2).join("/")}`,
        }
      : undefined,
  };
}

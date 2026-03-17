import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "search-store",
    description:
      "Search the Deco Store or registry for new connections that match a user need.",
    text: `# Search store

Goal: find good candidate connections in the Deco Store or another registry before recommending or installing anything.

Read docs://store.md for registry types, search patterns, and evaluation criteria. Read docs://connections.md if you need a refresher on how installed connections behave after discovery.

Recommended tool order:
1. Use CONNECTIONS_LIST to find available registry connections such as Deco Store or MCP Registry.
2. If the user has not clearly described the target capability, data source, or authentication constraints, use user_ask.
3. Use CONNECTIONS_GET if you need more detail about the chosen registry connection.
4. Enable the registry discovery tools from that connection.
5. Prefer REGISTRY_ITEM_SEARCH or COLLECTION_REGISTRY_APP_SEARCH when available. Otherwise use COLLECTION_REGISTRY_APP_LIST with search-like filters.
6. Use REGISTRY_ITEM_GET or COLLECTION_REGISTRY_APP_GET on the most promising results.
7. Summarize the best matches, key tradeoffs, and which one to install next if the user wants to proceed.

Checks:
- Search by the user's outcome, not just product names.
- Prefer curated Deco Store results first when they satisfy the need.
- Note authentication expectations, verification status, and obvious capability gaps.
- Do not install anything until the user picks a candidate or asks you to proceed.
`,
  },
  {
    name: "inspect-store-item",
    description:
      "Inspect a registry/store result in detail before recommending or installing it.",
    text: `# Inspect store item

Goal: validate that a specific store or registry item actually matches the user's requirements.

Read docs://store.md for evaluation criteria and registry tool patterns.

Recommended tool order:
1. Use CONNECTIONS_LIST to confirm which registry connection should be queried.
2. Enable the relevant registry detail tools from that connection.
3. Use REGISTRY_ITEM_GET or COLLECTION_REGISTRY_APP_GET to inspect the candidate item.
4. If multiple versions are available and a versions tool exists, use REGISTRY_ITEM_VERSIONS or COLLECTION_REGISTRY_APP_VERSIONS.
5. Report whether the item fits the user's use case and what the next step should be.

Checks:
- Confirm the item exposes the capability the user asked for.
- Look for auth requirements, transport type, and tool coverage.
- Prefer verified or clearly maintained items when the registry exposes that signal.
- Call out uncertainty instead of over-promising.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "store",
    uri: "docs://store.md",
    description:
      "How to search registries, compare candidates, and decide what to install.",
    text: `# Store and registry discovery

## Purpose

Use the Deco Store or another registry connection when the user needs a capability that is not already installed.

## Common registry sources

### Deco Store
- Curated official registry.
- Usually the best first place to search.
- Good default when the user wants reliable, common integrations.

### Community registry
- Broader catalog with more variety.
- Useful when Deco Store does not have a match.
- Expect more variation in quality and maintenance.

## Discovery workflow

1. Confirm the user's goal, target system, and any auth or hosting constraints.
2. Find the registry connection that should be queried.
3. Search broadly first.
4. Inspect the most promising items in detail.
5. Recommend the best candidate and only then move to installation.

## Search patterns

- Search by business outcome: "send email", "sync orders", "query postgres".
- Search by product or vendor when the user names one directly.
- Use tags or categories when the registry supports them.
- If search tools are unavailable, use list tools with a filtered query.

## What to evaluate

### Capability fit
- Does the item actually expose the tools the user needs?
- Is it a close fit or only adjacent?

### Trust and maintenance
- Prefer verified, curated, or clearly maintained items when that metadata exists.

### Authentication
- Note whether the item likely requires OAuth, API keys, or no auth.
- Flag cases where setup may require user credentials or admin approval.

### Transport and setup complexity
- Prefer simpler HTTP-based integrations when multiple options are otherwise equivalent.
- Call out if an item looks experimental or operationally heavy.

## After discovery

- Present a short shortlist with the main tradeoffs.
- Ask the user which item to proceed with before installing.
- Once the user chooses, switch to the connection-creation flow.
`,
  },
];

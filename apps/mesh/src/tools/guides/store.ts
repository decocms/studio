import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "store-search",
    description: "Find MCP servers in the Deco Store or a registry.",
    text: `# Search store

Goal: find good candidate connections in the Deco Store or another registry before recommending or installing anything.

Read docs://store.md for registry types, search patterns, and evaluation criteria. Read docs://connections.md if you need a refresher on how installed connections behave after discovery.

Recommended tool order:
1. Use COLLECTION_CONNECTIONS_LIST to find available registry connections such as Deco Store or MCP Registry.
2. If the user has not clearly described the target capability, data source, or authentication constraints, use user_ask.
3. Use COLLECTION_CONNECTIONS_GET if you need more detail about the chosen registry connection.
4. Enable the registry discovery tools from that connection.
5. Prefer REGISTRY_ITEM_SEARCH when available. Otherwise use the registry's list tool with search-like filters.
6. Use REGISTRY_ITEM_GET on the most promising results. Read docs://store-inspect-item.md for detailed inspection criteria.
7. Summarize the best matches, key tradeoffs, and which one to install next.
8. Once the user picks a candidate and asks to install it, read docs://store-install-connection.md and follow that resource before creating the connection.
9. Read docs://install-workflow.md for the complete end-to-end install workflow including transport selection, parameter extraction, and verification.

Checks:
- Search by the user's outcome, not just product names.
- Prefer curated Deco Store results first when they satisfy the need.
- Note authentication expectations, verification status, and obvious capability gaps.
- Do not install anything until the user picks a candidate or asks you to proceed.
`,
  },
  {
    name: "store-install",
    description: "Install an MCP server from a store or registry.",
    text: `# Install MCP server from store

Goal: install a specific MCP server from a registry into the workspace as a working connection.

Read docs://install-workflow.md for the complete end-to-end install workflow including transport selection, parameter extraction, and verification. Read docs://store-install-connection.md for detailed mapping rules when building the connection payload.

Recommended tool order:
1. COLLECTION_CONNECTIONS_LIST — find registry connections and check for duplicates of the target server.
2. Enable registry tools from the chosen registry connection.
3. REGISTRY_ITEM_SEARCH or the registry list tool — find the MCP server by name or capability.
4. REGISTRY_ITEM_GET — load full details for the chosen item.
5. Extract connection parameters per docs://install-workflow.md (transport selection, URL, auth, headers).
6. COLLECTION_CONNECTIONS_CREATE with the extracted payload wrapped in \`{ data: ... }\`.
7. CONNECTION_TEST to verify the new connection is healthy.
8. COLLECTION_CONNECTIONS_GET to confirm the saved result and explain next steps.

Checks:
- Do not install until the user has chosen or confirmed the specific item.
- Prefer HTTP/SSE/Websocket transports over STDIO.
- Do not guess secrets, OAuth values, or env var values — ask the user.
- Treat the install as incomplete until CONNECTION_TEST succeeds or the expected auth step is clear.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "store-install-connection",
    uri: "docs://store-install-connection.md",
    description:
      "How to turn a chosen registry/store item into a created and tested connection.",
    text: `# Install connection from store item

## Goal

Take a registry item the user already chose and convert it into a real connection with COLLECTION_CONNECTIONS_CREATE, then verify it with CONNECTION_TEST.

## Recommended tool order

1. Use COLLECTION_CONNECTIONS_LIST to avoid duplicate installs and confirm the correct registry connection is available.
2. Enable the relevant registry detail tools from that connection.
3. Use REGISTRY_ITEM_GET to load the full chosen item.
4. Derive the connection payload from the registry item instead of inventing values.
5. Use COLLECTION_CONNECTIONS_CREATE with the derived connection fields.
6. Use CONNECTION_TEST before treating the connection as usable.
7. Use COLLECTION_CONNECTIONS_GET if you need to confirm the saved result or explain next steps.

## How to map a registry item into COLLECTION_CONNECTIONS_CREATE

### Base fields
- title: prefer the store-friendly title from the item.
- description: copy the server description when available.
- icon: use the item or publisher icon when available.
- app_name and app_id: copy the registry/server identifiers when present.

### Transport selection
- Always prefer remote endpoints (HTTP, SSE, or Websocket) over package commands. STDIO transport is disabled by default in production.
- If the item exposes a remote endpoint, create an HTTP, SSE, or Websocket connection using that remote's type and URL.
- If the item only exposes a package command, warn the user that STDIO transport may be unavailable in production before creating the connection.
- If the item exposes multiple remotes or packages, prefer remote transports. Ask the user before choosing unless one is clearly the default.
- If the item exposes neither a usable remote nor a package command, stop and report that the item cannot be installed automatically.

### HTTP, SSE, or Websocket shape
- connection_type: the remote transport type.
- connection_url: the remote URL.
- connection_headers: only include headers if the registry item explicitly provides them.
- connection_token: leave null unless the user already provided a required token.

### STDIO shape
- connection_type: STDIO.
- connection_headers: include command, args, cwd, and envVars when the item provides them.
- For package-based installs, prefer the registry-provided command/package info over reconstructing it manually.
- If env vars are required but values are missing, ask the user before creation.

### Auth and configuration metadata
- oauth_config: copy it from the registry item when present.
- configuration_state: copy them when the registry item includes them.
- metadata: preserve store provenance such as source=store, registry item ID, verification state, repository, and other useful install metadata when available.

## Checks

- Do not create the connection until the user has chosen the specific item.
- Do not guess secrets, OAuth values, headers, or env var values.
- Prefer copying structured install data from the registry item over translating descriptions into guessed config.
- Treat the install as incomplete until CONNECTION_TEST succeeds or the expected next auth step is explicit.
`,
  },
  {
    name: "store-inspect-item",
    uri: "docs://store-inspect-item.md",
    description:
      "How to inspect a registry/store item in detail before recommending or installing it.",
    text: `# Inspect store item

## Goal

Validate that a specific store or registry item actually matches the user's requirements.

## Recommended tool order

1. Use COLLECTION_CONNECTIONS_LIST to confirm which registry connection should be queried.
2. Enable the relevant registry detail tools from that connection.
3. Use REGISTRY_ITEM_GET to inspect the candidate item.
4. If multiple versions are available and a versions tool exists, use REGISTRY_ITEM_VERSIONS.
5. Report whether the item fits the user's use case and what the next step should be.

## Checks

- Confirm the item exposes the capability the user asked for.
- Look for auth requirements, transport type, and tool coverage.
- Prefer verified or clearly maintained items when the registry exposes that signal.
- Call out uncertainty instead of over-promising.
`,
  },
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
- Once the user chooses, read docs://store-install-connection.md and switch to the connection-creation flow.
`,
  },
  {
    name: "install-workflow",
    uri: "docs://install-workflow.md",
    description:
      "Complete end-to-end workflow for installing an MCP server from a registry, including transport selection, parameter extraction, and verification.",
    text: `# Install workflow

## Purpose

End-to-end guide for programmatically installing an MCP server from a registry into the workspace. Covers everything from registry discovery through post-install verification.

## 1. Find registry connections

Use COLLECTION_CONNECTIONS_LIST to discover available registries in the workspace. Look for connections that expose tools like REGISTRY_ITEM_SEARCH or REGISTRY_ITEM_LIST. Common registries include the Deco Store and community registries.

Also check whether the target server is already installed to avoid duplicates.

## 2. Search the registry

Use REGISTRY_ITEM_SEARCH when available — it supports keyword and capability-based queries. Otherwise use the registry's list tool with search-like filters.

Search by the user's intended outcome (e.g. "send email", "query database") rather than just product names.

## 3. Inspect the registry item

Use REGISTRY_ITEM_GET on the chosen item. The response typically includes:
- \`server.remotes[]\` — remote transport endpoints (HTTP, SSE, Websocket)
- \`server.packages[]\` — STDIO package commands (npx, uvx, docker, etc.)
- \`_meta["mcp.mesh"]\` — Mesh-specific metadata (oauth_config, configuration_state)
- Tool listings, auth requirements, and publisher info

## 4. Extract connection parameters

### Transport selection rules
1. **Prefer remote transports** (HTTP, SSE, Websocket) over STDIO packages.
2. If multiple remotes exist, prefer HTTP > SSE > Websocket unless one is clearly the default.
3. Only use STDIO if no remote endpoint is available. Warn the user that STDIO may be unavailable in production.
4. If neither remote nor package is available, stop and report that the item cannot be installed.

### HTTP / SSE / Websocket payload template
\`\`\`json
{
  "data": {
    "title": "<item title>",
    "description": "<server description>",
    "icon": "<item or publisher icon>",
    "app_name": "<registry/server identifier>",
    "app_id": "<registry item ID>",
    "connection_type": "<HTTP | SSE | Websocket>",
    "connection_url": "<remote URL>",
    "connection_headers": null,
    "connection_token": null,
    "oauth_config": "<from _meta if present>",
    "configuration_state": "<from _meta if present>",
    "metadata": {
      "source": "store",
      "registry_item_id": "<item ID>",
      "verified": "<verification state>"
    }
  }
}
\`\`\`

### STDIO payload template
\`\`\`json
{
  "data": {
    "title": "<item title>",
    "description": "<server description>",
    "icon": "<item or publisher icon>",
    "app_name": "<registry/server identifier>",
    "app_id": "<registry item ID>",
    "connection_type": "STDIO",
    "connection_headers": {
      "command": "<package command>",
      "args": ["<arguments>"],
      "cwd": "<working directory if specified>",
      "envVars": { "<KEY>": "<value or ask user>" }
    },
    "metadata": {
      "source": "store",
      "registry_item_id": "<item ID>"
    }
  }
}
\`\`\`

### Auth config mapping
- Copy \`oauth_config\` from the registry item when present.
- Copy \`configuration_state\` and \`configuration_scopes\` when available.
- Never guess OAuth client IDs, secrets, or tokens — ask the user if required values are missing.
- For API key auth, prompt the user for the key value.

## 5. Create the connection

Use COLLECTION_CONNECTIONS_CREATE with the payload from step 4. Always wrap in \`{ data: ... }\`.

## 6. Verify

Use CONNECTION_TEST on the new connection. Expect \`{ healthy: true, latencyMs: ... }\` on success.
- If the connection requires OAuth, the test may fail until the user completes the auth flow — explain the next step.
- If it fails for other reasons, check the connection_url, headers, and transport type.

## 7. Confirm

Use COLLECTION_CONNECTIONS_GET to retrieve the saved connection and confirm its final state. Report the result to the user.

## Common patterns

### Install by name
User says "install Slack MCP" → search by "Slack" → pick the best match → extract and create.

### Install by capability
User says "I need to send emails" → search by "send email" → evaluate results → pick and install.

### OAuth handling
If the registry item includes oauth_config, copy it into the connection. After creation, CONNECTION_TEST may return unhealthy until the user completes the OAuth consent flow. Guide them to the auth URL if available.

### Missing env vars
For STDIO packages that require environment variables, list the required vars and ask the user for values before creating the connection. Do not use placeholder or empty values.
`,
  },
];

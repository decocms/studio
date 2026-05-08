import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "connections-create",
    title: "Create Connections",
    description: "Add a new MCP server connection to the workspace.",
    text: `# Create connection

Goal: install a new connection, capture the correct authentication method, and confirm it is healthy before treating it as usable.

Read docs://connections.md for authentication modes, lifecycle guidance, and error patterns. Read docs://platform.md if you need the broader model.

Recommended tool order:
1. Use COLLECTION_CONNECTIONS_LIST to avoid duplicate installs and inspect similar existing connections.
2. If the user has not provided a server URL or auth details, use user_ask.
3. Use COLLECTION_CONNECTIONS_CREATE with the MCP server URL and required authentication payload.
4. Use CONNECTION_TEST to verify the connection is reachable and healthy.
5. Use COLLECTION_CONNECTIONS_GET if you need the saved details for follow-up.

Checks:
- Confirm the server URL before creation.
- Choose the correct auth type from docs://connections.md.
- If the connection requires user interaction, explain that an OAuth or credential step is needed.
- Treat a connection as usable only after CONNECTION_TEST succeeds.
- Surface any missing auth, timeout, or schema issues clearly.
`,
  },
  {
    name: "connections-update",
    title: "Update Connections",
    description: "Change an existing connection's settings or credentials.",
    text: `# Update connection

Goal: modify an existing connection safely and verify the updated configuration works.

Read docs://connections.md for connection lifecycle and troubleshooting guidance.

Recommended tool order:
1. Use COLLECTION_CONNECTIONS_LIST or COLLECTION_CONNECTIONS_GET to identify the target connection.
2. Use user_ask if the intended URL, title, or auth change is not explicit.
3. Use COLLECTION_CONNECTIONS_UPDATE with only the fields that should change.
4. Use CONNECTION_TEST to validate the updated configuration.
5. Use COLLECTION_CONNECTIONS_GET to confirm the final saved state if needed.

Checks:
- Do not overwrite authentication blindly; confirm replacement credentials when needed.
- If a change may disrupt existing agents, warn before applying it.
- Re-test after every meaningful config or auth change.
- Report whether the connection is healthy after the update, not just whether the update call succeeded.
`,
  },
  {
    name: "connections-troubleshoot",
    title: "Troubleshoot Connections",
    description: "Fix a broken or unhealthy connection.",
    text: `# Troubleshoot connection

Goal: determine whether a connection issue is caused by missing authentication, server reachability, bad configuration, or missing tools.

Read docs://connections.md for common errors, lifecycle states, and troubleshooting patterns.

Recommended tool order:
1. Use COLLECTION_CONNECTIONS_LIST to find the connection and its current status.
2. Use COLLECTION_CONNECTIONS_GET for detailed configuration and metadata.
3. Use CONNECTION_TEST to reproduce or validate the health state.
4. If the failure suggests missing credentials or incorrect setup, use user_ask before changing anything.
5. Use COLLECTION_CONNECTIONS_UPDATE only after identifying a concrete remediation.

Checks:
- Distinguish between auth errors, network failures, and missing-tool expectations.
- Do not guess fixes; tie each recommendation to the observed error.
- If re-authentication is likely required, say that explicitly.
- If the connection is healthy but a tool is missing, verify whether the tool was ever exposed by that server.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "connections",
    uri: "docs://connections.md",
    description:
      "Connection auth types, lifecycle, testing, and troubleshooting.",
    text: `# Connections

## Purpose

Connections attach Deco CMS to external MCP servers and expose their tools to agents and automations.

## Authentication types

### OAuth
- Use when the provider supports an authorization flow.
- Expect a user-facing browser or consent step.
- Re-authentication may be required after token expiry or revocation.

### API token
- Use when the provider issues static or semi-static credentials.
- Validate which header or secret field the server expects.
- Treat token replacement as a consequential update.

### No auth
- Some public or internal services require no credentials.
- Still verify reachability and health after creation.

## Connection lifecycle

1. Discover the MCP server URL and auth requirements.
2. Create the connection.
3. Test the connection immediately.
4. Attach it to agents or workflows only after it is healthy.
5. Re-test after updates or when users report failures.

## Common errors

### 401 / unauthorized
- Credentials are missing, expired, or invalid.
- Likely action: re-authenticate or replace the token.

### Timeout / unreachable
- The MCP server may be down, slow, or blocked by networking.
- Likely action: re-run the health check and verify the server URL.

### Missing tools
- The server may not expose the expected tool.
- The connection may be healthy, but the capability assumption is wrong.
- Confirm with the tool catalog before promising the capability.

### Validation or schema errors
- Input shape or auth payload does not match what the server expects.
- Re-check required fields before retrying.

## Troubleshooting sequence

1. Inspect the connection metadata.
2. Run a health test.
3. Identify whether the failure is auth, reachability, or capability-related.
4. Apply the smallest corrective change.
5. Test again before closing the issue.
`,
  },
];

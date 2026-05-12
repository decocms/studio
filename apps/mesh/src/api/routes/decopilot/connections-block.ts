/**
 * Builds the <available-connections> + <connections-usage> system-prompt
 * block. Lists the current Virtual MCP's connections and the short names
 * of every tool each one exposes. The usage block teaches the model how
 * to activate them via enable_tool.
 *
 * Returns null when there are no tools to expose so the caller can drop
 * the block from the prompt entirely.
 */

export interface ConnectionsBlockTool {
  /** Original MCP tool name (with gateway prefix). */
  rawName: string;
  /** Safe name as exposed to the model (collision-prefixed only when needed). */
  safeName: string;
  /** Gateway connection id from MCP _meta.gatewayClientId. */
  connectionId: string;
}

const USAGE = `<connections-usage>
Tools live inside connections. Activate them with enable_tool before
calling: enable_tool({ tools: ["send_email"] }). Pass short tool names —
if a short name is ambiguous across connections, the call fails with a
list of candidates; pass the fully-qualified id to disambiguate. Never
guess tool names or parameters — only call tools that appear above.

Use sandbox to run JavaScript combining multiple enabled tools:
\`\`\`
export default async function(tools) {
  const result = await tools.tool_name({ param: "value" });
  return result;
}
\`\`\`

On errors:
- "Not connected" / "401" — the underlying service may need re-authentication
- "Tool not found" — re-check <available-connections> and enable the tool
- Schema validation — re-check the tool's input schema
</connections-usage>`;

function csvField(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes(";")
  ) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function shortNameOf(safeName: string, connectionId: string): string {
  const prefix = `${connectionId}_`;
  return safeName.startsWith(prefix) ? safeName.slice(prefix.length) : safeName;
}

export function buildConnectionsBlock(
  tools: ConnectionsBlockTool[],
  connectionTitleMap: Map<string, string>,
): string | null {
  if (tools.length === 0) return null;

  const groups = new Map<string, { title: string; shortNames: string[] }>();
  for (const t of tools) {
    const title = connectionTitleMap.get(t.connectionId) ?? t.connectionId;
    let group = groups.get(t.connectionId);
    if (!group) {
      group = { title, shortNames: [] };
      groups.set(t.connectionId, group);
    }
    group.shortNames.push(shortNameOf(t.safeName, t.connectionId));
  }

  const sorted = [...groups.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );

  const rows = sorted.map(({ title, shortNames }) => {
    const joined = shortNames.join("; ");
    return `${csvField(title)},${csvField(joined)}`;
  });

  return (
    `\n\n<available-connections>\nname,tools\n${rows.join("\n")}\n</available-connections>` +
    `\n\n${USAGE}`
  );
}

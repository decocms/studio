/** One entry of an MCP tool's `inputSchema.properties` — the shape the tool
 *  detail panel reads to lay a tool's arguments out. The form that used to
 *  live here belonged to the home tile drawer, which is gone. */
export interface ToolInputProperty {
  type: string;
  description?: string;
}

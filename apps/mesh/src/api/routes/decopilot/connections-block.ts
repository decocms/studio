export interface ConnectionsBlockTool {
  rawName: string;
  safeName: string;
  connectionId: string;
}

export function buildConnectionsBlock(
  _tools: ConnectionsBlockTool[],
  _connectionTitleMap: Map<string, string>,
): string | null {
  throw new Error("not implemented");
}

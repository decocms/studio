/** The org's connections opened for a read-only pass. */

import type { ToolSet } from "ai";
import type { StudioContext } from "../../core/studio-context";
import { toolsFromMCP } from "../../harnesses/lib/decopilot/mcp-tools";
import { clientFromConnection } from "../../mcp-clients";
import { isGroundingTool, survivingFailure } from "../blog/site-tools";
import type { ConnectionEntity } from "../connection/schema";

const TOOL_CALL_MS = 20_000;
/** A connection that takes longer than this to list its tools is skipped. */
const OPEN_MS = 10_000;
/** Provider tool names stop at 64 characters. */
const MAX_TOOL_NAME = 64;

/** Studio's own well-known connections hold nothing about the brand. */
const PLATFORM_SUFFIXES = [
  "_self",
  "_registry",
  "_community-registry",
  "_dev-assets",
];

/** The connections worth reading: Studio's own and virtual MCPs hold nothing about the brand. */
export function storeConnections(
  connections: readonly ConnectionEntity[],
): ConnectionEntity[] {
  return connections.filter(
    (connection) =>
      connection.connection_type !== "VIRTUAL" &&
      !PLATFORM_SUFFIXES.some((suffix) => connection.id.endsWith(suffix)),
  );
}

/** Each connection's read-only tools; `onResult` hears every result with the connection it came from. */
export async function connectionTools(
  ctx: StudioContext,
  connections: readonly ConnectionEntity[],
  onResult: (connection: ConnectionEntity, raw: string) => void,
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const open = async (connection: ConnectionEntity, index: number) => {
    const client = await clientFromConnection(connection, ctx, false);
    try {
      const { tools } = await toolsFromMCP(
        client,
        new Map(),
        undefined,
        "auto",
        { isToolVisible: isGroundingTool, timeoutMs: TOOL_CALL_MS },
      );
      const named = Object.entries(tools).map(([name, tool]) => {
        const key = `c${index}_${name}`.slice(0, MAX_TOOL_NAME);
        return [
          key,
          survivingFailure(tool, key, (_, raw) => onResult(connection, raw)),
        ] as const;
      });
      return { client, named };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  };
  const opened = await Promise.allSettled(
    connections.map((connection, index) => {
      const opening = open(connection, index);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Close it whenever it does answer, since nobody will use it.
          opening.then(({ client }) => client.close()).catch(() => {});
          reject(new Error(`${connection.id} took too long to list tools`));
        }, OPEN_MS);
      });
      return Promise.race([opening, late]).finally(() => clearTimeout(timer));
    }),
  );
  const ready = opened.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  return {
    tools: Object.fromEntries(ready.flatMap(({ named }) => named)),
    close: async () => {
      await Promise.allSettled(ready.map(({ client }) => client.close()));
    },
  };
}

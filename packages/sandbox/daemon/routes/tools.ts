import { type McpEndpoint, syncToolCatalog } from "../tools-catalog";
import { jsonResponse, parseJsonBody } from "./body-parser";

export interface ToolsDeps {
  appRoot: string;
  repoDir: string;
  onWorkingTreeWrite?: (filePath: string) => void;
}

/**
 * POST /_sandbox/tools/sync — body `{ url, headers }` (the run's Virtual MCP
 * endpoint). Lists its tools and writes a JSON Schema catalog under
 * `<repo>/.deco/tools/`. Idempotent; overwrites. Returns `{ count, tools }`.
 */
export function makeToolsSyncHandler(deps: ToolsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    const mcp = body as Partial<McpEndpoint>;
    if (
      typeof mcp?.url !== "string" ||
      typeof mcp.headers !== "object" ||
      mcp.headers === null
    ) {
      return jsonResponse(
        {
          error: "body must be { url: string, headers: Record<string,string> }",
        },
        400,
      );
    }

    try {
      const result = await syncToolCatalog(
        { url: mcp.url, headers: mcp.headers as Record<string, string> },
        { appRoot: deps.appRoot, repoDir: deps.repoDir },
      );
      deps.onWorkingTreeWrite?.(".deco/tools");
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  };
}

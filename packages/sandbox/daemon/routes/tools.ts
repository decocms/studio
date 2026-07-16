import {
  fetchToolCatalog,
  type McpEndpoint,
  writeEndpointFile,
  writeToolCatalog,
} from "../tools-catalog";
import { jsonResponse, parseJsonBody } from "./body-parser";

export interface ToolsDeps {
  appRoot: string;
  repoDir: string;
}

/**
 * POST /_sandbox/tools/sync — body `{ url, headers, expiresAt? }` (the run's
 * Virtual MCP endpoint). Writes the endpoint file, then lists the endpoint's
 * tools and writes a JSON Schema catalog under `<repo>/.deco/tools/`.
 * Idempotent; overwrites and prunes stale files. Returns `{ count, tools }`.
 * 502 when the endpoint is unreachable/errors (the endpoint file is still
 * written), 500 when the local write fails.
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

    const endpoint = {
      url: mcp.url,
      headers: mcp.headers as Record<string, string>,
      ...(typeof mcp.expiresAt === "number"
        ? { expiresAt: mcp.expiresAt }
        : {}),
    };

    try {
      await writeEndpointFile(endpoint, {
        appRoot: deps.appRoot,
        repoDir: deps.repoDir,
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    let tools: Awaited<ReturnType<typeof fetchToolCatalog>>;
    try {
      tools = await fetchToolCatalog(endpoint);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    try {
      const result = await writeToolCatalog(tools, {
        appRoot: deps.appRoot,
        repoDir: deps.repoDir,
      });
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  };
}

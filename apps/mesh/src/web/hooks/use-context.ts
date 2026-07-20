/**
 * Context Hook
 *
 * Provides dynamic context for the AI assistant based on:
 * - Current route parameters (connection, collection, item)
 * - The Library file the user currently has open (`?main=library-file:…`
 *   side tab, or `?preview=`/`?skill=`/`?brand=` panel/dialog)
 * - Selected virtual MCP (agent) and its custom instructions
 *
 * This hook only returns context information; base system instructions
 * are handled server-side in models.ts (DECOPILOT_SYSTEM_PROMPT).
 */

import { useMatch, useSearch } from "@tanstack/react-router";
import { basename, orgFsMountPath } from "@/web/layouts/library/location";
import { parseLibraryFileTabId } from "@/web/layouts/main-panel-tabs/tab-id";

/**
 * Hook that generates context for the AI assistant based on current state
 *
 * @param virtualMcpId - The selected virtual MCP (agent) ID (optional)
 * @returns Context string to be sent to the backend
 */
export function useContext(virtualMcpId?: string | null): string {
  // Extract route parameters directly using useParams
  const collectionMatch = useMatch({
    from: "/shell/$org/settings/connections/$appSlug/$collectionName/$itemId",
    shouldThrow: false,
  });

  // Library file the user currently has open. Desktop opens it as a
  // main-panel side tab (`?main=library-file:<encoded browse path>`); the
  // Library's own right panel and the mobile dialog use the raw browse-path
  // params (`?preview=`/`?skill=`/`?brand=`). Precedence mirrors the panel's
  // own (preview › skill › brand); the side tab wins when both are set.
  const search = useSearch({ strict: false }) as {
    main?: string | 0;
    preview?: string;
    skill?: string;
    brand?: string;
  };
  const openFilePath =
    (typeof search.main === "string"
      ? parseLibraryFileTabId(search.main)?.path
      : undefined) ??
    search.preview ??
    search.skill ??
    search.brand ??
    null;

  const contextParts: string[] = [];

  // Add virtual MCP context if selected
  if (virtualMcpId) {
    contextParts.push(`### Selected Agent
- ID: ${virtualMcpId}`);
  }

  // Point the assistant at the file the user is looking at, so an ambiguous
  // request ("change the h1") resolves to it instead of guessing. We give the
  // sandbox mount path so the agent can read/edit it directly with its file
  // tools — the browse path alone isn't where those tools operate.
  if (openFilePath) {
    const mountPath = orgFsMountPath(openFilePath);
    contextParts.push(`### Currently Open File
The user has this file open in the Library and is most likely referring to it:
- Name: ${basename(openFilePath)}
- Library path: ${openFilePath}${
      mountPath
        ? `
- Read/edit it with your file tools at: \`${mountPath}\``
        : ""
    }

When a request is ambiguous about which file or resource it targets (e.g. "change the h1", "fix this", "what's in this file", "update the title"), assume it means this file unless the user clearly indicates otherwise.`);
  }

  // Add route context based on available params
  const routeContextParts: string[] = [];

  if (collectionMatch?.params.appSlug) {
    routeContextParts.push(
      `- Connection ID: ${collectionMatch?.params.appSlug}`,
    );
  }

  if (collectionMatch?.params.collectionName) {
    routeContextParts.push(
      `- Collection: ${collectionMatch?.params.collectionName}`,
    );
  }

  if (collectionMatch?.params.itemId) {
    routeContextParts.push(`- Item ID: ${collectionMatch?.params.itemId}`);
  }

  if (routeContextParts.length > 0) {
    contextParts.push(`### Current Resource
The user is viewing the following resource:
${routeContextParts.join("\n")}

Help the user understand and work with this resource.`);
  }

  return contextParts.join("\n\n");
}

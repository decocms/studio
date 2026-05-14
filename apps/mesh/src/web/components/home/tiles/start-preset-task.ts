/**
 * Kick off a preset task from the home — creates a new task id, primes
 * the autosend cache with the prompt, optionally activates the matching
 * home tile, then navigates to the new chat.
 */

import {
  getWellKnownDecopilotVirtualMCP,
  type ProjectLocator,
} from "@decocms/mesh-sdk";
import type { useNavigate } from "@tanstack/react-router";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/web/lib/autosend";
import type { TileId } from "./types";

function buildDoc(prompt: string) {
  return {
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: prompt }],
      },
    ],
  };
}

interface StartArgs {
  prompt: string;
  orgId: string;
  orgSlug: string;
  locator: ProjectLocator;
  navigate: ReturnType<typeof useNavigate>;
  /** When provided, the matching home tile is marked active. */
  activate?: (id: TileId, taskId: string) => void;
  tileId?: TileId;
}

export function startPresetTask({
  prompt,
  orgId,
  orgSlug,
  locator,
  navigate,
  activate,
  tileId,
}: StartArgs) {
  const taskId = crypto.randomUUID();
  const targetVmcp = getWellKnownDecopilotVirtualMCP(orgId).id;
  writeStoredAutosend(sessionStorage, locator, taskId, {
    tiptapDoc: buildDoc(prompt),
  });
  if (tileId && activate) activate(tileId, taskId);
  navigate({
    to: "/$org/$taskId",
    params: { org: orgSlug, taskId },
    search: { virtualmcpid: targetVmcp, autosend: AUTOSEND_QUERY_VALUE },
  });
}

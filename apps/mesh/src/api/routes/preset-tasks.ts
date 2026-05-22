/**
 * Preset Task API Routes
 *
 * Org-scoped:
 *   GET  /preset-tasks                  → visible cards (display + action + state)
 *   POST /preset-tasks/:taskId/start    → run the def's start(), kick decopilot,
 *                                         auto-pin a tile on the user's home
 *                                         board, return { taskId, virtualMcpId }
 *   POST /preset-tasks/:taskId/dismiss  → mark dismissed in KV state
 *
 * Mounted under `/api/:org` so `resolveOrgFromPath` populates
 * `meshContext.organization`.
 *
 * The `/start` route is the server-side analog of the chat path's
 * `POST /:org/decopilot/threads/:threadId/messages`: it mints a fresh
 * taskId via `dispatchRun`, primes the thread with the definition's seed
 * messages, and fans the agent stream out through `streamBuffer`. The FE
 * then navigates to `/$org/$taskId` and attaches via SSE — same as it
 * would for any other running thread.
 */

import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import type { CancelBroadcast } from "@/api/routes/decopilot/cancel-broadcast";
import {
  dispatchRun,
  type DispatchRunInput,
} from "@/api/routes/decopilot/dispatch-run";
import { resolvePerRequestModels } from "@/api/routes/decopilot/routes";
import type { RunRegistry } from "@/api/routes/decopilot/run-registry";
import type { StreamBuffer } from "@/api/routes/decopilot/stream-buffer";
import { getOrgPrimaryBrand } from "@/agents/brand-context";
import { ensureSystemHealthAgent } from "@/agents/system-health";
import { getVisiblePresetTasks, resolveDefinition } from "@/preset-tasks";
import type { PresetTaskRegistry } from "@/preset-tasks";
import {
  BRAND_CONTEXT_PRESET_ID,
  startBrandContextWorkflow,
} from "@/preset-tasks/brand-context-workflow";
import {
  type HomeBoardStore,
  type HomeBoardTile,
  pickAutoPinSlot,
} from "@/storage/home-board";
import type { PresetTaskState, PresetTaskStore } from "@/storage/preset-tasks";
import { generatePrefixedId } from "@/shared/utils/generate-id";

interface PresetTaskRouteDeps {
  store: PresetTaskStore;
  registry: PresetTaskRegistry;
  homeBoardStore: HomeBoardStore;
  runRegistry: RunRegistry;
  streamBuffer: StreamBuffer;
  cancelBroadcast: CancelBroadcast;
}

/** Mirrors `SIZE_PRESETS.L` / `GRID_COLS` on the FE. */
const DEFAULT_TILE_W = 2;
const DEFAULT_TILE_H = 1;
const BOARD_GRID_COLS = 3;

type Variables = {
  meshContext: MeshContext;
};

export function createPresetTaskRoutes(deps: PresetTaskRouteDeps) {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/preset-tasks", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization required" }, 400);
    }
    const tasks = await getVisiblePresetTasks(
      orgId,
      deps.store,
      deps.registry,
      mesh,
    );
    return c.json({ tasks });
  });

  app.post("/preset-tasks/:taskId/start", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);

    const presetId = c.req.param("taskId");
    const rawDef = deps.registry.get(presetId);
    if (!rawDef) return c.json({ error: "Unknown task" }, 404);
    // Apply resolve() so morphing tasks (e.g. brand-context's
    // setup ↔ confirm faces) use the right seed for current state.
    const prevState = await deps.store.get(orgId, presetId);
    const def = await resolveDefinition(
      rawDef,
      { organizationId: orgId },
      prevState,
      mesh,
    );
    if (def.action.kind !== "preset" || !def.start) {
      return c.json({ error: "Preset is not startable" }, 400);
    }

    let seed: Awaited<ReturnType<NonNullable<typeof def.start>>>;
    try {
      seed = await def.start({ organizationId: orgId }, mesh);
    } catch (err) {
      console.error(`[preset-tasks] start("${presetId}") failed`, err);
      const message = err instanceof Error ? err.message : "Failed to start";
      return c.json({ error: message }, 500);
    }

    const models = await resolvePerRequestModels(mesh, undefined, undefined);

    // `dispatchRun` / `createMemory` require the thread row to already exist —
    // the chat path goes through COLLECTION_THREADS_CREATE for this. Server-
    // initiated runs do the same minimum here: mint a taskId and insert the
    // row before kicking the agent. Branch stays null because the well-known
    // decopilot vmcp has no github-repo metadata to derive one from.
    const taskId = generatePrefixedId("thrd");
    await mesh.storage.threads.create({
      id: taskId,
      title: def.display.title,
      virtual_mcp_id: seed.virtualMcpId,
      status: "in_progress",
      created_by: userId,
    });

    // For the brand-context preset, setup mode (no brand yet) is owned
    // by a DBOS workflow that completes when the LLM calls
    // `brand_context_setup`. Confirm mode shares the agent id but
    // doesn't need a workflow — `confirm_brand` writes preset state
    // directly. Start the workflow BEFORE the agent run so the
    // workflowID is persisted before the LLM can fire the tool.
    let dbosWorkflowId: string | undefined;
    if (presetId === BRAND_CONTEXT_PRESET_ID) {
      const existingBrand = await getOrgPrimaryBrand(orgId, mesh);
      if (!existingBrand) {
        try {
          const handle = await startBrandContextWorkflow({
            organizationId: orgId,
            taskId,
          });
          dbosWorkflowId = handle.workflowID;
        } catch (err) {
          console.error(
            `[preset-tasks] failed to start brand-context workflow`,
            err,
          );
          // Continue without the handle — the LLM can still extract via
          // the tool; the workflow only owned auto-completion, and the
          // resolver flips the card to confirm-mode on next load.
        }
      }
    }

    const state: PresetTaskState = {
      ...prevState,
      status: "started",
      startedAt: new Date().toISOString(),
      workflowRunId: taskId,
      dbosWorkflowId,
    };
    await deps.store.set(orgId, presetId, state);

    const input: DispatchRunInput = {
      messages: seed.messages,
      models,
      agent: { id: seed.virtualMcpId },
      temperature: 0.5,
      toolApprovalLevel: "auto",
      mode: "default",
      organizationId: orgId,
      userId,
      taskId,
    };

    await dispatchRun(input, mesh, {
      runRegistry: deps.runRegistry,
      streamBuffer: deps.streamBuffer,
      cancelBroadcast: deps.cancelBroadcast,
    });

    // Auto-pin a tile on the user's home board. The FE's GET /home-board
    // picks this up; the per-preset body renderer reads from preset state
    // (status/output) so the tile stays in sync as the workflow advances.
    // Skip if the user already has a tile for this preset — re-running a
    // preset shouldn't multiply tiles.
    try {
      const board = await deps.homeBoardStore.get(orgId, userId);
      const existing = board.tiles.find((t) => t.presetId === presetId);
      if (!existing) {
        const slot = pickAutoPinSlot(
          board.tiles,
          { w: DEFAULT_TILE_W, h: DEFAULT_TILE_H },
          BOARD_GRID_COLS,
        );
        const tile: HomeBoardTile = {
          id: generatePrefixedId("tile"),
          presetId,
          taskId,
          virtualMcpId: seed.virtualMcpId,
          x: slot.x,
          y: slot.y,
          w: DEFAULT_TILE_W,
          h: DEFAULT_TILE_H,
        };
        await deps.homeBoardStore.addTile(orgId, userId, tile);
      } else {
        // Re-run: keep the same tile (and slot) but point it at the new
        // thread so clicking the tile lands in the active run.
        await deps.homeBoardStore.addTile(orgId, userId, {
          ...existing,
          taskId,
          virtualMcpId: seed.virtualMcpId,
        });
      }
    } catch (err) {
      console.error(
        `[preset-tasks] auto-pin failed for preset "${presetId}"`,
        err,
      );
      // Non-fatal: the run still proceeds. User can re-trigger to pin.
    }

    return c.json(
      {
        taskId,
        virtualMcpId: seed.virtualMcpId,
      },
      202,
    );
  });

  // Server-side install step for presets that require an OAuth handshake
  // before the thread can start (currently: error-monitoring + system
  // health). Idempotent: re-calling returns the same connection / vmcp
  // ids. The FE then runs the OAuth dance against the proxy URL using
  // the returned connection id, persists the token via
  // /connections/:id/oauth-token, and finally POSTs /start.
  app.post("/preset-tasks/:taskId/install", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);

    const presetId = c.req.param("taskId");
    if (presetId !== "error-monitoring") {
      return c.json({ error: "Preset is not installable" }, 400);
    }

    try {
      const virtualMcpId = await ensureSystemHealthAgent(orgId, userId, mesh);
      const wrappers = await mesh.storage.virtualMcps.findById(virtualMcpId);
      const connectionId = wrappers?.connections[0]?.connection_id ?? null;
      if (!connectionId) {
        return c.json({ error: "System health connection missing" }, 500);
      }
      return c.json({ connectionId, virtualMcpId });
    } catch (err) {
      console.error(`[preset-tasks] install("${presetId}") failed`, err);
      const message = err instanceof Error ? err.message : "Failed to install";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/preset-tasks/:taskId/dismiss", async (c) => {
    const orgId = c.get("meshContext").organization?.id;
    if (!orgId) {
      return c.json({ error: "Organization required" }, 400);
    }
    const taskId = c.req.param("taskId");
    const def = deps.registry.get(taskId);
    if (!def) {
      return c.json({ error: "Unknown task" }, 404);
    }
    if (def.dismissible === false) {
      return c.json({ error: "Task is not dismissible" }, 400);
    }
    const prev = await deps.store.get(orgId, taskId);
    const state: PresetTaskState = {
      ...prev,
      status: "dismissed",
      dismissedAt: new Date().toISOString(),
    };
    await deps.store.set(orgId, taskId, state);
    return c.json({ taskId, state });
  });

  return app;
}

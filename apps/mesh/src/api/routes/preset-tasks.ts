/**
 * Preset Task API Routes
 *
 * Org-scoped:
 *   GET  /preset-tasks                  → visible cards (display + action + state)
 *   POST /preset-tasks/:taskId/start    → run the def's start(), kick decopilot,
 *                                         return { taskId, tileType? }
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
import { getVisiblePresetTasks } from "@/preset-tasks";
import type { PresetTaskRegistry } from "@/preset-tasks";
import {
  BRAND_CONTEXT_PRESET_ID,
  startBrandContextWorkflow,
} from "@/preset-tasks/brand-context-workflow";
import type { PresetTaskState, PresetTaskStore } from "@/storage/preset-tasks";
import { generatePrefixedId } from "@/shared/utils/generate-id";

interface PresetTaskRouteDeps {
  store: PresetTaskStore;
  registry: PresetTaskRegistry;
  runRegistry: RunRegistry;
  streamBuffer: StreamBuffer;
  cancelBroadcast: CancelBroadcast;
}

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
    const def = deps.registry.get(presetId);
    if (!def) return c.json({ error: "Unknown task" }, 404);
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

    const models = await resolvePerRequestModels(mesh, undefined);

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

    // For the brand-context preset the lifecycle is owned by a DBOS
    // workflow that completes when the LLM calls `BRAND_CONTEXT_SETUP`.
    // Start it BEFORE the agent run so the workflowID is persisted on the
    // preset state before the LLM can possibly fire the tool — otherwise
    // a fast model call could race the state write and find no handle.
    let dbosWorkflowId: string | undefined;
    if (presetId === BRAND_CONTEXT_PRESET_ID) {
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
        // Continue without the workflow handle — the LLM can still extract
        // via the tool, the preset card just won't auto-dismiss; the
        // isApplicable check (no brand_context row) catches it next refresh.
      }
    }

    const prev = await deps.store.get(orgId, presetId);
    const state: PresetTaskState = {
      ...prev,
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

    return c.json(
      {
        taskId,
        tileType: def.action.tileType,
        virtualMcpId: seed.virtualMcpId,
      },
      202,
    );
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

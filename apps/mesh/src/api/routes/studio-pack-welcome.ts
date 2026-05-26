/**
 * Studio Pack Welcome
 *
 * `POST /api/:org/studio-pack-welcome/:agentId/:taskId`
 *
 * Lazily materializes a Studio Pack agent's state-aware welcome into its
 * pre-seeded welcome thread (`thrd_welcome_<agentId>`). The thread itself
 * is created empty at install time by `createWelcomeThreadsStep`; the
 * greeting is *not* persisted at install so the message can pivot on org
 * state at first open (no-brand-yet ⇢ user_ask for URL; has-brand ⇢ "what
 * would you like to do?").
 *
 * Idempotent: if the thread already has any message, returns no-op so
 * concurrent clients can't race a duplicate insert. The well-known
 * `msg_welcome_<agentId>` id also forces the upsert to collapse.
 *
 * Called by the chat client when it lands on a Studio Pack welcome thread
 * with zero messages and no autosend pending — see chat-context.tsx.
 */

import { Hono } from "hono";
import { isStudioPackAgent } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import type { ThreadMessage } from "@/storage/types";
import { findStudioPackAgentByMcpId } from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

export function createStudioPackWelcomeRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/studio-pack-welcome/:agentId/:taskId", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);

    const agentId = c.req.param("agentId");
    const taskId = c.req.param("taskId");

    if (taskId !== `thrd_welcome_${agentId}`) {
      return c.json(
        { error: "taskId does not match the welcome thread for agentId" },
        400,
      );
    }

    const agent = findStudioPackAgentByMcpId(agentId);
    if (!agent) {
      return c.json({ error: "Not a Studio Pack agent" }, 404);
    }

    const { messages } = await mesh.storage.threads.listMessages(taskId, {
      limit: 1,
    });
    if (messages.length > 0) {
      return c.json({ inserted: false, message: null });
    }

    const [brands, vmcps] = await Promise.all([
      mesh.storage.brandContext.list(orgId),
      mesh.storage.virtualMcps.list(orgId),
    ]);
    const hasBrandContext = brands.length > 0;
    const hasCustomAgents = vmcps.some((vm) => !isStudioPackAgent(vm.id));

    const parts = await agent.welcomeMessage({
      orgId,
      createdBy: userId,
      hasBrandContext,
      hasCustomAgents,
    });

    const now = new Date().toISOString();
    const message = {
      id: `msg_welcome_${agentId}`,
      thread_id: taskId,
      role: "assistant",
      parts,
      metadata: null,
      created_at: now,
      updated_at: now,
    } as unknown as ThreadMessage;

    await mesh.storage.threads.saveMessages([message]);

    return c.json({ inserted: true, message });
  });

  return app;
}

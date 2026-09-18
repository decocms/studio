import { type Kysely, type Selectable, sql } from "kysely";
import {
  DemoRecipeSchema,
  DEMO_SCENARIO,
  type DemoRecipe,
  type DemoStatus,
} from "@decocms/shared/demo";
import {
  getDecopilotId,
  getWellKnownSelfConnection,
} from "@decocms/shared/sdk";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { ForbiddenError } from "@/core/access-control";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { recipes, seedTasks } from "@/demo/scenario";
import { executeDemoTool } from "./demo-tools";
import type { Database, DemoOrganizationTable } from "./types";
import { TaskBoardStorage } from "./task-board";
import { SqlThreadStorage } from "./threads";
import { OrganizationSettingsStorage } from "./organization-settings";

type Registration = Selectable<DemoOrganizationTable>;
export class DemoStorage {
  constructor(private db: Kysely<Database>) {}

  executeTool(
    orgId: string,
    actorId: string,
    name: string,
    input: unknown,
    origin: string,
    slug: string,
  ) {
    return executeDemoTool(this.db, orgId, actorId, name, input, origin, slug);
  }

  get(organizationId: string) {
    return this.db
      .selectFrom("demo_organizations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
  }

  async assertLive(organizationId: string) {
    if (await this.get(organizationId))
      throw new ForbiddenError(
        "This action is unavailable in a demonstration organization.",
      );
  }

  async status(organizationId: string): Promise<DemoStatus | null> {
    const row = await this.get(organizationId);
    if (!row) return null;
    const [settings, tasks, active] = await Promise.all([
      new OrganizationSettingsStorage(this.db).get(organizationId),
      this.db
        .selectFrom("demo_tasks")
        .select(["task_id", "recipe"])
        .where("organization_id", "=", organizationId)
        .execute(),
      this.db
        .selectFrom("demo_runs")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("organization_id", "=", organizationId)
        .where("state", "=", "pending")
        .executeTakeFirstOrThrow(),
    ]);
    return {
      enabled: settings?.flags?.demo_mode_enabled === true,
      scenario: row.scenario,
      generation: row.generation,
      resetAt: new Date(row.reset_at).toISOString(),
      activeRuns: Number(active.n),
      sessionOwner:
        row.session_expires_at &&
        new Date(row.session_expires_at).getTime() > Date.now()
          ? row.session_owner
          : null,
      sessionExpiresAt: row.session_expires_at
        ? new Date(row.session_expires_at).toISOString()
        : null,
      tasks: tasks.map((t) => ({
        id: t.task_id,
        recipe: DemoRecipeSchema.parse(t.recipe),
      })),
    };
  }

  /** Every demo writer, reset and replay locks the same row for its entire transaction. */
  async mutate<T>(
    organizationId: string,
    actorId: string | null,
    fn: (db: Kysely<Database>, row: Registration) => Promise<T>,
    allowSuspended = false,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("demo_organizations")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const settings = await new OrganizationSettingsStorage(trx).get(
        organizationId,
      );
      if (
        !allowSuspended &&
        (!settings?.flags?.demo_mode_enabled || row.scenario !== DEMO_SCENARIO)
      )
        throw new ForbiddenError(
          "This demonstration is suspended or its scenario is unavailable.",
        );
      if (
        actorId &&
        row.session_owner &&
        row.session_owner !== actorId &&
        row.session_expires_at &&
        new Date(row.session_expires_at).getTime() > Date.now()
      )
        throw new ForbiddenError(
          "Another presenter has reserved this demonstration. Try again after their presentation ends.",
        );
      return fn(trx, row);
    });
  }

  /** Administrative CLI only. Existing working organizations cannot be converted implicitly. */
  async ensureSelfConnection(
    organizationId: string,
    actorId: string,
    baseUrl: string,
  ) {
    const self = getWellKnownSelfConnection(baseUrl, organizationId);
    await this.db
      .insertInto("connections")
      .values({
        id: self.id!,
        organization_id: organizationId,
        created_by: actorId,
        updated_by: actorId,
        title: self.title,
        description: self.description ?? null,
        icon: null,
        app_name: self.app_name ?? null,
        app_id: null,
        slug: "management-mcp",
        connection_type: "HTTP",
        connection_url: self.connection_url ?? null,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: JSON.stringify(self.metadata),
        bindings: null,
        repository_id: null,
        status: "active",
        pinned: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  async register(organizationId: string) {
    await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`demo-register:${organizationId}`})::bigint)`.execute(
        trx,
      );
      if (await new DemoStorage(trx).get(organizationId)) return;
      for (const table of [
        "task_board_items",
        "threads",
        "automations",
        "repositories",
      ] as const) {
        const existing = await trx
          .selectFrom(table)
          .select("id")
          .where("organization_id", "=", organizationId)
          .limit(1)
          .executeTakeFirst();
        if (existing)
          throw new Error(
            "Demo setup requires an empty organization. Create a new org instead of converting live data.",
          );
      }
      await trx
        .insertInto("demo_organizations")
        .values({
          organization_id: organizationId,
          scenario: DEMO_SCENARIO,
          session_owner: null,
          session_expires_at: null,
        })
        .execute();
      await new OrganizationSettingsStorage(trx).upsert(organizationId, {
        flags: {
          demo_mode_enabled: true,
          delivery_lanes_enabled: true,
          reviewer_enabled: false,
          qa_agent_enabled: false,
          code_reviewer_enabled: false,
          auto_merge: false,
        },
      });
    });
  }

  async reset(
    organizationId: string,
    actorId: string,
    key: string,
    expectedGeneration?: number,
  ) {
    return this.mutate(organizationId, actorId, async (trx, row) => {
      const prior = await trx
        .selectFrom("demo_resets")
        .select("generation")
        .where("organization_id", "=", organizationId)
        .where("idempotency_key", "=", key)
        .executeTakeFirst();
      if (prior) return { generation: prior.generation, repeated: true };
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== row.generation
      )
        throw new ForbiddenError(
          "The demonstration has been restored since this page was opened. Reload before trying again.",
        );
      // Only fresh, registered demo orgs can enter this path. All their task/chat data is disposable.
      // Revoked generations and deleted run rows fence callbacks before they can recreate anything.
      await trx
        .deleteFrom("async_research_jobs")
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .deleteFrom("task_board_items")
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .deleteFrom("threads")
        .where("organization_id", "=", organizationId)
        .execute();
      const board = new TaskBoardStorage(trx);
      for (const entry of seedTasks) {
        const recipe = recipes[entry.recipe];
        const historical = ["in_review", "approved", "done"].includes(
          entry.status,
        );
        const item = await board.create({
          organizationId,
          title: entry.title ?? recipe.title,
          description: recipe.description,
          status: entry.status,
          priority: entry.recipe === "search" ? "high" : "medium",
          type: entry.recipe === "diagnostic" ? "bug" : "feature",
          by: actorId,
          assigneeId: historical ? SUPER_AGENT_ASSIGNEE_ID : null,
        });
        await board.recordActivity({
          taskBoardItemId: item.id,
          action: "created",
          actorId,
          data: { demo: true },
        });
        await trx
          .insertInto("demo_tasks")
          .values({
            task_id: item.id,
            organization_id: organizationId,
            recipe: entry.recipe,
            delivered: historical,
          })
          .execute();
        if (historical) {
          const thread = await this.createThread(
            trx,
            organizationId,
            item.id,
            actorId,
            recipe.title,
          );
          const emitter = new PartEmitter({
            storage: new SqlThreadStorage(trx).messageParts(),
            orgId: organizationId,
            threadId: thread.id,
            runId: thread.id,
            baseTimeMs: Date.now() - 86_400_000,
          });
          await emitter.emitFinal({
            id: `${thread.id}:request`,
            role: "user",
            parts: [{ type: "text", text: recipe.description }],
          });
          await emitter.emitFinal({
            id: `${thread.id}:answer`,
            role: "assistant",
            parts: [
              {
                type: "text",
                text: `${recipe.result}\n\nThe prepared checks passed. You can review the preview and the change before approving.`,
              },
            ],
          });
          await board.createComment({
            taskBoardItemId: item.id,
            organizationId,
            authorId: actorId,
            body: "Prepared review: responsive layout, accessible controls and the expected storefront change are ready to inspect.",
          });
        }
      }
      const actual = await board.list(organizationId);
      if (
        actual.length !== seedTasks.length ||
        actual.some((i) => i.threads.some((t) => t.status === "in_progress"))
      )
        throw new Error("Scenario validation failed");
      const generation = row.generation + 1;
      await trx
        .updateTable("demo_organizations")
        .set({ generation, reset_at: new Date() })
        .where("organization_id", "=", organizationId)
        .execute();
      await trx
        .insertInto("demo_resets")
        .values({
          id: crypto.randomUUID(),
          organization_id: organizationId,
          idempotency_key: key,
          generation,
          actor_id: actorId,
        })
        .execute();
      return { generation, repeated: false };
    });
  }

  async createTask(
    org: string,
    actor: string,
    recipe: DemoRecipe,
    expectedGeneration: number,
  ) {
    return this.mutate(org, actor, async (db, row) => {
      if (row.generation !== expectedGeneration)
        throw new ForbiddenError(
          "The demonstration was restored. Reload and try again.",
        );
      const template = recipes[recipe];
      const task = await new TaskBoardStorage(db).create({
        organizationId: org,
        title: template.title,
        description: template.description,
        status: "todo",
        type: recipe === "diagnostic" ? "bug" : "feature",
        by: actor,
      });
      await db
        .insertInto("demo_tasks")
        .values({ organization_id: org, task_id: task.id, recipe })
        .execute();
      return { id: task.id };
    });
  }

  async reserve(organizationId: string, actorId: string, active: boolean) {
    await this.mutate(organizationId, actorId, async (trx) => {
      await trx
        .updateTable("demo_organizations")
        .set({
          session_owner: active ? actorId : null,
          session_expires_at: active
            ? new Date(Date.now() + 90 * 60_000)
            : null,
        })
        .where("organization_id", "=", organizationId)
        .execute();
    });
  }

  private async createThread(
    db: Kysely<Database>,
    org: string,
    task: string,
    actor: string,
    title: string,
  ) {
    const thread = await new SqlThreadStorage(db).create({
      organization_id: org,
      created_by: actor,
      title,
      status: "completed",
      virtual_mcp_id: getDecopilotId(org),
      harness_id: "decopilot",
      message_storage_version: 2,
      metadata: { demo: true },
    });
    await new TaskBoardStorage(db).linkThread(task, thread.id, org);
    return thread;
  }

  async start(
    db: Kysely<Database>,
    row: Registration,
    taskId: string,
    actorId: string,
    request?: { threadId: string; id: string; text: string },
  ) {
    const task = await db
      .selectFrom("demo_tasks")
      .selectAll()
      .where("organization_id", "=", row.organization_id)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!task)
      throw new ForbiddenError(
        "Choose one of the prepared demonstration tasks to run this scenario.",
      );
    const recipe = DemoRecipeSchema.parse(task.recipe);
    const id = request
      ? `demo:${row.generation}:${request.threadId}:${request.id}`
      : `demo:${crypto.randomUUID()}`;
    const prior = await db
      .selectFrom("demo_runs")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", row.organization_id)
      .executeTakeFirst();
    if (prior) return prior;
    const pending = await db
      .selectFrom("demo_runs")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("organization_id", "=", row.organization_id)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (pending)
      throw new ForbiddenError(
        "This task is already running. Wait for it to finish or stop it first.",
      );
    const thread = request
      ? await new SqlThreadStorage(db).get(
          request.threadId,
          row.organization_id,
        )
      : await this.createThread(
          db,
          row.organization_id,
          taskId,
          actorId,
          recipes[recipe].title,
        );
    if (!thread)
      throw new ForbiddenError("Chat not found in this demonstration.");
    await new SqlThreadStorage(db).update(thread.id, row.organization_id, {
      status: "in_progress",
    });
    const emitter = new PartEmitter({
      storage: new SqlThreadStorage(db).messageParts(),
      orgId: row.organization_id,
      threadId: thread.id,
      runId: id,
    });
    await emitter.emitFinal({
      id: request?.id ?? `${id}:request`,
      role: "user",
      parts: [
        { type: "text", text: request?.text ?? recipes[recipe].description },
      ],
    });
    await new TaskBoardStorage(db).update(
      taskId,
      row.organization_id,
      {
        status: "in_progress",
        assigneeId: SUPER_AGENT_ASSIGNEE_ID,
        assignedBy: actorId,
      },
      actorId,
    );
    await new TaskBoardStorage(db).recordActivity({
      taskBoardItemId: taskId,
      action: "status_changed",
      actorId,
      data: { to: "in_progress", demo: true },
    });
    return db
      .insertInto("demo_runs")
      .values({
        id,
        organization_id: row.organization_id,
        generation: row.generation,
        task_id: taskId,
        thread_id: thread.id,
        recipe,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  pending() {
    return this.db
      .selectFrom("demo_runs")
      .select(["id", "organization_id"])
      .where("state", "=", "pending")
      .orderBy("created_at")
      .limit(100)
      .execute();
  }

  /** Idempotent SQL step: a crash after commit can repeat this without duplicating parts. */
  async advance(organizationId: string, runId: string, step: number) {
    return this.mutate(
      organizationId,
      null,
      async (db, registration) => {
        const run = await db
          .selectFrom("demo_runs")
          .selectAll()
          .where("id", "=", runId)
          .where("organization_id", "=", organizationId)
          .executeTakeFirst();
        if (
          !run ||
          run.state !== "pending" ||
          run.generation !== registration.generation
        )
          return null;
        if (run.step > step) return run;
        if (run.step !== step)
          throw new Error("Demo execution sequence is inconsistent");
        const settings = await new OrganizationSettingsStorage(db).get(
          organizationId,
        );
        if (
          !settings?.flags?.demo_mode_enabled ||
          registration.scenario !== DEMO_SCENARIO
        ) {
          await db
            .updateTable("demo_runs")
            .set({ state: "cancelled" })
            .where("id", "=", runId)
            .execute();
          await new SqlThreadStorage(db).update(run.thread_id, organizationId, {
            status: "completed",
          });
          await new TaskBoardStorage(db).update(
            run.task_id,
            organizationId,
            { status: "todo", assigneeId: null },
            "system",
          );
          return { ...run, state: "cancelled" };
        }
        const recipe = recipes[DemoRecipeSchema.parse(run.recipe)];
        const finished = step === recipe.steps.length - 1;
        const emitter = new PartEmitter({
          storage: new SqlThreadStorage(db).messageParts(),
          orgId: organizationId,
          threadId: run.thread_id,
          runId,
          baseTimeMs: new Date(run.created_at).getTime() + 100,
        });
        const message = {
          id: `${runId}:answer`,
          role: "assistant" as const,
          parts: recipe.steps
            .slice(0, step + 1)
            .map((text) => ({ type: "text" as const, text: `${text}\n\n` })),
        };
        if (finished) await emitter.emitFinal(message);
        else await emitter.emitStepParts(message);
        await db
          .updateTable("demo_runs")
          .set({ step: step + 1, state: finished ? "completed" : "pending" })
          .where("id", "=", runId)
          .execute();
        if (finished) {
          await new SqlThreadStorage(db).update(run.thread_id, organizationId, {
            status: "completed",
          });
          await new TaskBoardStorage(db).update(
            run.task_id,
            organizationId,
            { status: "in_review" },
            "system",
          );
          await new TaskBoardStorage(db).recordActivity({
            taskBoardItemId: run.task_id,
            action: "status_changed",
            actorId: null,
            data: { from: "in_progress", to: "in_review", demo: true },
          });
          await db
            .updateTable("demo_tasks")
            .set({ delivered: true })
            .where("task_id", "=", run.task_id)
            .where("organization_id", "=", organizationId)
            .execute();
        }
        return {
          ...run,
          step: step + 1,
          state: finished ? "completed" : "pending",
        };
      },
      true,
    );
  }

  async fail(organizationId: string, runId: string) {
    return this.mutate(
      organizationId,
      null,
      async (db, registration) => {
        const run = await db
          .selectFrom("demo_runs")
          .selectAll()
          .where("id", "=", runId)
          .where("organization_id", "=", organizationId)
          .where("state", "=", "pending")
          .executeTakeFirst();
        if (!run || run.generation !== registration.generation) return null;
        await db
          .updateTable("demo_runs")
          .set({ state: "failed" })
          .where("id", "=", runId)
          .execute();
        await new SqlThreadStorage(db).update(run.thread_id, organizationId, {
          status: "failed",
        });
        await new TaskBoardStorage(db).update(
          run.task_id,
          organizationId,
          { status: "todo", assigneeId: null },
          "system",
        );
        await new TaskBoardStorage(db).recordActivity({
          taskBoardItemId: run.task_id,
          action: "status_changed",
          actorId: null,
          data: {
            from: "in_progress",
            to: "todo",
            reason:
              "The demonstration was interrupted. Run the scenario again.",
            demo: true,
          },
        });
        return run;
      },
      true,
    );
  }

  async followup(
    org: string,
    actor: string,
    threadId: string,
    id: string,
    text: string,
  ) {
    if (
      !["Run this scenario again", "Execute este roteiro novamente"].includes(
        text.trim(),
      )
    )
      throw new ForbiddenError(
        'This chat follows a prepared scenario. Send "Run this scenario again" to replay it, or use the demonstration controls to choose another task.',
      );
    return this.mutate(org, actor, async (db, row) => {
      const link = await db
        .selectFrom("task_board_item_threads as l")
        .innerJoin("demo_tasks as t", "t.task_id", "l.task_board_item_id")
        .select("t.task_id")
        .where("l.organization_id", "=", org)
        .where("t.organization_id", "=", org)
        .where("l.thread_id", "=", threadId)
        .executeTakeFirst();
      if (!link)
        throw new ForbiddenError(
          "This chat is outside the prepared demonstration",
        );
      return this.start(db, row, link.task_id, actor, { threadId, id, text });
    });
  }

  async publishedRecipes(org: string) {
    const rows = await this.db
      .selectFrom("demo_tasks")
      .select("recipe")
      .distinct()
      .where("organization_id", "=", org)
      .where("published", "=", true)
      .execute();
    return rows.map((row) => DemoRecipeSchema.parse(row.recipe));
  }

  async artifact(org: string, taskId: string) {
    return this.db
      .selectFrom("demo_tasks as d")
      .innerJoin("task_board_items as t", "t.id", "d.task_id")
      .select(["d.recipe", "d.delivered", "t.title", "t.status"])
      .where("d.organization_id", "=", org)
      .where("t.organization_id", "=", org)
      .where("d.task_id", "=", taskId)
      .executeTakeFirst();
  }

  async cancel(organizationId: string, actorId: string, threadId: string) {
    await this.mutate(organizationId, actorId, async (db) => {
      const rows = await db
        .updateTable("demo_runs")
        .set({ state: "cancelled" })
        .where("organization_id", "=", organizationId)
        .where("thread_id", "=", threadId)
        .where("state", "=", "pending")
        .returning("task_id")
        .execute();
      if (!(await new SqlThreadStorage(db).get(threadId, organizationId)))
        throw new ForbiddenError("Chat not found");
      await new SqlThreadStorage(db).update(threadId, organizationId, {
        status: "completed",
      });
      for (const row of rows)
        await new TaskBoardStorage(db).update(
          row.task_id,
          organizationId,
          { status: "todo", assigneeId: null },
          actorId,
        );
    });
  }
}

import { z } from "zod";
import { reactToSuperAgentDelegation } from "@/automations/fire-implementer";
import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { taskKey } from "@decocms/shared/task-key";
import {
  AnalyticsRegistrationError,
  readAnalyticsRegistration,
  registerAnalyticsSite,
  siteDomains,
} from "../../analytics/registration";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  isCustomerLakeConfigured,
  linkAnalyticsSite,
} from "../../customer-lake/client";
import { findOwnedProject } from "../experiments/ownership";
import { resolveRepositoryForProject } from "../experiments/resolve-site-repository";
import { emitTaskBoardUpdated } from "../task-board/run-reactions";
import { buildInstruction } from "./instruction";

export const ANALYTICS_INSTALL = defineTool({
  name: "ANALYTICS_INSTALL",
  description:
    "Delegate adding Deco Analytics to a site's code to the Super Agent: it puts the collector's tag in the site's <head>, tracks purchases where the repo renders the order confirmation, and opens a PR. Registers the site with the collector by key first when it can't collect yet, and links it to the organization's data lake, so its traffic reaches CUSTOMER_LAKE_QUERY. Requires a linked GitHub repository.",
  annotations: {
    title: "Install Analytics On Site",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
  }),
  outputSchema: z.object({
    taskBoardItemId: z.string(),
    /** The card's human key (`DECO-07`), for a deep link. Null when the org has no slug. */
    taskKey: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const site = input.site.toLowerCase();

    // Analytics is keyed globally by slug: only a slug the org owns may be read
    // or linked, or another org's traffic would land in this org's lake rows.
    if (!(await ctx.storage.orgSites.isOwnedBy(site, organization.id))) {
      throw new Error("Site not found in organization");
    }
    const project = await findOwnedProject(ctx, organization.id, site);

    const title = `Install Deco Analytics on ${site}`;
    const keyOf = (keySeq: number | null) =>
      organization.slug && keySeq != null
        ? taskKey(organization.slug, keySeq)
        : null;

    /** A second card would mean a second run and a second PR for one change. */
    const [open] = (
      await ctx.storage.taskBoard.searchByTitle(organization.id, title, 20)
    ).filter(
      (item) =>
        item.title === title &&
        item.status !== LANES.done &&
        item.status !== LANES.archive,
    );
    if (open) return { taskBoardItemId: open.id, taskKey: keyOf(open.keySeq) };

    const repository = await resolveRepositoryForProject(
      ctx,
      organization.id,
      project,
    );
    if (!repository) {
      throw new Error(
        `${site} has no linked GitHub repository — connect one before installing analytics.`,
      );
    }

    let registration = await readAnalyticsRegistration(site);
    // Keyed, because a keyed tag collects on any host; a host registration
    // collects only where `/_dq/*` is routed to the collector, which the
    // control-plane checks before converting one.
    if (
      registration.status === "unregistered" ||
      (registration.status === "registered" && !registration.key)
    ) {
      if (!registration.host) {
        throw new Error(
          `${site} has no production domain to register for analytics.`,
        );
      }
      try {
        await registerAnalyticsSite(site, {
          key: true,
          domains: siteDomains(registration.host),
          modules: ["core", "commerce", "vitals"],
        });
      } catch (err) {
        if (
          !(err instanceof AnalyticsRegistrationError && err.code === "on_cdn")
        )
          throw err;
      }
      registration = await readAnalyticsRegistration(site);
    }
    if (registration.status !== "registered") {
      throw new Error("Couldn't read this site's analytics registration");
    }

    if (isCustomerLakeConfigured()) {
      await linkAnalyticsSite(organization.id, registration.id);
    }

    const owner = await ctx.db
      .selectFrom("member")
      .select(["userId"])
      .where("organizationId", "=", organization.id)
      .where("role", "=", "owner")
      .orderBy("createdAt", "asc")
      .executeTakeFirst();

    const item = await ctx.storage.taskBoard.create({
      organizationId: organization.id,
      title,
      description: buildInstruction(registration),
      status: LANES.progress,
      assigneeId: SUPER_AGENT_ASSIGNEE_ID,
      assignedBy: owner?.userId ?? null,
      repositoryId: repository.id,
      repo: repository.path,
      by: ctx.auth.user!.id,
    });
    emitTaskBoardUpdated(organization.id, item);

    // Not best-effort: a swallowed quota error would read as "installing".
    await reactToSuperAgentDelegation(ctx, item, { userInitiated: true });

    return { taskBoardItemId: item.id, taskKey: keyOf(item.keySeq) };
  },
});

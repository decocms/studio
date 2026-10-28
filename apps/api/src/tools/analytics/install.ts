import { z } from "zod";
import { reactToSuperAgentDelegation } from "@/automations/fire-implementer";
import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { taskKey } from "@decocms/shared/task-key";
import {
  AnalyticsRegistrationError,
  readAnalyticsRegistration,
  registerAnalyticsSite,
  registerExternalAnalyticsSite,
  siteDomains,
  typedHost,
} from "../../analytics/registration";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  isCustomerLakeConfigured,
  linkAnalyticsSite,
} from "../../customer-lake/client";
import { findOwnedProject } from "../experiments/ownership";
import { resolveRepositoryForProject } from "../experiments/resolve-site-repository";
import { DECO_ANALYTICS_METADATA_KEY } from "../strip-server-managed-metadata";
import { emitTaskBoardUpdated } from "../task-board/run-reactions";
import { buildInstruction } from "./instruction";

const MODULES = ["core", "commerce", "vitals"];

/** What a site the control-plane doesn't host keeps of its registration: the
 *  key is only returned when it's created. */
const ExternalRegistration = z.object({ id: z.string(), key: z.string() });

export const ANALYTICS_INSTALL = defineTool({
  name: "ANALYTICS_INSTALL",
  description:
    "Delegate adding Deco Analytics to a site's code to the Super Agent: it puts the collector's tag in the site's <head>, tracks purchases where the repo renders the order confirmation, and opens a PR. Registers the site with the collector by key first when it can't collect yet, and links it to the organization's data lake, so its traffic reaches CUSTOMER_LAKE_QUERY. Works for sites deco doesn't host too, registered by the domain they're live on. Requires a linked GitHub repository. Answers needs_domain when no domain is known for the site; call again with the domain it is live on.",
  annotations: {
    title: "Install Analytics On Site",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    /** Where the site is live, for a site hosting doesn't know a domain for. */
    domain: z.string().max(253).optional(),
  }),
  outputSchema: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("dispatched"),
      taskBoardItemId: z.string(),
      /** The card's human key (`DECO-07`), for a deep link. Null when the org has no slug. */
      taskKey: z.string().nullable(),
    }),
    /** Hosting has no domain for the site: call again with `domain`. */
    z.object({ status: z.literal("needs_domain") }),
  ]),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const site = input.site.toLowerCase();

    // A hosted site's analytics is keyed globally by slug: only a slug the org
    // owns may be read or linked, or another org's traffic would land in this
    // org's lake rows. Any other project registers by its domain instead.
    const hosted = await ctx.storage.orgSites.isOwnedBy(site, organization.id);
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
    if (open) {
      return {
        status: "dispatched" as const,
        taskBoardItemId: open.id,
        taskKey: keyOf(open.keySeq),
      };
    }

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

    let registration: { id: string; key: string | null; modules: string[] };
    if (hosted) {
      let hostedRegistration = await readAnalyticsRegistration(site);
      // Keyed, because a keyed tag collects on any host; a host registration
      // collects only where `/_dq/*` is routed to the collector, which the
      // control-plane checks before converting one.
      if (
        hostedRegistration.status === "unregistered" ||
        (hostedRegistration.status === "registered" && !hostedRegistration.key)
      ) {
        const host = hostedRegistration.host ?? typedHost(input.domain);
        if (!host) return { status: "needs_domain" as const };
        try {
          await registerAnalyticsSite(site, {
            key: true,
            domains: siteDomains(host),
            modules: MODULES,
          });
        } catch (err) {
          if (
            !(
              err instanceof AnalyticsRegistrationError && err.code === "on_cdn"
            )
          )
            throw err;
        }
        hostedRegistration = await readAnalyticsRegistration(site);
      }
      if (hostedRegistration.status !== "registered") {
        throw new Error("Couldn't read this site's analytics registration");
      }
      registration = hostedRegistration;
    } else {
      const stored = ExternalRegistration.safeParse(
        (project.metadata as Record<string, unknown> | null)?.[
          DECO_ANALYTICS_METADATA_KEY
        ],
      );
      if (stored.success) {
        registration = { ...stored.data, modules: MODULES };
      } else {
        const host = typedHost(input.domain);
        if (!host) return { status: "needs_domain" as const };
        const created = await registerExternalAnalyticsSite({
          domains: siteDomains(host),
          modules: MODULES,
        });
        // Registered before, by whoever holds its key: never link that id, or
        // typing someone else's domain would read their traffic.
        if (!created.created || !created.key) {
          throw new Error(
            `${host} already has Deco Analytics under another registration.`,
          );
        }
        await ctx.storage.virtualMcps.patchMetadata({
          id: project.id,
          organizationId: organization.id,
          set: {
            [DECO_ANALYTICS_METADATA_KEY]: { id: created.id, key: created.key },
          },
          unset: [],
          by: ctx.auth.user!.id,
        });
        registration = { id: created.id, key: created.key, modules: MODULES };
      }
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

    await reactToSuperAgentDelegation(ctx, item);

    return {
      status: "dispatched" as const,
      taskBoardItemId: item.id,
      taskKey: keyOf(item.keySeq),
    };
  },
});

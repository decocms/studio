/**
 * The Jira tools a Jira-triggered run is served instead of the board tools.
 *
 * The run works on an ISSUE, so this is how it reads it, comments on it, moves
 * it, and fetches its files — all through Studio, with the integration's own
 * credential, which never reaches the sandbox. Which issue is not an input:
 * the run's MCP endpoint is keyed by thread (`task-run-context.ts`), and the
 * thread's anchor item is linked to exactly one issue.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireOrganization, type StudioContext } from "@/core/studio-context";
import { getPublicUrl } from "@/core/server-constants";
import {
  ATTACHMENT_GRANT_TTL_MS,
  mintAttachmentToken,
} from "@/jira/attachment-token";
import { JiraClient } from "@/jira/client";
import { uploadCommentImages } from "@/jira/comment-images";
import { loadIssueForPrompt, renderIssueForPrompt } from "@/jira/issue-prompt";
import {
  requireTaskRunContext,
  taskRunContextStore,
} from "@/tools/task-board/task-run-context";
import type { OrgJiraIntegration } from "@/storage/types";

const MAX_COMMENT_LENGTH = 50_000;

interface RunIssue {
  integration: OrgJiraIntegration;
  client: JiraClient;
  issueId: string;
  issueKey: string;
}

/**
 * The issue a run is on, with a client to reach it.
 *
 * `threadId` is the run's thread. Omitted on the MCP endpoint, where the path
 * already names it; passed explicitly by the built-in path, which has no
 * request scope to read it from.
 */
async function resolveRunIssue(
  ctx: StudioContext,
  threadId = requireTaskRunContext().threadId,
): Promise<RunIssue> {
  const organization = requireOrganization(ctx);
  const integration = await ctx.storage.jiraIntegrations.getByOrg(
    organization.id,
  );
  if (!integration) throw new Error("Jira is not connected for this org");
  for (const itemId of await ctx.storage.taskBoard.linkedTaskIds(
    threadId,
    organization.id,
  )) {
    const link = await ctx.storage.jiraIntegrations.getLinkByItemId(
      itemId,
      organization.id,
    );
    if (link) {
      return {
        integration,
        client: new JiraClient(
          integration.siteUrl,
          integration.email,
          integration.apiToken,
        ),
        issueId: link.jiraIssueId,
        issueKey: link.jiraIssueKey,
      };
    }
  }
  throw new Error("This run is not working on a Jira issue");
}

export const JIRA_ISSUE_GET = defineTool({
  name: "JIRA_ISSUE_GET",
  description:
    "Re-read the Jira issue this run is working on: summary, status, " +
    "description, comments, and attachments with the ids " +
    "JIRA_ATTACHMENT_DOWNLOAD takes.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    key: z.string(),
    url: z.string(),
    status: z.string(),
    markdown: z.string(),
  }),
  handler: async (_input, ctx) => {
    await ctx.access.check();
    const { integration, client, issueId } = await resolveRunIssue(ctx);
    const issue = await loadIssueForPrompt(
      client,
      integration.siteUrl,
      issueId,
    );
    return {
      key: issue.key,
      url: issue.url,
      status: issue.status,
      markdown: renderIssueForPrompt(issue),
    };
  },
});

export const JIRA_COMMENT_ADD = defineTool({
  name: "JIRA_COMMENT_ADD",
  description:
    "Post a comment on the Jira issue this run is working on. Markdown is " +
    "rendered as Jira rich text, tables included. Leave one when you finish: " +
    "what you did, and any pull request link. To show evidence, write the " +
    "image to `org/output/<name>.png` in your working pod and reference it as " +
    "`![what it shows](org/output/<name>.png)` — it is uploaded to the issue " +
    "and rendered inline. Any other URL stays a plain link.",
  inputSchema: z.object({
    body: z.string().min(1).max(MAX_COMMENT_LENGTH),
  }),
  outputSchema: z.object({
    commentId: z.string(),
    /** Screenshots that made it onto the issue, by markdown target. */
    embeddedImages: z.array(z.string()),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const { client, issueId } = await resolveRunIssue(ctx);
    const media = await uploadCommentImages({
      client,
      orgFs: ctx.orgFs,
      issueIdOrKey: issueId,
      threadId: taskRunContextStore.getStore()?.threadId ?? null,
      markdown: input.body,
    });
    const { id } = await client.addComment(issueId, input.body, { media });
    return { commentId: id, embeddedImages: [...media.keys()] };
  },
});

export const JIRA_REMOTE_LINK_ADD = defineTool({
  name: "JIRA_REMOTE_LINK_ADD",
  description:
    "Put a link on the Jira issue this run is working on — its pull request, " +
    "its deploy preview. A link on the card is what a person clicks; the same " +
    "URL inside a comment is not. Posting the same `key` again updates that " +
    "link instead of adding a second.",
  inputSchema: z.object({
    url: z.string().min(1),
    title: z.string().min(1).max(255),
    summary: z.string().max(1000).optional(),
    key: z
      .string()
      .max(255)
      .optional()
      .describe("Stable id for this link, e.g. `pull-request` or `preview`."),
  }),
  outputSchema: z.object({ linkId: z.number() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const { client, issueId, issueKey } = await resolveRunIssue(ctx);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error(`"${input.url}" is not an absolute URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`${url.protocol} is not a linkable scheme`);
    }
    const { id } = await client.addRemoteLink(issueId, {
      url: url.toString(),
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      // Scoped to the issue so two issues' "preview" links never collide.
      ...(input.key ? { globalId: `studio-${issueKey}-${input.key}` } : {}),
    });
    return { linkId: id };
  },
});

export const JIRA_ISSUE_TRANSITION = defineTool({
  name: "JIRA_ISSUE_TRANSITION",
  description:
    "Move the Jira issue this run is working on to another status, by the " +
    "status name (case-insensitive). Only a status the issue's workflow can " +
    "reach from where it is; the error names the reachable ones.",
  inputSchema: z.object({ toStatus: z.string().min(1) }),
  outputSchema: z.object({ status: z.string() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const { client, issueId } = await resolveRunIssue(ctx);
    const transitions = await client.listTransitions(issueId);
    const wanted = input.toStatus.trim().toLowerCase();
    const match = transitions.find(
      (t) =>
        t.to.name.toLowerCase() === wanted || t.name.toLowerCase() === wanted,
    );
    if (!match) {
      throw new Error(
        `The issue cannot move to "${input.toStatus}" from here — reachable: ${
          transitions.map((t) => t.to.name).join(", ") || "none"
        }`,
      );
    }
    await client.transitionIssue(issueId, match.id);
    return { status: match.to.name };
  },
});

export const JIRA_ATTACHMENT_DOWNLOAD = defineTool({
  name: "JIRA_ATTACHMENT_DOWNLOAD",
  description:
    "Get a short-lived URL for one attachment of the Jira issue this run is " +
    "working on, to `curl -L -o <path>` into the sandbox. Attachment ids are " +
    "listed by JIRA_ISSUE_GET. The URL needs no credential and expires.",
  inputSchema: z.object({ attachmentId: z.string().min(1) }),
  outputSchema: z.object({
    url: z.string(),
    filename: z.string(),
    expiresAt: z.string(),
    command: z.string(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const { integration, client, issueId, issueKey } =
      await resolveRunIssue(ctx);
    // Only this issue's attachments: the grant is minted from the run's own
    // issue, never from an id the model typed for some other issue.
    const attachment = (await client.listAttachments(issueId)).find(
      (a) => a.id === input.attachmentId,
    );
    if (!attachment) {
      throw new Error(
        `${issueKey} has no attachment "${input.attachmentId}" — JIRA_ISSUE_GET lists the ids`,
      );
    }
    const expiresAt = Date.now() + ATTACHMENT_GRANT_TTL_MS;
    const token = mintAttachmentToken({
      organizationId: integration.organizationId,
      attachmentId: attachment.id,
      expiresAt,
    });
    const url = `${getPublicUrl()}/api/_jira/attachments/${token}`;
    const safeName = attachment.filename.replace(/[^\w.-]+/g, "_");
    return {
      url,
      filename: attachment.filename,
      expiresAt: new Date(expiresAt).toISOString(),
      command: `curl -fsSL -o ${JSON.stringify(safeName)} ${JSON.stringify(url)}`,
    };
  },
});

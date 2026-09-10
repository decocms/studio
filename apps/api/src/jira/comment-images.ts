/**
 * Screenshots in a Jira comment.
 *
 * A run writes images to `org/output/…` in its pod — the idiom the board's QA
 * reviewer already uses (`embedOrgOutputImages`) — and references them as
 * markdown images. That mount materializes into the org-fs `outputs` volume
 * under the run's thread id, so the bytes are readable here.
 *
 * Jira needs three steps per image: upload it to the issue, resolve the
 * media-services uuid (the numeric attachment id is rejected), then address it
 * from an ADF `media` node. `markdownToAdf` already takes that map — this is
 * the half that fills it.
 */

import type { OrgFs } from "@/file-storage/org-fs";
import type { JiraClient } from "./client";
import { collectImageTargets, type AdfMedia } from "./markdown-adf";

/** The volume `org/output/…` materializes into. */
const OUTPUTS_VOLUME = "outputs";

/** Only this prefix is ours to upload — an external URL stays a link. */
const ORG_OUTPUT_PREFIX = "org/output/";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** `org/output/qa/before.png` → `qa/before.png`, or null when not ours. */
export function outputSubpath(target: string): string | null {
  if (!target.startsWith(ORG_OUTPUT_PREFIX)) return null;
  const subpath = target.slice(ORG_OUTPUT_PREFIX.length).trim();
  // No traversal out of the run's own prefix, and no empty ref.
  if (subpath === "" || subpath.includes("..")) return null;
  return subpath;
}

/** A flat, filesystem-safe name for the attachment on the issue. */
export function attachmentNameFor(subpath: string): string {
  return subpath.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

/**
 * Upload every `org/output/…` image the comment references and return the map
 * `markdownToAdf` wants, keyed by the target exactly as written.
 *
 * Best-effort per image: one unreadable file or one refused upload leaves that
 * ref as a link and still posts the comment. Losing the whole report because a
 * screenshot went missing is the worse failure — the text is the point, the
 * images are evidence for it.
 */
export async function uploadCommentImages(args: {
  client: JiraClient;
  orgFs: OrgFs | null;
  issueIdOrKey: string;
  threadId: string | null;
  markdown: string;
}): Promise<Map<string, AdfMedia>> {
  const media = new Map<string, AdfMedia>();
  const { orgFs, threadId } = args;
  if (!orgFs || !threadId) return media;

  // Deduped: the same screenshot referenced twice (a before/after table and a
  // paragraph) must not become two attachments on the customer's issue.
  const targets = [...new Set(collectImageTargets(args.markdown))];
  for (const target of targets) {
    const subpath = outputSubpath(target);
    if (!subpath) continue;
    try {
      const bytes = await orgFs.read(OUTPUTS_VOLUME, `${threadId}/${subpath}`);
      const attachment = await args.client.uploadAttachment(
        args.issueIdOrKey,
        attachmentNameFor(subpath),
        bytes,
        contentTypeFor(subpath),
      );
      const uuid = await args.client.attachmentMediaUuid(attachment.id);
      if (uuid) media.set(target, { id: uuid });
    } catch (err) {
      console.warn(
        `[jira] could not embed ${target} in the comment: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return media;
}

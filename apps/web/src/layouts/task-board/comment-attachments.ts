/**
 * The pure half of a comment's attachments: which picked files the composer
 * takes, and how the posted body carries them. A comment body is markdown, so
 * an attachment is a link (or an image) after the text, like the description's.
 */

import { maxUploadMb } from "@/components/markdown-editor/uploads";

export const MAX_COMMENT_ATTACHMENTS = 10;

export type RejectedAttachment = {
  file: File;
  reason: "too-large" | "too-many";
};

/**
 * Splits picked files into the ones the composer takes and the ones it turns
 * away, given how many are already waiting in the draft.
 */
export function admitAttachments(
  files: File[],
  pendingCount: number,
): { accepted: File[]; rejected: RejectedAttachment[] } {
  const accepted: File[] = [];
  const rejected: RejectedAttachment[] = [];
  for (const file of files) {
    if (file.size > maxUploadMb(file) * 1024 * 1024) {
      rejected.push({ file, reason: "too-large" });
    } else if (pendingCount + accepted.length >= MAX_COMMENT_ATTACHMENTS) {
      rejected.push({ file, reason: "too-many" });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/** How an uploaded file appears in a comment body. */
export type AttachmentLink = {
  name: string;
  url: string;
  isImage: boolean;
};

/** Escapes what markdown would read as link syntax or formatting inside a file name. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]*_`~<>]/g, (char) => `\\${char}`);
}

/**
 * The body a comment posts: the typed text, then one paragraph per
 * attachment — an image renders inline, any other file as a link to download.
 */
export function commentBodyWithAttachments(
  text: string,
  attachments: AttachmentLink[],
): string {
  const links = attachments.map(({ name, url, isImage }) =>
    isImage
      ? `![${escapeLinkText(name)}](${url})`
      : `[${escapeLinkText(name)}](${url})`,
  );
  return [text, ...links].filter(Boolean).join("\n\n");
}

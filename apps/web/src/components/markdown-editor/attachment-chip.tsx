import type { ReactNode } from "react";
import { Download01, File02 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

/**
 * A file with nothing to preview (pdf, docx, pptx, txt, …) as a chip you can
 * download. The editor's node view and a posted body's link both draw it, so
 * an attachment looks the same before and after it's sent.
 */
export const ATTACHMENT_CHIP_CLASS =
  "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 align-middle text-sm text-foreground";

/** The chip's insides; `children` follow the download link (the editor's remove). */
export function AttachmentChipContent({
  href,
  name,
  children,
}: {
  href: string;
  name: string;
  children?: ReactNode;
}) {
  const t = useT();
  const label = name || t("markdownEditor.fileNameFallback");

  return (
    <>
      <File02 size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{label}</span>
      {/* The stored name is a UUID; `download` restores the uploaded one. */}
      <a
        href={href}
        download={label}
        aria-label={t("markdownEditor.downloadFile", { name: label })}
        // Keeps an editor's selection out of the chip; the click still fires.
        onMouseDown={(e) => e.preventDefault()}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Download01 size={14} />
      </a>
      {children}
    </>
  );
}

/** An attachment in rendered markdown, outside any editor. */
export function AttachmentChip({ href, name }: { href: string; name: string }) {
  return (
    <span className={ATTACHMENT_CHIP_CLASS}>
      <AttachmentChipContent href={href} name={name} />
    </span>
  );
}

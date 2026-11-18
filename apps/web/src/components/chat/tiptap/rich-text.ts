/**
 * The formatting the chat composer accepts, shared by the composer and the
 * sent-message bubble so a message looks the same before and after sending.
 */

import StarterKit from "@tiptap/starter-kit";

export const chatStarterKit = StarterKit.configure({
  heading: false,
  blockquote: false,
  codeBlock: false,
  horizontalRule: false,
  dropcursor: false,
  // Messages reach the model as markdown, which has no underline.
  underline: false,
  link: {
    autolink: true,
    linkOnPaste: true,
    defaultProtocol: "https",
    // Clicking while typing places the caret; the read-only bubble's anchor opens it.
    openOnClick: false,
  },
});

/**
 * `prose` is inert without the typography plugin, so the marks StarterKit
 * produces need their own styles.
 */
export const CHAT_RICH_TEXT_CLASSES = [
  "[&_.ProseMirror_a]:text-link [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:underline-offset-2 [&_.ProseMirror_a]:decoration-link/40 [&_.ProseMirror_a]:wrap-break-word [&_.ProseMirror_a:hover]:decoration-link",
  "[&_.ProseMirror_strong]:font-semibold [&_.ProseMirror_em]:italic [&_.ProseMirror_s]:line-through",
  "[&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:border [&_.ProseMirror_code]:border-border [&_.ProseMirror_code]:bg-background [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:font-mono [&_.ProseMirror_code]:text-[0.9em]",
  "[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_li]:my-0.5",
].join(" ");

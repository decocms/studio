import { useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { useFileConfigsQuery } from "@/hooks/use-file-configs";
import { matchSiteSlugConfig } from "@/components/file-picker/match-site-slug-config";
import { useRef, useState } from "react";
import { CodeSquare01, Image01, ImagePlus } from "@untitledui/icons";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "@decocms/ui/lib/utils.ts";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { EDITOR_LINK_CLASS } from "@/components/sections-editor/editor-classes";
import { ImageUrlPopover } from "@/components/sections-editor/fields/image-url-popover";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { RichTextColorControl } from "@/components/sections-editor/rich-text-color-control";
import { ToolbarButton } from "@/components/sections-editor/rich-text-link-control";
import {
  type FontSizeScale,
  RichTextToolbar,
} from "@/components/sections-editor/rich-text-toolbar";
import { useT } from "@/i18n/use-t.ts";
import { useLinkSources } from "../blocks/link-pickers";
import { blankIfEmpty, bodyImageSrc } from "./legacy-content";
import { legacyContentExtensions } from "./legacy-content-extensions";

/** The admin's scale: its stepper wrote `font-size` in pt, from 12. */
const PT_FONT_SIZE: FontSizeScale = {
  unit: "pt",
  initial: 12,
  min: 6,
  max: 96,
};

/**
 * The body's typography. `@tailwindcss/typography` isn't installed here, so
 * `prose` would style nothing; headings step down from h1 like the admin's.
 */
const CONTENT_CLASS = [
  "outline-none min-h-80 px-4 py-3 text-[15px] leading-relaxed text-foreground",
  "[&>*:first-child]:mt-0 [&_p]:my-3",
  "[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-3xl [&_h1]:font-bold",
  "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:font-bold",
  "[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:font-bold",
  "[&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:text-lg [&_h4]:font-bold",
  "[&_h5]:mb-2 [&_h5]:mt-4 [&_h5]:text-base [&_h5]:font-bold",
  "[&_h6]:mb-2 [&_h6]:mt-4 [&_h6]:text-sm [&_h6]:font-bold",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:my-1",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm",
  "[&_img]:inline-block [&_img]:h-auto [&_img]:max-w-full",
  "[&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td>p]:my-0 [&_th>p]:my-0",
  "[&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2",
  "[&_strong]:font-bold",
  EDITOR_LINK_CLASS,
];

const PLACEHOLDER_CLASS = [
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
  "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
];

/** Insert an image from the library (or an upload), or from a pasted address. */
function ImageControls({
  editor,
  virtualMcpId,
}: {
  editor: Editor;
  virtualMcpId?: string;
}) {
  const project = useVirtualMCP(virtualMcpId);
  const configs = useFileConfigsQuery();
  const lockedConfigId =
    project?.metadata?.assetStorageConfigId ??
    matchSiteSlugConfig(
      configs.data?.configs ?? [],
      resolveAgentSiteSlug(project),
    )?.id;
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlNotice, setUrlNotice] = useState<string | null>(null);

  /** No `focus()`: blurring the address input would commit it a second time. */
  const insert = (url: string) => {
    editor.chain().setImage({ src: url }).run();
  };

  const closeUrl = () => {
    setUrlDraft(null);
    setUrlNotice(null);
  };

  const commitUrl = () => {
    const draft = (urlDraft ?? "").trim();
    const src = bodyImageSrc(draft);
    if (!src && draft) {
      setUrlNotice(
        draft.toLowerCase().startsWith("data:")
          ? t("sandbox.postEditor.legacyImageDataUrl")
          : t("sectionsEditor.imageField.unsafeUrl"),
      );
      return;
    }
    if (src) insert(src);
    closeUrl();
  };

  return (
    // Not `relative`: the address panel opens under the whole toolbar, which fits it at any wrap.
    <div className="flex items-center gap-0.5">
      <ToolbarButton
        active={pickerOpen}
        label={t("sandbox.postEditor.legacyInsertImage")}
        onClick={() => setPickerOpen(true)}
      >
        <ImagePlus size={14} />
      </ToolbarButton>
      <ToolbarButton
        active={urlDraft !== null}
        label={t("sandbox.postEditor.legacyInsertImageUrl")}
        onClick={() => (urlDraft === null ? setUrlDraft("") : commitUrl())}
      >
        <Image01 size={14} />
      </ToolbarButton>
      {urlDraft !== null && (
        <ImageUrlPopover
          draft={urlDraft}
          notice={urlNotice}
          label={t("sandbox.postEditor.legacyInsertImageUrl")}
          placeholder={t("sectionsEditor.imageField.urlPlaceholder")}
          onDraftChange={(next) => {
            setUrlNotice(null);
            setUrlDraft(next);
          }}
          onCommit={commitUrl}
          onCancel={closeUrl}
        />
      )}
      <FilePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="image"
        lockedConfigId={lockedConfigId}
        onSelect={(url) => {
          const src = bodyImageSrc(url);
          if (src) insert(src);
        }}
      />
    </div>
  );
}

/** The controls only the HTML body offers: highlight, code block and images. */
function LegacyToolbarExtras({
  editor,
  virtualMcpId,
}: {
  editor: Editor;
  virtualMcpId?: string;
}) {
  const t = useT();
  const [highlightOpen, setHighlightOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      highlight: editor.isActive("highlight")
        ? ((editor.getAttributes("highlight").color as string | undefined) ??
          null)
        : null,
      codeBlock: editor.isActive("codeBlock"),
    }),
  });

  return (
    <>
      <RichTextColorControl
        editor={editor}
        mark="highlight"
        currentColor={state.highlight}
        open={highlightOpen}
        onOpenChange={setHighlightOpen}
      />
      <ToolbarButton
        active={state.codeBlock}
        label={t("sandbox.postEditor.legacyCodeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <CodeSquare01 size={14} />
      </ToolbarButton>
      <ImageControls editor={editor} virtualMcpId={virtualMcpId} />
    </>
  );
}

/**
 * A blog post's body as one HTML document (`post.content`), edited the way
 * the deco admin edited it: a rich-text editor over the legacy schema, its
 * font sizes in pt. Seeded once, like the block editors: mounting never
 * writes, and only an edit reports a new value.
 */
export function LegacyContentEditor({
  value,
  onChange,
  decofile,
  sandboxRef,
}: {
  value: string;
  onChange: (html: string) => void;
  /** The site's blocks — enables linking to another post. */
  decofile?: Record<string, unknown>;
  /** A running preview — enables linking to a catalog product. */
  sandboxRef?: PreviewProxyRef | null;
}) {
  const t = useT();
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside the onUpdate callback, never during render
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      ...legacyContentExtensions(),
      Placeholder.configure({
        placeholder: t("sandbox.postEditor.legacyContentPlaceholder"),
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: cn(CONTENT_CLASS),
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(blankIfEmpty(editor.getHTML()));
    },
  });

  const linkSources = useLinkSources({ decofile, sandboxRef });

  if (!editor) return null;

  return (
    <div className="rounded-[var(--studio-surface-radius,var(--radius-md))] border shadow-edge border-input">
      <RichTextToolbar
        editor={editor}
        fontSize={PT_FONT_SIZE}
        linkSources={linkSources}
        extras={
          <LegacyToolbarExtras
            editor={editor}
            virtualMcpId={sandboxRef?.virtualMcpId}
          />
        }
      />
      {/* Scrolls on its own so the toolbar stays in reach in a long post. */}
      <EditorContent
        editor={editor}
        className={cn("max-h-[70vh] overflow-y-auto", PLACEHOLDER_CLASS)}
      />
    </div>
  );
}

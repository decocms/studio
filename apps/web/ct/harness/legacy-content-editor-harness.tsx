import { useState } from "react";
import { LegacyContentEditor } from "@/components/sandbox/content/blog/legacy-content/legacy-content-editor";

/**
 * Mounts the HTML post body editor over a post payload, the way the post
 * editor does: an edit replaces `content` and leaves the rest of the post as
 * it was. Dumps the payload and a write counter so specs can assert both the
 * stored HTML and that merely opening a post never writes.
 */
export function LegacyContentEditorHarness({
  initialPost,
}: {
  initialPost: Record<string, unknown>;
}) {
  const [post, setPost] = useState(initialPost);
  const [writes, setWrites] = useState(0);

  return (
    <div data-testid="harness">
      <LegacyContentEditor
        value={typeof post.content === "string" ? post.content : ""}
        onChange={(html) => {
          setPost((prev) => ({ ...prev, content: html }));
          setWrites((n) => n + 1);
        }}
      />
      <pre data-testid="record-value">{JSON.stringify(post)}</pre>
      <pre data-testid="write-count">{writes}</pre>
    </div>
  );
}

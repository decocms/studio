import { useRef, useState } from "react";
import { CornerDownLeft } from "@untitledui/icons";
import { stripSurroundingSlashes } from "@/web/components/sections-editor/page-path-utils";
import { useT } from "@/web/i18n/use-t.ts";

/**
 * Inline editor for one `:param` or `*` (catch-all) token, rendered in place
 * inside the URL label. Grows with its content and commits on Enter/blur.
 */
export function PathParamInput({
  name,
  value,
  onCommit,
}: {
  name: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const cancelledRef = useRef(false);
  const label = name === "*" ? "path" : `:${name}`;
  const sizer = draft || label;
  return (
    <>
      <span className="relative inline-flex max-w-64 shrink-0 items-center overflow-hidden">
        {/* Invisible sizer: the box hugs the rendered text exactly. Must
          mirror the input's font size and horizontal padding. */}
        <span
          aria-hidden
          className="invisible whitespace-pre px-1 py-0.5 text-[12px]"
        >
          {sizer}
        </span>
        <input
          type="text"
          value={draft}
          placeholder={label}
          title={t("sandbox.preview.valueForParam", { label })}
          spellCheck={false}
          className="absolute inset-0 rounded-sm bg-violet-500/15 px-1 text-[12px] text-violet-600 outline-none placeholder:text-violet-500/60 focus:bg-violet-500/25 dark:text-violet-400"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelledRef.current = true;
              setDraft(value);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setFocused(false);
            if (cancelledRef.current) {
              cancelledRef.current = false;
              return;
            }
            // Blank values are not accepted: clearing the input reverts to the
            // bare `:param` token (placeholder) and the template URL. Surrounding
            // slashes are stripped (the template supplies the leading `/`), so a
            // pasted `/perfumaasdria/colonia` commits as `perfumaasdria/colonia`.
            const next = stripSurroundingSlashes(draft);
            setDraft(next);
            if (next !== value) onCommit(next);
          }}
        />
      </span>
      {/* Editing hint, outside the value box */}
      {focused && (
        <span className="pointer-events-none ml-1.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          <CornerDownLeft size={10} />
          {t("sandbox.preview.enterToGo")}
        </span>
      )}
    </>
  );
}

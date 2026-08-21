/**
 * ReadOnlyCodeViewer — read-only Monaco viewer for source files, sharing the
 * same editor (and self-hosted engine) the sandbox file explorer uses so code
 * renders with real syntax highlighting and line numbers instead of a bare
 * <pre>. Distinct from the editable MonacoCodeEditor (workflow): this is a
 * pure viewer — `readOnly` + `domReadOnly` disable input and the cursor,
 * leaving selection/scroll/copy intact, and it carries none of the editor's
 * Prettier/TS-diagnostics/save machinery.
 */

import { Loading01 } from "@untitledui/icons";
import { getLanguageFromPath } from "@/components/sandbox/preview/file-explorer/utils";
import { Editor } from "@/components/monaco/editor";
import { usePreferences } from "@/hooks/use-preferences";

export function ReadOnlyCodeViewer({
  value,
  filename,
}: {
  value: string;
  filename: string;
}) {
  const [preferences] = usePreferences();
  const isDark =
    preferences.theme === "dark" ||
    (preferences.theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <Editor
      key={filename}
      path={filename}
      language={getLanguageFromPath(filename)}
      value={value}
      theme={isDark ? "vs-dark" : "light"}
      loading={
        <div className="flex h-full w-full items-center justify-center">
          <Loading01 size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
      options={{
        readOnly: true,
        domReadOnly: true,
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        lineNumbersMinChars: 3,
        wordWrap: "on",
        minimap: { enabled: false },
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: "none",
        scrollbar: {
          vertical: "auto",
          horizontal: "auto",
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
      }}
    />
  );
}

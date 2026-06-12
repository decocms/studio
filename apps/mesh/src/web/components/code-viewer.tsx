/**
 * CodeViewer — read-only Monaco viewer for source files, sharing the same
 * editor (and CDN-loaded engine) the sandbox file explorer uses so code
 * renders with real syntax highlighting and line numbers instead of a bare
 * <pre>. Not editable: `readOnly` + `domReadOnly` disable input and the
 * cursor, leaving selection/scroll/copy intact.
 */

import Editor, { loader } from "@monaco-editor/react";
import { Loading01 } from "@untitledui/icons";
import { getLanguageFromPath } from "@/web/components/sandbox/preview/file-explorer/utils";

// Load Monaco from the same CDN as the other editors (idempotent — the
// config is global and every consumer points at the same version).
loader.config({
  paths: {
    vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs",
  },
});

export function CodeViewer({
  value,
  filename,
}: {
  value: string;
  filename: string;
}) {
  return (
    <Editor
      key={filename}
      path={filename}
      language={getLanguageFromPath(filename)}
      value={value}
      theme={
        document.documentElement.classList.contains("dark")
          ? "vs-dark"
          : "light"
      }
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

import Editor, {
  DiffEditor,
  type EditorProps,
  type OnMount,
} from "@monaco-editor/react";
import { configureMonacoLoader } from "./loader";

/**
 * The app's editor components. Import `Editor`/`DiffEditor` from HERE, never
 * from `@monaco-editor/react` directly — `monaco-imports.test.ts` enforces it.
 *
 * Importing this module configures the loader, which is the whole point: the
 * engine path is latched by whichever `<Editor>` mounts first, and the value
 * it would latch by default is a CDN URL serving a DIFFERENT monaco version
 * than the one this app ships and self-hosts.
 */
configureMonacoLoader();

export { Editor, DiffEditor, type EditorProps, type OnMount };

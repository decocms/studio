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
 * it would latch by default is a CDN URL the packaged desktop app cannot load
 * at all. A component that reached `@monaco-editor/react` on its own would
 * render a permanent spinner there, with nothing failing anywhere else.
 */
configureMonacoLoader();

export { Editor, DiffEditor, type EditorProps, type OnMount };

import { useRef, useId } from "react";
import Editor, { OnMount, type EditorProps } from "@monaco-editor/react";
import type { Plugin } from "prettier";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { getReturnType } from "./monaco";
import { configureMonacoLoader } from "./monaco/loader";
import { MonacoErrorBoundary } from "./monaco-error-boundary";

// ============================================
// Types
// ============================================

interface MonacoCodeEditorProps {
  code: string;
  onChange?: (value: string | undefined) => void;
  onSave?: (
    value: string,
    outputSchema: Record<string, unknown> | null,
  ) => void;
  readOnly?: boolean;
  height?: string | number;
  language?: "typescript" | "json" | "shell";
  // Suppresses TS error squiggles. Useful when displaying snippets
  // (e.g. top-level `await`) that aren't valid programs on their own.
  disableDiagnostics?: boolean;
}

// Internal component that receives mountKey from error boundary
interface InternalEditorProps extends MonacoCodeEditorProps {
  mountKey?: number;
}

// Lazy load Prettier modules
let prettierCache: {
  format: (code: string, options: object) => Promise<string>;
  plugins: Plugin[];
} | null = null;

const loadPrettier = async () => {
  if (prettierCache) return prettierCache;

  const [prettierModule, tsPlugin, estreePlugin] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/estree"),
  ]);

  prettierCache = {
    format: prettierModule.format,
    plugins: [tsPlugin.default, estreePlugin.default],
  };

  return prettierCache;
};

configureMonacoLoader();

// ============================================
// Static Constants (module-scoped for stability)
// ============================================

const PRETTIER_OPTIONS = {
  parser: "typescript",
  semi: true,
  singleQuote: false,
  tabWidth: 2,
  trailingComma: "es5",
  printWidth: 80,
} as const;

const EDITOR_BASE_OPTIONS: EditorProps["options"] = {
  fontSize: 13,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  lineNumbersMinChars: 2,
  stickyScroll: { enabled: false },
  wordWrap: "on",
  folding: true,
  bracketPairColorization: { enabled: true },
  suggestOnTriggerCharacters: true,
  quickSuggestions: {
    other: true,
    comments: false,
    strings: true,
  },
  minimap: {
    enabled: false,
  },
  parameterHints: { enabled: true },
  inlineSuggest: { enabled: true },
  autoClosingBrackets: "always",
  autoClosingQuotes: "always",
  autoSurround: "languageDefined",
  padding: { top: 12, bottom: 12 },
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
};

const LoadingPlaceholder = (
  <div className="flex items-center justify-center h-full w-full text-gray-400">
    <Spinner size="sm" />
  </div>
);

function InternalMonacoEditor({
  code,
  onChange,
  onSave,
  readOnly = false,
  height = 300,
  language = "typescript",
  disableDiagnostics = false,
  mountKey = 0,
}: InternalEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const onSaveRef = useRef(onSave);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  onSaveRef.current = onSave;

  // Store language in ref to avoid stale closures in editor callbacks
  const languageRef = useRef(language);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  languageRef.current = language;

  // Unique path so Monaco treats this as a TypeScript file
  const uniqueId = useId();
  const editorKey = `${uniqueId}-${mountKey}`;
  const filePath =
    language === "typescript"
      ? `file:///workflow-${uniqueId.replace(/:/g, "-")}-${mountKey}.tsx`
      : undefined;

  // Compute options with readOnly merged in
  const editorOptions = readOnly
    ? { ...EDITOR_BASE_OPTIONS, readOnly: true }
    : EDITOR_BASE_OPTIONS;

  // Format function that uses refs to avoid stale closures
  const formatWithPrettier = async (editorInstance: Parameters<OnMount>[0]) => {
    const model = editorInstance.getModel();
    if (!model) {
      console.warn("No model found");
      return;
    }

    const currentCode = model.getValue();
    const currentLanguage = languageRef.current;

    // For JSON, use native JSON formatting
    if (currentLanguage === "json") {
      try {
        const parsed = JSON.parse(currentCode);
        const formatted = JSON.stringify(parsed, null, 2);
        if (formatted !== currentCode) {
          const fullRange = model.getFullModelRange();
          editorInstance.executeEdits("json-format", [
            { range: fullRange, text: formatted },
          ]);
        }
      } catch (err) {
        console.error("JSON formatting failed:", err);
      }
      return;
    }

    // For TypeScript, use Prettier
    try {
      const { format, plugins } = await loadPrettier();

      const formatted = await format(currentCode, {
        ...PRETTIER_OPTIONS,
        plugins,
      });

      // Only update if the formatted code is different
      if (formatted !== currentCode) {
        const fullRange = model.getFullModelRange();
        editorInstance.executeEdits("prettier", [
          { range: fullRange, text: formatted },
        ]);
      }
    } catch (err) {
      console.error("Prettier formatting failed:", err);
    }
  };

  const handleEditorDidMount: OnMount = async (editor, monaco) => {
    editorRef.current = editor;

    // Configure TypeScript AFTER mount (beforeMount was causing value not to display)
    if (language === "typescript") {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        allowNonTsExtensions: true,
        allowJs: true,
        strict: false, // Less strict for workflow code
        noEmit: true,
        esModuleInterop: true,
        jsx: monaco.languages.typescript.JsxEmit.React,
        allowSyntheticDefaultImports: true,
      });

      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: disableDiagnostics,
        noSyntaxValidation: disableDiagnostics,
      });
    }

    // Add Ctrl+S / Cmd+S keybinding to format and save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      // Format the document first
      await formatWithPrettier(editor);
      const returnType = await getReturnType(editor);

      // Then call onSave with the formatted value
      const value = editor.getValue();

      onSaveRef.current?.(value, returnType as Record<string, unknown> | null);
    });
  };

  return (
    <div className="h-full">
      <Editor
        key={editorKey}
        height={height}
        language={language}
        theme={
          document.documentElement.classList.contains("dark")
            ? "vs-dark"
            : "light"
        }
        value={code}
        path={filePath}
        onChange={onChange}
        onMount={handleEditorDidMount}
        loading={LoadingPlaceholder}
        options={editorOptions}
      />
    </div>
  );
}

// Public component that wraps with error boundary for disposal recovery
export function MonacoCodeEditor(props: MonacoCodeEditorProps) {
  return (
    <MonacoErrorBoundary>
      <InternalMonacoEditor {...props} />
    </MonacoErrorBoundary>
  );
}

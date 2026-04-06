import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useCurrentEditor, type Editor } from "@tiptap/react";
import { useEffect, useRef, type ChangeEvent } from "react";
import { Attachment01 } from "@untitledui/icons";
import { toast } from "sonner";
import { modelSupportsFiles } from "../../select-model";
import { insertFile, type FileAttrs } from "./node.tsx";
import { AiProviderModel } from "@/web/hooks/collections/use-ai-providers.ts";

interface FileUploaderProps {
  editor: Editor;
  selectedModel: AiProviderModel | null;
}

/**
 * Processes a file by converting it to base64 and inserting it into the editor.
 */
export async function processFile(
  editor: Editor,
  selectedModel: AiProviderModel | null,
  file: File,
  position: number,
): Promise<void> {
  // Check if model supports files
  if (!modelSupportsFiles(selectedModel)) {
    toast.error("Selected model does not support file uploads");
    return;
  }

  const MAX_SIZE = 10 * 1024 * 1024; // 10MB

  if (file.size > MAX_SIZE) {
    toast.error(`File "${file.name}" exceeds 10MB limit`);
    return;
  }

  try {
    const reader = new FileReader();
    const base64Promise = new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("Failed to read file as data URL"));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.includes(",")
          ? (result.split(",")[1] ?? result)
          : result;
        resolve(base64);
      };
      reader.onerror = reject;
    });

    reader.readAsDataURL(file);

    const base64Data = await base64Promise;

    const fileAttrs: FileAttrs = {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      data: base64Data,
    };

    insertFile(editor, { from: position, to: position }, fileAttrs);
  } catch (error) {
    console.error("Failed to process file:", error);
    toast.error(`Failed to load file "${file.name}"`);
  }
}

/**
 * FileUploader component that registers a ProseMirror plugin to handle file drops.
 * Uses a ref to keep the latest selectedModel in sync for file processing.
 */
export function FileUploader({ editor, selectedModel }: FileUploaderProps) {
  // Use a ref to store the latest processFile handler
  // This ensures we always use the latest selectedModel when processing files
  const processFileRef = useRef<
    (file: File, position: number) => Promise<void>
  >(() => Promise.resolve());

  // Keep the processFile handler in sync with selectedModel
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    processFileRef.current = async (file: File, position: number) => {
      await processFile(editor, selectedModel, file, position);
    };
  }, [editor, selectedModel]);

  // Register the file drop plugin once per editor instance
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (editor?.isDestroyed) {
      return;
    }

    const pluginKey = new PluginKey("fileDropHandler");

    // Remove existing plugin if present
    const existingPlugin = editor.state.plugins.find(
      (plugin) => plugin.spec.key === pluginKey,
    );
    if (existingPlugin) {
      editor.unregisterPlugin(pluginKey);
    }

    const fileDropPlugin = new Plugin({
      key: pluginKey,
      props: {
        handleDrop: (view, event, _slice, moved) => {
          // Don't handle if it's a move within the editor
          if (moved) return false;

          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;

          event.preventDefault();

          // Get drop position
          const coordinates = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });

          if (!coordinates) return false;

          // Process all dropped files sequentially at the drop position
          const fileArray = Array.from(files);
          const currentPos = coordinates.pos;

          for (const file of fileArray) {
            // Call the ref to use the latest selectedModel
            void processFileRef.current?.(file, currentPos);
            // In practice, they'll be inserted at the same position which is fine
          }

          return true;
        },

        handlePaste: (view, event) => {
          const items = event.clipboardData?.items;
          if (!items) return false;

          const fileItems = Array.from(items).filter(
            (item) => item.kind === "file",
          );
          if (fileItems.length === 0) return false;

          event.preventDefault();

          const { from } = view.state.selection;
          for (const item of fileItems) {
            const file = item.getAsFile();
            if (file) void processFileRef.current?.(file, from);
          }

          return true;
        },
      },
    });

    editor.registerPlugin(fileDropPlugin);

    return () => {
      if (!editor?.isDestroyed) {
        editor.unregisterPlugin(pluginKey);
      }
    };
  }, [editor]);

  // This component doesn't render anything
  return null;
}

/**
 * FileUploadButton component that renders a button with a hidden file input.
 * Uses EditorContext to access the editor instance and processFile to handle file uploads.
 */
interface FileUploadButtonProps {
  selectedModel: AiProviderModel | null;
  isStreaming: boolean;
}

export function FileUploadButton({
  selectedModel,
  isStreaming,
}: FileUploadButtonProps) {
  const { editor } = useCurrentEditor();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelSupportsFilesValue = modelSupportsFiles(selectedModel);

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !editor) return;

    const fileArray = Array.from(files);

    // Get current cursor position
    const { from } = editor.state.selection;
    const currentPos = from;

    // Process files sequentially using the shared processFile function
    for (const file of fileArray) {
      await processFile(editor, selectedModel, file, currentPos);
    }

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  if (!editor || !modelSupportsFilesValue) {
    return null;
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        disabled={isStreaming}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center justify-center size-8 rounded-md border border-border text-muted-foreground/75 transition-colors shrink-0",
              isStreaming
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:text-muted-foreground",
            )}
            disabled={isStreaming}
            onClick={() => fileInputRef.current?.click()}
          >
            <Attachment01 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Add file</TooltipContent>
      </Tooltip>
    </>
  );
}

import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useCurrentEditor, type Editor } from "@tiptap/react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Attachment01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  getAcceptedMimeTypesForModel,
  getSupportedFileTypesLabel,
  isFileTypeSupportedByModel,
  modelSupportsFiles,
} from "../../select-model";
import { insertFile, type FileAttrs } from "./node.tsx";
import { AiProviderModel } from "@/web/hooks/collections/use-ai-providers.ts";

export interface UnsupportedFileInfo {
  fileName: string;
  modelName: string;
  accepted: string;
}

interface FileUploaderProps {
  editor: Editor;
  selectedModel: AiProviderModel | null;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
}

/**
 * Processes a file by converting it to base64 and inserting it into the editor.
 */
export async function processFile(
  editor: Editor,
  selectedModel: AiProviderModel | null,
  file: File,
  position: number,
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void,
): Promise<void> {
  // Check if model supports files
  if (!modelSupportsFiles(selectedModel)) {
    toast.error("Selected model does not support file uploads");
    return;
  }

  const fileMimeType = file.type || "application/octet-stream";
  if (!isFileTypeSupportedByModel(fileMimeType, selectedModel)) {
    const accepted = getSupportedFileTypesLabel(selectedModel);
    const modelName = selectedModel?.title ?? "This model";
    if (onUnsupportedFile) {
      onUnsupportedFile({ fileName: file.name, modelName, accepted });
    } else {
      toast.error(`"${file.name}" can't be attached`, {
        description: `${modelName} accepts ${accepted}.`,
      });
    }
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
export function FileUploader({
  editor,
  selectedModel,
  onUnsupportedFile,
}: FileUploaderProps) {
  // Use a ref to store the latest processFile handler
  // This ensures we always use the latest selectedModel when processing files
  const processFileRef = useRef<
    (file: File, position: number) => Promise<void>
  >(() => Promise.resolve());

  // Keep the processFile handler in sync with selectedModel
  // eslint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    processFileRef.current = async (file: File, position: number) => {
      await processFile(
        editor,
        selectedModel,
        file,
        position,
        onUnsupportedFile,
      );
    };
  }, [editor, selectedModel, onUnsupportedFile]);

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
  icon?: React.ReactNode;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
}

export function FileUploadButton({
  selectedModel,
  isStreaming,
  icon,
  onUnsupportedFile,
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
      await processFile(
        editor,
        selectedModel,
        file,
        currentPos,
        onUnsupportedFile,
      );
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
        accept={getAcceptedMimeTypesForModel(selectedModel)}
        className="hidden"
        onChange={handleFileSelect}
        disabled={isStreaming}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground/75"
            disabled={isStreaming || !modelSupportsFilesValue}
            onClick={() => fileInputRef.current?.click()}
          >
            {icon ?? <Attachment01 size={16} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Add file</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Dialog shown when the user tries to attach a file whose MIME type the
 * selected model doesn't support.
 */
export function UnsupportedFileDialog({
  info,
  onClose,
}: {
  info: UnsupportedFileInfo | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={info !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[480px] gap-0 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header with subtle amber warning gradient */}
        <div className="relative px-8 pt-8 pb-2 overflow-hidden">
          <div
            className="absolute inset-x-0 top-0 h-36 pointer-events-none"
            style={{
              backgroundImage: [
                "radial-gradient(ellipse 40% 200% at -5% 100%, rgba(251,191,36,0.35) 0%, transparent 100%)",
                "radial-gradient(ellipse 40% 200% at 105% -10%, rgba(244,114,182,0.25) 0%, transparent 100%)",
              ].join(", "),
              maskImage:
                "linear-gradient(to bottom, black 0%, transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, black 0%, transparent 100%)",
            }}
          />
          <DialogHeader className="relative gap-4">
            <div className="flex items-center justify-center size-9 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={18} />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold tracking-tight">
                File type not supported
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-sm leading-relaxed">
                <span className="font-medium text-foreground">
                  &ldquo;{info?.fileName}&rdquo;
                </span>{" "}
                can&apos;t be attached to this chat.
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="px-8 pt-3 pb-6 space-y-3">
          <div className="rounded-xl border border-border p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              {info?.modelName} accepts
            </div>
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Attachment01 size={14} className="text-muted-foreground" />
              <span className="capitalize">{info?.accepted}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-4 border-t border-border bg-muted/30 flex items-center justify-end">
          <Button onClick={onClose}>Got it</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function useUnsupportedFileDialog() {
  const [unsupportedFile, setUnsupportedFile] =
    useState<UnsupportedFileInfo | null>(null);
  return {
    unsupportedFile,
    onUnsupportedFile: setUnsupportedFile,
    clearUnsupportedFile: () => setUnsupportedFile(null),
  };
}

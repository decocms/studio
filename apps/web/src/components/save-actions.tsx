import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { FlipBackward, Save01 } from "@untitledui/icons";

interface SaveActionsProps {
  onSave: () => void | Promise<void>;
  onUndo: () => void;
  isDirty: boolean;
  isSaving: boolean;
  saveLabel?: string;
  undoLabel?: string;
}

export function SaveActions({
  onSave,
  onUndo,
  isDirty,
  isSaving,
  saveLabel = "Save",
  undoLabel = "Undo",
}: SaveActionsProps) {
  if (!isDirty) {
    return null;
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={onUndo}
        disabled={isSaving}
        aria-label={undoLabel}
      >
        <FlipBackward size={14} />
        {undoLabel}
      </Button>
      <Button
        variant="default"
        size="sm"
        onClick={onSave}
        disabled={isSaving}
        aria-label={saveLabel}
      >
        {isSaving ? <Spinner className="size-3.5" /> : <Save01 size={14} />}
        {saveLabel}
      </Button>
    </>
  );
}

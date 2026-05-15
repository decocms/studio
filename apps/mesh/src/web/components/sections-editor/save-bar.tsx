import { Button } from "@deco/ui/components/button.tsx";
import { Loading01 } from "@untitledui/icons";

export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty) return null;

  return (
    <div className="sticky bottom-0 border-t bg-background px-4 py-2 flex items-center justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
        Discard
      </Button>
      <Button type="button" size="sm" onClick={onSave} disabled={saving}>
        {saving && <Loading01 size={14} className="animate-spin mr-1.5" />}
        Save
      </Button>
    </div>
  );
}

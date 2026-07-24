/**
 * CT stub for `@/components/file-picker/file-picker-dialog`.
 *
 * The real dialog pulls in @tanstack/react-router (<Link>), Suspense queries,
 * and the MCP client. For component tests we render a tiny deterministic stand
 * in that mirrors the real contract (open/onOpenChange/mode/onSelect) so we can
 * assert "Browse opens the picker" and "selecting a file calls onChange".
 */
import type { ReactNode } from "react";

export const LAST_CONFIG_KEY = "deco:file-picker:last-config";

const PICKED_URL = "https://cdn.example.com/ct-picked.png";

export function FilePickerDialog({
  open,
  onOpenChange,
  mode,
  onSelect,
  lockedConfigId: _lockedConfigId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "image" | "any" | string;
  onSelect: (url: string) => void;
  lockedConfigId?: string | null;
}): ReactNode {
  if (!open) return null;
  return (
    <div data-testid="file-picker-stub" data-mode={mode}>
      <button
        type="button"
        data-testid="file-picker-pick"
        onClick={() => {
          onSelect(PICKED_URL);
          onOpenChange(false);
        }}
      >
        ct-pick
      </button>
      <button
        type="button"
        data-testid="file-picker-close"
        onClick={() => onOpenChange(false)}
      >
        ct-close
      </button>
    </div>
  );
}

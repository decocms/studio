"use client";

import { Check } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useChat } from "../../../context.tsx";
import {
  usePreferences,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";

interface ApprovalActionsProps {
  approvalId: string;
}

const DEFAULT_DENY_REASON =
  "User denied this tool call, give other alternatives.";

const APPROVAL_LEVEL_OPTIONS: {
  value: ToolApprovalLevel;
  label: string;
}[] = [
  { value: "none", label: "Always ask" },
  { value: "readonly", label: "Skip read-only" },
  { value: "yolo", label: "Auto-approve all" },
];

export function ApprovalActions({ approvalId }: ApprovalActionsProps) {
  const { addToolApprovalResponse } = useChat();
  const [preferences, setPreferences] = usePreferences();

  const handleLevelChange = (value: string) => {
    const newLevel = value as ToolApprovalLevel;
    setPreferences({ ...preferences, toolApprovalLevel: newLevel });
    // When switching to "yolo" (auto-approve all), immediately accept
    // the current pending approval so the user isn't left waiting.
    if (newLevel === "yolo") {
      addToolApprovalResponse({ id: approvalId, approved: true });
    }
  };

  return (
    <div className="flex items-center w-full gap-2">
      {/* Left: tool behavior preference */}
      <Select
        value={preferences.toolApprovalLevel}
        onValueChange={handleLevelChange}
      >
        <SelectTrigger
          size="xs"
          className="text-xs text-muted-foreground border-border/60 bg-transparent hover:bg-accent/60 h-7 gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {APPROVAL_LEVEL_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: deny / accept */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-muted-foreground [@media(hover:hover)]:hover:text-foreground active:scale-[0.97] transition-transform"
        onClick={(e) => {
          e.stopPropagation();
          addToolApprovalResponse({
            id: approvalId,
            approved: false,
            reason: DEFAULT_DENY_REASON,
          });
        }}
      >
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 px-2.5 text-xs active:scale-[0.97] transition-transform"
        onClick={(e) => {
          e.stopPropagation();
          addToolApprovalResponse({ id: approvalId, approved: true });
        }}
      >
        <Check className="size-3.5" />
        Accept
      </Button>
    </div>
  );
}

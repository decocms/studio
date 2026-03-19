const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

const MOD = isMac ? "⌘" : "Ctrl";

interface Shortcut {
  /** Display keys shown in the shortcuts dialog, e.g. ["⌘", "K"] */
  keys: string[];
  /** Human-readable description */
  description: string;
}

interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

const KEYBOARD_SHORTCUTS = {
  keyboardShortcuts: { keys: [MOD, "K"], description: "Keyboard shortcuts" },
  focusChatInput: { keys: [MOD, "L"], description: "Focus chat input" },
  saveAndFormat: { keys: [MOD, "S"], description: "Save & format" },
  sendMessage: { keys: ["Enter"], description: "Send message" },
  newLine: { keys: ["Shift", "Enter"], description: "New line" },
  selectOption: { keys: ["1-9"], description: "Select option" },
  applyFilter: { keys: [MOD, "Enter"], description: "Apply filter" },
  togglePlanMode: {
    keys: [MOD, "Shift", "L"],
    description: "Toggle plan mode",
  },
} as const satisfies Record<string, Shortcut>;

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "General",
    shortcuts: [KEYBOARD_SHORTCUTS.keyboardShortcuts],
  },
  {
    label: "Editor",
    shortcuts: [KEYBOARD_SHORTCUTS.saveAndFormat],
  },
  {
    label: "Chat",
    shortcuts: [
      KEYBOARD_SHORTCUTS.focusChatInput,
      KEYBOARD_SHORTCUTS.togglePlanMode,
      KEYBOARD_SHORTCUTS.sendMessage,
      KEYBOARD_SHORTCUTS.newLine,
    ],
  },
  {
    label: "Questions",
    shortcuts: [KEYBOARD_SHORTCUTS.selectOption],
  },
  {
    label: "Monitoring",
    shortcuts: [KEYBOARD_SHORTCUTS.applyFilter],
  },
];

/** Whether the platform modifier key (⌘ on Mac, Ctrl elsewhere) is pressed */
export function isModKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export { isMac };

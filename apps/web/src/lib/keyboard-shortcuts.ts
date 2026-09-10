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

export const KEYBOARD_SHORTCUTS = {
  /** ⌘K opens the command palette; the shortcuts sheet it used to open moved
   *  to "?" (see `shell-layout.tsx`'s keydown handler). */
  commandPalette: { keys: [MOD, "K"], description: "Command palette" },
  keyboardShortcuts: { keys: ["?"], description: "Keyboard shortcuts" },
  back: { keys: [MOD, "["], description: "Back to previous" },
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
  newTask: {
    keys: ["Shift", MOD, "S"],
    description: "New task",
  },
  toggleDaemon: {
    keys: [MOD, "D"],
    description: "Toggle daemon logs",
  },
} as const satisfies Record<string, Shortcut>;

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "General",
    shortcuts: [
      KEYBOARD_SHORTCUTS.commandPalette,
      KEYBOARD_SHORTCUTS.keyboardShortcuts,
      KEYBOARD_SHORTCUTS.back,
      KEYBOARD_SHORTCUTS.newTask,
      KEYBOARD_SHORTCUTS.toggleDaemon,
    ],
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

/**
 * Whether the event came from somewhere the user is entering text.
 *
 * Unmodified single-character shortcuts (like "?") must yield to typing;
 * `contentEditable` covers the chat composer, which is not an `<input>`.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

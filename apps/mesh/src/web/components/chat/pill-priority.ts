/**
 * Per-pill priority in the chat input bottom row. Used by ToolsPopover,
 * TierTrigger, ModePicker, and BranchPicker.
 *
 * - `primary`   — label expands at `@[320px]/chat-bottom`+ (visible in
 *                 nearly all layouts).
 * - `secondary` — label only expands at `@[720px]/chat-bottom`+ (visible
 *                 only on very wide layouts).
 *
 * Chat.Input swaps which group is primary based on `isChatEmpty`:
 *   • empty thread:    branch + mode are primary, tools + tier secondary
 *   • non-empty thread: tools + tier are primary,  branch + mode secondary
 *
 * Tailwind JIT note: the literal container-query classes
 * `@[320px]/chat-bottom:…` and `@[720px]/chat-bottom:…` must appear
 * verbatim in the source files (no template-literal interpolation), so
 * each pill inlines its own class strings rather than receiving them
 * from this module. This file is just the canonical type.
 */
export type PillPriority = "primary" | "secondary";

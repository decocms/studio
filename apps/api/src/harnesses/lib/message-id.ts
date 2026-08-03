import { nanoid } from "nanoid";

/** Message ID generator shared by ALL harnesses (decopilot, codex, claude-code).
 *  Pass to `toUIMessageStream({ generateMessageId })` so each message's `start`
 *  chunk carries a stable `msg_…` id. The studio projection consumes that id
 *  verbatim (single id authority); without it `toUIMessageStream` emits
 *  `start.messageId: undefined` and the studio cannot keep a stable id across
 *  re-folds. Lives at the package root (not under `decopilot/`) so the CLI
 *  harnesses can import it without crossing the decopilot import boundary
 *  (`cli-import-boundary.test.ts`). Portable harness leaf — no cluster imports. */
export const generateMessageId = () => `msg_${nanoid()}`;

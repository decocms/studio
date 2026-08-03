import { nanoid } from "nanoid";

/** Message ID generator used by the hosted Decopilot harness.
 *  Pass to `toUIMessageStream({ generateMessageId })` so each message's `start`
 *  chunk carries a stable `msg_…` id. The studio projection consumes that id
 *  verbatim (single id authority); without it `toUIMessageStream` emits
 *  `start.messageId: undefined` and the studio cannot keep a stable id across
 *  re-folds. Portable harness leaf — no cluster imports. */
export const generateMessageId = () => `msg_${nanoid()}`;

/**
 * POST /api/:org/feedback — shared by account and chat feedback dialogs.
 */

export type GeneralFeedbackBody = {
  kind?: "general";
  message: string;
};

export type ChatNegativeFeedbackBody = {
  kind: "chat_negative";
  messageId: string;
  threadId?: string | null;
  reasons?: string[];
  details?: string;
};

export type FeedbackRequestBody =
  | GeneralFeedbackBody
  | ChatNegativeFeedbackBody;

export async function submitFeedback(
  orgSlug: string,
  body: FeedbackRequestBody,
): Promise<Response> {
  return fetch(`/api/${encodeURIComponent(orgSlug)}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
}
